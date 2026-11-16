"""Guandan rules (ddz_sdk.rules_gd), following docs/guandan.md sections 1-2: level-aware values,
sequences with a low/high ace, the heart-level wildcard, every pattern type, bomb ordering,
resolve hints and legal-move consistency (including a brute-force cross-check)."""

import random
import time
from collections import Counter

import pytest

from ddz_sdk.cards import contains_all, full_deck4
from ddz_sdk.rules import RuleError
from ddz_sdk.rules_gd import (
    GdPattern,
    beats_gd,
    bomb_tier,
    card_value,
    identify_gd,
    is_legal_gd,
    is_wildcard,
    legal_moves_gd,
    level_index,
    lowest_single_gd,
    resolve_gd,
    returnable_cards,
    sort_cards_gd,
    wildcard,
)


def c(s):
    return s.split()


def api(cards, level="7"):
    """identify_gd as sorted (type, rank, length) tuples."""
    return sorted((p.type, p.rank, p.length) for p in identify_gd(c(cards), level))


def pat(cards, level="7", last=None, hint=None):
    return resolve_gd(c(cards), last, level, hint)


# ------------------------------------------------------------------ values


def test_level_index_and_wildcard():
    assert level_index("2") == 0 and level_index("A") == 12
    assert level_index("T") == level_index("10") == level_index(8) == 8
    with pytest.raises(ValueError):
        level_index("1")
    assert wildcard("7") == "7H" and wildcard("T") == "TH"
    assert is_wildcard("7H", "7") and not is_wildcard("7S", "7")


def test_single_values_are_level_aware():
    # level 7: ... 6 < 8 < ... < A < 7 < BJ < RJ
    order = c("2S 6S 8S AS 7S BJ RJ")
    vals = [card_value(x, "7") for x in order]
    assert vals == sorted(vals) and len(set(vals)) == len(vals)
    assert card_value("7S", "7") == 12 and card_value("BJ", "7") == 13
    # level 2: 3 < ... < A < 2 < BJ
    assert card_value("3S", "2") == 0 < card_value("AS", "2") < card_value("2D", "2")
    assert sort_cards_gd(c("RJ 7S AS 2S 7H 8C"), "7") == c("2S 8C AS 7S 7H RJ")


# --------------------------------------------------------------- identify

VALID = [
    ("5S", [("single", "5", 1)]),
    ("BJ", [("single", "BJ", 1)]),
    ("5S 5S", [("pair", "5", 1)]),
    ("BJ BJ", [("pair", "BJ", 1)]),
    ("RJ RJ", [("pair", "RJ", 1)]),
    ("KS KH KD", [("triple", "K", 1)]),
    ("KS KH KD 3S 3C", [("triple_pair", "K", 1)]),
    ("KS KH KD RJ RJ", [("triple_pair", "K", 1)]),
    ("AS 2S 3H 4S 5S", [("straight", "5", 1)]),
    ("TS JS QH KS AS", [("straight", "A", 1)]),
    ("9S TS JS QS KS", [("straight", "K", 1), ("straight_flush", "K", 1)]),
    ("AS AH 2S 2H 3S 3H", [("pair_chain", "3", 1)]),
    ("QS QH KS KH AS AH", [("pair_chain", "A", 1)]),
    ("AS AH AC 2S 2H 2C", [("plane", "2", 1)]),
    ("KS KH KC AS AH AC", [("plane", "A", 1)]),
    ("4S 4H 4C 4D", [("bomb", "4", 4)]),
    ("4S 4H 4C 4D 4S 4H 4C 4D", [("bomb", "4", 8)]),
    ("BJ BJ RJ RJ", [("rocket", "RJ", 4)]),
    # triple + pair of the same rank is a 5-card bomb, not triple_pair
    ("KS KH KD KS KH", [("bomb", "K", 5)]),
]

INVALID = [
    "BJ RJ",  # different jokers are not a pair
    "5S 6S",
    "BJ BJ RJ",  # no joker triple
    "KS KH KD KC 3S",  # four + one
    "QS KS AS 2S 3S",  # no wrap-around
    "KS AS 2S 3S 4S",
    "3S 4S 5S 6S 7S 8S",  # straights have exactly 5 cards
    "3S 3H 4S 4H",  # pair chains have exactly 3 pairs
    "3S 3H 4S 4H 5S 5H 6S 6H",
    "3S 3H 3C 4S 4H 4C 5S 5H 5C",  # planes have exactly 2 triples
    "KS KH AS AH 2S 2H",  # no wrap for pair chains either
    "BJ 2S 3S 4S 5S",  # jokers never in sequences
    "4S 4H 4C 4D 4S 4H 4C 4D 4S",  # no 9-card bomb (and no 3rd copy anyway)
]


