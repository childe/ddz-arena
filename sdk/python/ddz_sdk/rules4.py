"""Rules of 4-player Dou Dizhu (``game: "ddz4"``), a pure-Python port of the server engine
(``packages/engine/src/ddz4/patterns4.ts`` and ``moves4.ts``).

Differences from the 3-player rules in :mod:`ddz_sdk.rules`:

* Two decks (108 cards): hands and plays are multisets, e.g. ``["3S", "3S"]`` is a pair.
* ``BJ BJ`` and ``RJ RJ`` are pairs; ``BJ RJ`` is nothing.
* Bombs have 4-8 cards of one rank (``Pattern.length`` = number of cards); the rocket is all
  four jokers (``length`` 4). Order: rocket > 8 cards > 7 > 6 > 5 > 4; same size by rank.
* No four-with-two patterns.
* Wings never contain a body rank and are never all four jokers. Pair wings are pairs of
  distinct ranks (``BJ BJ`` / ``RJ RJ`` allowed, not both); single wings may repeat a rank.

:class:`~ddz_sdk.rules.Pattern`, :class:`~ddz_sdk.rules.Move` and
:class:`~ddz_sdk.rules.RuleError` are shared with the 3-player module.

Main functions: :func:`identify4`, :func:`beats4`, :func:`resolve4`, :func:`legal_moves4`,
:func:`is_legal4`.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Sequence

from .cards import (
    RANK_A,
    RANK_BJ,
    RANK_COUNT,
    RANK_LABELS,
    RANK_RJ,
    contains_all,
    rank_counts,
    rank_of,
    sort_cards,
)
from .rules import Move, Pattern, PatternLike, RuleError, _as_pattern, lowest_single

PATTERN_TYPES4 = [
    "single",
    "pair",
    "triple",
    "triple_single",
    "triple_pair",
    "straight",
    "pair_chain",
    "plane",
    "plane_single",
    "plane_pair",
    "bomb",
    "rocket",
]

PATTERN_NAMES4 = {
    "single": "单张",
    "pair": "对子",
    "triple": "三张",
    "triple_single": "三带一",
    "triple_pair": "三带一对",
    "straight": "顺子",
    "pair_chain": "连对",
    "plane": "飞机",
    "plane_single": "飞机带单",
    "plane_pair": "飞机带对",
    "bomb": "炸弹",
    "rocket": "天王炸",
}

HAND_SIZE4 = 25
BOTTOM_SIZE4 = 8
SEATS4 = 4

__all__ = [
    "PATTERN_TYPES4",
    "PATTERN_NAMES4",
    "identify4",
    "preferred4",
    "beats4",
    "resolve4",
    "legal_moves4",
    "lowest_single",
    "is_legal4",
    "describe4",
]


def _runs(counts: List[int], need: int, length: int) -> List[int]:
    """Start ranks of every run of ``length`` consecutive ranks (all <= A) with counts == need."""
    starts = []
    s = 0
    while s + length - 1 <= RANK_A:
        if all(counts[r] == need for r in range(s, s + length)):
            starts.append(s)
        s += 1
    return starts


def identify4(cards: Sequence[str]) -> List[Pattern]:
    """All valid interpretations of ``cards`` as a 4-player pattern (empty list if invalid)."""
    n = len(cards)
    if n == 0:
        return []
    counts = rank_counts(cards)
    distinct = sum(1 for c in counts if c > 0)
    four_jokers = counts[RANK_BJ] == 2 and counts[RANK_RJ] == 2
    out: List[Pattern] = []

    def rank_with(k: int) -> int:
        for i, c in enumerate(counts):
            if c == k:
                return i
        return -1

    if n == 1:
        return [Pattern("single", rank_with(1), 1)]
    if n == 2:
        return [Pattern("pair", rank_with(2), 1)] if distinct == 1 else []
    if n == 3:
        return [Pattern("triple", rank_with(3), 1)] if distinct == 1 else []
    if n == 4 and four_jokers:
        return [Pattern("rocket", RANK_RJ, 4)]
    if distinct == 1 and n <= 8:
        # 4-8 of one non-joker rank (jokers have at most 2 copies).
        return [Pattern("bomb", rank_with(n), n)]
    if n == 4:
        if distinct == 2 and 3 in counts:
            return [Pattern("triple_single", rank_with(3), 1)]
        return []
    if n == 5 and distinct == 2 and 3 in counts and 2 in counts:
        out.append(Pattern("triple_pair", rank_with(3), 1))

    if n >= 5 and distinct == n:
        s = _runs(counts, 1, n)
        if s:
            out.append(Pattern("straight", s[0], n))
    if n >= 6 and n % 2 == 0 and distinct == n // 2:
        s = _runs(counts, 2, n // 2)
        if s:
            out.append(Pattern("pair_chain", s[0], n // 2))
    if n >= 6 and n % 3 == 0 and distinct == n // 3:
        s = _runs(counts, 3, n // 3)
        if s:
            out.append(Pattern("plane", s[0], n // 3))
    # Plane + single wings: body ranks have exactly 3 cards; kickers may repeat a rank but
    # may not be all four jokers.
    if n >= 8 and n % 4 == 0 and not four_jokers:
        k = n // 4
        for s in _runs(counts, 3, k):
            out.append(Pattern("plane_single", s, k))
    # Plane + pair wings: k pairs of k different ranks (BJ BJ / RJ RJ allowed, not both).
    if n >= 10 and n % 5 == 0 and not four_jokers:
        k = n // 5
        for s in _runs(counts, 3, k):
            ok = True
            for r in range(len(counts)):
                if s <= r < s + k:
                    continue
                if counts[r] != 0 and counts[r] != 2:
                    ok = False
                    break
            if ok:
                out.append(Pattern("plane_pair", s, k))
    return out


def _body_size(p: Pattern) -> int:
    t = p.type
    if t == "rocket":
        return 100
    if t == "bomb":
        return 99
    if t in ("plane", "plane_single", "plane_pair"):
        return p.length * 3
    if t == "pair_chain":
        return p.length * 2
    if t == "straight":
        return p.length
    return 3


def preferred4(patterns: Sequence[Pattern]) -> Optional[Pattern]:
    """Interpretation used when leading: biggest main body first, then highest main rank."""
    if not patterns:
        return None
    return sorted(patterns, key=lambda p: (-_body_size(p), -p.main))[0]


def beats4(a: PatternLike, b: PatternLike) -> bool:
    """True if pattern ``a`` beats ``b`` (``b`` is the play on the table).

    rocket > 8-card bomb > ... > 4-card bomb (same size: higher rank); any bomb beats every
    non-bomb.
    """
    a = _as_pattern(a)
    b = _as_pattern(b)
    if a is None:
        return False
    if b is None:
        return True
    if b.type == "rocket":
        return False
    if a.type == "rocket":
        return True
    if a.type == "bomb":
        if b.type != "bomb":
            return True
        return a.length > b.length or (a.length == b.length and a.main > b.main)
    if a.type != b.type or a.length != b.length:
        return False
    return a.main > b.main


def describe4(p: Pattern) -> str:
    r = RANK_LABELS[p.main]
    return (
        "%s(%sx%d)" % (p.type, r, p.length) if p.length > 1 else "%s(%s)" % (p.type, r)
    )


def resolve4(
    cards: Sequence[str], last: PatternLike = None, hint: Optional[str] = None
) -> Pattern:
    """Pick the interpretation the server would use for ``cards`` in a ddz4 game.

    With ``last`` (the pattern to beat) choose an interpretation that beats it; with
    ``hint`` restrict to that type. Raises :class:`~ddz_sdk.rules.RuleError` on failure.
    """
    last = _as_pattern(last)
    allp = identify4(cards)
    if hint:
        allp = [p for p in allp if p.type == hint]
    if not allp:
        raise RuleError(
            "INVALID_PATTERN",
            (
                "cards do not form a %s" % hint
                if hint
                else "cards do not form a valid pattern"
            ),
        )
    if last is None:
        return preferred4(allp)  # type: ignore[return-value]
    winners = [p for p in allp if beats4(p, last)]
    if not winners:
        raise RuleError(
            "CANNOT_BEAT",
            "%s cannot beat %s" % (describe4(allp[0]), describe4(last)),
        )
    return preferred4(winners)  # type: ignore[return-value]


def _each_multiset(avail: List[int], k: int, cb: Callable[[List[int]], None]) -> None:
    """Call ``cb`` with every multiset of size k (ascending ranks); avail[r] = units of rank r."""
    cur: List[int] = []

    def rec(start: int, left: int) -> None:
        if left == 0:
            cb(cur)
            return
        for r in range(start, len(avail)):
            if avail[r] <= 0:
                continue
            avail[r] -= 1
            cur.append(r)
            rec(r, left - 1)
            cur.pop()
            avail[r] += 1

    rec(0, k)


def _each_combination(
    items: List[int], k: int, cb: Callable[[List[int]], None]
) -> None:
    """Call ``cb`` with every k-subset of ``items`` (in order)."""
    cur: List[int] = []

    def rec(start: int) -> None:
        if len(cur) == k:
            cb(cur)
            return
        for i in range(start, len(items) - (k - len(cur)) + 1):
            cur.append(items[i])
            rec(i + 1)
            cur.pop()

    rec(0)


def legal_moves4(hand: Sequence[str], last: PatternLike = None) -> List[Move]:
    """Every distinct legal play from a ddz4 ``hand`` (by rank multiset; lowest suits chosen).

    With ``last`` only plays that beat it are returned. Passing is never included.
    """
    last = _as_pattern(last)
    c = rank_counts(hand)
    by_rank: List[List[str]] = [[] for _ in range(RANK_COUNT)]
    for card in sort_cards(hand):
        by_rank[rank_of(card)].append(card)
    found: Dict[str, Move] = {}

    def add(t: str, main: int, length: int, ranks: List[int]) -> None:
        """``ranks`` must be ascending."""
        pattern = Pattern(t, main, length)
        if last is not None and not beats4(pattern, last):
            return
        key = "%s:%d:%s" % (t, main, ",".join(map(str, ranks)))
        if key in found:
            return
        cards: List[str] = []
        i = 0
        while i < len(ranks):
            r = ranks[i]
            j = i
            while j < len(ranks) and ranks[j] == r:
                j += 1
            cards.extend(by_rank[r][: j - i])
            i = j
        # Guard against generator/identifier drift: must identify as this exact pattern.
        if not any(
            p.type == t and p.main == main and p.length == length
            for p in identify4(cards)
        ):
            return
        found[key] = Move(cards, pattern)

    def want(t: str) -> bool:
        return last is None or last.type == t or t in ("bomb", "rocket")

    def chain_len(t: str, ln: int) -> bool:
        return last is None or last.type != t or last.length == ln

    for r in range(len(c)):
        n = c[r]
        if n >= 1 and want("single"):
            add("single", r, 1, [r])
        if n >= 2 and want("pair"):
            add("pair", r, 1, [r] * 2)
        if n >= 3 and want("triple"):
            add("triple", r, 1, [r] * 3)
        if r < RANK_BJ and want("bomb"):
            for k in range(4, n + 1):
                add("bomb", r, k, [r] * k)
    if c[RANK_BJ] == 2 and c[RANK_RJ] == 2:
        add("rocket", RANK_RJ, 4, [RANK_BJ, RANK_BJ, RANK_RJ, RANK_RJ])

    for t in range(RANK_BJ):
        if c[t] < 3:
            continue
        if want("triple_single"):
            for k in range(len(c)):
                if k != t and c[k] >= 1:
                    add("triple_single", t, 1, sorted([t] * 3 + [k]))
        if want("triple_pair"):
            for p in range(len(c)):
                if p != t and c[p] >= 2:
                    add("triple_pair", t, 1, sorted([t] * 3 + [p, p]))

    def chains(need: int, min_len: int, max_len: int):
        for ln in range(min_len, max_len + 1):
            s = 0
            while s + ln - 1 <= RANK_A:
                if all(c[r] >= need for r in range(s, s + ln)):
                    yield s, ln
                s += 1

    def chain_ranks(s: int, ln: int, times: int) -> List[int]:
        out: List[int] = []
        for r in range(s, s + ln):
            out.extend([r] * times)
        return out

    if want("straight"):
        for s, ln in chains(1, 5, 12):
            if chain_len("straight", ln):
                add("straight", s, ln, chain_ranks(s, ln, 1))
    if want("pair_chain"):
        for s, ln in chains(2, 3, 12):
            if chain_len("pair_chain", ln):
                add("pair_chain", s, ln, chain_ranks(s, ln, 2))
    if want("plane"):
        for s, ln in chains(3, 2, 12):
            if chain_len("plane", ln):
                add("plane", s, ln, chain_ranks(s, ln, 3))

    if want("plane_single"):
        for s, ln in list(chains(3, 2, 12)):
            if not chain_len("plane_single", ln) or len(hand) < ln * 4:
                continue
            body = chain_ranks(s, ln, 3)
            avail = [0 if s <= r < s + ln else n for r, n in enumerate(c)]

            def on_kick(kick: List[int], s=s, ln=ln, body=body) -> None:
                if ln >= 4 and sum(1 for r in kick if r >= RANK_BJ) == 4:
                    return
                add("plane_single", s, ln, sorted(body + kick))

            _each_multiset(avail, ln, on_kick)
    if want("plane_pair"):
        for s, ln in list(chains(3, 2, 12)):
            if not chain_len("plane_pair", ln) or len(hand) < ln * 5:
                continue
            body = chain_ranks(s, ln, 3)
            pair_ranks = [
                r for r in range(len(c)) if (r < s or r >= s + ln) and c[r] >= 2
            ]

            def on_pick(picked: List[int], s=s, ln=ln, body=body) -> None:
                if RANK_BJ in picked and RANK_RJ in picked:
                    return
                add(
                    "plane_pair",
                    s,
                    ln,
                    sorted(body + [x for r in picked for x in (r, r)]),
                )

            _each_combination(pair_ranks, ln, on_pick)
    return list(found.values())


def is_legal4(
    cards: Sequence[str], hand: Sequence[str], last: PatternLike = None
) -> bool:
    """True if ``cards`` is a legal non-pass ddz4 play from ``hand`` against ``last``."""
    if not cards or not contains_all(hand, cards):
        return False
    try:
        resolve4(cards, last)
        return True
    except RuleError:
        return False
