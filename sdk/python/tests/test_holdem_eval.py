"""Hold'em evaluator (ddz_sdk.holdem): cases from packages/engine/test/holdem.test.ts, a randomized
comparison against an independent brute-force reference, and reference outputs of the TypeScript
engine (tests/data/engine_fixtures.json)."""

import itertools
import json
import random
from pathlib import Path

import pytest

from ddz_sdk.holdem import (
    HAND_NAMES,
    card_index,
    compare,
    deck,
    evaluate,
    hand_score,
    score_rank,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "data" / "engine_fixtures.json").read_text()
)


def h(s):
    return s.split(" ")


def test_names_every_category():
    cases = [
        ("AS KD 9C 7H 4S 3D 2C", "high_card"),
        ("AS AD 9C 7H 4S 3D 2C", "pair"),
        ("AS AD 9C 9H 4S 3D 2C", "two_pair"),
        ("AS AD AC 9H 4S 3D 2C", "three_of_a_kind"),
        ("6S 5D 4C 3H 2S KD KC", "straight"),
        ("AS 2D 3C 4H 5S KD KC", "straight"),
        ("AS 9S 7S 4S 2S KD KC", "flush"),
        ("AS AD AC 9H 9S 3D 2C", "full_house"),
        ("AS AD AC AH 9S 3D 2C", "four_of_a_kind"),
        ("9H 8H 7H 6H 5H AS AD", "straight_flush"),
        ("AH 2H 3H 4H 5H KS KD", "straight_flush"),
    ]
    for cards, rank in cases:
        assert evaluate(h(cards))[1] == rank, cards
    assert len(HAND_NAMES) == 9


def test_orders_categories():
    order = [
        hand_score(h(x))
        for x in [
            "AS KD 9C 7H 4S 3D 2C",
            "AS AD 9C 7H 4S 3D 2C",
            "AS AD 9C 9H 4S 3D 2C",
            "AS AD AC 9H 4S 3D 2C",
            "AS 2D 3C 4H 5S KD 9C",
            "AS 9S 7S 4S 2S KD KC",
            "2S 2D 2C 3H 3S 8D 9C",
            "2S 2D 2C 2H 3S 8D 9C",
            "AH 2H 3H 4H 5H KS KD",
        ]
    ]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert [score_rank(s) for s in order] == HAND_NAMES


def test_wheel_and_broadway():
    wheel = hand_score(h("AS 2D 3C 4H 5S 9D 9C"))
    six = hand_score(h("6S 2D 3C 4H 5S 9D 9C"))
    broadway = hand_score(h("AS KD QC JH TS 2D 2C"))
    assert wheel < six < broadway
    assert evaluate(h("AS 2D 3C 4H 5S 9D 9C"))[2] == h("5S 4H 3C 2D AS")
    assert evaluate(h("AS 2D 3C 4H 5S 6D 9C"))[2] == h("6D 5S 4H 3C 2D")
    assert evaluate(h("KS AD 2C 3H 4S 9D 8C"))[1] == "high_card"


def test_kickers_and_best_order():
    assert compare(h("AS AD KC 7H 4S 3D 2C"), h("AH AC QC 7D 4H 3C 2D")) > 0
    assert evaluate(h("AS AD KC KH 4S 4D 2C"))[2] == h("AS AD KH KC 4S")
    assert compare(h("AS AD KC KH QS 4D 2C"), h("AH AC KD KS JS 4H 3C")) > 0
    assert compare(h("7S 7D 7C AH 3S 4D 2C"), h("7H 7S 7D KH QS JD 9C")) > 0
    assert compare(h("AS QS 9S 7S 3S"), h("AH QH 9H 7H 2H")) > 0
    assert evaluate(h("5S 5D 5C 9H 9S 9D 2C"))[2] == h("9S 9H 9D 5S 5D")
    assert compare(h("3S 3D 3C AH AS"), h("2S 2D 2C AD AC")) > 0
    assert compare(h("9S 9D 9C 9H AS 2D 3C"), h("9S 9D 9C 9H KS QD JC")) > 0
    assert compare(h("AS KD 9C 7H 4S 3D 2C"), h("AS KD 9C 7H 4S 3H 2H")) == 0


