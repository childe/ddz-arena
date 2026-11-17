"""Gongzhu (拱猪) rules, a port of the TypeScript engine (``packages/engine/src/gongzhu``, the
source of truth; see ``docs/gongzhu.md``).

One 52-card deck without jokers, 13 cards each, 4 players each on their own. Cards use the same
codes as Dou Dizhu (``"5S"``, ``"TH"``, ``"QS"``); within a suit ``2`` is lowest and ``A``
highest, and suits never beat each other (no trumps).

* Follow suit when you can; otherwise play anything. The highest card of the led suit wins the
  trick and its scoring cards.
* Exposed cards (亮牌: ``QS`` / ``JD`` / ``TC`` / ``AH``) may not be played before their suit
  has been led in an earlier trick -- not as the lead, not following and not as a discard --
  unless it is the only card of that suit in hand. (The engine's ``legalCards()`` currently
  lists an exposed card as a discard while ``play()`` refuses it with ``EXPOSED_CARD_LOCKED``;
  :func:`legal_cards` follows ``play()``, so every card it returns is accepted.)
* :func:`score_taken` / :func:`settle` score a hand exactly like the engine's ``scoreTaken`` /
  ``settleGz``.

>>> score_taken(["QS", "TC"], [])
-200
>>> trick_winner([(0, "5S"), (1, "KS"), (2, "AH"), (3, "9S")])
1
"""

from __future__ import annotations

from typing import (
    Any,
    Collection,
    Dict,
    Iterable,
    List,
    Optional,
    Sequence,
    Tuple,
    Union,
)

from .rules import RuleError

RANKS = "23456789TJQKA"
SUITS = "SHCD"
#: all 52 cards, suit by suit (S H C D), 2 to A within a suit
DECK: List[str] = [r + s for s in SUITS for r in RANKS]
_DECK_SET = frozenset(DECK)

PIG = "QS"  # 猪
GOAT = "JD"  # 羊
TRANSFORMER = "TC"  # 变压器
HEART_ACE = "AH"
#: cards that may be exposed before play, in the engine's order
EXPOSABLE: Tuple[str, ...] = (PIG, GOAT, TRANSFORMER, HEART_ACE)
SCORING_COUNT = 16
HAND_SIZE_GZ = 13
SEATS_GZ = 4
#: a match ends after the hand in which some player's total drops to this or lower
MATCH_LOSS = -1000


def is_card(c: Any) -> bool:
    return isinstance(c, str) and c in _DECK_SET


def suit_of(card: str) -> str:
    return card[1]


def rank_of(card: str) -> int:
    """2..14 (A high)."""
    return RANKS.index(card[0]) + 2


def sort_cards_gz(cards: Iterable[str]) -> List[str]:
    """Sorts by suit (S H C D), then rank ascending, like the engine's ``sortGz``."""
    return sorted(cards, key=lambda c: SUITS.index(c[1]) * 16 + rank_of(c))


def heart_points(card: str) -> int:
    """Heart values before doubling: A -50, K -40, Q -30, J -20, 10..5 -10, 4..2 0."""
    if card[1] != "H":
        return 0
    r = rank_of(card)
    if r == 14:
        return -50
    if r >= 11:
        return -(r - 9) * 10
    return -10 if r >= 5 else 0


def is_scoring(card: str) -> bool:
    """One of the 16 scoring cards (分牌): every heart, the pig, the goat, the transformer."""
    return card[1] == "H" or card in (PIG, GOAT, TRANSFORMER)


def exposable(hand: Iterable[str]) -> List[str]:
    """Cards in ``hand`` that may be exposed, in the engine's order."""
    h = set(hand)
    return [c for c in EXPOSABLE if c in h]


# ------------------------------------------------------------------ playing
def is_locked(
    card: str,
    hand: Sequence[str],
    exposed: Collection[str],
    led_before: Collection[str],
) -> bool:
    """True if ``card`` is one of your ``exposed`` cards, its suit is not in ``led_before``
    (suits led in completed tricks) and you hold another card of that suit."""
    if card not in exposed or card[1] in led_before:
        return False
    return any(c != card and c[1] == card[1] for c in hand)


def legal_cards(
    hand: Sequence[str],
    led_suit: Optional[str] = None,
    exposed: Collection[str] = (),
    led_before: Collection[str] = (),
) -> List[str]:
    """Cards you may play, in hand order.

    ``led_suit`` is the suit led in the current trick (None when you lead), ``exposed`` your own
    exposed cards and ``led_before`` the suits led in completed tricks. With cards of the led
    suit you must play one of them; otherwise any card. Exposed cards are locked (see
    :func:`is_locked`).
    """
    pool = list(hand)
    if led_suit is not None:
        follow = [c for c in pool if c[1] == led_suit]
        if follow:
            pool = follow
    return [c for c in pool if not is_locked(c, hand, exposed, led_before)]


