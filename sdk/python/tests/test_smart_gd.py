"""Offline tests for smart/smart_gd_bot.py and the smart/gd_sim.py simulator."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from gd_sim import duplicate, play_hand  # noqa: E402
from guandan_bot import GreedyGuandanBot, RandomGuandanBot  # noqa: E402
from smart_gd_bot import SmartGuandanBot, decompose  # noqa: E402

from ddz_sdk import GuandanState  # noqa: E402
from ddz_sdk.cards import parse_short  # noqa: E402


def test_decompose_uses_wildcard_for_bomb():
    # level 7: 999 plus one wildcard should become a bomb of four 9s
    counts = [0] * 15
    for n in (7, 7, 7):  # natural index of "9"
        counts[n] += 1
    cost, groups = decompose(counts, 1, 5)
    assert any(g.type == "bomb" and g.size == 4 for g in groups)


def test_hands_are_legal_and_finish():
    stats = {}
    for seed in range(20):
        bots = [
            SmartGuandanBot(),
            GreedyGuandanBot(),
            SmartGuandanBot(),
            RandomGuandanBot(),
        ]
        r = play_hand(bots, seed, stats)
        assert r["upgrade"] in (1, 2, 3)
    assert stats == {}


def test_return_is_returnable():
    st = GuandanState(
        seat=0, hand=parse_short("2345TJQKA") + ["BJ"], phase="return", level="7"
    )
    card = SmartGuandanBot().on_return(st)
    assert card in st.returnable_cards()


def test_duplicate_beats_random():
    res = duplicate(SmartGuandanBot, RandomGuandanBot, range(5))
    assert res["edge"] > 0
