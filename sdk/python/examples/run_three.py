"""Register three bots, seat them in one room and let them play N games.

Usage:
    python examples/run_three.py --base http://localhost:8080 --games 5 [--invite CODE]
                                 [--bots greedy,greedy,random] [--play-timeout-ms 20000]

Prints per-game results, the room scores and the leaderboard rows for the three bots.
Exit code is non-zero if any bot did not finish all games in time (a stall).
"""

from __future__ import annotations

import argparse
import logging
import secrets
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from ddz_sdk import Client, register_bot  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402

KINDS = {"greedy": GreedyBot, "random": RandomBot}


class Reporter:
    """Prints a line per finished game (only from the first bot to avoid duplicates)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.results = []

    def add(self, result):
        with self.lock:
            self.results.append(result)
            r = result
            print(
                "game %3d: %-5s winner=%-8s landlord=%s base=%s bombs=%s x%s scores=%s"
                % (
                    len(self.results),
                    r.get("kind"),
                    r.get("winner"),
                    r.get("landlord"),
                    r.get("base"),
                    r.get("bombs"),
                    r.get("multiplier"),
                    r.get("scores"),
                ),
                flush=True,
            )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--games", type=int, default=5)
    ap.add_argument("--invite", default=None)
    ap.add_argument("--bots", default="greedy,greedy,random")
    ap.add_argument("--prefix", default="py")
    ap.add_argument("--play-timeout-ms", type=int, default=None)
    ap.add_argument("--per-game-timeout", type=float, default=120.0)
    ap.add_argument(
        "--chaos",
        type=float,
        default=0,
        help="drop a random bot's WebSocket every N seconds (reconnect test)",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    kinds = args.bots.split(",")
    if len(kinds) != 3 or any(k not in KINDS for k in kinds):
        ap.error("--bots must list 3 of: " + ",".join(KINDS))

    suffix = secrets.token_hex(3)
    creds = []
    for i, k in enumerate(kinds):
        name = "%s-%s%d-%s" % (args.prefix, k, i, suffix)
        info = register_bot(args.base, name, args.invite)
        creds.append((name, info["bot_id"], info["token"], k))
        print("registered %s (%s)" % (name, info["bot_id"]))

    config = {}
    if args.play_timeout_ms:
        config["play_timeout_ms"] = args.play_timeout_ms
    room = Client(args.base, creds[0][2]).create_room(
        "run-three-" + suffix, config or None
    )
    rid = room["id"]
    print("room %s" % rid)

    reporter = Reporter()
    bots, threads, errors = [], [], []
    for idx, (name, _bid, token, k) in enumerate(creds):
        bot = KINDS[k](name)
        if idx == 0:
            bot.on_game_over = reporter.add  # type: ignore[method-assign]
        bots.append(bot)

        def target(b=bot, t=token):
            try:
                b.run(args.base, t, rid, max_games=args.games, leave_on_exit=False)
            except Exception as e:  # pragma: no cover - reported below
                logging.exception("bot %s crashed", b.name)
                errors.append((b.name, e))

        th = threading.Thread(target=target, name=name, daemon=True)
        threads.append(th)
        th.start()

    deadline = time.time() + 30 + args.games * args.per_game_timeout
    if args.chaos > 0:
        # Test reconnects: every N seconds drop one bot's WebSocket (it must resume with since=).
        import random

        while any(th.is_alive() for th in threads) and time.time() < deadline:
            time.sleep(args.chaos)
            victim = random.choice(bots)
            ws = victim._ws
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
    for th in threads:
        th.join(max(0.0, deadline - time.time()))
    stalled = [b.name for b, th in zip(bots, threads) if th.is_alive()]
    for b in bots:
        b.stop()

    print()
    print("games finished per bot: %s" % [b.games_finished for b in bots])
    print("SDK stats per bot: %s" % [b.stats for b in bots])
    print("API errors per bot: %s" % [b.api_errors for b in bots])
    pub = Client(args.base)
    try:
        info = pub.get_room(rid)["room"]
        print("room seats/scores:")
        for s in info["seats"]:
            if s:
                print("  seat %d %-28s score=%d" % (s["seat"], s["name"], s["score"]))
    except Exception as e:  # room may be closed already
        print("room info unavailable: %s" % e)
    for _name, _bid, token, _k in creds:
        try:
            Client(args.base, token).leave_room(rid)
        except Exception:
            pass
    ours = {c[1] for c in creds}
    print("leaderboard:")
    for row in pub.leaderboard():
        if row["bot_id"] in ours:
            print(
                "  %-28s games=%d wins=%d landlord=%d/%d score=%d timeouts=%d"
                % (
                    row["name"],
                    row["games"],
                    row["wins"],
                    row["landlord_wins"],
                    row["landlord_games"],
                    row["score"],
                    row["timeouts"],
                )
            )
    if stalled or errors:
        print("STALLED: %s ERRORS: %s" % (stalled, errors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
