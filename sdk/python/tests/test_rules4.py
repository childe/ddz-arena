"""4-player rules (ddz_sdk.rules4): cases ported from packages/engine/test/ddz4.test.ts plus a
comparison against reference outputs of the TypeScript engine (tests/data/engine_fixtures.json,
regenerated with tests/data/gen_fixtures.ts)."""

import json
import random
import time
from pathlib import Path

import pytest

from ddz_sdk.cards import (
    contains_all,
    full_deck4,
    parse_short,
    rank_of,
    remove_cards,
    sort_cards,
)
from ddz_sdk.rules import Pattern, RuleError
from ddz_sdk.rules4 import (
    PATTERN_TYPES4,
    beats4,
    identify4,
    is_legal4,
    legal_moves4,
    preferred4,
    resolve4,
)

c = parse_short
FIXTURES = json.loads(
    (Path(__file__).parent / "data" / "engine_fixtures.json").read_text()
)


def types(s):
    return sorted(p.type for p in identify4(c(s)))


def one(s):
    allp = identify4(c(s))
    assert allp, s
    return preferred4(allp)


def P(t, main, length=1):
    return Pattern(t, main, length)


# ------------------------------------------------------------- identify4

VALID = [
    ("3", ["single"]),
    ("D", ["single"]),
    ("33", ["pair"]),
    ("XX", ["pair"]),
    ("DD", ["pair"]),
    ("222", ["triple"]),
    ("3333", ["bomb"]),
    ("33333", ["bomb"]),
    ("333333", ["bomb"]),
    ("3333333", ["bomb"]),
    ("33333333", ["bomb"]),
    ("XXDD", ["rocket"]),
    ("3334", ["triple_single"]),
    ("333X", ["triple_single"]),
    ("33344", ["triple_pair"]),
    ("333XX", ["triple_pair"]),
    ("222DD", ["triple_pair"]),
    ("34567", ["straight"]),
    ("3456789TJQKA", ["straight"]),
    ("334455", ["pair_chain"]),
    ("33445566778899TTJJQQKKAA", ["pair_chain"]),
    ("333444", ["plane"]),
    ("33344456", ["plane_single"]),
    ("33344455", ["plane_single"]),
    ("333444XD", ["plane_single"]),
    ("333444XX", ["plane_single"]),
    ("333444555XDD", ["plane_single"]),
    ("333444555666XXDD", []),  # wings can't be all four jokers
    ("3334445566", ["plane_pair"]),
    ("33344455XX", ["plane_pair"]),
    ("333444555666", ["plane", "plane_single", "plane_single"]),
]


@pytest.mark.parametrize("s,expected", VALID)
def test_identify4_valid(s, expected):
    assert types(s) == sorted(expected)


INVALID = [
    "XD",
    "34",
    "3X",
    "XXD",
    "XXDD3",
    "3333X",  # bomb with a joker
    "33334",  # four with one is not triple_single
    "333344",  # no four-with-two
    "33334455",  # no four-with-two-pairs
    "3456",
    "34562",
    "TJQKA2",
    "3344",
    "QQKKAA22",
    "222AAA",
    "33344445",  # body rank used 4 times
    "3334445555",  # pair wings must be different ranks
    "333444XXDD",  # pair wings can't be all four jokers
    "3334445",
    "3333444",
    "333444566",
]


@pytest.mark.parametrize("s", INVALID)
def test_identify4_invalid(s):
    assert identify4(c(s)) == []


def test_identify4_same_code_twice_and_lengths():
    assert [p.type for p in identify4(["3S", "3S"])] == ["pair"]
    assert identify4(["3S", "3S", "3S"]) == [P("triple", 0)]
    assert identify4(["BJ", "RJ"]) == []
    assert identify4([]) == []
    assert one("77777") == P("bomb", 4, 5)
    assert one("22222222") == P("bomb", 12, 8)
    assert one("XXDD") == P("rocket", 14, 4)
    assert one("456789") == P("straight", 1, 6)
    assert one("445566") == P("pair_chain", 1, 3)
    assert one("333444555666") == P("plane", 0, 4)
    assert one("3334445566") == P("plane_pair", 0, 2)
    assert len(PATTERN_TYPES4) == 12 and "four_two_single" not in PATTERN_TYPES4


# ---------------------------------------------------------------- beats4


def b(x, y):
    return beats4(one(x), one(y))


def test_beats4_same_type():
    assert b("4", "3") and not b("3", "4")
    assert b("D", "X") and b("XX", "22") and b("DD", "XX")
    assert b("45678", "34567") and not b("456789", "34567")
    assert not b("44455", "3339")


def test_beats4_bomb_order():
    order = [
        "3333",
        "2222",
        "33333",
        "22222",
        "333333",
        "222222",
        "3333333",
        "2222222",
        "33333333",
        "22222222",
        "XXDD",
    ]
    for i, x in enumerate(order):
        for j, y in enumerate(order):
            assert b(x, y) == (i > j), (x, y)


def test_bombs_beat_non_bombs():
    assert b("3333", "3456789TJQKA") and b("3333", "DD") and b("XXDD", "3456789TJQKA")
    assert not b("DD", "3333") and not b("33344455566677788899", "3333")
    # API dicts work too
    assert beats4({"type": "bomb", "rank": "3", "length": 5}, one("2222"))


