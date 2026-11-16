"""Rule-based 3-player Dou Dizhu bot (``game: "ddz"``): hand decomposition, card counting,
bomb management, bidding by hand strength and farmer cooperation.

Same design as ``smart4_bot.py`` with the 3-player rules: one deck (4 cards per rank, one
of each joker), bombs are four of a kind, the rocket is BJ + RJ, two farmers.

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
  unless that lets them finish; the farmer before the landlord may top up the other
  farmer's low single / pair so the landlord has to spend a big card.
* Bombs: only to finish, to stop an opponent with few cards, or when the rest of the hand
  is strong; always the smallest bomb that wins.
* Bidding: the hand's decomposition cost and control cards give a strength; bid 3/2/1/0 by
  thresholds calibrated with ``smart/ddz3_sim.py``.

Usage:
    python smart/smart3_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
    python smart/smart3_bot.py --base http://localhost:8080 --register my-smart3 --invite CODE
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import Bot, GameState, Move, Pattern, register_bot  # noqa: E402
from ddz_sdk.cards import (  # noqa: E402
    RANK_2,
    RANK_A,
    RANK_BJ,
    RANK_RJ,
    rank_counts,
    rank_of,
    sort_cards,
)
from ddz_sdk.rules import identify  # noqa: E402

#: copies of each rank in one deck (3..2: 4, BJ: 1, RJ: 1)
TOTAL = (4,) * 13 + (1, 1)
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
        return -0.8
    if g.type in CHAIN_TYPES:
        return 1.0 - 0.6 * min(1.0, max(0.0, (g.top - 8) / 3))
    return 1.0 - min(1.0, max(0.0, (g.main - 8) / 6))


# ---------------------------------------------------------------- decomposition
def decompose(counts: Sequence[int]) -> Tuple[float, Tuple[Group, ...]]:
    """Lowest-cost split of a hand given as ``rank_counts``."""
    c = list(counts)
    fixed: List[Group] = []
    if c[RANK_BJ] == 1 and c[RANK_RJ] == 1:
        fixed.append(Group("rocket", RANK_RJ, 1, (RANK_BJ, RANK_RJ)))
        c[RANK_BJ] = c[RANK_RJ] = 0
    for r in range(RANK_BJ):
        if c[r] == 4:
            fixed.append(Group("bomb", r, 1, (r,) * 4))
            c[r] = 0
    cost, groups = _search(tuple(c), (-1, -1, -1), ())
    return cost + sum(group_cost(g) for g in fixed), tuple(fixed) + groups


@lru_cache(maxsize=200_000)
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
    if unseen[RANK_BJ] == 1 and unseen[RANK_RJ] == 1 and max_cards >= 2:
        return True
    for r in range(RANK_BJ):
        if unseen[r] == 4 and max_cards >= 4 and (g.type != "bomb" or r > g.main):
            return True
    return False


class Smart3Bot(Bot):
    games = ("ddz",)
    default_game = "ddz"

    #: bid when the 17-card hand strength reaches these values (see :meth:`strength`)
    BID_THRESHOLDS = ((3, 0.0), (2, -1.0), (1, -2.0))
    #: decomposition damage accepted to beat an opponent: landlord, farmer, the farmer
    #: just before the landlord (the last one who can stop it)
    LANDLORD_DAMAGE = 0.4
    FARMER_DAMAGE = 0.1
    LAST_FARMER_DAMAGE = 0.6
    #: beat at any cost (bombs included) when the player to beat has <= this many cards,
    #: or any opponent has <= DANGER_OPP
    DANGER_PLAYER = 4
    DANGER_OPP = 3
    #: a farmer bombs the landlord once the landlord has <= this many cards
    FARMER_BOMB_AT = 10
    #: bomb when the rest of the hand then costs <= this
    BOMB_REST_COST = 1.0
    #: when leading and an opponent has <= this many cards, lead what they cannot beat
    LEAD_GUARD = 2
    #: the farmer before the landlord tops up the other farmer's single / pair below this
    #: rank (-1: never) when that does not hurt its own hand
    TOP_UP_BELOW = 8

    # ------------------------------------------------------------------ bidding
    @staticmethod
    def strength(hand: Sequence[str]) -> float:
        """Higher is stronger: control cards minus how many weak groups the hand has."""
        c = rank_counts(hand)
        cost, groups = decompose(tuple(c))
        ctrl = 2 * c[RANK_RJ] + 1.5 * c[RANK_BJ] + c[RANK_2] + 0.5 * c[RANK_A]
        ctrl += 2 * sum(1 for g in groups if g.type == "bomb")
        ctrl += 2 * sum(1 for g in groups if g.type == "rocket")
        return ctrl - cost

    def on_bid(self, state: GameState) -> int:
        s = self.strength(state.hand)
        for bid, threshold in self.BID_THRESHOLDS:
            if s >= threshold:
                return bid if bid > state.high_bid else 0
        return 0

    # ------------------------------------------------------------------ playing
    def on_play(self, state: GameState):
        moves = state.legal_moves()
        if not moves:
            return []
        for m in moves:
            if len(m.cards) == len(state.hand):
                return m
        ctx = _Ctx(self, state)
        if state.leading:
            return ctx.lead()
        return ctx.follow(moves)


class _Ctx:
    """Everything one decision needs: hand, unseen cards, sides and card counts."""

    def __init__(self, bot: "Smart3Bot", st: GameState):
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
            self.opps = [s for s in range(3) if s != self.me]
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
            for p in identify(cards)
        ):
            pats = identify(cards)
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
        # An opponent close to going out: lead what they cannot beat (too many cards for
        # them, or nothing unseen beats it); else the strongest group.
        if self.opp_min <= self.bot.LEAD_GUARD:
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
            # Top up the other farmer's low single / pair just before the landlord plays.
            tb = st.to_beat_pattern
            if (
                scored
                and st.next_seat() == self.landlord
                and tb is not None
                and tb.type in ("single", "pair")
                and tb.main < self.bot.TOP_UP_BELOW
                and scored[0][0] <= 0
            ):
                return scored[0][1]
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
    Smart3Bot().run(args.base, token, args.room, max_games=args.games)


if __name__ == "__main__":
    main()