def check_play(
    card: str,
    hand: Sequence[str],
    led_suit: Optional[str] = None,
    exposed: Collection[str] = (),
    led_before: Collection[str] = (),
) -> None:
    """Raises :class:`~ddz_sdk.rules.RuleError` with the server's code (``UNKNOWN_CARD``,
    ``CARDS_NOT_IN_HAND``, ``MUST_FOLLOW_SUIT``, ``EXPOSED_CARD_LOCKED``) if ``card`` may not
    be played."""
    if not is_card(card):
        raise RuleError("UNKNOWN_CARD", "unknown card code: %r" % (card,))
    if card not in hand:
        raise RuleError("CARDS_NOT_IN_HAND", "%s is not in your hand" % card)
    if (
        led_suit is not None
        and card[1] != led_suit
        and any(c[1] == led_suit for c in hand)
    ):
        raise RuleError("MUST_FOLLOW_SUIT", "you must follow suit %s" % led_suit)
    if is_locked(card, hand, exposed, led_before):
        raise RuleError(
            "EXPOSED_CARD_LOCKED",
            "exposed %s cannot be played in the first round of its suit" % card,
        )


Play = Union[Tuple[int, str], Dict[str, Any]]


def _seat_card(p: Play) -> Tuple[int, str]:
    if isinstance(p, dict):
        return p["seat"], p["card"]
    return p[0], p[1]


def trick_winner(plays: Sequence[Play]) -> int:
    """Seat that wins a trick: the highest card of the led suit. ``plays`` are ``(seat, card)``
    pairs or ``{"seat", "card"}`` dicts in play order (a partial trick gives the current
    winner)."""
    seat, card = _seat_card(plays[0])
    suit = card[1]
    best = rank_of(card)
    for p in plays[1:]:
        s, c = _seat_card(p)
        if c[1] == suit and rank_of(c) > best:
            seat, best = s, rank_of(c)
    return seat


def lowest_safe_card(cards: Sequence[str]) -> str:
    """The server's timeout choice among ``cards``: the lowest card, preferring cards that are
    not scoring cards (ties keep the first)."""
    plain = [c for c in cards if not is_scoring(c)]
    pool = plain or list(cards)
    best = pool[0]
    for c in pool[1:]:
        if rank_of(c) < rank_of(best):
            best = c
    return best


# ------------------------------------------------------------------ scoring
def score_taken(taken: Collection[str], exposed: Iterable[str] = ()) -> int:
    """Points for one player's taken scoring cards; ``exposed`` are all exposed cards (any seat).

    Hearts sum to -200, or +200 when one player takes all 13 (全红), and then the pig counts
    +100 instead of -100. The goat is +100. The transformer doubles the rest, or is +50 on its
    own (no other scoring card). Exposing doubles a card's effect: the heart ace doubles all
    hearts, an exposed transformer multiplies by 4 (or is +100 alone).
    """
    ex = set(exposed)
    hearts = [c for c in taken if c[1] == "H"]
    all_hearts = len(hearts) == 13
    hm = 2 if HEART_ACE in ex else 1
    pts = (200 if all_hearts else sum(heart_points(c) for c in hearts)) * hm
    has_pig = PIG in taken
    has_goat = GOAT in taken
    if has_pig:
        pts += (100 if all_hearts else -100) * (2 if PIG in ex else 1)
    if has_goat:
        pts += 100 * (2 if GOAT in ex else 1)
    if TRANSFORMER in taken:
        tm = 2 if TRANSFORMER in ex else 1
        if not hearts and not has_pig and not has_goat:
            pts = 50 * tm
        else:
            pts = pts * 2 * tm
    return pts


def platform_scores(points: Sequence[int]) -> List[int]:
    """Leaderboard scores: ``(4 * points - sum(points)) / 10`` per seat (sums to zero)."""
    total = sum(points)
    return [(4 * p - total) // 10 for p in points]


def settle(
    taken: Sequence[Collection[str]],
    exposed: Sequence[Iterable[str]],
    totals: Sequence[int] = (0, 0, 0, 0),
) -> Dict[str, Any]:
    """Settles a hand like the engine's ``settleGz``: the ``result`` object of
    ``game.finished`` (``points``, ``totals_before``, ``totals_after``, ``taken``,
    ``exposed``, ``all_hearts``, ``pig``, ``losers``, ``match_over``, ``scores``)."""
    exposed = [list(e) for e in exposed]
    all_ex = [c for e in exposed for c in e]
    points = [score_taken(t, all_ex) for t in taken]
    after = [t + p for t, p in zip(totals, points)]
    losers = [s for s in range(SEATS_GZ) if after[s] <= MATCH_LOSS]

    def owner(pred) -> Optional[int]:
        return next((s for s in range(SEATS_GZ) if pred(taken[s])), None)

    return {
        "points": points,
        "totals_before": list(totals),
        "totals_after": after,
        "taken": [sort_cards_gz(t) for t in taken],
        "exposed": exposed,
        "all_hearts": owner(lambda t: sum(1 for c in t if c[1] == "H") == 13),
        "pig": owner(lambda t: PIG in t),
        "losers": losers,
        "match_over": bool(losers),
        "scores": platform_scores(points),
    }
