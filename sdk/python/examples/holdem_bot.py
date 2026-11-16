"""Texas Hold'em example bots built on ddz_sdk.HoldemBot.

* SimpleHoldemBot -- a tight, simple strategy:
  - Preflop: sorts the two hole cards into tiers. Premium hands (TT+, AK, AQs) raise to 3x the
    current bet (AA/KK keep re-raising, the rest just call once the pot is big); good hands
    (66-99, AQ, AJ, KQ, ATs+, KJs, QJs, JTs) open-raise and call moderate raises; playable hands
    (small pairs, suited aces, suited connectors, broadway cards) call small bets; the rest
    check or fold.
  - After the flop: evaluates hole + board with ddz_sdk.holdem.evaluate. Only hands that use a
    hole card count. Trips or better bet / raise about the pot; two pair bets half the pot and
    calls up to a pot-sized bet; top pair bets half the pot and calls up to half the pot; a
    weaker pair calls small bets; otherwise check or fold.
* RandomHoldemBot -- picks a random legal action (raise sizes too); handy for testing.

Usage:
    python examples/holdem_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python examples/holdem_bot.py --base http://localhost:8080 --register my-poker --invite CODE
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import Action, HoldemBot, HoldemState, register_bot  # noqa: E402
from ddz_sdk.holdem import rank_of  # noqa: E402

T, J, Q, K, A = 8, 9, 10, 11, 12  # rank values (2 = 0 .. A = 12)


def preflop_tier(hole: List[str]) -> int:
    """3 premium, 2 good, 1 playable, 0 trash."""
    hi, lo = sorted((rank_of(c) for c in hole), reverse=True)
    suited = hole[0][1] == hole[1][1]
    if hi == lo:
        return 3 if hi >= T else 2 if hi >= 4 else 1
    if hi == A and (lo == K or (lo == Q and suited)):
        return 3
    if (hi == A and lo in (Q, J)) or (hi == K and lo == Q):
        return 2
    if suited and ((hi == A and lo >= T) or (hi, lo) in ((K, J), (Q, J), (J, T))):
        return 2
    if suited and (hi == A or (hi - lo == 1 and lo >= 3)):
        return 1
    if lo >= T:
        return 1
    return 0


class SimpleHoldemBot(HoldemBot):
    def on_action(self, state: HoldemState):
        if state.phase == "preflop":
            return self._preflop(state)
        return self._postflop(state)

    # ---- helpers
    def _passive(self, state: HoldemState, max_call: int) -> Action:
        """Check if free, call up to ``max_call`` chips, else fold."""
        if state.can_check:
            return Action.check()
        if state.to_call <= max_call:
            return Action.call()
        return Action.fold()

    def _raise(self, state: HoldemState, target: int, max_call: int) -> Action:
        """Raise to ``target`` (clamped to the legal range); call / check if raising is closed."""
        amount = state.clamp_raise(target)
        if amount is None:
            return self._passive(state, max_call)
        return Action.raise_to(amount)

    def _preflop(self, state: HoldemState) -> Action:
        tier = preflop_tier(state.hole)
        bb = state.big_blind
        cur = max(state.current_bet, bb)
        if tier == 3:
            pair_ak = rank_of(state.hole[0]) == rank_of(state.hole[1]) >= K
            if pair_ak:
                return self._raise(state, 3 * cur, state.my_stack)
            if cur >= 20 * bb:
                return self._passive(state, 40 * bb)
            return self._raise(state, 3 * cur, 40 * bb)
        if tier == 2:
            if state.current_bet <= bb:
                return self._raise(state, 3 * bb, 10 * bb)
            return self._passive(state, 10 * bb)
        if tier == 1:
            return self._passive(state, 2 * bb)
        return self._passive(state, 0)

    def _postflop(self, state: HoldemState) -> Action:
        hv = state.hand_value()
        if hv is None:
            return self._passive(state, 0)
        score, _name, best = hv
        cat = score >> 20
        uses_hole = any(c in best for c in state.hole)
        pot = max(state.pot, state.big_blind)
        cur = state.current_bet
        if not uses_hole:
            return self._passive(state, 0)
        if cat >= 3:  # trips or better
            return self._raise(state, cur + pot, state.my_stack)
        if cat == 2:  # two pair
            if state.to_call == 0:
                return self._raise(state, pot // 2, pot)
            return self._passive(state, pot)
        if cat == 1:  # one pair
            pair_rank = (score >> 16) & 15
            top = max(rank_of(c) for c in state.board)
            if pair_rank >= top:
                if state.to_call == 0:
                    return self._raise(state, pot // 2, pot // 2)
                return self._passive(state, pot // 2)
            return self._passive(state, pot // 4)
        return self._passive(state, 0)


class RandomHoldemBot(HoldemBot):
    """Random legal actions: never folds when checking is free; random raise sizes."""

    def __init__(self, name=None, seed=None):
        super().__init__(name)
        self.rng = random.Random(seed)

    def on_action(self, state: HoldemState):
        r = self.rng.random()
        if state.can_raise and r < 0.25:
            lo, hi = state.min_raise_to, state.max_raise_to
            amount = (
                hi if self.rng.random() < 0.1 else self.rng.randint(lo, min(hi, lo * 3))
            )
            return ("raise", amount)
        if state.can_check:
            return ("check", None)
        if r < 0.6:
            return ("call", None)
        return ("fold", None)


STRATEGIES = {"simple": SimpleHoldemBot, "random": RandomHoldemBot}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token")
    ap.add_argument("--register", metavar="NAME", help="register a new bot first")
    ap.add_argument("--invite", default=None)
    ap.add_argument("--room", default=None)
    ap.add_argument("--games", type=int, default=None, help="hands to play")
    ap.add_argument("--strategy", choices=sorted(STRATEGIES), default="simple")
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