@pytest.mark.parametrize("cards,expect", VALID)
def test_identify_valid(cards, expect):
    level = "7"
    assert api(cards, level) == sorted(expect)


@pytest.mark.parametrize("cards", INVALID)
def test_identify_invalid(cards):
    assert api(cards) == []


def test_level_card_in_natural_place_for_sequences():
    # level 7: 34567 is a straight; the level card keeps its natural position.
    assert api("3S 4H 5S 6S 7S") == [("straight", "7", 1)]
    p = pat("3S 4H 5S 6S 7S")
    assert p.main == 6  # sequence position of the top card (A low = 0, 2 = 1, ...)


def test_sequence_main_positions():
    assert pat("AS 2S 3H 4S 5S").main == 4
    assert pat("TS JS QH KS AS").main == 13
    assert pat("AS AH 2S 2H 3S 3H").main == 2
    assert pat("KS KH KC AS AH AC").main == 13


# -------------------------------------------------------------- wildcards


def test_wildcard_alone_or_with_level_cards_is_a_level_card():
    assert api("7H") == [("single", "7", 1)]
    assert api("7H 7H") == [("pair", "7", 1)]
    assert api("7H 7S") == [("pair", "7", 1)]
    assert api("7S 7C 7D 7H 7H") == [("bomb", "7", 5)]
    # at another level 7H is an ordinary card
    assert api("7H 7S", "5") == [("pair", "7", 1)]
    assert api("7H 5S", "5") == []


def test_wildcard_substitutes_non_jokers():
    assert api("5S 7H") == [("pair", "5", 1)]
    assert api("5S 5D 7H") == [("triple", "5", 1)]
    assert api("5S 5D 5C 7H") == [("bomb", "5", 4)]
    assert api("5S 5D 5C 5H 5S 5D 7H 7H") == [("bomb", "5", 8)]
    assert api("5S 7H 7H") == [("triple", "5", 1)]
    # never a joker: no pair, no rocket
    assert api("BJ 7H") == []
    assert api("BJ BJ RJ 7H") == []


def test_wildcard_triple_pair_interpretations():
    assert api("3S 3H 5S 5H 7H") == [("triple_pair", "3", 1), ("triple_pair", "5", 1)]
    # three 3s + two wildcards: a 5-card bomb or 333 + any pair; leading plays the bomb
    assert api("3S 3H 3C 7H 7H") == [("bomb", "3", 5), ("triple_pair", "3", 1)]
    assert pat("3S 3H 3C 7H 7H").type == "bomb"
    assert pat("3S 3H 3C 7H 7H", last=pat("2S 2H 2C AS AH")).type == "triple_pair"
    assert api("3S 3H 7H BJ BJ") == [("triple_pair", "3", 1)]
    assert api("BJ BJ 7H 7H 3S") == [("triple_pair", "3", 1)]  # 3 + two wildcards
    assert api("BJ BJ 7H 7H RJ") == []  # the triple can't be jokers


def test_wildcard_sequences():
    # 3456 + wildcard: 23456 or 34567, and as straight flushes when the rest is one suit
    assert api("3S 4S 5S 6S 7H") == [
        ("straight", "6", 1),
        ("straight", "7", 1),
        ("straight_flush", "6", 1),
        ("straight_flush", "7", 1),
    ]
    assert api("3S 4H 5S 6S 7H") == [("straight", "6", 1), ("straight", "7", 1)]
    # gap filling, A-low and A-high
    assert api("AS 3D 4S 5S 7H") == [("straight", "5", 1)]
    assert api("TS JD QS AS 7H") == [("straight", "A", 1)]
    assert api("QS KS AS 2S 7H") == []  # no wrap-around even with a wildcard
    # pair chain and plane from the same cards
    assert api("3S 3H 4S 4H 7H 7H") == [
        ("pair_chain", "4", 1),
        ("pair_chain", "5", 1),
        ("plane", "4", 1),
    ]
    assert api("KS KH AS AH 7H 7H") == [("pair_chain", "A", 1), ("plane", "A", 1)]
    assert api("AS AH AC 2S 7H 7H") == [("plane", "2", 1)]


