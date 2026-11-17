"""Rule-based Guandan bot (``game: "guandan"``): the smart3/smart4 design adapted to Guandan.

* Decomposition: bombs (4-8 of a rank), the rocket and one straight flush are taken first,
  then fixed-length chains (5-card straights, 3-pair 木板, 2-triple 钢板) are searched, and
  the rest becomes triples with a pair (三带二), triples, pairs and singles. Each wildcard
  (逢人配) is tried on the ranks where it helps (completing a bomb, a triple, a straight
  gap) or kept as a level card; the cheapest split wins. A group costs ``1 - control``;
  bombs cost less than nothing.
* Card counting: unseen cards (not ours, not played) decide whether a group is a "boss"
  that the opponents cannot beat without a bomb.
* Leading: finish with bosses when at most one weak group is left; feed a partner who is
  about to go out; when an opponent is close to going out lead what they cannot beat;
  otherwise lead the weakest group, longest first.
* Following: never beat the partner unless that lets us finish. Against an opponent, play
  the move that hurts the split least if the damage is under a threshold; the threshold is
  higher when the partner has already had its chance in this trick and when an opponent is
  close to going out. Bombs only to finish, to stop an opponent or when the rest is strong.
* Return (还贡): give back the returnable card whose loss hurts the split least.

Usage:
    python smart/smart_gd_bot.py --base http://localhost:8080 --token TOKEN [--room r_xxx]
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from functools import lru_cache
from itertools import combinations_with_replacement
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ddz_sdk import GuandanBot, GuandanState, Move, register_bot  # noqa: E402
from ddz_sdk.rules import RuleError  # noqa: E402
from ddz_sdk.rules_gd import (  # noqa: E402
    BOMB_TYPES,
    NAT_A,
    NAT_BJ,
    NAT_RANKS,
    NAT_RJ,
    SEQ_LABELS,
    GdPattern,
    level_index,
    resolve_gd,
)

SUITS = "SHCD"
#: copies of each natural rank in two decks (2..A: 8, BJ: 2, RJ: 2)
TOTAL = (8,) * 13 + (2, 2)
#: (type, cards per rank, exact length) of sequence patterns
CHAINS = (("plane", 3, 2), ("pair_chain", 2, 3), ("straight", 1, 5))
SEQ_TYPES = ("straight", "pair_chain", "plane", "straight_flush")
#: single value of the ace / the level card (see ddz_sdk.rules_gd)
VALUE_A = 11
VALUE_LEVEL = 12


def nat_of(card: str) -> int:
    if card == "BJ":
        return NAT_BJ
    if card == "RJ":
        return NAT_RJ
    return NAT_RANKS.index(card[0])


def seq_nat(pos: int) -> int:
    """Natural rank at sequence position ``pos`` (0 = low ace, 13 = high ace)."""
    return NAT_A if pos == 0 else pos - 1


def value(nat: int, lv: int) -> int:
    """Single value of a natural rank at level index ``lv`` (level 12, BJ 13, RJ 14)."""
    if nat >= NAT_BJ:
        return nat
    if nat == lv:
        return VALUE_LEVEL
    return nat if nat < lv else nat - 1


@dataclass(frozen=True)
class Group:
    """One planned play. ``nats`` is the natural-rank multiset (wildcards counted on the rank
    they stand for); ``top`` is the single value (or the top sequence position for chains).
    """

    type: str
    top: int
    nats: Tuple[int, ...]
    suit: Optional[str] = None  # straight flushes only

    @property
    def size(self) -> int:
        return len(self.nats)


def group_cost(g: Group) -> float:
    """1 for a weak group, less for strong ones, below zero for bombs."""
    if g.type == "rocket":
        return -1.6
    if g.type == "straight_flush":
        return -0.9
    if g.type == "bomb":
        return -0.6 - 0.2 * (g.size - 4)
    if g.type in SEQ_TYPES:
        return 1.0 - 0.6 * min(1.0, max(0.0, (g.top - 9) / 4))
    return 1.0 - min(1.0, max(0.0, (g.top - 8) / 6))


# ---------------------------------------------------------------- decomposition
# Kept small: an entry costs ~1.5 KB and few hits come from earlier decisions.
@lru_cache(maxsize=20_000)
def _search(
    c: Tuple[int, ...], lv: int, after: Tuple[int, int]
) -> Tuple[float, Tuple[Group, ...]]:
    """Cheapest split of counts ``c`` (no bombs, no rocket): chains in canonical order
    ``> after``, then :func:`_leaf`."""
    best = _leaf(c, lv)
    for ti, (t, need, ln) in enumerate(CHAINS):
        for s in range(0, 14 - ln + 1):
            if (ti, s) <= after:
                continue
            nats = [seq_nat(p) for p in range(s, s + ln)]
            if any(c[n] < need for n in nats):
                continue
            rest = list(c)
            for n in nats:
                rest[n] -= need
            g = Group(
                t, s + ln - 1, tuple(sorted(n for n in nats for _ in range(need)))
            )
            sub_cost, sub = _search(tuple(rest), lv, (ti, s))
            if sub_cost + group_cost(g) < best[0] - 1e-9:
                best = (sub_cost + group_cost(g), sub + (g,))
    return best


def _leaf(c: Tuple[int, ...], lv: int) -> Tuple[float, Tuple[Group, ...]]:
    """Leftover counts (<= 3, jokers <= 2) as triples with a pair, triples, pairs, singles."""
    by_value = sorted(range(len(c)), key=lambda n: value(n, lv))
    triples = [n for n in by_value if c[n] == 3]
    pairs = [n for n in by_value if c[n] == 2]
    singles = [n for n in by_value if c[n] == 1]
    groups: List[Group] = []
    for t in triples:
        weak = [p for p in pairs if value(p, lv) < VALUE_A]
        if weak:
            pairs.remove(weak[0])
            groups.append(
                Group(
                    "triple_pair",
                    value(t, lv),
                    tuple(sorted((t, t, t, weak[0], weak[0]))),
                )
            )
        else:
            groups.append(Group("triple", value(t, lv), (t, t, t)))
    groups += [Group("pair", value(n, lv), (n, n)) for n in pairs]
    groups += [Group("single", value(n, lv), (n,)) for n in singles]
    return sum(group_cost(g) for g in groups), tuple(groups)


def _bombs(c: List[int], lv: int) -> List[Group]:
    """Take the rocket and bombs (4+ of a rank) out of ``c`` in place."""
    out: List[Group] = []
    if c[NAT_BJ] == 2 and c[NAT_RJ] == 2:
        out.append(Group("rocket", 14, (NAT_BJ, NAT_BJ, NAT_RJ, NAT_RJ)))
        c[NAT_BJ] = c[NAT_RJ] = 0
    for n in range(13):
        if c[n] >= 4:
            k = min(c[n], 8)
            out.append(Group("bomb", value(n, lv), (n,) * k))
            c[n] -= k
    return out


def wild_targets(c: Sequence[int], lv: int) -> List[int]:
    """Ranks a wildcard may usefully stand for: the level itself (kept), ranks with 2+ cards
    (to make a triple or a bomb) and single-rank gaps between held ranks (straights)."""
    out = {lv}
    for n in range(13):
        if c[n] >= 2:
            out.add(n)
    for p in range(1, 13):
        n, lo, hi = seq_nat(p), seq_nat(p - 1), seq_nat(p + 1)
        if c[n] == 0 and c[lo] and c[hi]:
            out.add(n)
    return sorted(out)


def decompose(
    counts: Sequence[int], wilds: int, lv: int
) -> Tuple[float, Tuple[Group, ...]]:
    """Cheapest split of natural counts plus ``wilds`` wildcards."""
    best: Tuple[float, Tuple[Group, ...]] = (1e9, ())
    for assign in combinations_with_replacement(wild_targets(counts, lv), wilds):
        c = list(counts)
        for n in assign:
            c[n] += 1
        fixed = _bombs(c, lv)
        cost, groups = _search(tuple(c), lv, (-1, -1))
        cost += sum(group_cost(g) for g in fixed)
        if cost < best[0]:
            best = (cost, tuple(fixed) + groups)
    return best


def straight_flushes(
    hand: Sequence[str], wild: str, lv: int
) -> List[Tuple[Group, List[str]]]:
    """Straight flushes in ``hand`` (up to the wildcards held), with the cards they use."""
    wilds = sum(1 for x in hand if x == wild)
    have = {x for x in hand if x != wild}
    out = []
    for suit in SUITS:
        for s in range(0, 10):
            need, cards = 0, []
            for p in range(s, s + 5):
                code = NAT_RANKS[seq_nat(p)] + suit
                if code in have:
                    cards.append(code)
                else:
                    need += 1
            if (
                need <= wilds and need <= 1
            ):  # spending both wildcards on one is rarely right
                cards += [wild] * need
                nats = tuple(sorted(seq_nat(p) for p in range(s, s + 5)))
                out.append((Group("straight_flush", s + 4, nats, suit), cards))
    return out


# ---------------------------------------------------------------- card counting
def can_beat(
    g: Group, unseen: Sequence[int], flex: int, lv: int, max_cards: int
) -> bool:
    """True if one player with at most ``max_cards`` unseen cards (and up to ``flex`` unseen
    wildcards) could beat ``g`` without a bomb."""
    if g.size > max_cards or g.type in BOMB_TYPES:
        return False
    need = {"single": 1, "pair": 2, "triple": 3, "triple_pair": 3}.get(g.type)
    if need is not None:
        for n in range(len(unseen)):
            if value(n, lv) > g.top and unseen[n] + (flex if n < NAT_BJ else 0) >= need:
                return True
        return False
    for t, k, ln in CHAINS:
        if t == g.type:
            for s in range(g.top - ln + 2, 14 - ln + 1):
                short = sum(max(0, k - unseen[seq_nat(p)]) for p in range(s, s + ln))
                if short <= flex:
                    return True
    return False


class SmartGuandanBot(GuandanBot):
    #: decomposition damage accepted to beat an opponent: when the partner can still answer
    #: in this trick, and when we are the last of our team who can
    EARLY_DAMAGE = 0.1
    LAST_DAMAGE = 0.6
    #: beat at any cost (bombs included) when the player to beat has <= this many cards, or
    #: any opponent has <= DANGER_OPP
    DANGER_PLAYER = 9
    DANGER_OPP = 6
    #: bomb when the rest of the hand then costs <= this
    BOMB_REST_COST = 2.0
    #: when leading and an opponent has <= this many cards, lead what they cannot beat
    LEAD_GUARD = 1

    def on_return(self, state: GuandanState) -> str:
        options = sorted(set(state.returnable_cards()), key=state.value)
        ctx = _Ctx(self, state)
        return min(options, key=lambda x: (ctx.cost_without([x]), state.value(x)))

    def on_play(self, state: GuandanState):
        moves = state.legal_moves()
        if not moves:
            return []
        for m in moves:
            if len(m.cards) == len(state.hand):
                return m
        ctx = _Ctx(self, state)
        if state.leading:
            return ctx.lead(moves)
        return ctx.follow(moves)


class _Ctx:
    """One decision: hand, level, unseen cards, seats and the current split."""

    def __init__(self, bot: SmartGuandanBot, st: GuandanState):
        self.bot = bot
        self.st = st
        self.level = st.level
        self.lv = level_index(st.level)
        self.wild = st.wildcard
        self.counts = [0] * 15
        self.wilds = 0
        for x in st.hand:
            if x == self.wild:
                self.wilds += 1
            else:
                self.counts[nat_of(x)] += 1
        played = [0] * 15
        played_wild = 0
        for h in st.history:
            for x in h.get("cards") or []:
                played[nat_of(x)] += 1
                played_wild += x == self.wild
        mine = [self.counts[n] + (self.wilds if n == self.lv else 0) for n in range(15)]
        self.unseen = [TOTAL[n] - mine[n] - played[n] for n in range(15)]
        self.flex = 2 - self.wilds - played_wild
        self.me = st.seat
        self.partner = (self.me + 2) % 4
        self.opps = [(self.me + 1) % 4, (self.me + 3) % 4]
        self.left = list(st.cards_left)
        live = [self.left[s] for s in self.opps if self.left[s] > 0]
        self.opp_min = min(live) if live else 99
        self.opp_max = max(live) if live else 0
        self.cost, self.groups, self.sf_cards = self.split(st.hand)

    # ---- splitting
    def split(
        self, hand: Sequence[str]
    ) -> Tuple[float, Tuple[Group, ...], Optional[List[str]]]:
        """Best split of ``hand``; tries taking out each straight flush first."""
        counts = [0] * 15
        wilds = 0
        for x in hand:
            if x == self.wild:
                wilds += 1
            else:
                counts[nat_of(x)] += 1
        best = decompose(counts, wilds, self.lv) + (None,)
        for g, cards in straight_flushes(hand, self.wild, self.lv):
            c = list(counts)
            w = wilds
            for x in cards:
                if x == self.wild:
                    w -= 1
                else:
                    c[nat_of(x)] -= 1
            # Do not break a bomb for a straight flush.
            if any(counts[n] >= 4 and c[n] < 4 for n in range(13)):
                continue
            cost, groups = decompose(c, w, self.lv)
            cost += group_cost(g)
            if cost < best[0]:
                best = (cost, (g,) + groups, cards)
        return best

    def cost_without(self, cards: Sequence[str]) -> float:
        rest = list(self.st.hand)
        for x in cards:
            rest.remove(x)
        return self.split(rest)[0] if rest else -5.0

    def groups_without(self, cards: Sequence[str]) -> Tuple[float, Tuple[Group, ...]]:
        rest = list(self.st.hand)
        for x in cards:
            rest.remove(x)
        if not rest:
            return -5.0, ()
        cost, groups, _ = self.split(rest)
        return cost, groups

    # ---- helpers
    def is_boss(self, g: Group) -> bool:
        return not can_beat(g, self.unseen, self.flex, self.lv, self.opp_max)

    def weak(self, groups: Sequence[Group]) -> List[Group]:
        return [g for g in groups if g.type not in BOMB_TYPES and not self.is_boss(g)]

    def can_finish(self, groups: Sequence[Group]) -> bool:
        return len(self.weak(groups)) <= 1

    def to_move(self, g: Group, moves: List[Move]) -> Move:
        """Concrete cards for ``g`` (natural cards first, wildcards for the rest)."""
        if g.type == "straight_flush" and self.sf_cards:
            cards = list(self.sf_cards)
        else:
            pool: Dict[int, List[str]] = {}
            for x in self.st.hand:
                if x != self.wild:
                    pool.setdefault(nat_of(x), []).append(x)
            wilds = self.wilds
            cards = []
            for n in g.nats:
                if pool.get(n):
                    cards.append(pool[n].pop(0))
                elif wilds:
                    cards.append(self.wild)
                    wilds -= 1
        if g.type in SEQ_TYPES:
            rank = SEQ_LABELS[g.top]
        elif g.type == "rocket":
            rank = "RJ"
        else:
            rank = (
                "BJ"
                if g.top == 13
                else "RJ" if g.top == 14 else NAT_RANKS[_nat_of_value(g.top, self.lv)]
            )
        try:
            p = resolve_gd(cards, None, self.level, {"type": g.type, "rank": rank})
            return Move(cards, p)
        except (RuleError, ValueError):
            # Should not happen; fall back to the weakest legal move of that type.
            same = [m for m in moves if m.pattern.type == g.type] or moves
            return min(same, key=lambda m: (m.pattern.main, len(m.cards)))

    # ---- leading
    def lead(self, moves: List[Move]) -> Move:
        groups = self.groups
        weak = self.weak(groups)
        normal = [g for g in groups if g.type not in BOMB_TYPES]
        if len(weak) <= 1:
            bosses = [g for g in normal if g not in weak]
            if bosses:
                return self.to_move(max(bosses, key=lambda g: (g.size, -g.top)), moves)
            if weak:
                return self.to_move(weak[0], moves)
            bombs = sorted(groups, key=lambda g: (group_cost(g) * -1, g.top))
            return self.to_move(bombs[0], moves)

        # Feed a partner who is about to go out, unless an opponent is closer.
        pl = self.left[self.partner]
        if 0 < pl <= 2 and self.opp_min > 2:
            singles = [
                m
                for m in moves
                if m.pattern.type == "single" and m.cards[0] != self.wild
            ]
            if singles:
                return min(singles, key=lambda m: m.pattern.main)

        pool = weak or normal or list(groups)
        if self.opp_min <= self.bot.LEAD_GUARD:
            safe = [
                g
                for g in normal
                if not can_beat(g, self.unseen, self.flex, self.lv, self.opp_min)
            ]
            if safe:
                return self.to_move(min(safe, key=lambda g: (g.top, -g.size)), moves)
            return self.to_move(max(pool, key=lambda g: (g.size, g.top)), moves)
        return self.to_move(
            min(
                pool,
                key=lambda g: (
                    g.top if g.type not in SEQ_TYPES else g.top - 6,
                    -g.size,
                ),
            ),
            moves,
        )

    # ---- following
    def follow(self, moves: List[Move]) -> Optional[Move]:
        st = self.st
        tb_seat = st.to_beat.get("seat")
        normal = [m for m in moves if m.pattern.type not in BOMB_TYPES]
        bombs = [m for m in moves if m.pattern.type in BOMB_TYPES]
        nw = lambda m: sum(1 for x in m.cards if x == self.wild)  # noqa: E731
        normal.sort(key=lambda m: (nw(m), m.pattern.main, len(m.cards)))
        scored = []
        for m in normal[:30]:
            cost, groups = self.groups_without(m.cards)
            scored.append((cost - self.cost + 0.3 * nw(m), m, groups))
        scored.sort(key=lambda x: (x[0], x[1].pattern.main))

        if tb_seat == self.partner:
            for delta, m, groups in scored:
                if self.can_finish(groups):
                    return m
            return []

        bot = self.bot
        danger = (
            self.left[tb_seat] <= bot.DANGER_PLAYER or self.opp_min <= bot.DANGER_OPP
        )
        if scored:
            delta, m, groups = scored[0]
            if self.can_finish(groups) or danger:
                return m
            # The play came from the opponent after us: our partner has already passed.
            last_chance = tb_seat == self.opps[0] or self.left[self.partner] == 0
            if delta <= (bot.LAST_DAMAGE if last_chance else bot.EARLY_DAMAGE):
                return m
        if bombs:
            bombs.sort(key=lambda m: (nw(m), bomb_rank(m), m.pattern.main))
            b = bombs[0]
            cost, groups = self.groups_without(b.cards)
            if self.can_finish(groups) or danger or cost <= bot.BOMB_REST_COST:
                return b
        return []


def bomb_rank(m: Move) -> int:
    t = m.pattern.type
    if t == "rocket":
        return 9
    if t == "straight_flush":
        return 2
    return {4: 0, 5: 1}.get(m.pattern.length, m.pattern.length - 3)


def _nat_of_value(v: int, lv: int) -> int:
    if v == VALUE_LEVEL:
        return lv
    return v if v < lv else v + 1


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
    SmartGuandanBot().run(
        args.base, token, args.room, max_games=args.games, game="guandan"
    )


if __name__ == "__main__":
    main()
