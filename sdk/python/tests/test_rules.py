import itertools
import random

import pytest

from ddz_sdk.cards import (
    full_deck,
    parse_short,
    rank_counts,
    rank_of,
    sort_cards,
    pick_by_ranks,
)
from ddz_sdk.rules import (
    Pattern,
    RuleError,
    beats,
    identify,
    is_legal,
    legal_moves,
    lowest_single,
    resolve,
)

c = parse_short


def types(s):
    return sorted(p.type for p in identify(c(s)))


# ---------------------------------------------------------------- cards


def test_rank_order_and_sort():
    assert [rank_of(x) for x in ["3S", "TH", "AD", "2C", "BJ", "RJ"]] == [
        0,
        7,
        11,
        12,
        13,
        14,
    ]
    assert sort_cards(["RJ", "2S", "3D", "3S", "BJ", "TH"]) == [
        "3S",
        "3D",
        "TH",
        "2S",
        "BJ",
        "RJ",
    ]
    assert len(set(full_deck())) == 54
    counts = rank_counts(c("33XD2"))
    assert counts[0] == 2 and counts[12] == 1 and counts[13] == 1 and counts[14] == 1
    assert pick_by_ranks(["3D", "3S", "4H"], [0]) == ["3S"]
    with pytest.raises(ValueError):
        rank_of("1S")


# ------------------------------------------------------------- identify

VALID = [
    ("3", ["single"]),
    ("D", ["single"]),
    ("33", ["pair"]),
    ("XD", ["rocket"]),
    ("222", ["triple"]),
    ("3333", ["bomb"]),
    ("3334", ["triple_single"]),
    ("333X", ["triple_single"]),
    ("33344", ["triple_pair"]),
    ("34567", ["straight"]),
    ("3456789TJQKA", ["straight"]),
    ("334455", ["pair_chain"]),
    ("333444", ["plane"]),
    ("33344456", ["plane_single"]),
    ("33344455", ["plane_single"]),
    ("3334445566", ["plane_pair"]),
    ("3334445555", ["plane_pair"]),
    ("333345", ["four_two_single"]),
    ("333355", ["four_two_single"]),
    ("33334455", ["four_two_pair"]),
    ("333444555666", sorted(["plane", "plane_single", "plane_single"])),
    ("44445555", ["four_two_pair", "four_two_pair"]),
    ("33334444", ["four_two_pair", "four_two_pair"]),
    ("2222", ["bomb"]),
    ("3333X", []),
    ("TTJJQQKKAA", ["pair_chain"]),
    ("KKKAAA34", ["plane_single"]),
    ("444555666X89", ["plane_single"]),
    ("3334448899", ["plane_pair"]),
    ("3333XD", []),  # four with both jokers is not four_two_single
    ("333444X5", ["plane_single"]),  # a single joker is a fine wing
    ("33335X", ["four_two_single"]),
]

INVALID = [
    "34",
    "3344",
    "33445",
    "3456",
    "JQKA2",
    "QKA23",
    "33XD",
    "2233",
    "22AAKK",
    "333444XD",
    "334455X",
    "3333XD",
    "333444555XD",
    "3334446",
    "333XD",
    "3333444455XD",
    "TJQKA2",
    "KKAA22",
    "AAA222",
    "33334445",  # 4th card of a plane rank cannot be a wing (docs §3)
    "33344455XD",  # jokers can't be pair wings
    "33334455XD",  # four with two pairs can't use jokers
    "333344445X",  # plane ranks must have exactly 3 cards
]


@pytest.mark.parametrize("s,expected", VALID)
def test_identify_valid(s, expected):
    assert types(s) == expected


@pytest.mark.parametrize("s", INVALID)
def test_identify_invalid(s):
    assert types(s) == []


def test_every_pattern_type_covered():
    seen = set()
    for s, t in VALID:
        seen.update(t)
    from ddz_sdk.rules import PATTERN_TYPES

    assert seen == set(PATTERN_TYPES)


def test_ranks_and_lengths():
    p = identify(c("456789"))[0]
    assert (p.type, p.rank, p.length) == ("straight", "4", 6)
    p = identify(c("99TTJJ"))[0]
    assert (p.type, p.rank, p.length) == ("pair_chain", "9", 3)
    p = identify(c("KKK3"))[0]
    assert (p.type, p.rank, p.length) == ("triple_single", "K", 1)
    p = identify(c("XD"))[0]
    assert (p.type, p.rank) == ("rocket", "RJ")
    assert identify(c("QQQKKK"))[0].to_api() == {
        "type": "plane",
        "rank": "Q",
        "length": 2,
    }


# ---------------------------------------------------------------- beats


def P(s):
    return resolve(c(s))


def test_beats():
    assert beats(P("4"), P("3"))
    assert beats(P("2"), P("A"))
    assert beats(P("X"), P("2"))
    assert beats(P("D"), P("X"))
    assert not beats(P("3"), P("3"))
    assert not beats(P("44"), P("3"))
    assert not beats(P("456789"), P("34567"))
    assert beats(P("45678"), P("34567"))
    assert beats(P("3333"), P("22"))
    assert beats(P("3333"), P("3456789TJQKA"))
    assert beats(P("4444"), P("3333"))
    assert not beats(P("3333"), P("4444"))
    assert beats(P("XD"), P("2222"))
    assert not beats(P("2222"), P("XD"))
    # kickers don't matter, only the main body
    assert beats(P("44433"), P("333AA"))
    assert not beats(P("3332"), P("4445"))