def test_straight_flush_with_wildcard_in_hearts():
    # the wildcard may stand for itself (7H) in a heart straight flush
    assert ("straight_flush", "7", 1) in api("3H 4H 5H 6H 7H")
    assert ("straight_flush", "8", 1) in api("4H 5H 6H 8H 7H")


# ------------------------------------------------------------------ beats


def P(t, main, length=1, level="7"):
    return GdPattern(t, main, length, level)


def test_bomb_ordering():
    ladder = [
        pat("3S 3H 3C 3D"),  # 4 cards
        pat("AS AH AC AD"),
        pat("3S 3H 3C 3D 3S"),  # 5 cards
        pat("AS 2S 3S 4S 5S"),  # straight flush (lowest)
        pat("TS JS QS KS AS"),  # straight flush (highest)
        pat("3S 3H 3C 3D 3S 3H"),  # 6 cards
        pat("3S 3H 3C 3D 3S 3H 3C"),  # 7 cards
        pat("3S 3H 3C 3D 3S 3H 3C 3D"),  # 8 cards
        pat("BJ BJ RJ RJ"),  # rocket
    ]
    tiers = [bomb_tier(p) for p in ladder]
    assert tiers == sorted(tiers) and tiers[0] == 0 and tiers[-1] == 6
    for i, a in enumerate(ladder):
        for j, b in enumerate(ladder):
            assert beats_gd(a, b) == (i > j), (a, b)
    assert not beats_gd(ladder[-1], ladder[-1])


def test_bombs_beat_everything_else():
    for other in ("AS", "RJ RJ", "TS JS QH KS AS", "QS QH KS KH AS AH", "BJ"):
        p = pat(other)
        assert beats_gd(pat("2S 2H 2C 2D"), p)
        assert not beats_gd(p, pat("2S 2H 2C 2D"))


def test_non_bombs_compare_same_type_only():
    assert beats_gd(pat("8S 8H"), pat("6S 6H"))
    assert not beats_gd(pat("8S 8H"), pat("6S"))
    assert not beats_gd(pat("8S 8H 8C"), pat("6S 6H"))
    assert beats_gd(pat("RJ RJ"), pat("BJ BJ"))
    assert beats_gd(pat("BJ BJ"), pat("7S 7S"))
    assert beats_gd(pat("2S 3S 4H 5S 6S"), pat("AS 2S 3H 4S 5S"))


def test_level_aware_comparison():
    # level 7: the level card beats an ace; level 2: 2 is above the ace
    assert beats_gd(pat("7S", "7"), pat("AS", "7"))
    assert not beats_gd(pat("AS", "7"), pat("7S", "7"))
    assert beats_gd(pat("2S", "2"), pat("AS", "2"))
    assert not beats_gd(pat("2S", "7"), pat("3S", "7"))
    assert beats_gd(pat("7S 7S 7C 3S 3H", "7"), pat("AS AH AC KS KH", "7"))
    assert beats_gd(pat("7S 7C 7D 7S", "7"), pat("AS AH AC AD", "7"))
    # sequences ignore the level: 34567 < 45678 at level 7
    assert beats_gd(pat("4S 5H 6S 7S 8S"), pat("3S 4H 5S 6S 7S"))


def test_beats_accepts_api_dicts_with_level():
    a = {"type": "pair", "rank": "7", "length": 1}
    b = {"type": "pair", "rank": "A", "length": 1}
    assert beats_gd(a, b, "7") and not beats_gd(a, b, "8")
    with pytest.raises(ValueError):
        beats_gd(a, b)


def test_api_round_trip():
    hands = [
        "5S",
        "7S",
        "AS",
        "BJ",
        "RJ RJ",
        "KS KH KD 3S 3C",
        "AS 2S 3H 4S 5S",
        "TS JS QH KS AS",
        "QS QH KS KH AS AH",
        "AS AH AC 2S 2H 2C",
        "4S 4H 4C 4D 4S 4H",
        "9S TS JS QS KS",
        "BJ BJ RJ RJ",
    ]
    for level in ("2", "7", "A"):
        for h in hands:
            for p in identify_gd(c(h), level):
                d = p.to_api()
                assert GdPattern.from_api(d, level) == p, (h, level, d)
    assert pat("AS 2S 3H 4S 5S").to_api() == {
        "type": "straight",
        "rank": "5",
        "length": 1,
    }
    assert pat("BJ BJ RJ RJ").to_api() == {"type": "rocket", "rank": "RJ", "length": 4}
    assert pat("7S 7C 7D 7S 7C").to_api() == {"type": "bomb", "rank": "7", "length": 5}
    assert GdPattern.from_api(None) is None


