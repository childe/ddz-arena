"""Gongzhu (拱猪) example bots built on ddz_sdk.GongzhuBot and ddz_sdk.rules_gz.

* ``GreedyGongzhuBot``:
  - Expose: never.
  - Leading: the lowest card that is not a scoring card, from the shortest suit (to make a
    void early), keeping ``AS`` / ``KS`` while the pig is still out.
  - Following suit: drops the pig on an ``AS`` / ``KS``; otherwise ducks with the highest card
    under the current winner. If it cannot duck it plays its highest card when it is last (it
    wins the trick anyway) and its lowest otherwise, never the pig when it would win with it.
    When last on a trick with the goat and no negative cards it takes the trick.
  - Void in the led suit: dumps the pig, then the most expensive heart, then ``AS`` / ``KS``
    while the pig is out, then its highest card; the transformer and the goat go last.
* ``RandomGongzhuBot``: random legal card, never exposes. Useful for testing.

Usage:
    python examples/gongzhu_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python examples/gongzhu_bot.py --base http://localhost:8080 --register my-gz --invite CODE
    python examples/gongzhu_bot.py --base http://localhost:8080 --token TOKEN --strategy random
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import GongzhuBot, GongzhuState, register_bot  # noqa: E402
from ddz_sdk.rules_gz import (  # noqa: E402
    GOAT,
    PIG,
    TRANSFORMER,
    heart_points,
    is_scoring,
    rank_of,
)

#: spades above the pig: winning a spade trick with them may collect the pig
PIG_CATCHERS = ("AS", "KS")


def greedy_card(state: GongzhuState) -> str:
    """The greedy choice among ``state.legal_cards()`` (see the module docstring)."""
    legal = state.legal_cards()
    if len(legal) == 1:
        return legal[0]
    pig_out = PIG not in state.played_cards()
    suit_len = {s: sum(1 for c in state.hand if c[1] == s) for s in "SHCD"}
    if state.leading:

        def lead_key(c: str):
            risky = pig_out and c in PIG_CATCHERS and PIG not in state.hand
            return (is_scoring(c), risky, rank_of(c), suit_len[c[1]])

        return min(legal, key=lead_key)
    suit = state.led_suit
    if legal[0][1] == suit:
        return _follow(state, legal, suit)
    return _discard(legal, pig_out, PIG in state.hand)


def _follow(state: GongzhuState, legal: List[str], suit: str) -> str:
    top = rank_of(state.winning_card() or legal[0])
    trick = state.trick_cards
    last = len(trick) == 3
    if PIG in legal and top > rank_of(PIG):
        return PIG  # an ace or king of spades is winning: give it the pig
    bad = any(c[1] == "H" or c == PIG for c in trick)
    above = [c for c in legal if rank_of(c) > top]
    below = [c for c in legal if rank_of(c) < top]
    if last and GOAT in trick and not bad and above:
        safe = [c for c in above if c != PIG] or above
        return min(safe, key=rank_of)
    if below:
        return max(below, key=rank_of)
    safe = [c for c in legal if c != PIG] or legal
    return max(safe, key=rank_of) if last else min(safe, key=rank_of)


def _discard(legal: List[str], pig_out: bool, have_pig: bool) -> str:
    if PIG in legal:
        return PIG
    hearts = [c for c in legal if c[1] == "H"]
    if hearts:
        return min(hearts, key=lambda c: (heart_points(c), -rank_of(c)))
    if pig_out and not have_pig:
        for c in PIG_CATCHERS:
            if c in legal:
                return c
    plain = [c for c in legal if c not in (GOAT, TRANSFORMER)]
    if plain:
        return max(plain, key=rank_of)
    return TRANSFORMER if TRANSFORMER in legal else legal[0]


class GreedyGongzhuBot(GongzhuBot):
    def choose_expose(self, state: GongzhuState) -> List[str]:
        return []

    def choose_card(self, state: GongzhuState) -> str:
        return greedy_card(state)


class RandomGongzhuBot(GongzhuBot):
    def __init__(self, name=None, seed=None):
        super().__init__(name)
        self.rng = random.Random(seed)

    def choose_expose(self, state: GongzhuState) -> List[str]:
        return []

    def choose_card(self, state: GongzhuState) -> str:
        return self.rng.choice(state.legal_cards())


STRATEGIES = {"greedy": GreedyGongzhuBot, "random": RandomGongzhuBot}


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
