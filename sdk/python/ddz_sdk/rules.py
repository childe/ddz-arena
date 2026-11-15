"""Pure-Python pattern identification and legal-move generation.

This mirrors the server's rules engine (``packages/engine/src/patterns.ts`` and
``moves.ts``) so a bot can compute its own legal moves without calling
``GET /games/{gid}/legal-moves`` (which ranked rooms may disable).

Key types:

* :class:`Pattern` -- ``type``, ``main`` (rank value 0..14 used for comparison) and
  ``length`` (chain length; 1 for non-chains). Convert from/to the API's
  ``{"type", "rank", "length"}`` dict with :meth:`Pattern.from_api` / :meth:`Pattern.to_api`.
* :class:`Move` -- concrete ``cards`` plus their ``pattern``.

Main functions: :func:`identify`, :func:`beats`, :func:`resolve`, :func:`legal_moves`,
:func:`lowest_single`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Union

from .cards import (
    RANK_A,
    RANK_BJ,
    RANK_LABELS,
    RANK_RJ,
    pick_by_ranks,
    rank_counts,
    rank_from_label,
)

PATTERN_TYPES = [
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
    "four_two_single",
    "four_two_pair",
    "bomb",
    "rocket",
]

PATTERN_NAMES = {
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
    "four_two_single": "四带二",
    "four_two_pair": "四带两对",
    "bomb": "炸弹",
    "rocket": "王炸",
}


@dataclass(frozen=True)
class Pattern:
    """A pattern interpretation. ``main`` is a rank value (0=``3`` .. 14=``RJ``)."""

    type: str
    main: int
    length: int = 1

    @property
    def rank(self) -> str:
        """API rank label of ``main`` (e.g. ``"T"``, ``"2"``, ``"RJ"``)."""
        return RANK_LABELS[self.main]

    def to_api(self) -> Dict[str, Any]:
        return {"type": self.type, "rank": self.rank, "length": self.length}

    @classmethod
    def from_api(cls, d: Optional[Dict[str, Any]]) -> Optional["Pattern"]:
        """Parse an API pattern dict (``rank`` may be a label or an int). ``None`` passes through."""
        if not d:
            return None
        r = d.get("rank")
        main = r if isinstance(r, int) else rank_from_label(str(r))
        return cls(d["type"], main, int(d.get("length", 1) or 1))

    def __str__(self) -> str:
        return describe(self)


@dataclass(frozen=True)
class Move:
    cards: List[str]
    pattern: Pattern


PatternLike = Union[Pattern, Dict[str, Any], None]


def _as_pattern(p: PatternLike) -> Optional[Pattern]:
    if p is None or isinstance(p, Pattern):
        return p
    return Pattern.from_api(p)


def _runs(counts: List[int], need: int, exact: bool, length: int) -> List[int]:
    """Start ranks of every run of ``length`` consecutive ranks (all <= A) with counts == / >= need."""
    starts = []
    s = 0
    while s + length - 1 <= RANK_A:
        ok = True
        for r in range(s, s + length):
            c = counts[r]
            if (c != need) if exact else (c < need):
                ok = False
                break
        if ok:
            starts.append(s)
        s += 1
    return starts


def identify(cards: Sequence[str]) -> List[Pattern]:
    """All valid interpretations of ``cards`` as a pattern (empty list if invalid)."""
    n = len(cards)
    if n == 0:
        return []
    counts = rank_counts(cards)
    distinct = sum(1 for c in counts if c > 0)
    out: List[Pattern] = []
    has_rocket = counts[RANK_BJ] == 1 and counts[RANK_RJ] == 1

    def first_rank(k: int) -> int:
        for i, c in enumerate(counts):
            if c == k:
                return i
        return -1

    if n == 1:
        return [Pattern("single", first_rank(1), 1)]
    if n == 2:
        if has_rocket:
            return [Pattern("rocket", RANK_RJ, 1)]
        if distinct == 1:
            return [Pattern("pair", first_rank(2), 1)]
        return []
    if n == 3 and distinct == 1:
        return [Pattern("triple", first_rank(3), 1)]
    if n == 4:
        if distinct == 1:
            return [Pattern("bomb", first_rank(4), 1)]
        if distinct == 2 and 3 in counts:
            return [Pattern("triple_single", first_rank(3), 1)]
        return []
    if n == 5 and distinct == 2 and 3 in counts and 2 in counts:
        out.append(Pattern("triple_pair", first_rank(3), 1))

    if n >= 5 and distinct == n:
        s = _runs(counts, 1, True, n)
        if s:
            out.append(Pattern("straight", s[0], n))
    if n >= 6 and n % 2 == 0 and distinct == n // 2:
        s = _runs(counts, 2, True, n // 2)
        if s:
            out.append(Pattern("pair_chain", s[0], n // 2))
    if n >= 6 and n % 3 == 0 and distinct == n // 3:
        s = _runs(counts, 3, True, n // 3)
        if s:
            out.append(Pattern("plane", s[0], n // 3))
    # plane + single wings: plane ranks must have exactly 3 cards; wings may not be both jokers.
    if n >= 8 and n % 4 == 0:
        k = n // 4
        for s in _runs(counts, 3, True, k):
            if has_rocket:
                break
            out.append(Pattern("plane_single", s, k))
    # plane + pair wings: four of a kind counts as two pairs; jokers can't pair.
    if n >= 10 and n % 5 == 0:
        k = n // 5
        for s in _runs(counts, 3, True, k):
            ok = True
            for r in range(len(counts)):
                if s <= r < s + k:
                    continue
                if counts[r] % 2 != 0 or (r >= RANK_BJ and counts[r] > 0):
                    ok = False
                    break
            if ok:
                out.append(Pattern("plane_pair", s, k))
    if n == 6:
        f = first_rank(4)
        if f >= 0 and not has_rocket:
            out.append(Pattern("four_two_single", f, 1))
    if n == 8:
        for f in range(len(counts)):
            if counts[f] != 4:
                continue
            ok = True
            for r in range(len(counts)):
                if r == f:
                    continue
                if counts[r] % 2 != 0 or (r >= RANK_BJ and counts[r] > 0):
                    ok = False
                    break
            if ok:
                out.append(Pattern("four_two_pair", f, 1))
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
    if t in ("four_two_single", "four_two_pair"):
        return 4
    return 3


def preferred(patterns: Sequence[Pattern]) -> Optional[Pattern]:
    """Interpretation used when leading: biggest main body first, then highest main rank."""
    if not patterns:
        return None
    # Stable sort like the engine: ties keep identify() order.
    return sorted(patterns, key=lambda p: (-_body_size(p), -p.main))[0]


def beats(a: PatternLike, b: PatternLike) -> bool:
    """True if pattern ``a`` beats ``b`` (``b`` is the play on the table)."""
    a = _as_pattern(a)
    b = _as_pattern(b)
    if a is None:
        return False
    if b is None:
        return True
    if a.type == "rocket":
        return True
    if b.type == "rocket":
        return False
    if a.type == "bomb" and b.type != "bomb":
        return True
    if a.type != b.type or a.length != b.length:
        return False
    return a.main > b.main


class RuleError(ValueError):
    """Raised by :func:`resolve` with ``code`` ``INVALID_PATTERN`` or ``CANNOT_BEAT``."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def resolve(
    cards: Sequence[str], last: PatternLike = None, hint: Optional[str] = None
) -> Pattern:
    """Pick the interpretation the server would use for ``cards``.

    With ``last`` (the pattern to beat) choose an interpretation that beats it; with
    ``hint`` restrict to that type. Raises :class:`RuleError` on failure.
    """
    last = _as_pattern(last)
    allp = identify(cards)
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
        return preferred(allp)  # type: ignore[return-value]
    winners = [p for p in allp if beats(p, last)]
    if not winners:
        raise RuleError(
            "CANNOT_BEAT", "%s cannot beat %s" % (describe(allp[0]), describe(last))
        )
    return preferred(winners)  # type: ignore[return-value]


