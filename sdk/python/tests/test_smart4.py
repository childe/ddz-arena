"""Offline tests for smart/smart4_bot.py and the smart/ddz4_sim.py simulator."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from ddz4_sim import duplicate, make_factory, play_game  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402
import pimc  # noqa: E402
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


def test_bid_by_win_chance():
    bot = Smart4Bot()
    strong = parse_short("22222AAAAKKKQQQJJ345") + ["RJ", "RJ", "BJ", "BJ"]
    weak = parse_short("3355779JKQ4468TQ3579JK46")
    assert bot.win_chance(strong) > 0.7
    st = GameState(game="ddz4", seat=0, hand=strong, phase="bidding")
    assert bot.on_bid(st) == 3
    # Someone already bid 1: every cutoff rises by BID_RAISE.
    st = GameState(
        game="ddz4",
        seat=1,
        hand=weak,
        phase="bidding",
        bids=[{"seat": 0, "score": 1}],
        high_bid=1,
    )
    assert bot.win_chance(weak) < 0.5 and bot.on_bid(st) == 0


def test_rollout_pays_the_landlord_three_times():
    # Seat 0 is the landlord and goes out at once with its pair.
    st = GameState(
        game="ddz4",
        seat=0,
        hand=parse_short("KK"),
        phase="playing",
        landlord=0,
        high_bid=1,
        to_beat=None,
        can_pass=False,
        cards_left=[2, 3, 3, 3],
        history=[],
    )
    hands = (tuple(st.hand),) + tuple(
        tuple(parse_short(h)) for h in ("345", "678", "9TJ")
    )
    pair = next(m for m in st.legal_moves() if m.pattern.type == "pair")
    rule = Smart4Bot().rule_move
    assert pimc.rollout(st, hands, pair, rule) == 6  # 3x, doubled for a spring
    assert pimc.rollout(st, hands, pair, rule, win_only=True) == 1


def test_variant_and_monte_carlo_keep_games_legal():
    make = make_factory("smart4:PIMC_SAMPLES=4,PIMC_POOL=8")
    assert make().PIMC_SAMPLES == 4 and Smart4Bot.PIMC_SAMPLES == 0
    stats = {}
    for seed in range(2):
        r = play_game(
            [make(), Smart4Bot(), GreedyBot(), Smart4Bot()], seed, stats=stats
        )
        assert sum(r["scores"]) == 0
    assert stats == {}
