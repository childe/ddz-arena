"""Smart-bot service: keeps a pool of smart bots per game type and seats them where players ask.

A player seated in a room clicks 「智能 bot 补位」 on the web page (``POST /rooms/{rid}/smart-bots``);
this service polls the server for those invites (``GET /bot-service/poll`` with the shared
``DDZ_BOT_SERVICE_KEY``), reporting how many bots of each game type are free, and seats free
bots in the room. A bot leaves when no one but pool bots is left in its room, so its slot frees
up again. At most ``DDZ_BOTS_PER_GAME`` (default 4) bots per game type play at the same time.

Environment:
    DDZ_BOT_SERVICE_KEY   shared secret, same as the server's (required)
    DDZ_INVITE_CODE       needed to register the pool bots the first time
    DDZ_BOT_BASE          server URL (default http://127.0.0.1:$PORT, PORT default 8080)
    DDZ_BOTS_STATE        token file (default data/smart_bots.json)
    DDZ_BOTS_PER_GAME     bots per game type (default 4)
    DDZ_BOTS_PAUSE_MS     pause before each action so humans can follow (default 1000)

Usage:
    DDZ_BOT_SERVICE_KEY=... python sdk/python/smart/service.py
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from ddz_sdk import ApiError, Client, register_bot  # noqa: E402
from ddz_sdk.client import USER_AGENT  # noqa: E402
from join import paused  # noqa: E402
from smart3_bot import Smart3Bot  # noqa: E402
from smart4_bot import Smart4Bot  # noqa: E402
from smart_gd_bot import SmartGuandanBot  # noqa: E402

log = logging.getLogger("smart-bots")

STRATEGY = {"ddz": Smart3Bot, "ddz4": Smart4Bot, "guandan": SmartGuandanBot}
NAMES = {"ddz": "智能斗地主", "ddz4": "智能四人", "guandan": "智能掼蛋"}
#: how often a seated bot checks whether anyone else is still in its room
WATCH_S = 10


class PoolBot:
    def __init__(self, game: str, name: str, token: str):
        self.game = game
        self.name = name
        self.token = token
        self.bot_id: Optional[str] = None
        self.busy = False


class Service:
    def __init__(self, base: str, key: str, per_game: int, pause: float, state: Path):
        self.base = base.rstrip("/")
        self.key = key
        self.pause = pause
        self.state = state
        self.lock = threading.Lock()
        self.pool: List[PoolBot] = []
        tokens = json.loads(state.read_text()) if state.exists() else {}
        for game, prefix in NAMES.items():
            for i in range(per_game):
                name = prefix + "ABCDEFGH"[i]
                if name not in tokens:
                    info = register_bot(
                        self.base, name, os.environ.get("DDZ_INVITE_CODE")
                    )
                    tokens[name] = info["token"]
                    state.parent.mkdir(parents=True, exist_ok=True)
                    state.write_text(json.dumps(tokens, ensure_ascii=False, indent=2))
                    log.info("registered %s", name)
                self.pool.append(PoolBot(game, name, tokens[name]))
        for pb in self.pool:
            me = Client(self.base, pb.token).me()
            pb.bot_id = me["bot_id"]
            if me.get("room_id"):  # left over from before a restart
                try:
                    Client(self.base, pb.token).leave_room(me["room_id"])
                except ApiError:
                    pass
        self.ids = {pb.bot_id for pb in self.pool}

    def free(self) -> Dict[str, int]:
        with self.lock:
            return {
                g: sum(1 for pb in self.pool if pb.game == g and not pb.busy)
                for g in NAMES
            }

    def poll(self) -> List[dict]:
        q = "&".join("free_%s=%d" % kv for kv in self.free().items())
        req = urllib.request.Request(
            "%s/api/v1/bot-service/poll?%s" % (self.base, q),
            headers={"x-service-key": self.key, "user-agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())["invites"]

    def dispatch(self, invite: dict) -> None:
        with self.lock:
            idle = [pb for pb in self.pool if pb.game == invite["game"] and not pb.busy]
            chosen = idle[: invite["count"]]
            for pb in chosen:
                pb.busy = True
        log.info(
            "invite %s: %s -> %s",
            invite["id"],
            invite["room_id"],
            [pb.name for pb in chosen],
        )
        for pb in chosen:
            threading.Thread(
                target=self.serve, args=(pb, invite["room_id"]), daemon=True
            ).start()
            time.sleep(0.3)  # join one at a time so seats fill in order

    def serve(self, pb: PoolBot, room_id: str) -> None:
        """Play in ``room_id`` until only pool bots are left there, then free the slot."""
        bot = paused(STRATEGY[pb.game], self.pause)(pb.name)
        runner = threading.Thread(
            target=bot.run, args=(self.base, pb.token, room_id), daemon=True
        )
        runner.start()
        client = Client(self.base, pb.token)
        alone = 0
        try:
            while runner.is_alive():
                runner.join(WATCH_S)
                try:
                    seats = client.get_room(room_id)["room"]["seats"]
                except ApiError as e:
                    if e.status == 404:  # room closed
                        break
                    continue
                others = [s for s in seats if s and s.get("bot_id") not in self.ids]
                alone = 0 if others else alone + 1
                if alone >= 2:
                    log.info("%s leaves %s: nobody else is there", pb.name, room_id)
                    break
        finally:
            bot.stop()
            runner.join(10)
            try:
                if client.me().get("room_id") == room_id:
                    client.leave_room(room_id)
            except ApiError:
                pass
            with self.lock:
                pb.busy = False

    def run(self) -> None:
        log.info("serving %d bots at %s", len(self.pool), self.base)
        while True:
            try:
                for inv in self.poll():
                    self.dispatch(inv)
            except Exception as e:  # server restarting, network blip...
                log.warning("poll failed: %s", e)
                time.sleep(3)
            time.sleep(1)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("ddz_sdk").setLevel(logging.WARNING)
    key = os.environ.get("DDZ_BOT_SERVICE_KEY")
    if not key:
        raise SystemExit("DDZ_BOT_SERVICE_KEY is required")
    base = os.environ.get("DDZ_BOT_BASE") or "http://127.0.0.1:%s" % os.environ.get(
        "PORT", "8080"
    )
    Service(
        base,
        key,
        int(os.environ.get("DDZ_BOTS_PER_GAME", "4")),
        int(os.environ.get("DDZ_BOTS_PAUSE_MS", "1000")) / 1000,
        Path(os.environ.get("DDZ_BOTS_STATE", "data/smart_bots.json")),
    ).run()


if __name__ == "__main__":
    main()
