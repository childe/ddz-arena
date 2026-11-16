"""Guandan (掼蛋) example bots built on ddz_sdk.GuandanBot and ddz_sdk.rules_gd.

* ``GreedyGuandanBot``:
  - Return (还贡): the smallest returnable card that is not part of a pair or more.
  - Leading: plays the whole hand if it is one legal combo; otherwise leads the longest, lowest
    combo, keeping bombs, straight flushes, the rocket and wildcards for later and avoiding
    combos headed by an ace, the level card or a joker. If the next player is an opponent with
    few cards left, avoids singles.
  - Following: never beats its teammate; against an opponent plays the smallest move that beats
    it without wildcards or breaking a bomb (then with wildcards); uses a bomb only when that
    opponent is close to going out or the bomb leaves us with few cards.
* ``RandomGuandanBot``: random returnable card, random legal move (passes 30% of the time when
  allowed). Useful for testing.

Usage:
    python examples/guandan_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python examples/guandan_bot.py --base http://localhost:8080 --register my-gd --invite CODE
    python examples/guandan_bot.py --base http://localhost:8080 --token TOKEN --strategy random
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
from collections import Counter
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import GuandanBot, GuandanState, Move, register_bot  # noqa: E402
from ddz_sdk.rules_gd import BOMB_TYPES  # noqa: E402

#: single value of the ace; the level card is 12, jokers 13 / 14 (see ddz_sdk.rules_gd)
VALUE_A = 11
#: sequence position of the high ace
SEQ_A = 13


def wilds_used(m: Move, state: GuandanState) -> int:
    return sum(1 for c in m.cards if c == state.wildcard)


def is_bomb(m: Move) -> bool:
    return m.pattern.type in BOMB_TYPES


def high_head(m: Move) -> bool:
    """Combo headed by an ace, the level card or a joker (worth keeping for later)."""
    if m.pattern.type in ("straight", "pair_chain", "plane"):
        return m.pattern.main >= SEQ_A
    return m.pattern.main >= VALUE_A


class GreedyGuandanBot(GuandanBot):
    # ---- return
    def on_return(self, state: GuandanState) -> str:
        options = state.returnable_cards()
        counts = Counter(c[0] for c in state.hand)
        lonely = [c for c in options if counts[c[0]] == 1]
        return (lonely or options)[0]

    # ---- helpers
    def _breaks_bomb(self, m: Move, state: GuandanState) -> bool:
        if is_bomb(m):
            return False
        counts = Counter(c[0] for c in state.hand if c != state.wildcard)
        if any(counts[c[0]] >= 4 for c in m.cards if c not in ("BJ", "RJ")):
            return True
        jokers = sum(1 for c in state.hand if c in ("BJ", "RJ"))
        return jokers == 4 and any(c in ("BJ", "RJ") for c in m.cards)

    def _plain(self, moves: List[Move], state: GuandanState) -> List[Move]:
        """Non-bomb moves without wildcards that keep our bombs intact."""
        return [
            m
            for m in moves
            if not is_bomb(m)
            and wilds_used(m, state) == 0
            and not self._breaks_bomb(m, state)
        ]

    def on_play(self, state: GuandanState):
        moves = state.legal_moves()
        if not moves:
            return []
        n = len(state.hand)
        for m in moves:  # go out in one shot if possible
            if len(m.cards) == n:
                return m
        if state.leading:
            return self._lead(state, moves)
        return self._follow(state, moves)

    def _lead(self, state: GuandanState, moves: List[Move]):
        pool = self._plain(moves, state) or [m for m in moves if not is_bomb(m)]
        pool = pool or moves
        nxt = state.next_seat()
        if (
            nxt is not None
            and not state.is_teammate(nxt)
            and state.cards_left[nxt] <= 2
        ):
            multi = [m for m in pool if len(m.cards) > state.cards_left[nxt]]
            if multi:
                pool = multi
            else:
                return max(pool, key=lambda m: m.pattern.main)
        return min(
            pool,
            key=lambda m: (
                high_head(m),
                wilds_used(m, state),
                -len(m.cards),
                m.pattern.main,
            ),
        )

    def _follow(self, state: GuandanState, moves: List[Move]):
        tb_seat = state.to_beat.get("seat")
        if state.is_teammate(tb_seat):
            return []  # never beat the teammate
        plain = self._plain(moves, state)
        if plain:
            return min(plain, key=lambda m: m.pattern.main)
        normal = [m for m in moves if not is_bomb(m)]
        if normal:
            return min(normal, key=lambda m: (wilds_used(m, state), m.pattern.main))
        bombs = [m for m in moves if is_bomb(m)]
        opp_left = state.cards_left[tb_seat] if tb_seat is not None else 27
        if bombs:
            small = min(
                bombs,
                key=lambda m: (
                    m.pattern.type == "rocket",
                    wilds_used(m, state),
                    len(m.cards),
                    m.pattern.main,
                ),
            )
            if opp_left <= 6 or len(state.hand) - len(small.cards) <= 4:
                return small
        return []


class RandomGuandanBot(GuandanBot):
    def __init__(self, name=None, seed=None):
        super().__init__(name)
        self.rng = random.Random(seed)

    def on_return(self, state: GuandanState) -> str:
        return self.rng.choice(state.returnable_cards())

    def on_play(self, state: GuandanState):
        moves = state.legal_moves()
        if state.can_pass and (not moves or self.rng.random() < 0.3):
            return []
        return self.rng.choice(moves)  # a Move: its pattern type and rank are sent


STRATEGIES = {"greedy": GreedyGuandanBot, "random": RandomGuandanBot}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token")
    ap.add_argument("--register", metavar="NAME", help="register a new bot first")
    ap.add_argument("--invite", default=None)
    ap.add_argument("--room", default=None)
    ap.add_argument("--games", type=int, default=None)
    ap.add_argument("--strategy", choices=sorted(STRATEGIES), default="greedy")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    token = args.token
    if args.register:
        info = register_bot(args.base, args.register, args.invite)
        token = info["token"]
        print("registered %s, token=%s (save it!)" % (info["bot_id"], token))
    if not token:
        ap.error("--token or --register is required")
    STRATEGIES[args.strategy]().run(args.base, token, args.room, max_games=args.games)


if __name__ == "__main__":
    main()
