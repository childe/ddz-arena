"""Offline tests for smart/smart4_bot.py and the smart/ddz4_sim.py simulator."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from ddz4_sim import duplicate, play_game  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402
from smart4_bot import Smart4Bot, decompose  # noqa: E402

from ddz_sdk import GameState  # noqa: E402
from ddz_sdk.cards import parse_short, rank_counts  # noqa: E402


def groups_of(short):
    return sorted(
        (g.type, g.main, g.length)
        for g in decompose(rank_counts(parse_short(short)))[1]
    )


def test_decompose_keeps_bombs_and_chains():
    # 3-7 straight, a bomb of 9s, a pair of Ks with a triple of Qs
    got = groups_of("34567" + "9999" + "QQQKK")
    assert ("straight", 0, 5) in got
    assert ("bomb", 6, 4) in got
    assert ("triple_pair", 9, 1) in got
    assert len(got) == 3


def test_decompose_rocket_and_plane():
    got = groups_of("XXDD" + "333444" + "56")
    assert ("rocket", 14, 4) in got
    assert ("plane_single", 0, 2) in got


def test_games_are_legal_and_finish():
    stats = {}
    for seed in range(30):
        bots = [Smart4Bot(), GreedyBot(), Smart4Bot(), RandomBot(seed=seed)]
        r = play_game(bots, seed, stats=stats)
        assert sum(r["scores"]) == 0
    assert stats == {}


def test_forced_landlord_game():
    r = play_game([Smart4Bot() for _ in range(4)], 7, forced_landlord=2)
    assert r["landlord"] == 2 and r["high_bid"] == 3


def test_teammate_not_beaten():
    # Seat 1 is a farmer; teammate seat 2 led a low single. Smart4 passes.
    st = GameState(
        game="ddz4",
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
        cards_left=[30, 13, 20, 25],
        history=[{"seat": 2, "cards": ["3S"], "pattern": None}],
    )
    assert Smart4Bot().on_play(st) == []


def test_beats_landlord_close_to_out():
    st = GameState(
        game="ddz4",
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
        cards_left=[2, 8, 20, 25],
        history=[{"seat": 0, "cards": ["KS"], "pattern": None}],
    )
    m = Smart4Bot().on_play(st)
    assert m and m.cards == ["2S"]


def test_duplicate_beats_random():
    res = duplicate(Smart4Bot, RandomBot, range(5))
    assert res["games"] == 20
    assert res["unit_edge"] > 0
