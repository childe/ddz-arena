"""Rule-based 4-player Dou Dizhu bot (``game: "ddz4"``): hand decomposition, card counting,
bomb management, bidding by hand strength and farmer cooperation.

* Decomposition: splits the hand into groups (bombs, chains, planes, triples with kickers,
  pairs, singles) with the lowest cost. A group costs ``1 - control``, where control grows
  with the group's top rank; bombs have negative cost. Lower cost = fewer weak groups to
  get rid of.
* Card counting: cards not in our hand and not yet played are "unseen". A group is a "boss"
  if no unseen cards can beat it without a bomb (or every opponent has fewer cards than it).
* Leading: if at most one group is not a boss, play bosses first and finish. Otherwise
  lead the lowest weak group, longest first; when an opponent has 1-2 cards left avoid
  leading what they can beat; a farmer feeds a teammate who has one card left.
* Following: an opponent's play is beaten with the move that hurts the decomposition the
  least, if the damage is below a threshold that rises when the opponent is close to going
  out; the last farmer before the landlord tries harder. Farmers never beat a teammate
  unless that lets them finish.
* Bombs: only to finish, to stop an opponent with few cards, or when the rest of the hand
  is strong; always the smallest bomb that wins.
* Bidding: the hand's decomposition cost and control cards give a strength; bid 3/2/1/0 by
  thresholds calibrated with ``smart/ddz4_sim.py``.

Usage:
    python smart/smart4_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python smart/smart4_bot.py --base http://localhost:8080 --register my-smart4 --invite CODE
"""

from __future__ import annotations

import argparse
import logging
import math
import random
import sys
import time
from dataclasses import dataclass
from math import comb
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz_sdk import Bot, GameState, Move, Pattern, register_bot  # noqa: E402
import endgame  # noqa: E402
import pimc  # noqa: E402
from ddz_sdk.cards import (  # noqa: E402
    RANK_2,
    RANK_A,
    RANK_BJ,
    RANK_RJ,
    rank_counts,
    rank_of,
    sort_cards,
)
from ddz_sdk.rules4 import identify4  # noqa: E402

#: copies of each rank in two decks (3..2: 8, BJ: 2, RJ: 2)
TOTAL = (8,) * 13 + (2, 2)
BOMBS = ("bomb", "rocket")
KICKED = ("triple_single", "triple_pair", "plane_single", "plane_pair")
#: (type, cards per rank, minimum length) of chain patterns
CHAINS = (("plane", 3, 2), ("pair_chain", 2, 3), ("straight", 1, 5))


@dataclass(frozen=True)
class Group:
    """One planned play: ``ranks`` is the ascending rank multiset, kickers included."""

    type: str
    main: int
    length: int
    ranks: Tuple[int, ...]

    @property
    def size(self) -> int:
        return len(self.ranks)

    @property
    def top(self) -> int:
        """Highest rank of the body (chains compare by start, but strength follows the top)."""
        return self.main + self.length - 1 if self.type in CHAIN_TYPES else self.main

    @property
    def pattern(self) -> Pattern:
        return Pattern(self.type, self.main, self.length)


CHAIN_TYPES = ("straight", "pair_chain", "plane", "plane_single", "plane_pair")


def group_cost(g: Group) -> float:
    """Cost of having to play ``g``: 1 for a weak group, less for strong ones, <0 for bombs."""
    if g.type == "rocket":
        return -1.2
    if g.type == "bomb":
        return -0.6 - 0.15 * (g.length - 4)
    if g.type in CHAIN_TYPES:
        return 1.0 - 0.6 * min(1.0, max(0.0, (g.top - 8) / 3))
    return 1.0 - min(1.0, max(0.0, (g.main - 8) / 6))


