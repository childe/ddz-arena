"""Rules of Guandan (掼蛋, ``game: "guandan"``) in pure Python, following ``docs/guandan.md``.

Cards use the same codes as the other games (two decks, 108 cards, hands are multisets), but
the order of ranks depends on the current **level** (级牌, ``"2"`` .. ``"A"``):

* **Single value** (singles, pairs, triples, triple+pair, bombs): ``2 < 3 < ... < A``, then the
  level rank is taken out and put above A, then ``BJ``, ``RJ``. Values are integers 0..14:
  the 12 non-level ranks get 0..11 in natural order, the level rank 12, ``BJ`` 13, ``RJ`` 14.
* **Sequence position** (straight, pair chain, plane, straight flush): natural order with the
  ace at both ends, positions 0..13 = ``A(low) 2 3 ... K A(high)``; the level rank stays in its
  natural place, jokers never take part, no wrap-around (``QKA23`` is invalid).
* **Wildcard** (逢人配): the two heart level cards (e.g. ``7H`` when the level is ``7``) can
  stand for any non-joker card. Played alone or only with other level cards they are just
  level cards.

:class:`GdPattern` is a :class:`~ddz_sdk.rules.Pattern` with a different meaning of ``main``:

* ``single`` / ``pair`` / ``triple`` / ``triple_pair`` / ``bomb``: the single value (0..14) of
  the rank (the triple's rank for ``triple_pair``);
* ``straight`` / ``pair_chain`` / ``plane`` / ``straight_flush``: the sequence position of the
  top card (``A2345`` -> 4, ``TJQKA`` -> 13);
* ``rocket`` (four jokers): 14.

``length`` is the number of cards for ``bomb``, 4 for ``rocket`` and 1 otherwise (all chains
have a fixed size). ``pattern.rank`` / ``pattern.to_api()`` give the API form
``{"type", "rank", "length"}`` where ``rank`` is a label (``"2"`` .. ``"A"``, ``"BJ"``,
``"RJ"``; the top card for chains); :meth:`GdPattern.from_api` needs the level to convert back.
Larger ``main`` always means stronger within a type, so ``min(moves, key=lambda m:
m.pattern.main)`` picks the weakest move as in Dou Dizhu.

Main functions: :func:`identify_gd`, :func:`beats_gd`, :func:`resolve_gd`,
:func:`legal_moves_gd`, :func:`is_legal_gd`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from .cards import SUITS, contains_all
from .rules import Move, Pattern, RuleError

#: natural rank order, index 0..12 (``2`` .. ``A``); ``BJ`` is 13, ``RJ`` is 14
NAT_RANKS = "23456789TJQKA"
NAT_A = 12
NAT_BJ = 13
NAT_RJ = 14
#: label of each sequence position 0..13
SEQ_LABELS = "A23456789TJQKA"
#: return (还贡) cards must have a natural rank 2..10
RETURN_RANKS = "23456789T"

PATTERN_TYPES_GD = [
    "single",
    "pair",
    "triple",
    "triple_pair",
    "straight",
    "pair_chain",
    "plane",
    "bomb",
    "straight_flush",
    "rocket",
]

PATTERN_NAMES_GD = {
    "single": "单张",
    "pair": "对子",
    "triple": "三同张",
    "triple_pair": "三带二",
    "straight": "顺子",
    "pair_chain": "木板",
    "plane": "钢板",
    "bomb": "炸弹",
    "straight_flush": "同花顺",
    "rocket": "天王炸",
}

SEQUENCE_TYPES = ("straight", "pair_chain", "plane", "straight_flush")
BOMB_TYPES = ("bomb", "straight_flush", "rocket")

HAND_SIZE_GD = 27
SEATS_GD = 4

__all__ = [
    "PATTERN_TYPES_GD",
    "PATTERN_NAMES_GD",
    "BOMB_TYPES",
    "GdPattern",
    "level_index",
    "card_value",
    "wildcard",
    "is_wildcard",
    "sort_cards_gd",
    "identify_gd",
    "beats_gd",
    "bomb_tier",
    "resolve_gd",
    "legal_moves_gd",
    "is_legal_gd",
    "lowest_single_gd",
    "returnable_cards",
    "describe_gd",
]

LevelLike = Union[str, int]


# ------------------------------------------------------------------ ranks


def level_index(level: LevelLike) -> int:
    """Natural index 0..12 of a level given as a label (``"7"``, ``"T"``, ``"10"``) or index."""
    if isinstance(level, int):
        if 0 <= level <= NAT_A:
            return level
        raise ValueError("invalid level %r" % (level,))
    s = str(level).upper()
    if s == "10":
        s = "T"
    if len(s) != 1 or s not in NAT_RANKS:
        raise ValueError("invalid level %r" % (level,))
    return NAT_RANKS.index(s)


def _nat(card: str) -> int:
    """Natural rank index of a card: 0..12 for ``2``..``A``, 13 ``BJ``, 14 ``RJ``."""
    if card == "BJ":
        return NAT_BJ
    if card == "RJ":
        return NAT_RJ
    if len(card) != 2 or card[1] not in SUITS:
        raise ValueError("invalid card %r" % (card,))
    i = NAT_RANKS.find(card[0])
    if i < 0:
        raise ValueError("invalid card %r" % (card,))
    return i


def _value(nat: int, lv: int) -> int:
    """Single value of a natural rank at level index ``lv``."""
    if nat >= NAT_BJ:
        return nat
    if nat == lv:
        return 12
    return nat if nat < lv else nat - 1


def _nat_of_value(v: int, lv: int) -> int:
    if v >= NAT_BJ:
        return v
    if v == 12:
        return lv
    return v if v < lv else v + 1


def _nat_label(nat: int) -> str:
    return "BJ" if nat == NAT_BJ else "RJ" if nat == NAT_RJ else NAT_RANKS[nat]


def _seq_nat(pos: int) -> int:
    """Natural rank at sequence position ``pos`` (0 and 13 are both the ace)."""
    return NAT_A if pos == 0 else pos - 1


def card_value(card: str, level: LevelLike) -> int:
    """Single value 0..14 of ``card`` at ``level`` (level rank 12, ``BJ`` 13, ``RJ`` 14)."""
    return _value(_nat(card), level_index(level))


def wildcard(level: LevelLike) -> str:
    """Code of the wildcard (heart level card), e.g. ``"7H"`` at level ``7``."""
    return NAT_RANKS[level_index(level)] + "H"


def is_wildcard(card: str, level: LevelLike) -> bool:
    return card == wildcard(level)


def _sort_key(lv: int):
    def key(card: str) -> Tuple[int, int]:
        n = _nat(card)
        return (_value(n, lv), 0 if n >= NAT_BJ else SUITS.index(card[1]))

    return key


def sort_cards_gd(cards: Sequence[str], level: LevelLike) -> List[str]:
    """Sort ascending by single value at ``level``, then suit (S, H, C, D)."""
    return sorted(cards, key=_sort_key(level_index(level)))


# --------------------------------------------------------------- patterns


@dataclass(frozen=True)
class GdPattern(Pattern):
    """A Guandan pattern. ``main`` is a single value or a sequence position (see the module
    docs); ``level`` is the level label needed to turn ``main`` into an API rank label.
    """

    level: str = "2"

    @property
    def rank(self) -> str:
        if self.type in SEQUENCE_TYPES:
            return SEQ_LABELS[self.main]
        if self.type == "rocket":
            return "RJ"
        return _nat_label(_nat_of_value(self.main, level_index(self.level)))

    def to_api(self) -> Dict[str, Any]:
        return {"type": self.type, "rank": self.rank, "length": self.length}

    @classmethod
    def from_api(  # type: ignore[override]
        cls, d: Optional[Dict[str, Any]], level: LevelLike = "2"
    ) -> Optional["GdPattern"]:
        """Parse an API pattern dict at ``level``. ``None`` passes through."""
        if not d:
            return None
        t = d["type"]
        lv = level_index(level)
        label = str(d.get("rank") or "")
        if t == "rocket":
            main = NAT_RJ
        elif t in SEQUENCE_TYPES:
            main = 13 if label == "A" else SEQ_LABELS.index(label)
        elif label in ("BJ", "RJ"):
            main = NAT_BJ if label == "BJ" else NAT_RJ
        else:
            main = _value(level_index(label), lv)
        length = int(d.get("length", 1) or 1)
        if t == "rocket":
            length = 4
        return cls(t, main, length, NAT_RANKS[lv])

    def __str__(self) -> str:
        return describe_gd(self)


PatternLikeGd = Union[Pattern, Dict[str, Any], None]


def _as_gd(p: PatternLikeGd, level: Optional[LevelLike]) -> Optional[Pattern]:
    if p is None or isinstance(p, Pattern):
        return p
    if level is None:
        raise ValueError("level is required to parse an API pattern dict")
    return GdPattern.from_api(p, level)


def describe_gd(p: Pattern) -> str:
    if isinstance(p, GdPattern):
        r = p.rank
    elif p.type in SEQUENCE_TYPES:
        r = SEQ_LABELS[p.main]
    else:
        r = str(p.main)
    return (
        "%s(%sx%d)" % (p.type, r, p.length)
        if p.type == "bomb"
        else "%s(%s)"
        % (
            p.type,
            r,
        )
    )


_BOMB_TIER = {4: 0, 5: 1, 6: 3, 7: 4, 8: 5}


def bomb_tier(p: Pattern) -> int:
    """-1 for non-bombs; else 4-card bomb 0 < 5-card 1 < straight flush 2 < 6-card 3 <
    7-card 4 < 8-card 5 < rocket 6."""
    if p.type == "bomb":
        return _BOMB_TIER.get(p.length, -1)
    if p.type == "straight_flush":
        return 2
    if p.type == "rocket":
        return 6
    return -1


def beats_gd(
    a: PatternLikeGd, b: PatternLikeGd, level: Optional[LevelLike] = None
) -> bool:
    """True if pattern ``a`` beats ``b`` (``b`` is the play on the table).

    ``level`` is only needed when ``a`` or ``b`` is an API dict. Bomb classes beat every
    non-bomb and each other by tier (see :func:`bomb_tier`), then by ``main``; other patterns
    only beat the same type with a larger ``main``.
    """
    a = _as_gd(a, level)
    b = _as_gd(b, level)
    if a is None:
        return False
    if b is None:
        return True
    ta, tb = bomb_tier(a), bomb_tier(b)
    if ta >= 0 or tb >= 0:
        if ta != tb:
            return ta > tb
        return a.type != "rocket" and a.main > b.main
    return a.type == b.type and a.main > b.main


def identify_gd(cards: Sequence[str], level: LevelLike) -> List[GdPattern]:
    """All valid interpretations of ``cards`` at ``level`` (empty list if invalid)."""
    n = len(cards)
    if n == 0:
        return []
    lv = level_index(level)
    lab = NAT_RANKS[lv]
    wild = lab + "H"
    # Only level cards: the wildcards are plain level cards.
    all_level = all(c[0] == lab and c not in ("BJ", "RJ") for c in cards)
    counts = [0] * 15
    w = 0
    suits = set()
    for c in cards:
        if c == wild and not all_level:
            w += 1
            continue
        r = _nat(c)
        counts[r] += 1
        if r < NAT_BJ:
            suits.add(c[1])
    present = [r for r in range(15) if counts[r]]
    out: List[GdPattern] = []
    seen = set()

    def add(t: str, main: int, length: int = 1) -> None:
        k = (t, main, length)
        if k not in seen:
            seen.add(k)
            out.append(GdPattern(t, main, length, lab))

    if n <= 3:
        # Jokers: a single, or a natural pair (BJ BJ / RJ RJ); wildcards never act as jokers.
        if len(present) == 1:
            r = present[0]
            if r < NAT_BJ or n == 1 or (n == 2 and counts[r] == 2):
                add(("single", "pair", "triple")[n - 1], _value(r, lv))
        return out
    jokers = counts[NAT_BJ] + counts[NAT_RJ]
    if n == 4 and counts[NAT_BJ] == 2 and counts[NAT_RJ] == 2:
        add("rocket", NAT_RJ, 4)
        return out
    if n <= 8 and len(present) == 1 and present[0] < NAT_BJ:
        add("bomb", _value(present[0], lv), n)
    if n == 5:
        # triple + pair: non-wild cards of at most two ranks; jokers only as a natural pair.
        cand: List[Tuple[int, int]] = []
        if len(present) == 2:
            a, b = present
            cand = [(a, b), (b, a)]
        elif len(present) == 1 and present[0] < NAT_BJ and counts[present[0]] == 3:
            cand = [(present[0], -1)]  # the pair is two wildcards
        for x, y in cand:
            if x >= NAT_BJ or counts[x] > 3:
                continue
            if y >= 0:
                if counts[y] > 2 or (y >= NAT_BJ and counts[y] != 2):
                    continue
            add("triple_pair", _value(x, lv))
    if jokers == 0 and n in (5, 6):
        for t, g, k in (("straight", 1, 5), ("pair_chain", 2, 3), ("plane", 3, 2)):
            if n != g * k or any(counts[r] > g for r in present):
                continue
            for top in range(k - 1, 14):
                covered = {_seq_nat(q) for q in range(top - k + 1, top + 1)}
                if all(r in covered for r in present):
                    add(t, top)
                    if t == "straight" and len(suits) == 1:
                        add("straight_flush", top)
        # Stable output: interpretations grouped in PATTERN_TYPES_GD order.
        out.sort(key=lambda p: PATTERN_TYPES_GD.index(p.type))
    return out


def _lead_key(p: Pattern) -> Tuple[int, int, int]:
    return (bomb_tier(p), p.main, PATTERN_TYPES_GD.index(p.type))


def preferred_gd(patterns: Sequence[Pattern]) -> Optional[Pattern]:
    """Interpretation used when leading: the biggest bomb class, else the largest ``main``
    (ties between types: the later type in :data:`PATTERN_TYPES_GD`)."""
    if not patterns:
        return None
    return max(patterns, key=_lead_key)


def _hint_parts(hint: Any) -> Tuple[Optional[str], Optional[str]]:
    if hint is None:
        return None, None
    if isinstance(hint, str):
        return hint, None
    if isinstance(hint, Pattern):
        return hint.type, hint.rank
    return hint.get("type"), hint.get("rank")


def resolve_gd(
    cards: Sequence[str],
    last: PatternLikeGd = None,
    level: LevelLike = "2",
    hint: Any = None,
) -> GdPattern:
    """Pick the interpretation the server would use for ``cards`` at ``level``.

    ``hint`` restricts the choice: a type name, an API dict ``{"type", "rank"?}`` or a
    :class:`GdPattern`. Without ``last`` (leading) the preferred interpretation is the biggest
    bomb class, else the largest rank; with ``last`` it is the smallest interpretation that
    beats ``last``. Raises :class:`~ddz_sdk.rules.RuleError` with code ``INVALID_PATTERN``,
    ``PATTERN_MISMATCH`` (the hinted interpretation does not exist) or ``CANNOT_BEAT``.
    """
    last = _as_gd(last, level)
    allp = identify_gd(cards, level)
    if not allp:
        raise RuleError("INVALID_PATTERN", "cards do not form a valid pattern")
    ht, hr = _hint_parts(hint)
    if ht:
        allp = [p for p in allp if p.type == ht and (hr is None or p.rank == hr)]
        if not allp:
            raise RuleError(
                "PATTERN_MISMATCH",
                "cards do not form a %s%s" % (ht, "(%s)" % hr if hr else ""),
            )
    if last is None:
        return preferred_gd(allp)  # type: ignore[return-value]
    winners = [p for p in allp if beats_gd(p, last)]
    if not winners:
        raise RuleError(
            "CANNOT_BEAT",
            "%s cannot beat %s" % (describe_gd(allp[0]), describe_gd(last)),
        )
    return min(winners, key=_lead_key)


def is_legal_gd(
    cards: Sequence[str],
    hand: Sequence[str],
    last: PatternLikeGd = None,
    level: LevelLike = "2",
) -> bool:
    """True if ``cards`` is a legal non-pass play from ``hand`` against ``last``."""
    if not cards or not contains_all(hand, cards):
        return False
    try:
        resolve_gd(cards, last, level)
        return True
    except RuleError:
        return False


# ------------------------------------------------------------ legal moves


def legal_moves_gd(
    hand: Sequence[str], last: PatternLikeGd = None, level: LevelLike = "2"
) -> List[Move]:
    """Every distinct legal play from ``hand`` at ``level`` (passing is never included).

    With ``last`` only plays that beat it are returned. Plays are distinct by pattern and
    concrete cards: natural cards are taken lowest suit first, and every way of using 0, 1 or
    2 wildcards in place of natural cards is listed separately (e.g. ``33`` and ``3`` +
    ``7H``), so a bot can choose whether to spend its wildcards. Straight flushes use real
    suits. Each ``Move.pattern`` is a :class:`GdPattern`; send it as a hint (the bot base class
    does) so the server uses exactly that interpretation.
    """
    lv = level_index(level)
    lab = NAT_RANKS[lv]
    wild = lab + "H"
    last = _as_gd(last, level)
    last_tier = bomb_tier(last) if last is not None else -1
    nw = 0
    by_nat: List[List[str]] = [[] for _ in range(15)]
    by_suit: Dict[str, List[List[str]]] = {s: [[] for _ in range(13)] for s in SUITS}
    for c in sorted(hand, key=_sort_key(lv)):
        if c == wild:
            nw += 1
            continue
        r = _nat(c)
        by_nat[r].append(c)
        if r < NAT_BJ:
            by_suit[c[1]][r].append(c)
    cnt = [len(x) for x in by_nat]
    found: Dict[Tuple[str, int, int, Tuple[str, ...]], Move] = {}

    def add(t: str, main: int, length: int, cards: List[str]) -> None:
        p = GdPattern(t, main, length, lab)
        if last is not None and not beats_gd(p, last):
            return
        key = (t, main, length, tuple(sorted(cards)))
        if key in found:
            return
        found[key] = Move(sort_cards_gd(cards, lv), p)

    def want(t: str) -> bool:
        if last is None:
            return True
        if t in BOMB_TYPES:
            return True
        return last_tier < 0 and last.type == t

    def fills(slots: List[Tuple[int, int]], pool: List[List[str]], min_nat: int):
        """Yield card lists for ``slots`` [(nat, need)], wildcards making up any shortfall
        (at most ``nw`` in total; at least ``min_nat`` natural cards)."""
        res: List[List[str]] = []

        def rec(i: int, used_w: int, acc: List[str]) -> None:
            if i == len(slots):
                if len(acc) >= min_nat:
                    res.append(acc + [wild] * used_w)
                return
            r, need = slots[i]
            have = len(pool[r])
            lo = need if r >= NAT_BJ else max(0, need - (nw - used_w))
            for u in range(min(need, have), lo - 1, -1):
                rec(i + 1, used_w + need - u, acc + pool[r][:u])

        rec(0, 0, [])
        return res

    # single / pair / triple / bomb: one rank; wildcards need at least one natural card,
    # except for the level rank itself (where the wildcard is a plain level card).
    for r in range(13):
        v = _value(r, lv)
        mn = 0 if r == lv else 1
        avail = cnt[r] + nw
        for t, k in (("single", 1), ("pair", 2), ("triple", 3)):
            if avail >= k and want(t):
                for cs in fills([(r, k)], by_nat, mn):
                    add(t, v, 1, cs)
        if want("bomb"):
            for k in range(4, min(8, avail) + 1):
                for cs in fills([(r, k)], by_nat, mn):
                    add("bomb", v, k, cs)
    for r in (NAT_BJ, NAT_RJ):
        if cnt[r] >= 1 and want("single"):
            add("single", r, 1, by_nat[r][:1])
        if cnt[r] == 2 and want("pair"):
            add("pair", r, 1, by_nat[r][:2])
    if cnt[NAT_BJ] == 2 and cnt[NAT_RJ] == 2:
        add("rocket", NAT_RJ, 4, by_nat[NAT_BJ] + by_nat[NAT_RJ])

    if want("triple_pair"):
        for x in range(13):
            if cnt[x] + nw < 3 or cnt[x] == 0:
                continue
            vx = _value(x, lv)
            if last is not None and vx <= last.main:
                continue
            for y in range(15):
                if y == x or cnt[y] + (0 if y >= NAT_BJ else nw) < 2:
                    continue
                for cs in fills([(x, 3), (y, 2)], by_nat, 3):
                    if x == lv and all(c[0] == lab for c in cs):
                        continue  # only level cards: a bomb, not triple + pair
                    add("triple_pair", vx, 1, cs)

    def windows(k: int):
        lo = 0 if last is None or last_tier >= 0 else last.main + 1
        for top in range(max(k - 1, lo), 14):
            yield top, [_seq_nat(q) for q in range(top - k + 1, top + 1)]

    for t, g, k in (("straight", 1, 5), ("pair_chain", 2, 3), ("plane", 3, 2)):
        if not want(t):
            continue
        for top, nats in windows(k):
            if sum(min(g, cnt[r]) for r in nats) + nw < g * k:
                continue
            for cs in fills([(r, g) for r in nats], by_nat, 1):
                add(t, top, 1, cs)
    if want("straight_flush"):
        for s in SUITS:
            pool = by_suit[s]
            for top in range(4, 14):
                nats = [_seq_nat(q) for q in range(top - 4, top + 1)]
                if sum(1 for r in nats if pool[r]) + nw < 5:
                    continue
                for cs in fills([(r, 1) for r in nats], pool, 1):
                    add("straight_flush", top, 1, cs)
    return list(found.values())


# ---------------------------------------------------------------- helpers


def lowest_single_gd(hand: Sequence[str], level: LevelLike) -> List[str]:
    """The lowest single by value, never a wildcard unless only wildcards are left (what the
    server plays for a timed-out leader)."""
    lv = level_index(level)
    wild = NAT_RANKS[lv] + "H"
    srt = sorted(hand, key=_sort_key(lv))
    for c in srt:
        if c != wild:
            return [c]
    return srt[:1]


def returnable_cards(hand: Sequence[str], level: LevelLike) -> List[str]:
    """Distinct cards of ``hand`` that may be returned (还贡): natural rank 2..10, not a
    wildcard. Sorted ascending by value, then suit; the first is the server's timeout choice.
    """
    wild = wildcard(level)
    out = sorted(
        {c for c in hand if c != wild and len(c) == 2 and c[0] in RETURN_RANKS},
        key=_sort_key(level_index(level)),
    )
    return out
