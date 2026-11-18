"""Tests for ddz_sdk.rules_gz: the scoring table of docs/gongzhu.md §2, follow suit, the
exposed-card lock, and a comparison against reference outputs of the TypeScript engine
(tests/data/gz_fixtures.json, made by tests/data/gen_gz_fixtures.ts)."""

import json
from pathlib import Path

import pytest

from ddz_sdk.rules import RuleError
from ddz_sdk.rules_gz import (
    DECK,
    HAND_SIZE_GZ,
    check_play,
    exposable,
    forced_expose,
    heart_points,
    is_scoring,
    legal_cards,
    lowest_safe_card,
    platform_scores,
    rank_of,
    score_taken,
    settle,
    sort_cards_gz,
    trick_winner,
)

FIXTURES_PATH = Path(__file__).parent / "data" / "gz_fixtures.json"
HEARTS = [r + "H" for r in "23456789TJQKA"]
ALL_SCORING = HEARTS + ["QS", "JD", "TC"]


def test_deck_and_cards():
    assert len(DECK) == 52 and len(set(DECK)) == 52
    assert sum(1 for c in DECK if is_scoring(c)) == 16
    assert rank_of("2S") == 2 and rank_of("TS") == 10 and rank_of("AD") == 14
    assert sort_cards_gz(["2D", "AS", "3H", "2S", "TC"]) == [
        "2S",
        "AS",
        "3H",
        "TC",
        "2D",
    ]
    assert exposable(["TC", "AH", "2S", "QS"]) == ["QS", "TC", "AH"]


def test_forced_expose():
    hands = [["QS", "2C"], ["AH"], ["TC", "JD"], ["3D"]]
    assert forced_expose(hands, [["QS"], [], ["TC", "JD"], []]) == (1, "AH")
    assert forced_expose(hands, [["QS"], ["AH"], ["TC"], []]) == (2, "JD")
    assert forced_expose(hands, [["QS"], [], ["TC"], []]) is None
    assert forced_expose(hands, [["QS"], ["AH"], ["TC", "JD"], []]) is None


def test_heart_values():
    values = {c: heart_points(c) for c in HEARTS}
    assert values["AH"] == -50 and values["KH"] == -40
    assert values["QH"] == -30 and values["JH"] == -20
    assert [values[r + "H"] for r in "56789T"] == [-10] * 6
    assert [values[r + "H"] for r in "234"] == [0] * 3
    assert sum(values.values()) == -200
    assert heart_points("AS") == 0


@pytest.mark.parametrize(
    "taken, exposed, points",
    [
        ([], [], 0),
        (["QS"], [], -100),
        (["JD"], [], 100),
        (["TC"], [], 50),  # transformer alone
        (["TC", "2H"], [], 0),  # 2H counts as "another scoring card": 0 x 2
        (["TC", "QS"], [], -200),
        (["TC", "JD", "AH"], [], 100),  # (100 - 50) x 2
        (["AH", "KH", "QH", "JH"], [], -140),
        (["5H", "TH", "4H"], [], -20),
        (HEARTS, [], 200),  # 全红
        (HEARTS + ["QS"], [], 300),  # 全红 turns the pig into +100
        (ALL_SCORING, [], 800),  # 全收 (200 + 100 + 100) x 2
        # exposed cards double their own effect, whoever exposed them
        (["QS"], ["QS"], -200),
        (["JD"], ["JD"], 200),
        (["TC"], ["TC"], 100),
        (["TC", "QS"], ["TC"], -400),
        (["AH", "5H"], ["AH"], -120),
        (HEARTS, ["AH"], 400),
        (HEARTS + ["QS"], ["QS", "AH"], 600),
        (ALL_SCORING, ["QS", "JD", "TC", "AH"], (400 + 200 + 200) * 4),
        (["JD"], ["QS", "AH"], 100),  # other exposures do not touch the goat
    ],
)
def test_score_table(taken, exposed, points):
    assert score_taken(taken, exposed) == points


def test_settle_and_platform_scores():
    taken = [["QS"], ["AH", "KH"], ["JD", "TC"], []]
    r = settle(taken, [[], ["AH"], [], []], totals=[-950, 0, 0, 0])
    assert r["points"] == [-100, -180, 200, 0]
    assert r["totals_after"] == [-1050, -180, 200, 0]
    assert r["losers"] == [0] and r["match_over"] is True
    assert r["pig"] == 0 and r["all_hearts"] is None
    assert r["scores"] == [-32, -64, 88, 8]
    assert platform_scores([-100, -150, 200, -50]) == [-30, -50, 90, -10]