# ---------------------------------------------------------------- decomposition
def decompose(counts: Sequence[int]) -> Tuple[float, Tuple[Group, ...]]:
    """Lowest-cost split of a hand given as ``rank_counts``."""
    c = list(counts)
    fixed: List[Group] = []
    if c[RANK_BJ] == 2 and c[RANK_RJ] == 2:
        fixed.append(Group("rocket", RANK_RJ, 4, (RANK_BJ,) * 2 + (RANK_RJ,) * 2))
        c[RANK_BJ] = c[RANK_RJ] = 0
    for r in range(RANK_BJ):
        if c[r] >= 4:
            fixed.append(Group("bomb", r, c[r], (r,) * c[r]))
            c[r] = 0
    cost, groups = _search(tuple(c), (-1, -1, -1), ())
    return cost + sum(group_cost(g) for g in fixed), tuple(fixed) + groups


# Kept small: an entry costs ~1.5 KB and few hits come from earlier decisions.
@lru_cache(maxsize=20_000)
def _search(
    c: Tuple[int, ...], after: Tuple[int, int, int], planes: Tuple[Tuple[int, int], ...]
) -> Tuple[float, Tuple[Group, ...]]:
    """Choose chains (in canonical order ``> after``), then group the rest in :func:`_leaf`."""
    best = _leaf(c, planes)
    for ti, (t, need, min_len) in enumerate(CHAINS):
        for s in range(RANK_A + 1):
            ln = 0
            while s + ln <= RANK_A and c[s + ln] >= need:
                ln += 1
                if ln < min_len or (ti, s, ln) <= after:
                    continue
                rest = list(c)
                for r in range(s, s + ln):
                    rest[r] -= need
                if t == "plane":
                    sub_cost, sub = _search(
                        tuple(rest), (ti, s, ln), tuple(sorted(planes + ((s, ln),)))
                    )
                    cand = (sub_cost, sub)
                else:
                    g = Group(
                        t,
                        s,
                        ln,
                        tuple(r for r in range(s, s + ln) for _ in range(need)),
                    )
                    sub_cost, sub = _search(tuple(rest), (ti, s, ln), planes)
                    cand = (sub_cost + group_cost(g), sub + (g,))
                if cand[0] < best[0] - 1e-9:
                    best = cand
    return best


def _leaf(
    c: Tuple[int, ...], planes: Tuple[Tuple[int, int], ...]
) -> Tuple[float, Tuple[Group, ...]]:
    """Group leftover ranks (counts <= 3) into triples/pairs/singles and attach kickers."""
    singles = [r for r in range(len(c)) if c[r] == 1]
    pairs = [r for r in range(len(c)) if c[r] == 2]
    triples = [r for r in range(len(c)) if c[r] == 3]
    groups: List[Group] = []

    def weak(rs: List[int]) -> List[int]:
        """Kicker candidates: low ranks only (an ace or better is worth keeping)."""
        return [r for r in rs if r < RANK_A]

    for s, ln in sorted(planes, key=lambda p: -p[1]):
        body = tuple(r for r in range(s, s + ln) for _ in range(3))
        ws, wp = weak(singles), weak(pairs)
        if len(ws) >= ln:
            kick = ws[:ln]
            for r in kick:
                singles.remove(r)
            groups.append(
                Group("plane_single", s, ln, tuple(sorted(body + tuple(kick))))
            )
        elif len(wp) >= ln:
            kick = wp[:ln]
            for r in kick:
                pairs.remove(r)
            groups.append(
                Group(
                    "plane_pair",
                    s,
                    ln,
                    tuple(sorted(body + tuple(r for r in kick for _ in (0, 1)))),
                )
            )
        else:
            groups.append(Group("plane", s, ln, body))
    for t in triples:
        ws, wp = weak(singles), weak(pairs)
        if ws and (not wp or ws[0] <= wp[0]):
            singles.remove(ws[0])
            groups.append(Group("triple_single", t, 1, tuple(sorted((t, t, t, ws[0])))))
        elif wp:
            pairs.remove(wp[0])
            groups.append(
                Group("triple_pair", t, 1, tuple(sorted((t, t, t, wp[0], wp[0]))))
            )
        else:
            groups.append(Group("triple", t, 1, (t, t, t)))
    groups += [Group("pair", r, 1, (r, r)) for r in pairs]
    groups += [Group("single", r, 1, (r,)) for r in singles]
    return sum(group_cost(g) for g in groups), tuple(groups)


