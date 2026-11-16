"""Greedy bot: a simple but sensible strategy built on ddz_sdk.rules.

Works in 3-player (ddz) and 4-player (ddz4) rooms: ``state.legal_moves()`` follows the room's rules.

* Bidding: scores the hand (jokers, 2s, aces, bombs) and bids 0-3 accordingly.
* Leading: plays the whole hand if it is one legal combo; otherwise leads the longest, lowest
  combo, keeping bombs, rockets and A/2/joker-headed combos for later. If the next player is an
  opponent with one card left, avoid leading singles (or lead the highest single); if it is a
  teammate with one card left, lead the lowest single.
* Following: never beats a teammate (farmers cooperate); against an opponent plays the smallest
  move that beats it without breaking a bomb; uses a bomb/rocket only when the opponent is close
  to going out or it lets us finish quickly.

Usage:
    python examples/greedy_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python examples/greedy_bot.py --base http://localhost:8080 --register my-greedy --invite CODE
    python examples/greedy_bot.py --base http://localhost:8080 --token TOKEN --game ddz4
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import Bot, GameState, Move, register_bot  # noqa: E402
from ddz_sdk.cards import RANK_A, RANK_BJ, RANK_RJ, rank_counts, rank_of  # noqa: E402

BOMBS = ("bomb", "rocket")


def hand_strength(hand: List[str]) -> int:
    c = rank_counts(hand)
    s = 4 * c[RANK_RJ] + 3 * c[RANK_BJ] + 2 * c[12] + c[RANK_A]
    s += 5 * sum(1 for r in range(13) if c[r] >= 4)
    if c[RANK_BJ] and c[RANK_RJ]:
        s += 2
    return s


def kick_sum(m: Move) -> int:
    return sum(rank_of(x) for x in m.cards)


class GreedyBot(Bot):
    def on_bid(self, state: GameState) -> int:
        s = hand_strength(state.hand)
        want = 3 if s >= 11 else 2 if s >= 8 else 1 if s >= 5 else 0
        return want if want > state.high_bid else 0

    # ---- helpers
    def _breaks_bomb(self, m: Move, counts: List[int], state: GameState) -> bool:
        if m.pattern.type in BOMBS:
            return False
        # ddz4: bombs are 4-8 cards of a rank and the rocket is all four jokers
        jokers = 2 if state.is_ddz4 else 1
        return any(
            counts[rank_of(x)] >= 4 and rank_of(x) < RANK_BJ for x in m.cards
        ) or (
            counts[RANK_BJ] == jokers
            and counts[RANK_RJ] == jokers
            and any(x in ("BJ", "RJ") for x in m.cards)
        )

    def _next_seat(self, state: GameState) -> int:
        return state.next_seat()

    def _is_opponent(self, state: GameState, seat: int) -> bool:
        if seat == state.seat:
            return False
        if state.is_landlord:
            return True
        return seat == state.landlord

    def on_play(self, state: GameState):
        moves = state.legal_moves()
        if not moves:
            return []
        n = len(state.hand)
        for m in moves:  # go out in one shot if possible
            if len(m.cards) == n:
                return m
        counts = rank_counts(state.hand)
        if state.leading:
            return self._lead(state, moves, counts)
        return self._follow(state, moves, counts)

    def _lead(self, state: GameState, moves: List[Move], counts: List[int]):
        nxt = self._next_seat(state)
        nxt_left = state.cards_left[nxt]
        normal = [
            m
            for m in moves
            if m.pattern.type not in BOMBS + ("four_two_single", "four_two_pair")
            and not self._breaks_bomb(m, counts, state)
        ]
        pool = normal or moves
        if nxt_left == 1 and not self._is_opponent(state, nxt):
            singles = [m for m in pool if m.pattern.type == "single"]
            if singles:
                return min(singles, key=lambda m: m.pattern.main)
        if nxt_left == 1 and self._is_opponent(state, nxt):
            multi = [m for m in pool if len(m.cards) > 1]
            if multi:
                pool = multi
            else:
                return max(pool, key=lambda m: m.pattern.main)
        return min(
            pool,
            key=lambda m: (
                m.pattern.main >= RANK_A,
                -len(m.cards),
                m.pattern.main,
                kick_sum(m),
            ),
        )

    def _follow(self, state: GameState, moves: List[Move], counts: List[int]):
        tb_seat = state.to_beat.get("seat")
        if not self._is_opponent(state, tb_seat):
            return []  # never beat a teammate
        normal = [
            m
            for m in moves
            if m.pattern.type not in BOMBS and not self._breaks_bomb(m, counts, state)
        ]
        if not normal:
            normal = [m for m in moves if m.pattern.type not in BOMBS]
        if normal:
            return min(
                normal, key=lambda m: (m.pattern.main, len(m.cards), kick_sum(m))
            )
        bombs = [m for m in moves if m.pattern.type in BOMBS]
        opp_left = state.cards_left[tb_seat]
        if bombs and (opp_left <= 6 or len(state.hand) - 4 <= 4):
            return min(
                bombs, key=lambda m: (m.pattern.type == "rocket", m.pattern.main)
            )
        return []


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
    GreedyBot().run(args.base, token, args.room, max_games=args.games, game=args.game)


if __name__ == "__main__":
    main()