def test_follow_suit():
    hand = ["2S", "9S", "3H", "KC", "4D"]
    assert legal_cards(hand, "S") == ["2S", "9S"]
    assert legal_cards(hand, "H") == ["3H"]
    assert legal_cards(["2S", "KC"], "H") == ["2S", "KC"]  # void: anything
    assert legal_cards(hand) == hand  # leading: anything
    with pytest.raises(RuleError) as e:
        check_play("KC", hand, "S")
    assert e.value.code == "MUST_FOLLOW_SUIT"
    with pytest.raises(RuleError) as e:
        check_play("AS", hand, None)
    assert e.value.code == "CARDS_NOT_IN_HAND"
    with pytest.raises(RuleError) as e:
        check_play("ZZ", hand, None)
    assert e.value.code == "UNKNOWN_CARD"
    check_play("3H", hand, "H")
    check_play("KC", ["2S", "KC"], "H")


def test_exposed_card_locked_in_first_round_of_its_suit():
    hand = ["5S", "QS", "AH", "3C"]
    ex = ["QS", "AH"]
    # lead: QS locked (another spade in hand), AH free (only heart)
    assert legal_cards(hand, None, ex) == ["5S", "AH", "3C"]
    # follow spades in the first spade round: QS locked
    assert legal_cards(hand, "S", ex) == ["5S"]
    with pytest.raises(RuleError) as e:
        check_play("QS", hand, "S", ex)
    assert e.value.code == "EXPOSED_CARD_LOCKED"
    # once spades have been led in an earlier trick the pig is free
    assert legal_cards(hand, "S", ex, {"S"}) == ["5S", "QS"]
    # discarding an exposed card on another suit's trick is always allowed
    assert legal_cards(hand, "D", ex) == hand
    check_play("QS", hand, "D", ex)
    # the only card of its suit may always be played
    assert legal_cards(["QS", "3C"], "S", ["QS"]) == ["QS"]


def test_trick_winner():
    assert trick_winner([(0, "5S"), (1, "KS"), (2, "AH"), (3, "9S")]) == 1
    assert trick_winner([(2, "2D"), (3, "AS"), (0, "AC"), (1, "3D")]) == 1
    plays = [{"seat": 3, "card": "TC"}, {"seat": 0, "card": "JC"}]
    assert trick_winner(plays) == 0
    assert trick_winner([(1, "4H")]) == 1


def test_lowest_safe_card_matches_timeout_rule():
    assert lowest_safe_card(["2H", "5S", "3C"]) == "3C"
    assert lowest_safe_card(["QS", "AH", "2H"]) == "2H"
    assert lowest_safe_card(["4S", "4D"]) == "4S"


# ---------------------------------------------------------------- engine fixtures
def _fixtures():
    if not FIXTURES_PATH.exists():
        pytest.skip("tests/data/gz_fixtures.json missing (see gen_gz_fixtures.ts)")
    return json.loads(FIXTURES_PATH.read_text())


def test_score_taken_matches_engine():
    fx = _fixtures()
    for case in fx["score_taken"]:
        assert score_taken(case["taken"], case["exposed"]) == case["points"], case


def test_settle_matches_engine():
    fx = _fixtures()
    for case in fx["settle"]:
        r = settle(case["taken"], case["exposed"], case["totals"])
        assert r == case["result"], case


def test_whole_hands_match_engine():
    """Replay engine hands: legal cards before every play, trick winners, the result."""
    fx = _fixtures()
    for g in fx["games"]:
        hands = [list(h) for h in g["hands"]]
        assert all(len(h) == HAND_SIZE_GZ for h in hands)
        exposed = g["exposed"]
        for s in range(4):
            assert all(c in exposable(g["hands"][s]) for c in exposed[s])
        f = g["forced"]
        chosen = [[c for c in e if not f or c != f["card"]] for e in exposed]
        want = (f["seat"], f["card"]) if f else None
        assert forced_expose(g["hands"], chosen) == want
        led_before = set()
        trick = []
        taken = [[], [], [], []]
        for p in g["plays"]:
            seat, card = p["seat"], p["card"]
            led = trick[0][1][1] if trick else None
            ours = legal_cards(hands[seat], led, exposed[seat], led_before)
            accepted = [c for c in p["legal"] if c not in p["rejected"]]
            assert ours == accepted, (g["first_leader"], p)
            check_play(card, hands[seat], led, exposed[seat], led_before)
            for c in p["rejected"]:
                with pytest.raises(RuleError):
                    check_play(c, hands[seat], led, exposed[seat], led_before)
            hands[seat].remove(card)
            trick.append((seat, card))
            if len(trick) == 4:
                w = trick_winner(trick)
                assert w == p["winner"]
                taken[w] += [c for _, c in trick if is_scoring(c)]
                led_before.add(trick[0][1][1])
                trick = []
            else:
                assert p["winner"] is None
        totals = g["match"]["totals"]
        r = settle(taken, exposed, totals)
        assert r == g["result"]
