"""Monte-Carlo Gongzhu (拱猪) bot (``game: "gongzhu"``).

* Playing: for every distinct legal card (cards that touch, with no unseen card between them and
  the same point value, count once) the bot deals the unseen cards to the other three players at
  random, consistent with what it knows -- how many cards each holds, the suits each is known to
  be out of (it did not follow), the exposed cards not played yet -- and plays the hand out with
  a fast greedy policy for all four seats. The same deals are used for every candidate. It plays
  the card with the best mean platform score ``(4 x own points - sum of points) / 10``. Each
  decision stops after ``budget`` seconds (default 0.35 s) or ``max_samples`` deals.
* Rollout policy (all seats): lead the lowest plain card of the shortest suit; follow by dropping
  the pig on ``AS`` / ``KS``, else duck under the winning card, else play high when last and low
  otherwise; when void dump the pig, then the most expensive heart, then ``AS`` / ``KS`` while
  the pig is out, then the highest card, keeping the goat and the transformer.
* Exposing: the pig only with at least 5 spades under it and no ``AS`` / ``KS`` (others will be
  out of spades before we are), the goat with at least 4 diamonds including 2 of ``AD KD QD``
  (we can win it ourselves), the transformer never (it doubles whatever the taker has, usually
  a loss), the heart ace only with 9 or more hearts including ``KH`` (a try for all the hearts).

Usage:
    python smart/smart_gz_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import GongzhuBot, GongzhuState, register_bot  # noqa: E402
from ddz_sdk import rules_gz  # noqa: E402

# ---- integer cards: suit * 13 + (rank - 2), suits S H C D -> 0..3
SUITS = "SHCD"
RANKS = rules_gz.RANKS
S, H, C, D = 0, 1, 2, 3


def to_int(card: str) -> int:
    return SUITS.index(card[1]) * 13 + RANKS.index(card[0])


def to_str(i: int) -> str:
    return RANKS[i % 13] + SUITS[i // 13]


PIG = to_int("QS")
GOAT = to_int("JD")
TC = to_int("TC")
AH = to_int("AH")
AS = to_int("AS")
KS = to_int("KS")
#: heart points per card (0 for other suits)
HPTS = [rules_gz.heart_points(to_str(i)) for i in range(52)]
SCORING = [rules_gz.is_scoring(to_str(i)) for i in range(52)]
#: discard preference while void: higher goes first
DISCARD = [0] * 52
for _i in range(52):
    if _i == PIG:
        DISCARD[_i] = 1000
    elif _i // 13 == H:
        DISCARD[_i] = 500 - HPTS[_i] * 5 + _i % 13
    elif _i in (GOAT, TC):
        DISCARD[_i] = -100 + (_i == TC) * 10
    else:
        DISCARD[_i] = _i % 13


def score_ints(
    taken: Sequence[int], ex_pig: bool, ex_goat: bool, ex_tc: bool, ex_ah: bool
) -> int:
    """``rules_gz.score_taken`` on integer cards."""
    hearts = 0
    hp = 0
    pig = goat = tc = False
    for c in taken:
        if c // 13 == H:
            hearts += 1
            hp += HPTS[c]
        elif c == PIG:
            pig = True
        elif c == GOAT:
            goat = True
        elif c == TC:
            tc = True
    allh = hearts == 13
    pts = (200 if allh else hp) * (2 if ex_ah else 1)
    if pig:
        pts += (100 if allh else -100) * (2 if ex_pig else 1)
    if goat:
        pts += 100 * (2 if ex_goat else 1)
    if tc:
        tm = 2 if ex_tc else 1
        pts = 50 * tm if hearts == 0 and not pig and not goat else pts * 2 * tm
    return pts


class Sim:
    """A hand in progress on integer cards, played out with :func:`policy`."""

    __slots__ = (
        "hands",
        "plays",
        "leader",
        "led",
        "exposed",
        "taken",
        "pig_out",
        "scoring_left",
    )

    def __init__(
        self, hands, plays, leader, led, exposed, taken, pig_out, scoring_left
    ):
        self.hands = hands  # 4 lists of ints
        self.plays = plays  # [(seat, card)] of the trick in progress
        self.leader = leader
        self.led = led  # 4 bools: suit led in a completed trick
        self.exposed = exposed  # 4 sets of ints (each seat's exposed cards)
        self.taken = taken  # 4 lists of ints
        self.pig_out = pig_out  # the pig has not been played yet
        self.scoring_left = scoring_left  # scoring cards not taken yet

    def play(self, seat: int, card: int) -> None:
        self.hands[seat].remove(card)
        self.plays.append((seat, card))
        if card == PIG:
            self.pig_out = False
        if len(self.plays) == 4:
            suit = self.plays[0][1] // 13
            w, best = self.plays[0]
            for s, c in self.plays[1:]:
                if c // 13 == suit and c > best:
                    w, best = s, c
            got = [c for _, c in self.plays if SCORING[c]]
            self.taken[w].extend(got)
            self.scoring_left -= len(got)
            self.led[suit] = True
            self.plays = []
            self.leader = w

    def turn(self) -> int:
        return (self.leader + len(self.plays)) % 4

    def finish(self) -> None:
        while self.scoring_left > 0 and self.hands[self.turn()]:
            s = self.turn()
            self.play(s, policy(self, s))


def locked(sim: Sim, seat: int, card: int) -> bool:
    if card not in sim.exposed[seat] or sim.led[card // 13]:
        return False
    suit = card // 13
    return any(c != card and c // 13 == suit for c in sim.hands[seat])


def legal(sim: Sim, seat: int) -> List[int]:
    hand = sim.hands[seat]
    pool = hand
    if sim.plays:
        suit = sim.plays[0][1] // 13
        follow = [c for c in hand if c // 13 == suit]
        if follow:
            pool = follow
    if sim.exposed[seat]:
        return [c for c in pool if not locked(sim, seat, c)]
    return list(pool)


def policy(sim: Sim, seat: int) -> int:
    """Fast greedy choice for ``seat`` (see the module docstring)."""
    opts = legal(sim, seat)
    if len(opts) == 1:
        return opts[0]
    hand = sim.hands[seat]
    if not sim.plays:
        counts = [0, 0, 0, 0]
        for c in hand:
            counts[c // 13] += 1
        risky_spades = sim.pig_out and PIG not in hand

        def lead_key(c: int):
            return (
                SCORING[c],
                risky_spades and (c == AS or c == KS),
                c % 13,
                counts[c // 13],
            )

        return min(opts, key=lead_key)
    suit = sim.plays[0][1] // 13
    if opts[0] // 13 != suit:  # void: discard
        if not sim.pig_out or PIG in hand:
            return max(opts, key=lambda c: DISCARD[c] if c not in (AS, KS) else c % 13)
        return max(opts, key=lambda c: DISCARD[c] + (400 if c == AS or c == KS else 0))
    top = max(c for _, c in sim.plays if c // 13 == suit)
    if PIG in opts and top > PIG:
        return PIG
    below = [c for c in opts if c < top]
    last = len(sim.plays) == 3
    if last and below:
        trick = [c for _, c in sim.plays]
        if GOAT in trick and not any(c // 13 == H or c == PIG for c in trick):
            above = [c for c in opts if c > top and c != PIG]
            if above:
                return min(above)
    if below:
        return max(below)
    safe = [c for c in opts if c != PIG] or opts
    return max(safe) if last else min(safe)


class SmartGongzhuBot(GongzhuBot):
    """Monte-Carlo card choice with a greedy rollout policy; rule-based exposing."""

    #: seconds per decision (the server's turn limit is 20 s by default)
    BUDGET = 0.35
    MIN_SAMPLES = 8
    MAX_SAMPLES = 300

    def __init__(
        self,
        name: Optional[str] = None,
        budget: Optional[float] = None,
        seed: Optional[int] = None,
        max_samples: Optional[int] = None,
    ):
        super().__init__(name)
        self.budget = self.BUDGET if budget is None else budget
        self.max_samples = max_samples or self.MAX_SAMPLES
        self.rng = random.Random(seed)
        #: samples used by the last choose_card (for logging / tests)
        self.last_samples = 0
        #: mean value per candidate card of the last choose_card
        self.last_values: Dict[str, float] = {}

    # ---- expose
    def choose_expose(self, state: GongzhuState) -> List[str]:
        hand = state.hand
        out: List[str] = []
        spades = [c for c in hand if c[1] == "S"]
        if "QS" in hand:
            low = [c for c in spades if rules_gz.rank_of(c) < 12]
            if len(low) >= 5 and "AS" not in hand and "KS" not in hand:
                out.append("QS")
        if "JD" in hand:
            diamonds = [c for c in hand if c[1] == "D"]
            high = sum(1 for c in ("AD", "KD", "QD") if c in hand)
            if len(diamonds) >= 4 and high >= 2:
                out.append("JD")
        if "AH" in hand:
            hearts = [c for c in hand if c[1] == "H"]
            if len(hearts) >= 9 and "KH" in hand:
                out.append("AH")
        return out

    # ---- play
    def choose_card(self, state: GongzhuState) -> str:
        legal_cards = state.legal_cards()
        self.last_samples = 0
        if len(legal_cards) == 1:
            return legal_cards[0]
        me = state.seat
        unseen = [to_int(c) for c in state.unseen_cards()]
        cands = self._candidates(state, legal_cards, set(unseen))
        if len(cands) == 1:
            return to_str(cands[0])
        base = self._base_sim(state)
        voids = state.voids()
        played = set(state.played_cards())
        fixed = [
            [to_int(c) for c in state.exposed[s] if c not in played] if s != me else []
            for s in range(4)
        ]
        need = [
            state.cards_left[s] if s != me else 0 for s in range(4)
        ]  # cards each other seat holds
        totals = [0.0] * len(cands)
        deadline = time.perf_counter() + self.budget
        n = 0
        while n < self.max_samples and (
            n < self.MIN_SAMPLES or time.perf_counter() < deadline
        ):
            hands = self._sample(unseen, need, fixed, voids, me)
            hands[me] = [to_int(c) for c in state.hand]
            for i, card in enumerate(cands):
                sim = Sim(
                    [list(h) for h in hands],
                    list(base.plays),
                    base.leader,
                    list(base.led),
                    base.exposed,
                    [list(t) for t in base.taken],
                    base.pig_out,
                    base.scoring_left,
                )
                sim.play(me, card)
                sim.finish()
                totals[i] += self._value(sim, me)
            n += 1
        self.last_samples = n
        self.last_values = {to_str(c): totals[i] / n for i, c in enumerate(cands)}
        best = max(range(len(cands)), key=lambda i: totals[i])
        return to_str(cands[best])

    def _value(self, sim: Sim, me: int) -> float:
        ex = set().union(*sim.exposed)
        flags = (PIG in ex, GOAT in ex, TC in ex, AH in ex)
        pts = [score_ints(t, *flags) for t in sim.taken]
        return (4 * pts[me] - sum(pts)) / 10

    def _base_sim(self, state: GongzhuState) -> Sim:
        led = [False] * 4
        for s in state.led_before():
            led[SUITS.index(s)] = True
        plays = [(p["seat"], to_int(p["card"])) for p in state.plays]
        leader = plays[0][0] if plays else state.seat
        taken = [[to_int(c) for c in t] for t in state.taken]
        exposed = [{to_int(c) for c in e} for e in state.exposed]
        scoring_left = rules_gz.SCORING_COUNT - sum(len(t) for t in taken)
        pig_out = "QS" not in state.played_cards()
        return Sim(
            [[], [], [], []], plays, leader, led, exposed, taken, pig_out, scoring_left
        )

    @staticmethod
    def _candidates(
        state: GongzhuState, legal_cards: Sequence[str], unseen: Set[int]
    ) -> List[int]:
        """Distinct legal cards: of touching cards (no unseen card of the suit between them)
        with the same point value only the lowest is kept."""
        ints = sorted(to_int(c) for c in legal_cards)
        out: List[int] = []
        for c in ints:
            if out:
                p = out[-1]
                if (
                    p // 13 == c // 13
                    and _same_value(p, c)
                    and not any(x in unseen for x in range(p + 1, c))
                ):
                    continue
            out.append(c)
        return out

    def _sample(
        self,
        unseen: Sequence[int],
        need: Sequence[int],
        fixed: Sequence[Sequence[int]],
        voids: Sequence[Set[str]],
        me: int,
    ) -> List[List[int]]:
        """Deal ``unseen`` to the other seats: ``need[s]`` cards each, ``fixed`` cards to their
        owner, no card of a suit a seat is known to be out of (relaxed if that fails).
        """
        rng = self.rng
        void_ints = [{SUITS.index(x) for x in v} for v in voids]
        fixed_set = {c for f in fixed for c in f}
        free = [c for c in unseen if c not in fixed_set]
        for attempt in range(30):
            hands: List[List[int]] = [list(f) for f in fixed]
            room = [need[s] - len(hands[s]) for s in range(4)]
            room[me] = 0
            cards = list(free)
            rng.shuffle(cards)
            use_voids = attempt < 25
            # most constrained cards first
            if use_voids:
                cards.sort(
                    key=lambda c: sum(
                        1 for s in range(4) if s != me and c // 13 not in void_ints[s]
                    )
                )
            ok = True
            for c in cards:
                seats = [
                    s
                    for s in range(4)
                    if room[s] > 0 and (not use_voids or c // 13 not in void_ints[s])
                ]
                if not seats:
                    ok = False
                    break
                total = sum(room[s] for s in seats)
                r = rng.random() * total
                for s in seats:
                    r -= room[s]
                    if r < 0:
                        break
                hands[s].append(c)
                room[s] -= 1
            if ok:
                return hands
        # The counts do not add up (a stale view): deal round-robin, ignoring them.
        hands = [list(f) for f in fixed]
        others = [s for s in range(4) if s != me]
        for i, c in enumerate(free):
            hands[others[i % 3]].append(c)
        return hands


def _same_value(a: int, b: int) -> bool:
    if SCORING[a] or SCORING[b]:
        return a // 13 == H and b // 13 == H and HPTS[a] == HPTS[b] and AH not in (a, b)
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token")
    ap.add_argument("--register", metavar="NAME", help="register a new bot first")
    ap.add_argument("--invite", default=None)
    ap.add_argument("--room", default=None)
    ap.add_argument("--games", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    token = args.token
    if args.register:
        info = register_bot(args.base, args.register, args.invite)
        token = info["token"]
        print("registered %s, token=%s (save it!)" % (info["bot_id"], token))
    if not token:
        ap.error("--token or --register is required")
    SmartGongzhuBot().run(
        args.base, token, args.room, max_games=args.games, game="gongzhu"
    )


if __name__ == "__main__":
    main()