def test_board_plays():
    board = "AS KS QS JS TS"
    assert compare(h(board + " 2H 3D"), h(board + " 9H 8D")) == 0
    assert evaluate(h(board + " 2H 3D"))[2] == h("AS KS QS JS TS")
    assert compare(h("9S 8D 7C 6H 5S 2H 2D"), h("9S 8D 7C 6H 5S AH KD")) == 0
    assert compare(h("AS AD KC KH 4S QH 2D"), h("AS AD KC KH 4S JH 2D")) > 0


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        hand_score(h("AS AS KD QC JH"))
    with pytest.raises(ValueError):
        hand_score(h("AS KD QC JH"))
    with pytest.raises(ValueError):
        hand_score(h("AS KD QC JH 1H"))
    with pytest.raises(ValueError):
        evaluate(h("AS KD QC JH TH 9H 8H 7H"))
    assert card_index("AD") == 51 and card_index("2S") == 0 and card_index("BJ") == -1
    assert len(set(deck())) == 52


# ------------------------------------------------- brute-force reference


def ref5(cards):
    """Independent 5-card scorer producing the same encoding (category << 20 | nibbles)."""
    ranks = sorted((card_index(c) >> 2 for c in cards), reverse=True)
    suits = {card_index(c) & 3 for c in cards}
    flush = len(suits) == 1
    distinct = sorted(set(ranks), reverse=True)
    straight_high = None
    if len(distinct) == 5:
        if distinct[0] - distinct[4] == 4:
            straight_high = distinct[0]
        elif distinct == [12, 3, 2, 1, 0]:
            straight_high = 3
    groups = sorted(((ranks.count(r), r) for r in distinct), reverse=True)
    shape = [g[0] for g in groups]
    order = [g[1] for g in groups]
    if straight_high is not None and flush:
        cat, nib = 8, [straight_high]
    elif shape == [4, 1]:
        cat, nib = 7, order
    elif shape == [3, 2]:
        cat, nib = 6, order
    elif flush:
        cat, nib = 5, order
    elif straight_high is not None:
        cat, nib = 4, [straight_high]
    elif shape == [3, 1, 1]:
        cat, nib = 3, order
    elif shape == [2, 2, 1]:
        cat, nib = 2, order
    elif shape == [2, 1, 1, 1]:
        cat, nib = 1, order
    else:
        cat, nib = 0, order
    score = cat
    for k in range(5):
        score = (score << 4) | (nib[k] if k < len(nib) else 0)
    return score


def ref_best(cards):
    return max(ref5(list(combo)) for combo in itertools.combinations(cards, 5))


def test_random_hands_match_brute_force():
    rng = random.Random(2024)
    full = deck()
    for i in range(4000):
        n = 5 + i % 3
        if i % 2:
            # narrow pool: more quads / full houses / straight flushes
            lo = rng.randrange(8)
            pool = [c for c in full if lo <= card_index(c) >> 2 < lo + 6]
        else:
            pool = full
        cards = rng.sample(pool, n)
        score, rank, best = evaluate(cards)
        assert score == ref_best(cards), cards
        assert rank == HAND_NAMES[score >> 20]
        assert len(best) == 5 and set(best) <= set(cards)
        assert ref5(best) == score


def test_matches_engine_fixtures():
    for case in FIXTURES["holdem"]:
        score, rank, best = evaluate(case["cards"])
        assert (score, rank, best) == (
            case["score"],
            case["rank"],
            case["best"],
        ), case["cards"]
    ranks = {case["rank"] for case in FIXTURES["holdem"]}
    assert ranks == set(HAND_NAMES)  # the fixture covers every category