def describe(p: Pattern) -> str:
    r = RANK_LABELS[p.main]
    return (
        "%s(%sx%d)" % (p.type, r, p.length)
        if p.length > 1
        else "%s(%s)"
        % (
            p.type,
            r,
        )
    )


def _multisets(avail: List[int], k: int, start: int = 0) -> List[List[int]]:
    """All multisets of size k from ranks where avail[r] = units rank r can contribute."""
    if k == 0:
        return [[]]
    out: List[List[int]] = []
    for r in range(start, len(avail)):
        if avail[r] <= 0:
            continue
        avail[r] -= 1
        for rest in _multisets(avail, k - 1, r):
            out.append([r] + rest)
        avail[r] += 1
    return out


def legal_moves(hand: Sequence[str], last: PatternLike = None) -> List[Move]:
    """Every distinct legal play from ``hand`` (by rank multiset; lowest suits chosen).

    With ``last`` (a :class:`Pattern` or API pattern dict) only plays that beat it are
    returned. Passing is never included -- check ``can_pass`` separately.
    """
    last = _as_pattern(last)
    c = rank_counts(hand)
    found: Dict[str, Move] = {}

    def add(t: str, main: int, length: int, ranks: List[int]) -> None:
        pattern = Pattern(t, main, length)
        if last is not None and not beats(pattern, last):
            return
        srt = sorted(ranks)
        key = "%s:%d:%s" % (t, main, ",".join(map(str, srt)))
        if key in found:
            return
        cards = pick_by_ranks(hand, srt)
        if not any(
            p.type == t and p.main == main and p.length == length
            for p in identify(cards)
        ):
            return
        found[key] = Move(cards, pattern)

    def want(t: str) -> bool:
        return last is None or last.type == t or t in ("bomb", "rocket")

    def chain_len(t: str, ln: int) -> bool:
        return last is None or last.type != t or last.length == ln

    def rep(r: int, n: int) -> List[int]:
        return [r] * n

    for r in range(len(c)):
        n = c[r]
        if n >= 1 and want("single"):
            add("single", r, 1, [r])
        if n >= 2 and r < RANK_BJ and want("pair"):
            add("pair", r, 1, rep(r, 2))
        if n >= 3 and want("triple"):
            add("triple", r, 1, rep(r, 3))
        if n == 4 and want("bomb"):
            add("bomb", r, 1, rep(r, 4))
    if c[RANK_BJ] == 1 and c[RANK_RJ] == 1:
        add("rocket", RANK_RJ, 1, [RANK_BJ, RANK_RJ])

    for t in range(len(c)):
        if c[t] < 3:
            continue
        if want("triple_single"):
            for k in range(len(c)):
                if k != t and c[k] >= 1:
                    add("triple_single", t, 1, rep(t, 3) + [k])
        if want("triple_pair"):
            for p in range(RANK_BJ):
                if p != t and c[p] >= 2:
                    add("triple_pair", t, 1, rep(t, 3) + [p, p])

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
            out.extend(rep(r, times))
        return out

    if want("straight"):
        for s, ln in chains(1, 5, 12):
            if chain_len("straight", ln):
                add("straight", s, ln, chain_ranks(s, ln, 1))
    if want("pair_chain"):
        for s, ln in chains(2, 3, 10):
            if chain_len("pair_chain", ln):
                add("pair_chain", s, ln, chain_ranks(s, ln, 2))
    if want("plane"):
        for s, ln in chains(3, 2, 6):
            if chain_len("plane", ln):
                add("plane", s, ln, chain_ranks(s, ln, 3))
    if want("plane_single"):
        for s, ln in chains(3, 2, 5):
            if not chain_len("plane_single", ln) or len(hand) < ln * 4:
                continue
            avail = [0 if s <= r < s + ln else n for r, n in enumerate(c)]
            for kick in _multisets(avail, ln):
                add("plane_single", s, ln, chain_ranks(s, ln, 3) + kick)
    if want("plane_pair"):
        for s, ln in chains(3, 2, 4):
            if not chain_len("plane_pair", ln) or len(hand) < ln * 5:
                continue
            avail = [
                0 if (s <= r < s + ln) or r >= RANK_BJ else n // 2
                for r, n in enumerate(c)
            ]
            for kick in _multisets(avail, ln):
                add(
                    "plane_pair",
                    s,
                    ln,
                    chain_ranks(s, ln, 3) + [x for r in kick for x in (r, r)],
                )
    for f in range(len(c)):
        if c[f] != 4:
            continue
        if want("four_two_single"):
            avail = [0 if r == f else n for r, n in enumerate(c)]
            for kick in _multisets(avail, 2):
                add("four_two_single", f, 1, rep(f, 4) + kick)
        if want("four_two_pair"):
            avail = [0 if (r == f or r >= RANK_BJ) else n // 2 for r, n in enumerate(c)]
            for kick in _multisets(avail, 2):
                add(
                    "four_two_pair", f, 1, rep(f, 4) + [x for r in kick for x in (r, r)]
                )
    return list(found.values())


def lowest_single(hand: Sequence[str]) -> List[str]:
    """The lowest single card in ``hand`` (what the server plays for a timed-out leader)."""
    c = rank_counts(hand)
    for r, n in enumerate(c):
        if n > 0:
            return pick_by_ranks(hand, [r])
    return []


def is_legal(
    cards: Sequence[str], hand: Sequence[str], last: PatternLike = None
) -> bool:
    """True if ``cards`` is a legal non-pass play from ``hand`` against ``last``."""
    from .cards import contains_all

    if not cards or not contains_all(hand, cards):
        return False
    try:
        resolve(cards, last)
        return True
    except RuleError:
        return False
