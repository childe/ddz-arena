"""Offline tests for smart/smart3_bot.py and the smart/ddz3_sim.py simulator."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from ddz3_sim import duplicate, play_game  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402
from smart3_bot import Smart3Bot, decompose  # noqa: E402

from ddz_sdk import GameState  # noqa: E402
from ddz_sdk.cards import parse_short, rank_counts  # noqa: E402


def groups_of(short):
    return sorted(
        (g.type, g.main, g.length)
        for g in decompose(rank_counts(parse_short(short)))[1]
    )


def test_decompose_keeps_bombs_and_chains():
    # 3-7 straight, a bomb of 9s, a triple of Qs with a pair of Ks
    got = groups_of("34567" + "9999" + "QQQKK")
    assert ("straight", 0, 5) in got
    assert ("bomb", 6, 1) in got
    assert ("triple_pair", 9, 1) in got
    assert len(got) == 3


def test_decompose_rocket_and_plane():
    got = groups_of("XD" + "333444" + "56")
    assert ("rocket", 14, 1) in got
    assert ("plane_single", 0, 2) in got


def test_games_are_legal_and_finish():
    stats = {}
    for seed in range(30):
        bots = [Smart3Bot(), GreedyBot(), RandomBot(seed=seed)]
        r = play_game(bots, seed, stats=stats)
        assert sum(r["scores"]) == 0
    assert stats == {}


def test_forced_landlord_game():
    r = play_game([Smart3Bot() for _ in range(3)], 7, forced_landlord=2)
    assert r["landlord"] == 2 and r["high_bid"] == 3


def test_teammate_not_beaten():
    # Seat 1 is the farmer after the landlord; teammate seat 2 led a low single.
    st = GameState(
        game="ddz",
        seat=1,
        hand=parse_short("4456789TJQKA2"),
        phase="playing",
        landlord=0,
        to_beat={
            "seat": 2,
            "cards": ["3S"],
            "pattern": {"type": "single", "rank": "3", "length": 1},
        },
        can_pass=True,
        cards_left=[15, 13, 12],
        history=[{"seat": 2, "cards": ["3S"], "pattern": None}],
    )
    assert Smart3Bot().on_play(st) == []


def test_beats_landlord_close_to_out():
    st = GameState(
        game="ddz",
        seat=1,
        hand=parse_short("44567892"),
        phase="playing",
        landlord=0,
        to_beat={
            "seat": 0,
            "cards": ["KS"],
            "pattern": {"type": "single", "rank": "K", "length": 1},
        },
        can_pass=True,
        cards_left=[2, 8, 12],
        history=[{"seat": 0, "cards": ["KS"], "pattern": None}],
    )
    m = Smart3Bot().on_play(st)
    assert m and m.cards == ["2S"]


def test_duplicate_beats_random():
    res = duplicate(Smart3Bot, RandomBot, range(5))
    assert res["games"] == 15
    assert res["unit_edge"] > 0