def hand_cost(counts: Sequence[int]) -> float:
    return decompose(tuple(counts))[0]


# ---------------------------------------------------------------- card counting
def can_beat_with(g: Group, unseen: Sequence[int], max_cards: int) -> bool:
    """True if some combination of ``unseen`` cards (held by one player with at most
    ``max_cards`` cards) beats ``g`` without a bomb."""
    if g.size > max_cards:
        return False
    need = {"single": 1, "pair": 2, "triple": 3, "triple_single": 3, "triple_pair": 3}
    if g.type in need:
        n = need[g.type]
        return any(unseen[r] >= n for r in range(g.main + 1, len(unseen)))
    for t, n, _ in CHAINS:
        if g.type.startswith(t):
            for s in range(g.main + 1, RANK_A - g.length + 2):
                if all(unseen[r] >= n for r in range(s, s + g.length)):
                    return True
            return False
    return False


def bomb_can_beat(g: Group, unseen: Sequence[int], max_cards: int) -> bool:
    """True if an unseen bomb could beat ``g`` (``g`` itself may be a bomb)."""
    if g.type == "rocket":
        return False
    if unseen[RANK_BJ] == 2 and unseen[RANK_RJ] == 2 and max_cards >= 4:
        return True
    for r in range(RANK_BJ):
        k = min(unseen[r], max_cards)
        if k < 4:
            continue
        if g.type != "bomb" or k > g.length or (k == g.length and r > g.main):
            return True
    return False