# ---------------------------------------------------------------- resolve


def test_resolve_leading_prefers_bombs_then_largest_rank():
    assert pat("3S 4S 5S 6S 7H").type == "straight_flush"
    assert pat("3S 4S 5S 6S 7H").rank == "7"
    assert pat("3S 4H 5S 6S 7H").rank == "7"
    assert (pat("3S 3H 5S 5H 7H").type, pat("3S 3H 5S 5H 7H").rank) == (
        "triple_pair",
        "5",
    )
    assert (pat("3S 3H 4S 4H 7H 7H").type, pat("3S 3H 4S 4H 7H 7H").rank) == (
        "pair_chain",
        "5",
    )
    # tie on rank between types: the later type (plane) wins
    assert pat("KS KH AS AH 7H 7H").type == "plane"


def test_resolve_following_picks_smallest_that_beats():
    last = pat("2S 3H 4S 5S 6S")  # straight to 6
    p = pat("3S 4S 5S 6S 7H", last=last)
    assert (p.type, p.rank) == ("straight", "7")  # not the straight flush
    last = pat("3S 4H 5S 6S 7S")  # straight to 7
    with pytest.raises(RuleError) as e:
        pat("3S 4H 5S 6S 7H", last=last)
    assert e.value.code == "CANNOT_BEAT"
    # the flush version still beats as a straight flush
    assert pat("3S 4S 5S 6S 7H", last=last).type == "straight_flush"
    last = pat("3S 3H 3C 4S 4H")
    p = pat("3S 3H 5S 5H 7H", last=last)
    assert (p.type, p.rank) == ("triple_pair", "5")
    # API dict as last
    p = resolve_gd(c("8S 8H"), {"type": "pair", "rank": "6", "length": 1}, "7")
    assert p.rank == "8"


def test_resolve_hints():
    cards = "3S 4S 5S 6S 7H"
    assert pat(cards, hint="straight").type == "straight"
    p = pat(cards, hint={"type": "straight", "rank": "6"})
    assert (p.type, p.rank) == ("straight", "6")
    p = pat(cards, hint=GdPattern("straight_flush", 5, 1, "7"))
    assert (p.type, p.rank) == ("straight_flush", "6")
    with pytest.raises(RuleError) as e:
        pat(cards, hint={"type": "straight", "rank": "8"})
    assert e.value.code == "PATTERN_MISMATCH"
    with pytest.raises(RuleError) as e:
        pat(cards, hint="pair")
    assert e.value.code == "PATTERN_MISMATCH"
    with pytest.raises(RuleError) as e:
        pat("5S 6S")
    assert e.value.code == "INVALID_PATTERN"


def test_is_legal_gd():
    hand = c("3S 4S 5S 6S 7H 9D")
    assert is_legal_gd(c("3S 4S 5S 6S 7H"), hand, None, "7")
    assert not is_legal_gd(c("3S 4S 5S 6S 7S"), hand, None, "7")  # 7S not in hand
    assert not is_legal_gd([], hand, None, "7")


# ------------------------------------------------------------ legal moves


def keys(moves):
    return {(m.pattern.type, m.pattern.rank, tuple(m.cards)) for m in moves}


def test_legal_moves_wildcard_variants_and_level_singles():
    hand = c("5S 5D 7H 7S")
    ks = keys(legal_moves_gd(hand, None, "7"))
    assert ("single", "7", ("7S",)) in ks and ("single", "7", ("7H",)) in ks
    assert ("pair", "5", ("5S", "5D")) in ks
    assert ("triple", "5", ("5S", "5D", "7H")) in ks
    assert ("pair", "7", ("7S", "7H")) in ks
    # a wildcard never stands alone for another rank
    assert ("single", "5", ("7H",)) not in ks
    assert ("bomb", "5", ("5S", "5D", "7H", "7S")) not in ks  # 7S is a real 7


def test_legal_moves_straight_flush_uses_real_suits():
    hand = c("3H 4H 5H 6H 3S 4S 5S 6S 7H")
    ks = keys(legal_moves_gd(hand, None, "7"))
    assert ("straight_flush", "7", ("3S", "4S", "5S", "6S", "7H")) in ks
    assert ("straight_flush", "7", ("3H", "4H", "5H", "6H", "7H")) in ks
    assert ("straight_flush", "6", ("3H", "4H", "5H", "6H", "7H")) in ks


