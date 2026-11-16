"""Texas Hold'em cards and the best-5-of-N hand evaluator, a port of the server engine
(``packages/engine/src/holdem/cards.ts`` and ``evaluator.ts``).

Cards are rank ``23456789TJQKA`` + suit ``SHCD`` (e.g. ``"AS"``, ``"TD"``). Rank values are
0 (deuce) .. 12 (ace); a card index is ``rank * 4 + suit``.

A score is one integer, ``category << 20`` plus up to five 4-bit rank nibbles, exactly as the
server computes it (it is the ``score`` in ``result.showdown``): a higher score is a stronger
hand and equal scores are exact ties. Categories, low to high, are :data:`HAND_NAMES`.

Main functions: :func:`evaluate` (score, rank name and best five cards), :func:`hand_score`,
:func:`compare`, :func:`score_rank`.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

RANKS = "23456789TJQKA"
SUITS = "SHCD"

HAND_NAMES = [
    "high_card",
    "pair",
    "two_pair",
    "three_of_a_kind",
    "straight",
    "flush",
    "full_house",
    "four_of_a_kind",
    "straight_flush",
]

__all__ = [
    "RANKS",
    "SUITS",
    "HAND_NAMES",
    "deck",
    "card_index",
    "card_from_index",
    "is_card",
    "rank_of",
    "suit_of",
    "score_indices",
    "hand_score",
    "score_rank",
    "compare",
    "evaluate",
]


def deck() -> List[str]:
    """All 52 cards, rank-major (``"2S", "2H", "2C", "2D", "3S", ...``)."""
    return [r + s for r in RANKS for s in SUITS]


def card_index(c: object) -> int:
    """Index 0..51 = rank * 4 + suit, or -1 for an invalid code."""
    if not isinstance(c, str) or len(c) != 2:
        return -1
    r = RANKS.find(c[0])
    s = SUITS.find(c[1])
    return -1 if r < 0 or s < 0 else r * 4 + s


def card_from_index(i: int) -> str:
    return RANKS[i >> 2] + SUITS[i & 3]


def is_card(c: object) -> bool:
    return card_index(c) >= 0


def rank_of(c: str) -> int:
    """Rank value 0 (deuce) .. 12 (ace)."""
    return RANKS.index(c[0])


def suit_of(c: str) -> str:
    return c[1]


def _build_straight_high() -> List[int]:
    table = [-1] * (1 << 13)
    for m in range(1 << 13):
        for hi in range(12, 2, -1):
            need = 0b1000000001111 if hi == 3 else 0b11111 << (hi - 4)
            if m & need == need:
                table[m] = hi
                break
    return table


# STRAIGHT_HIGH[rank_mask] = top rank of the highest straight in the mask, or -1.
_STRAIGHT_HIGH = _build_straight_high()


def _top_bits(mask: int, n: int, score: int) -> int:
    r = 12
    while r >= 0 and n > 0:
        if mask & (1 << r):
            score = (score << 4) | r
            n -= 1
        r -= 1
    while n > 0:
        score <<= 4
        n -= 1
    return score


def score_indices(cards: Sequence[int]) -> int:
    """Score of the best 5-card hand among 5..7 card indices (no validation)."""
    counts = [0] * 13
    suit_masks = [0, 0, 0, 0]
    suit_counts = [0, 0, 0, 0]
    rank_mask = 0
    for c in cards:
        r = c >> 2
        bit = 1 << r
        counts[r] += 1
        rank_mask |= bit
        s = c & 3
        suit_masks[s] |= bit
        suit_counts[s] += 1
    flush_mask = 0
    for s in range(4):
        if suit_counts[s] >= 5:
            flush_mask = suit_masks[s]
            break
    if flush_mask:
        sh = _STRAIGHT_HIGH[flush_mask]
        if sh >= 0:
            return (8 << 20) | (sh << 16)
    quad = trip1 = trip2 = pair1 = pair2 = -1
    for r in range(12, -1, -1):
        k = counts[r]
        if k == 4:
            quad = r
        elif k == 3:
            if trip1 < 0:
                trip1 = r
            elif trip2 < 0:
                trip2 = r
        elif k == 2:
            if pair1 < 0:
                pair1 = r
            elif pair2 < 0:
                pair2 = r
    if quad >= 0:
        return _top_bits(rank_mask & ~(1 << quad), 1, (7 << 4) | quad) << 12
    if trip1 >= 0 and (trip2 >= 0 or pair1 >= 0):
        p = trip2 if trip2 > pair1 else pair1
        return (6 << 20) | (trip1 << 16) | (p << 12)
    if flush_mask:
        return _top_bits(flush_mask, 5, 5)
    sh = _STRAIGHT_HIGH[rank_mask]
    if sh >= 0:
        return (4 << 20) | (sh << 16)
    if trip1 >= 0:
        return _top_bits(rank_mask & ~(1 << trip1), 2, (3 << 4) | trip1) << 8
    if pair2 >= 0:
        rest = rank_mask & ~(1 << pair1) & ~(1 << pair2)
        return _top_bits(rest, 1, (((2 << 4) | pair1) << 4) | pair2) << 8
    if pair1 >= 0:
        return _top_bits(rank_mask & ~(1 << pair1), 3, (1 << 4) | pair1) << 4
    return _top_bits(rank_mask, 5, 0)


def _to_indices(cards: Sequence[str]) -> List[int]:
    if len(cards) < 5 or len(cards) > 7:
        raise ValueError("need 5 to 7 cards")
    idx = [card_index(c) for c in cards]
    if any(i < 0 for i in idx):
        raise ValueError("invalid card in %s" % " ".join(map(str, cards)))
    if len(set(idx)) != len(idx):
        raise ValueError("duplicate card in %s" % " ".join(cards))
    return idx


def hand_score(cards: Sequence[str]) -> int:
    """Score of the best 5-card hand among 5..7 cards. Higher is better.

    Raises ``ValueError`` for fewer than 5 / more than 7 cards, unknown codes or duplicates.
    """
    return score_indices(_to_indices(cards))


def score_rank(score: int) -> str:
    """Category name of a score (``"pair"``, ``"flush"``, ...)."""
    return HAND_NAMES[score >> 20]


def compare(a: Sequence[str], b: Sequence[str]) -> int:
    """Positive when hand ``a`` beats ``b``, negative when ``b`` wins, 0 for a tie."""
    return hand_score(a) - hand_score(b)


def evaluate(cards: Sequence[str]) -> Tuple[int, str, List[str]]:
    """Evaluate 5..7 cards -> ``(score, rank_name, best5)``.

    ``best5`` lists the best five cards most significant first (e.g. trips before kickers;
    the ace of a wheel straight last), the same order the server reports in ``showdown``.
    """
    idx = _to_indices(cards)
    score = score_indices(idx)
    best: List[int] = idx[:5]
    n = len(idx)
    if n > 5:
        found: Optional[List[int]] = None
        for a in range(n):
            for b in range(a + 1, n):
                for c in range(b + 1, n):
                    for d in range(c + 1, n):
                        for e in range(d + 1, n):
                            pick = [idx[a], idx[b], idx[c], idx[d], idx[e]]
                            if score_indices(pick) == score:
                                found = pick
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                break
        if found:
            best = found
    cat = score >> 20
    wheel = cat in (4, 8) and ((score >> 16) & 15) == 3
    cnt: dict = {}
    for i in best:
        cnt[i >> 2] = cnt.get(i >> 2, 0) + 1

    def key(i: int) -> Tuple[int, int]:
        r = i >> 2
        rr = -1 if wheel and r == 12 else r
        return (-(cnt[r] * 100 + rr), i & 3)

    best = sorted(best, key=key)
    return score, score_rank(score), [card_from_index(i) for i in best]