class Smart4Bot(Bot):
    games = ("ddz4",)
    default_game = "ddz4"

    #: bid when the 25-card hand strength reaches these values (see :meth:`strength`)
    BID_THRESHOLDS = ((3, 6.0), (2, 4.5), (1, 2.5))
    #: bid by the estimated chance to win as landlord instead (:meth:`win_chance`): bid
    #: when it reaches these values, each raised by BID_RAISE once an opponent has bid
    BID_BY_WIN = True
    BID_WIN_CUTS = ((3, 0.6), (2, 0.5), (1, 0.4))
    BID_RAISE = 0.1
    #: landlord win model: intercept and one weight per BID_FEATURES (ddz4_bidfit.py)
    BID_MODEL: Tuple[float, ...] = (
        0.1420,  # intercept
        0.0820,  # split cost
        -0.1548,  # groups
        0.2690,  # red jokers
        -0.1187,  # black jokers
        0.1109,  # twos
        0.0800,  # aces
        0.0404,  # kings
        0.1134,  # bombs
        -0.2992,  # bomb cards over 4
        0.1581,  # rocket
    )
    #: decomposition damage accepted to beat an opponent: landlord, farmer, the farmer
    #: just before the landlord (the last one who can stop it)
    LANDLORD_DAMAGE = 0.4
    FARMER_DAMAGE = 0.1
    LAST_FARMER_DAMAGE = 0.6
    #: beat at any cost (bombs included) when the player to beat has <= this many cards,
    #: or any opponent has <= DANGER_OPP
    DANGER_PLAYER = 6
    DANGER_OPP = 5
    #: a farmer bombs the landlord once the landlord has <= this many cards
    FARMER_BOMB_AT = 12
    #: bomb when the rest of the hand then costs <= this
    BOMB_REST_COST = 1.0
    #: when leading and an opponent has <= this many cards, lead what they cannot beat
    LEAD_GUARD = 5
    #: in that case keep bosses for later and lead the weak group least likely to be beaten
    KEEP_BOSS = True
    #: endgame search (see endgame.py) once all hands hold <= ENDGAME_TOTAL cards and
    #: someone has <= ENDGAME_SHORT; 0 turns it off
    ENDGAME_TOTAL = 32
    ENDGAME_SHORT = 5
    #: hidden-hand samples per decision and the time limit for one decision
    ENDGAME_SAMPLES = 24
    ENDGAME_BUDGET_S = 2.0
    #: a sampled deal where an opponent passed while holding a non-bomb answer is kept
    #: with this probability per such pass (1: no inference)
    ENDGAME_PASS_WEIGHT = 1.0
    #: mid-game Monte Carlo (see pimc.py) before the endgame search applies: deals kept
    #: per decision (0 turns it off), deals drawn before weighing, at most this many
    #: candidate moves, the average result a candidate must gain over the rule move, and
    #: the time limit for one decision
    PIMC_SAMPLES = 0
    PIMC_POOL = 48
    PIMC_CANDS = 6
    PIMC_MARGIN = 0.1
    PIMC_BUDGET_S = 1.5
    #: score rollouts by win / loss only (bombs and springs make the stake too noisy)
    PIMC_WIN_ONLY = True
    #: deal weighing: logistic width around the bid thresholds (0: ignore bids), and the
    #: weight per pass made while holding a non-bomb answer (1: ignore passes)
    PIMC_BID_TEMP = 1.0
    PIMC_PASS_WEIGHT = 1.0

    # ------------------------------------------------------------------ bidding
    @staticmethod
    def strength(hand: Sequence[str]) -> float:
        """Higher is stronger: control cards minus how many weak groups the hand has."""
        return _strength(tuple(rank_counts(hand)))

    def win_chance(self, hand: Sequence[str]) -> float:
        """Estimated chance that ``hand`` (25 cards) wins as landlord."""
        w = self.BID_MODEL
        z = w[0] + sum(a * b for a, b in zip(w[1:], bid_features(hand)))
        return 1 / (1 + math.exp(-z))

    def on_bid(self, state: GameState) -> int:
        if self.BID_BY_WIN and self.BID_MODEL:
            p = self.win_chance(state.hand)
            raised = any((b.get("score") or 0) > 0 for b in state.bids)
            for bid, cut in self.BID_WIN_CUTS:
                if p >= cut + (self.BID_RAISE if raised else 0):
                    return bid if bid > state.high_bid else 0
            return 0
        s = self.strength(state.hand)
        for bid, threshold in self.BID_THRESHOLDS:
            if s >= threshold:
                return bid if bid > state.high_bid else 0
        return 0

    # ------------------------------------------------------------------ playing
    def rule_move(self, state: GameState) -> Optional[Move]:
        """The move by rules alone (None = pass); also the policy for Monte Carlo rollouts."""
        moves = state.legal_moves()
        if not moves:
            return None
        for m in moves:
            if len(m.cards) == len(state.hand):
                return m
        ctx = _Ctx(self, state)
        return (ctx.lead() if state.leading else ctx.follow(moves)) or None

    def on_play(self, state: GameState):
        moves = state.legal_moves()
        if not moves:
            return []
        for m in moves:
            if len(m.cards) == len(state.hand):
                return m
        ctx = _Ctx(self, state)
        rule = ctx.lead() if state.leading else ctx.follow(moves)
        seed = "%s|%s|%d" % (state.game_id, ",".join(state.hand), len(state.history))
        if self.ENDGAME_TOTAL and endgame.applies(
            state, self.ENDGAME_TOTAL, self.ENDGAME_SHORT
        ):
            return endgame.choose(
                state,
                rule,
                self.ENDGAME_SAMPLES,
                self.ENDGAME_BUDGET_S,
                random.Random(seed),
                self.ENDGAME_PASS_WEIGHT,
            )
        if self.PIMC_SAMPLES > 0:
            return self.monte_carlo(state, ctx, rule or None, random.Random(seed)) or []
        return rule

    def monte_carlo(
        self, st: GameState, ctx: "_Ctx", rule: Optional[Move], rng: random.Random
    ) -> Optional[Move]:
        """Pick among a few candidate moves by weighted sampled rollouts (pimc.py)."""
        deadline = time.time() + self.PIMC_BUDGET_S
        cands = ctx.candidates(self.PIMC_CANDS)
        if len(cands) <= 1:
            return rule
        evidence = endgame.pass_evidence(st) if self.PIMC_PASS_WEIGHT < 1 else []
        deals = pimc.draw(
            st,
            rng,
            self.PIMC_POOL,
            self.PIMC_SAMPLES,
            lambda hands: pimc.weight(
                st,
                hands,
                self.strength,
                self.BID_THRESHOLDS,
                self.PIMC_BID_TEMP,
                evidence,
                self.PIMC_PASS_WEIGHT,
            ),
        )
        return pimc.choose(
            st,
            rule,
            cands,
            self.rule_move,
            deals,
            self.PIMC_MARGIN,
            deadline,
            self.PIMC_WIN_ONLY,
        )


