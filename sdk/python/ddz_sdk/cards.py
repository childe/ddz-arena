"""Card and rank helpers mirroring the API encoding.

A card is a 2-character string: rank char from ``3456789TJQKA2`` plus suit from
``SHCD`` (e.g. ``"3S"``, ``"TH"``), or ``"BJ"`` (small joker) / ``"RJ"`` (big joker).

Ranks are integers 0..14: ``3``..``A`` -> 0..11, ``2`` -> 12, ``BJ`` -> 13, ``RJ`` -> 14.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Sequence

RANK_CHARS = "3456789TJQKA2"
SUITS = "SHCD"
SMALL_JOKER = "BJ"
BIG_JOKER = "RJ"

RANK_A = 11
RANK_2 = 12
RANK_BJ = 13
RANK_RJ = 14
RANK_COUNT = 15

RANK_LABELS: List[str] = list(RANK_CHARS) + ["BJ", "RJ"]

ALL_CARDS: List[str] = [r + s for r in RANK_CHARS for s in SUITS] + [
    SMALL_JOKER,
    BIG_JOKER,
]
_CARD_SET = frozenset(ALL_CARDS)


def full_deck() -> List[str]:
    """All 54 card codes."""
    return list(ALL_CARDS)


def is_valid_card(c: object) -> bool:
    return isinstance(c, str) and c in _CARD_SET


def rank_of(card: str) -> int:
    """Rank value 0..14 of a card code."""
    if card == SMALL_JOKER:
        return RANK_BJ
    if card == BIG_JOKER:
        return RANK_RJ
    if len(card) != 2 or card[0] not in RANK_CHARS:
        raise ValueError("invalid card %r" % (card,))
    return RANK_CHARS.index(card[0])


def rank_label(rank: int) -> str:
    """API label of a rank value (``"3"`` .. ``"2"``, ``"BJ"``, ``"RJ"``)."""
    return RANK_LABELS[rank]


def rank_from_label(label: str) -> int:
    """Inverse of :func:`rank_label`."""
    return RANK_LABELS.index(label)


def card_order(card: str) -> int:
    r = rank_of(card)
    return r * 4 + (0 if r >= RANK_BJ else SUITS.index(card[1]))


def sort_cards(cards: Iterable[str]) -> List[str]:
    """Sort ascending by rank, then suit (S, H, C, D)."""
    return sorted(cards, key=card_order)


def rank_counts(cards: Iterable[str]) -> List[int]:
    """``counts[rank]`` = number of cards of that rank (list of length 15)."""
    counts = [0] * RANK_COUNT
    for c in cards:
        counts[rank_of(c)] += 1
    return counts


def group_by_rank(cards: Iterable[str]) -> Dict[int, List[str]]:
    """Map rank -> cards of that rank (sorted)."""
    out: Dict[int, List[str]] = {}
    for c in sort_cards(cards):
        out.setdefault(rank_of(c), []).append(c)
    return out


def contains_all(hand: Sequence[str], cards: Sequence[str]) -> bool:
    """True if ``cards`` is a sub-multiset of ``hand``.

    Each copy in ``cards`` needs its own copy in ``hand``. With one deck (3-player game)
    every card appears once, so this is plain containment without duplicates; in the
    two-deck 4-player game ``["3S", "3S"]`` is fine when the hand holds both copies.
    """
    avail: Dict[str, int] = {}
    for c in hand:
        avail[c] = avail.get(c, 0) + 1
    for c in cards:
        n = avail.get(c, 0)
        if n == 0:
            return False
        avail[c] = n - 1
    return True


def remove_cards(hand: Sequence[str], cards: Iterable[str]) -> List[str]:
    """Remove one copy from ``hand`` per entry in ``cards`` (cards not in hand are ignored)."""
    rm: Dict[str, int] = {}
    for c in cards:
        rm[c] = rm.get(c, 0) + 1
    out: List[str] = []
    for c in hand:
        n = rm.get(c, 0)
        if n:
            rm[c] = n - 1
        else:
            out.append(c)
    return out


def pick_by_ranks(hand: Sequence[str], ranks: Iterable[int]) -> List[str]:
    """Pick concrete cards from ``hand`` matching a rank multiset (lowest suits first)."""
    pool = group_by_rank(hand)
    out: List[str] = []
    for r in ranks:
        lst = pool.get(r)
        if not lst:
            raise ValueError("rank %s not available" % RANK_LABELS[r])
        out.append(lst.pop(0))
    return sort_cards(out)


def full_deck4() -> List[str]:
    """The 108 cards of the 4-player game: every code twice."""
    return list(ALL_CARDS) + list(ALL_CARDS)


def parse_short(s: str) -> List[str]:
    """Test/debug helper: ``"334X D"`` -> ``["3S","3H","4S","BJ","RJ"]``.

    Rank chars get suits assigned in order S,H,C,D (then S,H,C,D again for the second
    deck of the 4-player game); ``X`` = BJ, ``D`` = RJ; spaces ignored.
    """
    used: Dict[str, int] = {}
    out: List[str] = []
    for ch in s:
        if ch == " ":
            continue
        if ch == "X":
            out.append(SMALL_JOKER)
        elif ch == "D":
            out.append(BIG_JOKER)
        else:
            i = used.get(ch, 0)
            used[ch] = i + 1
            out.append(ch + (SUITS + SUITS)[i])
    return out
