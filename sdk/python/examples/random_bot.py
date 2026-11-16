"""Random bot: bids randomly and plays a random legal move (computed locally via ddz_sdk.rules,
or ddz_sdk.rules4 in a 4-player room).

Usage:
    python examples/random_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python examples/random_bot.py --base http://localhost:8080 --register my-random --invite CODE
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import Bot, GameState, register_bot  # noqa: E402


class RandomBot(Bot):
    def __init__(self, name=None, seed=None):
        super().__init__(name)
        self.rng = random.Random(seed)

    def on_bid(self, state: GameState) -> int:
        options = [0] + [s for s in (1, 2, 3) if s > state.high_bid]
        return self.rng.choice(options)

    def on_play(self, state: GameState):
        moves = state.legal_moves()
        if state.can_pass and (not moves or self.rng.random() < 0.3):
            return []
        return self.rng.choice(moves)  # a Move: its pattern type is sent as a hint


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token")
    ap.add_argument("--register", metavar="NAME", help="register a new bot first")
    ap.add_argument("--invite", default=None)
    ap.add_argument("--room", default=None)
    ap.add_argument("--games", type=int, default=None)
    ap.add_argument("--game", choices=["ddz", "ddz4"], default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    token = args.token
    if args.register:
        info = register_bot(args.base, args.register, args.invite)
        token = info["token"]
        print("registered %s, token=%s (save it!)" % (info["bot_id"], token))
    if not token:
        ap.error("--token or --register is required")
    RandomBot().run(args.base, token, args.room, max_games=args.games, game=args.game)


if __name__ == "__main__":
    main()