#: features of a 25-card hand for the landlord win model (see ddz4_bidfit.py)
BID_FEATURES = (
    "split cost",
    "groups",
    "red jokers",
    "black jokers",
    "twos",
    "aces",
    "kings",
    "bombs",
    "bomb cards over 4",
    "rocket",
)


def bid_features(hand: Sequence[str]) -> List[float]:
    c = rank_counts(hand)
    cost, groups = decompose(tuple(c))
    bombs = [g for g in groups if g.type == "bomb"]
    rocket = sum(1 for g in groups if g.type == "rocket")
    return [
        cost,
        len(groups) - len(bombs) - rocket,
        c[RANK_RJ],
        c[RANK_BJ],
        c[RANK_2],
        c[RANK_A],
        c[RANK_A - 1],
        len(bombs),
        sum(g.length - 4 for g in bombs),
        rocket,
    ]


@lru_cache(maxsize=20_000)
def _strength(c: Tuple[int, ...]) -> float:
    cost, groups = decompose(c)
    ctrl = 2 * c[RANK_RJ] + 1.5 * c[RANK_BJ] + c[RANK_2] + 0.5 * c[RANK_A]
    ctrl += sum(2 + 0.5 * (g.length - 4) for g in groups if g.type == "bomb")
    ctrl += 4 * sum(1 for g in groups if g.type == "rocket")
    return ctrl - cost