def test_resolve4():
    assert resolve4(c("444555666777"), one("333444555789")) == P("plane_single", 2, 3)
    with pytest.raises(RuleError) as e:
        resolve4(c("444555666777"), one("33344489"))
    assert e.value.code == "CANNOT_BEAT"
    assert resolve4(c("444555666777")) == P("plane", 1, 4)
    with pytest.raises(RuleError) as e:
        resolve4(c("3"), one("4"))
    assert e.value.code == "CANNOT_BEAT"
    with pytest.raises(RuleError) as e:
        resolve4(c("XD"))
    assert e.value.code == "INVALID_PATTERN"
    assert resolve4(c("333444555666"), None, "plane_single") == P("plane_single", 1, 3)
    with pytest.raises(RuleError) as e:
        resolve4(c("333444555666"), None, "straight")
    assert e.value.code == "INVALID_PATTERN"


# --------------------------------------------------------- multiset helpers


def test_multiset_helpers():
    d = full_deck4()
    assert len(d) == 108 and len(set(d)) == 54
    assert all(d.count(x) == 2 for x in set(d))
    assert contains_all(["3S", "3S", "4H"], ["3S", "3S"])
    assert not contains_all(["3S", "4H"], ["3S", "3S"])
    assert not contains_all(["3S", "3S"], ["3S", "3S", "3S"])
    assert not contains_all(["3S"], ["3H"])
    assert contains_all(["3S"], [])
    assert remove_cards(["3S", "3S", "4H", "BJ", "BJ"], ["3S", "BJ"]) == [
        "3S",
        "4H",
        "BJ",
    ]
    assert remove_cards(["3S", "3S"], ["3S", "3S"]) == []
    assert c("33333") == ["3S", "3H", "3C", "3D", "3S"]
    assert is_legal4(["3S", "3S"], ["3S", "3S", "9H"])
    assert not is_legal4(["3S", "3S"], ["3S", "9H"])
    assert not is_legal4(["BJ", "RJ"], ["BJ", "RJ"])


# ----------------------------------------------------------- legal_moves4

RICH = "3334445555556789TT JJQQKK XXDD 22"


def test_legal_moves4_rich_hand():
    hand = c(RICH)
    moves = legal_moves4(hand)
    seen = {m.pattern.type for m in moves}
    assert seen == set(PATTERN_TYPES4)
    bombs = sorted(
        m.pattern.length
        for m in moves
        if m.pattern.type == "bomb" and m.pattern.main == 2
    )
    assert bombs == [4, 5, 6]
    assert any(m.pattern.type == "pair" and m.pattern.main == 13 for m in moves)
    for m in moves:
        assert contains_all(hand, m.cards)
        assert m.pattern in identify4(m.cards)


def test_legal_moves4_following():
    hand = c(RICH)
    assert [m.pattern.type for m in legal_moves4(hand, one("5555555"))] == ["rocket"]
    vs_pair = legal_moves4(hand, one("KK"))
    assert all(beats4(m.pattern, one("KK")) for m in vs_pair)
    assert "pair:13" in ["%s:%d" % (m.pattern.type, m.pattern.main) for m in vs_pair]


def _key(p, cards):
    return "%s:%d:%d:%s" % (
        p.type,
        p.main,
        p.length,
        ",".join(map(str, sorted(rank_of(x) for x in cards))),
    )


def test_legal_moves4_brute_force():
    """Every sub-multiset of a small hand that forms a pattern must be generated."""
    rng = random.Random(7)
    lasts = [None] + [
        one(s)
        for s in [
            "5",
            "66",
            "3334",
            "33344",
            "34567",
            "334455",
            "333444",
            "33344456",
            "3334445566",
            "3333",
            "77777",
            "888",
        ]
    ]
    for i in range(80):
        size = 8 + rng.randrange(3)
        if i % 3 == 0:
            pool = [x for x in full_deck4() if rank_of(x) < 7]
            hand = sort_cards(rng.sample(pool, size - 3) + ["BJ", "BJ", "RJ"])
        else:
            hand = sort_cards(rng.sample(full_deck4(), size))
        last = lasts[i % len(lasts)]
        expected = set()
        n = len(hand)
        for mask in range(1, 1 << n):
            sub = [hand[j] for j in range(n) if mask >> j & 1]
            for p in identify4(sub):
                if last is not None and not beats4(p, last):
                    continue
                expected.add(_key(p, sub))
        got = {_key(m.pattern, m.cards) for m in legal_moves4(hand, last)}
        assert got == expected, hand


def test_legal_moves4_fast_on_33_cards():
    hands = [
        "333444555666777888999TTT JQKA2XXDD",
        "333444555666777888999TTTJJJ QKA2XD",
        "333444555666777 8899TTJJQQKKAA22XD",
        "33344455566677788899TTJJQQKKAA22X",
    ]
    worst = 0.0
    for h in hands:
        cards = c(h)
        assert len(cards) == 33
        t = time.time()
        legal_moves4(cards)
        worst = max(worst, time.time() - t)
    assert worst < 5.0  # ~0.2 s locally


# --------------------------------------------- cross-check with the TS engine


def _pat(p):
    return None if p is None else Pattern(p[0], p[1], p[2])


def test_identify4_matches_engine():
    for case in FIXTURES["identify4"]:
        got = [[p.type, p.main, p.length] for p in identify4(case["cards"])]
        assert got == case["patterns"], case["cards"]


def test_legal_moves4_matches_engine():
    """Same moves (pattern + concrete cards) as legalMoves4 for 160 hands up to 33 cards."""
    for case in FIXTURES["legal_moves4"]:
        last = _pat(case["last"])
        got = sorted(
            "%s:%d:%d:%s"
            % (m.pattern.type, m.pattern.main, m.pattern.length, ",".join(m.cards))
            for m in legal_moves4(case["hand"], last)
        )
        assert got == case["moves"], case["hand"]


def test_resolve4_matches_engine():
    for case in FIXTURES["resolve4"]:
        try:
            p = resolve4(case["cards"], _pat(case["last"]))
            got = [p.type, p.main, p.length]
        except RuleError as e:
            got = e.code
        assert got == case["result"], case