def test_legal_moves_filters_by_last_and_bombs():
    hand = c("3S 3H 3C 3D 8S 8H 9S BJ BJ RJ RJ")
    last = pat("AS AH", "7")
    ms = legal_moves_gd(hand, last, "7")
    types = {m.pattern.type for m in ms}
    assert types == {"pair", "bomb", "rocket"}
    assert {m.pattern.rank for m in ms if m.pattern.type == "pair"} == {"BJ", "RJ"}
    ms = legal_moves_gd(hand, pat("BJ BJ RJ RJ"), "7")
    assert ms == []


def _random_hand(rng, level, size=27, wilds=2):
    w = wildcard(level)
    deck = [x for x in full_deck4() if x != w]
    rng.shuffle(deck)
    return deck[: size - wilds] + [w] * wilds


def test_legal_moves_consistency_random():
    rng = random.Random(7)
    for i in range(40):
        level = rng.choice("23456789TJQKA")
        hand = _random_hand(rng, level, wilds=rng.randint(0, 2))
        lead = legal_moves_gd(hand, None, level)
        lasts = [None] + [rng.choice(lead).pattern for _ in range(4)]
        for last in lasts:
            for m in legal_moves_gd(hand, last, level):
                assert contains_all(hand, m.cards)
                assert m.pattern in identify_gd(m.cards, level)
                p = resolve_gd(m.cards, last, level, m.pattern)
                assert p == m.pattern
                if last is not None:
                    assert beats_gd(m.pattern, last)


def _sub_multisets(hand, maxk=8):
    cnt = Counter(hand)
    items = sorted(cnt)

    def rec(i, acc):
        if i == len(items):
            if acc:
                yield list(acc)
            return
        for k in range(cnt[items[i]] + 1):
            if len(acc) + k > maxk:
                break
            yield from rec(i + 1, acc + [items[i]] * k)

    yield from rec(0, [])


def _norm(cards, p, level):
    """Card multiset up to suits (wildcards kept apart); real suits for straight flushes."""
    w = wildcard(level)
    if p.type == "straight_flush":
        return (p, tuple(sorted(cards)))
    return (p, tuple(sorted("W" if x == w else x[0] for x in cards)))


def test_legal_moves_match_brute_force():
    """Every playable sub-multiset of a small hand appears in legal_moves_gd (up to suits)."""
    rng = random.Random(11)
    for i in range(40):
        level = rng.choice("23456789TJQKA")
        w = wildcard(level)
        if i % 2:
            s0 = rng.randint(0, 9)
            ranks = "A23456789TJQKA"[s0 : s0 + 5]
        else:
            ranks = rng.sample("23456789TJQKA", 5)
        deck = [x for x in full_deck4() if (x[0] in ranks or x in ("BJ", "RJ"))]
        deck = [x for x in deck if x != w]
        rng.shuffle(deck)
        hand = deck[: rng.randint(8, 12)] + [w] * rng.randint(0, 2)
        lead = legal_moves_gd(hand, None, level)
        for last in [None] + [rng.choice(lead).pattern for _ in range(2)]:
            expect = set()
            for sub in _sub_multisets(hand):
                for p in identify_gd(sub, level):
                    if last is None or beats_gd(p, last):
                        expect.add(_norm(sub, p, level))
            got = {
                _norm(m.cards, m.pattern, level)
                for m in legal_moves_gd(hand, last, level)
            }
            assert got == expect, (level, sorted(hand), last)


def test_legal_moves_speed():
    rng = random.Random(3)
    worst = 0.0
    for _ in range(20):
        level = rng.choice("23456789TJQKA")
        hand = _random_hand(rng, level)
        t = time.perf_counter()
        legal_moves_gd(hand, None, level)
        worst = max(worst, time.perf_counter() - t)
    assert worst < 0.1


# ---------------------------------------------------------------- helpers


def test_returnable_cards_and_lowest_single():
    hand = c("2S 5H 5H TS JS 7H 7S BJ AS")
    # natural 2..10, no wildcard (7H at level 7), no jokers; level-aware order
    assert returnable_cards(hand, "7") == c("2S 5H TS 7S")
    assert returnable_cards(hand, "5") == c("2S 7S 7H TS")  # 5H is the wildcard
    assert lowest_single_gd(hand, "2") == ["5H"]  # 2 is the level: above the ace
    assert lowest_single_gd(c("7H 7H AS"), "7") == ["AS"]
    assert lowest_single_gd(c("7H 7H"), "7") == ["7H"]
