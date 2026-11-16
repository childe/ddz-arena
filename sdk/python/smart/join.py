"""Seat N smart bots in an existing Dou Dizhu room and keep them playing until Ctrl+C.

The room's game type picks the strategy: ``ddz`` -> Smart3Bot, ``ddz4`` -> Smart4Bot,
``guandan`` -> SmartGuandanBot.
Bots come from a fixed pool (智能A, 智能B, ...); each is registered once and its token kept
in ``smart/tokens.json`` (name -> {base url: token}). Bots already seated in another room
are skipped, so the same pool can serve several rooms at once.

Usage:
    python smart/join.py --room r_xxxxxx --count 2 [--pause-ms 1500] \
        [--base https://ddz.ohmycat.me] [--invite CODE]
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from ddz_sdk import Client, register_bot  # noqa: E402
from smart3_bot import Smart3Bot  # noqa: E402
from smart4_bot import Smart4Bot  # noqa: E402
from smart_gd_bot import SmartGuandanBot  # noqa: E402

TOKENS = HERE / "tokens.json"
POOL = ["智能" + c for c in "ABCDEFGH"]
STRATEGY = {"ddz": Smart3Bot, "ddz4": Smart4Bot, "guandan": SmartGuandanBot}


def paused(cls, pause: float):
    """Subclass of ``cls`` that waits ``pause`` seconds before each bid / play."""

    class Paused(cls):
        def on_bid(self, state):
            time.sleep(pause)
            return super().on_bid(state)

        def on_play(self, state):
            time.sleep(pause)
            return super().on_play(state)

        def on_return(self, state):
            time.sleep(pause)
            return super().on_return(state)

    return Paused


def pick_bots(base: str, room: str, count: int, invite):
    """``count`` (name, token) pairs of pool bots that are free or already in ``room``."""
    tokens = json.loads(TOKENS.read_text()) if TOKENS.exists() else {}
    picked = []
    for name in POOL:
        if len(picked) == count:
            break
        token = tokens.get(name, {}).get(base)
        if token is None:
            info = register_bot(base, name, invite)
            token = info["token"]
            tokens.setdefault(name, {})[base] = token
            TOKENS.write_text(json.dumps(tokens, ensure_ascii=False, indent=2))
            print("registered %s (%s)" % (name, info["bot_id"]), flush=True)
        cur = Client(base, token).me().get("room_id")
        if cur in (None, room):
            picked.append((name, token))
        else:
            print("%s is busy in %s, skipping" % (name, cur), flush=True)
    if len(picked) < count:
        raise SystemExit("only %d free bots in the pool" % len(picked))
    return picked


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://ddz.ohmycat.me")
    ap.add_argument("--room", required=True)
    ap.add_argument("--count", type=int, default=1, choices=[1, 2, 3, 4])
    ap.add_argument("--pause-ms", type=int, default=1500)
    ap.add_argument("--invite", default=None, help="needed only to register new bots")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    room = Client(args.base).get_room(args.room)["room"]
    if room.get("game") not in STRATEGY:
        raise SystemExit(
            "room %s is %s; smart bots play ddz / ddz4 / guandan"
            % (args.room, room.get("game"))
        )
    cls = paused(STRATEGY[room["game"]], args.pause_ms / 1000)

    bots, threads = [], []
    for name, token in pick_bots(args.base, args.room, args.count, args.invite):
        bot = cls(name)
        t = threading.Thread(
            target=bot.run, args=(args.base, token, args.room), daemon=True
        )
        t.start()
        bots.append(bot)
        threads.append(t)
        time.sleep(0.5)  # join one at a time so seats fill in order
    print(
        "%d %s bot(s) playing in %s; Ctrl+C to leave"
        % (len(bots), cls.__mro__[1].__name__, args.room),
        flush=True,
    )
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(1)
    except KeyboardInterrupt:
        for bot in bots:
            bot.stop()
        for t in threads:
            t.join(timeout=5)


if __name__ == "__main__":
    main()