class _Ctx:
    """Everything one decision needs: hand, unseen cards, sides and card counts."""

    def __init__(self, bot: "Smart4Bot", st: GameState):
        self.bot = bot
        self.st = st
        self.counts = rank_counts(st.hand)
        played = [0] * len(TOTAL)
        for h in st.history:
            for card in h.get("cards") or []:
                played[rank_of(card)] += 1
        self.unseen = [TOTAL[r] - self.counts[r] - played[r] for r in range(len(TOTAL))]
        self.me = st.seat
        self.landlord = st.landlord
        self.left = list(st.cards_left)
        if st.is_landlord:
            self.opps = [s for s in range(4) if s != self.me]
            self.mates: List[int] = []
        else:
            self.opps = [st.landlord]
            self.mates = st.teammates()
        self.opp_min = min(self.left[s] for s in self.opps)
        self.opp_max = max(self.left[s] for s in self.opps)
        self.cost, self.groups = decompose(tuple(self.counts))

    # ---- helpers
    def is_boss(self, g: Group) -> bool:
        return not can_beat_with(g, self.unseen, self.opp_max)

    def weak_groups(self, groups: Sequence[Group]) -> List[Group]:
        return [g for g in groups if g.type not in BOMBS and not self.is_boss(g)]

    def to_move(self, g: Group) -> Move:
        by_rank: Dict[int, List[str]] = {}
        for card in sort_cards(self.st.hand):
            by_rank.setdefault(rank_of(card), []).append(card)
        cards: List[str] = []
        for r in g.ranks:
            cards.append(by_rank[r].pop(0))
        if not any(
            p.type == g.type and p.main == g.main and p.length == g.length
            for p in identify4(cards)
        ):
            pats = identify4(cards)
            return (
                Move(cards, pats[0])
                if pats
                else Move(cards[:1], Pattern("single", g.ranks[0]))
            )
        return Move(cards, g.pattern)

    def after(self, m: Move) -> Tuple[float, Tuple[Group, ...]]:
        c = list(self.counts)
        for card in m.cards:
            c[rank_of(card)] -= 1
        return decompose(tuple(c))

    def can_finish(self, groups: Sequence[Group]) -> bool:
        """At most one group is not a boss: lead the bosses, then the last group."""
        return len(self.weak_groups(groups)) <= 1

    def beat_chance(self, g: Group) -> float:
        """Chance that an opponent holding ``opp_min`` random unseen cards beats ``g``
        without a bomb (singles and pairs; other groups count as beatable if possible).
        """
        k = self.opp_min
        total = sum(self.unseen)
        if total < k or k < 1:
            return 0.0
        higher = range(g.top + 1, len(self.unseen))
        if g.type == "single":
            h = sum(self.unseen[r] for r in higher)
            return 1 - comb(total - h, k) / comb(total, k)
        if g.type == "pair" and k >= 2:
            ways = sum(comb(self.unseen[r], 2) for r in higher)
            return min(1.0, ways * comb(k, 2) / comb(total, 2))
        return 1.0 if can_beat_with(g, self.unseen, k) else 0.0

    def candidates(self, limit: int) -> List[Optional[Move]]:
        """A few sensible moves for Monte Carlo to compare (None = pass): when leading,
        each non-bomb group of the split, lowest first; when following, passing, the
        moves that damage the split least and the smallest bomb."""
        st = self.st
        if st.leading:
            normal = sorted(
                (g for g in self.groups if g.type not in BOMBS),
                key=lambda g: (g.top, -g.size),
            )
            return [self.to_move(g) for g in normal[:limit]]
        moves = st.legal_moves()
        normal = [m for m in moves if m.pattern.type not in BOMBS]
        normal.sort(key=lambda m: (m.pattern.main, sum(rank_of(c) for c in m.cards)))
        scored = sorted(
            (
                (self.after(m)[0], m.pattern.main, i, m)
                for i, m in enumerate(normal[:60])
            ),
        )
        out: List[Optional[Move]] = [None] if st.can_pass else []
        out += [m for _, _, _, m in scored[: max(0, limit - 2)]]
        bombs = sorted(
            (m for m in moves if m.pattern.type in BOMBS),
            key=lambda m: (m.pattern.type == "rocket", len(m.cards), m.pattern.main),
        )
        out += bombs[:1]
        return out[:limit]

    # ---- leading
    def lead(self) -> Move:
        groups = self.groups
        weak = self.weak_groups(groups)
        bombs = sorted(
            (g for g in groups if g.type in BOMBS),
            key=lambda g: (g.type == "rocket", g.length, g.main),
        )
        if len(weak) <= 1:
            bosses = [g for g in groups if g.type not in BOMBS and g not in weak]
            if bosses:
                return self.to_move(max(bosses, key=lambda g: (g.size, -g.main)))
            if weak:
                return self.to_move(weak[0])
            return self.to_move(bombs[0])

        # Feed a teammate with one card left if the landlord is not about to go out.
        if any(self.left[s] == 1 for s in self.mates) and self.opp_min > 2:
            singles = sorted(r for r in range(len(self.counts)) if self.counts[r])
            if singles:
                return self.to_move(Group("single", singles[0], 1, (singles[0],)))

        pool = weak or [g for g in groups if g.type not in BOMBS] or list(groups)
        if self.opp_min <= self.bot.LEAD_GUARD and self.bot.KEEP_BOSS:
            # An opponent close to going out. A group with more cards than they hold cannot
            # be followed at all. Otherwise keep the bosses (they win the lead back later)
            # and lead a weak group: first one smaller than their hand (beating it does not
            # let them go out, and they may have to split a combo to do it), then one of
            # exactly their hand size; within each, the one they are least likely to beat.
            normal = [g for g in groups if g.type not in BOMBS]
            big = [g for g in normal if g.size > self.opp_min]
            if big:
                return self.to_move(min(big, key=lambda g: (g.top, -g.size)))
            if weak:
                return self.to_move(
                    min(
                        weak,
                        key=lambda g: (
                            g.size >= self.opp_min,
                            self.beat_chance(g),
                            g.top,
                        ),
                    )
                )
        if self.opp_min <= self.bot.LEAD_GUARD:
            # Older rule: lead what they cannot beat (too many cards for them, or nothing
            # unseen beats it); else the strongest group.
            allg = [g for g in groups if g.type not in BOMBS] or list(groups)
            safe = [g for g in allg if not can_beat_with(g, self.unseen, self.opp_min)]
            if safe:
                return self.to_move(min(safe, key=lambda g: (g.top, -g.size)))
            return self.to_move(max(pool, key=lambda g: (g.size, g.top)))
        return self.to_move(min(pool, key=lambda g: (g.top, -g.size)))

    # ---- following
    def follow(self, moves: List[Move]) -> Optional[Move]:
        st = self.st
        tb_seat = st.to_beat.get("seat")
        normal = [m for m in moves if m.pattern.type not in BOMBS]
        bombs = sorted(
            (m for m in moves if m.pattern.type in BOMBS),
            key=lambda m: (m.pattern.type == "rocket", len(m.cards), m.pattern.main),
        )
        # Evaluate at most 60 non-bomb candidates, cheapest-looking first.
        normal.sort(key=lambda m: (m.pattern.main, sum(rank_of(c) for c in m.cards)))
        scored = []
        for m in normal[:60]:
            cost, groups = self.after(m)
            scored.append((cost - self.cost, m, groups))
        scored.sort(key=lambda x: (x[0], x[1].pattern.main))

        if tb_seat in self.mates:
            # Never beat a teammate, unless that leaves us a hand we can surely finish.
            for delta, m, groups in scored:
                if self.can_finish(groups) and not bomb_can_beat(
                    Group(m.pattern.type, m.pattern.main, m.pattern.length, ()),
                    self.unseen,
                    self.opp_max,
                ):
                    return m
            return []

        bot = self.bot
        danger = (
            self.left[tb_seat] <= bot.DANGER_PLAYER
            or self.opp_min <= bot.DANGER_OPP
            or (not st.is_landlord and self.left[self.landlord] <= bot.FARMER_BOMB_AT)
        )
        if scored:
            delta, m, groups = scored[0]
            if self.can_finish(groups) or danger:
                return m
            if delta <= self.threshold(tb_seat):
                return m
        if bombs:
            b = bombs[0]
            cost, groups = self.after(b)
            if self.can_finish(groups) or danger or cost <= bot.BOMB_REST_COST:
                return b
        return []

    def threshold(self, tb_seat: int) -> float:
        """How much decomposition damage we accept to beat ``tb_seat``."""
        if self.st.is_landlord:
            return self.bot.LANDLORD_DAMAGE
        if self.st.next_seat() == self.landlord:
            return self.bot.LAST_FARMER_DAMAGE
        return self.bot.FARMER_DAMAGE


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
    Smart4Bot().run(args.base, token, args.room, max_games=args.games)


if __name__ == "__main__":
    main()
