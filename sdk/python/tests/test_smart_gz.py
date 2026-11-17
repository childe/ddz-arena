"""Offline tests for smart/smart_gz_bot.py, examples/gongzhu_bot.py and the smart/gz_sim.py
simulator."""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from gongzhu_bot import GreedyGongzhuBot, RandomGongzhuBot  # noqa: E402
from gz_sim import duplicate, play_hand  # noqa: E402
from smart_gz_bot import (  # noqa: E402
    SmartGongzhuBot,
    score_ints,
    to_int,
    to_str,
)

from ddz_sdk import GongzhuState, rules_gz  # noqa: E402


class Checked:
    """Wraps a bot and asserts every choice is legal and quick."""

    def __init__(self, bot, max_s=1.0):
        self.bot = bot
        self.max_s = max_s

    def choose_expose(self, st):
        cards = self.bot.choose_expose(st)
        assert set(cards) <= set(st.exposable_cards())
        return cards

    def choose_card(self, st):
        t = time.perf_counter()
        card = self.bot.choose_card(st)
        assert time.perf_counter() - t < self.max_s
        assert card in st.legal_cards(), (card, st.hand, st.plays)
        return card


def test_int_cards_and_scoring_match_rules():
    assert all(to_str(to_int(c)) == c for c in rules_gz.DECK)
    cases = [
        (["QS", "TC"], []),
        ([r + "H" for r in "23456789TJQKA"] + ["QS"], ["AH"]),
        (["TC"], ["TC"]),
        (["JD", "5H", "TC"], ["JD", "TC", "QS"]),
    ]
    for taken, ex in cases:
        flags = ("QS" in ex, "JD" in ex, "TC" in ex, "AH" in ex)
        assert score_ints([to_int(c) for c in taken], *flags) == rules_gz.score_taken(
            taken, ex
        )


def test_full_hands_are_legal():
    stats = {}
    for seed in range(6):
        bots = [
            Checked(SmartGongzhuBot(seed=seed, budget=0.05)),
            Checked(GreedyGongzhuBot()),
            Checked(SmartGongzhuBot(seed=seed + 1, budget=0.05)),
            Checked(RandomGongzhuBot(seed=seed)),
        ]
        r = play_hand(bots, seed, stats)
        assert sum(r["scores"]) == 0
    assert stats == {}


def test_respects_voids_and_exposed_cards():
    # Seat 0 is out of spades; seat 2 exposed the pig. Every sampled deal must agree.
    bot = SmartGongzhuBot(seed=3)
    unseen = [to_int(c) for c in rules_gz.DECK if c not in ("2C", "3C")]
    unseen = unseen[:30]
    if to_int("QS") not in unseen:
        unseen.append(to_int("QS"))
    voids = [{"S"}, set(), set(), set()]
    fixed = [[], [], [to_int("QS")], []]
    n = len(unseen)
    need = [n // 3, 0, n // 3, n - 2 * (n // 3)]
    for _ in range(50):
        hands = bot._sample(unseen, need, fixed, voids, 1)
        assert to_int("QS") in hands[2]
        assert all(c // 13 != 0 for c in hands[0])
        assert sorted(c for h in hands for c in h) == sorted(unseen)
        assert [len(h) for h in hands] == need


def test_dumps_pig_when_void():
    # Seat 0 leads KH in the first trick; we have no hearts and an unprotected pig.
    st = GongzhuState(
        seat=1,
        hand=rules_gz.sort_cards_gz("QS KS 2C 3C 4C 5C 6C 2D 3D 4D 5D 6D 7D".split()),
        phase="playing",
        turn=1,
        trick={"leader": 0, "plays": [{"seat": 0, "card": "KH"}], "winner": None},
        cards_left=[12, 13, 13, 13],
    )
    assert SmartGongzhuBot(seed=1).choose_card(st) == "QS"


def test_inconsistent_counts_do_not_crash():
    # cards_left that does not add up (e.g. a stale view) must not break the bot
    st = GongzhuState(
        seat=1,
        hand=["QS", "2S", "3C", "9D"],
        phase="playing",
        turn=1,
        trick={"leader": 0, "plays": [{"seat": 0, "card": "KH"}], "winner": None},
        cards_left=[3, 4, 4, 4],
    )
    assert SmartGongzhuBot(seed=1, budget=0.02).choose_card(st) in st.legal_cards()


def test_candidates_merge_touching_cards():
    st = GongzhuState(seat=0, hand=["2C", "3C", "4C", "9C"], phase="playing")
    unseen = {to_int(c) for c in st.unseen_cards()}
    cands = SmartGongzhuBot._candidates(st, st.hand, unseen)
    assert [to_str(c) for c in cands] == ["2C", "9C"]


def test_expose_policy():
    bot = SmartGongzhuBot()
    safe = GongzhuState(hand="2S 3S 4S 5S 6S QS 2C 3C 4C 5D 6D 7D 8D".split())
    assert bot.choose_expose(safe) == ["QS"]
    risky = GongzhuState(hand="2S 3S 4S 5S AS QS 2C 3C 4C 5D 6D 7D 8D".split())
    assert bot.choose_expose(risky) == []
    goat = GongzhuState(hand="2S 3S TC AH 2C 3C 4C JD AD KD 5D 6D 8D".split())
    assert bot.choose_expose(goat) == [
        "JD"
    ]  # never the transformer, AH only with long hearts


def test_duplicate_beats_greedy():
    res = duplicate(
        lambda: SmartGongzhuBot(seed=7, budget=0.03, max_samples=40),
        GreedyGongzhuBot,
        range(4),
    )
    assert res["stats"] == {}
    assert res["edge"] > 0