def test_beats_accepts_api_dicts():
    assert beats(
        {"type": "pair", "rank": "6", "length": 1}, {"type": "pair", "rank": "5"}
    )
    assert Pattern.from_api({"type": "bomb", "rank": "2", "length": 1}) == Pattern(
        "bomb", 12, 1
    )


# -------------------------------------------------------------- resolve


def test_resolve_prefers_longest_body_when_leading():
    r = resolve(c("333444555666"))
    assert (r.type, r.length) == ("plane", 4)


def test_resolve_picks_interpretation_that_beats():
    r = resolve(c("444555666777"), Pattern("plane_single", 0, 3))
    assert (r.type, r.main, r.length) == ("plane_single", 2, 3)


def test_resolve_hint():
    r = resolve(c("333444555666"), None, "plane_single")
    assert (r.type, r.main) == ("plane_single", 1)


def test_resolve_errors():
    with pytest.raises(RuleError) as e:
        resolve(c("33"), Pattern("pair", 5, 1))
    assert e.value.code == "CANNOT_BEAT"
    with pytest.raises(RuleError) as e:
        resolve(c("34"))
    assert e.value.code == "INVALID_PATTERN"


def test_is_legal():
    hand = c("3345678")
    assert is_legal(c("34567"), hand)
    assert not is_legal(c("34567"), hand, Pattern("straight", 1, 5))
    assert not is_legal(["9S"], hand)
    assert not is_legal(["3S", "3S"], hand)


# ---------------------------------------------------------- legal moves


def keyset(moves):
    return {
        (
            m.pattern.type,
            m.pattern.main,
            m.pattern.length,
            tuple(sorted(map(rank_of, m.cards))),
        )
        for m in moves
    }


def brute_force(hand, last=None):
    """Enumerate every subset of the hand, identify it, and keep plays that beat ``last``."""
    out = set()
    seen = set()
    for n in range(1, len(hand) + 1):
        for combo in itertools.combinations(hand, n):
            ranks = tuple(sorted(map(rank_of, combo)))
            if ranks in seen:
                continue
            seen.add(ranks)
            for p in identify(list(combo)):
                if last is None or beats(p, last):
                    out.add((p.type, p.main, p.length, ranks))
    return out


def test_legal_moves_simple_lead():
    moves = legal_moves(c("334"))
    assert keyset(moves) == {
        ("single", 0, 1, (0,)),
        ("single", 1, 1, (1,)),
        ("pair", 0, 1, (0, 0)),
    }


def test_legal_moves_follow_includes_bombs_and_rocket():
    hand = c("5566667XD")
    moves = legal_moves(hand, Pattern("pair", 2, 1))  # beat a pair of 5s
    ks = keyset(moves)
    assert ("pair", 3, 1, (3, 3)) in ks
    assert ("pair", 2, 1, (2, 2)) not in ks
    assert ("bomb", 3, 1, (3, 3, 3, 3)) in ks
    assert ("rocket", 14, 1, (13, 14)) in ks
    assert all(m.pattern.type in ("pair", "bomb", "rocket") for m in moves)


def test_legal_moves_nothing_beats_rocket():
    assert legal_moves(c("2222AA"), Pattern("rocket", 14, 1)) == []


def test_legal_moves_same_length_chain_only():
    hand = c("3456789T")
    moves = legal_moves(hand, Pattern("straight", 0, 5))
    assert {(m.pattern.main, m.pattern.length) for m in moves} == {
        (1, 5),
        (2, 5),
        (3, 5),
    }


def test_legal_moves_cards_are_from_hand_and_identify():
    hand = sort_cards(c("33344455567XD"))
    for m in legal_moves(hand):
        assert set(m.cards) <= set(hand)
        assert any(
            p.type == m.pattern.type and p.main == m.pattern.main
            for p in identify(m.cards)
        )


@pytest.mark.parametrize(
    "hand",
    [
        "33344455",
        "333444555666",
        "3333444XD",
        "334455667788",
        "33334455XD",
        "777888999TT",
        "JJJQQQKKK2XD",
    ],
)
def test_legal_moves_match_brute_force_fixed(hand):
    h = c(hand)
    assert keyset(legal_moves(h)) == brute_force(h)


def test_legal_moves_match_brute_force_random():
    rng = random.Random(1234)
    deck = full_deck()
    for _ in range(60):
        hand = rng.sample(deck, rng.randint(5, 12))
        assert keyset(legal_moves(hand)) == brute_force(hand), sort_cards(hand)
        # follow: pick a random play from another random hand as the table
        other = rng.sample(deck, 10)
        table = rng.choice(legal_moves(other)).pattern
        assert keyset(legal_moves(hand, table)) == brute_force(hand, table)


def test_lowest_single():
    assert lowest_single(c("2X5")) == ["5S"]
    assert lowest_single([]) == []
