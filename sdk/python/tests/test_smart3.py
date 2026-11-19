"""Offline tests for smart/smart3_bot.py and the smart/ddz3_sim.py simulator."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "smart"))

from ddz3_sim import duplicate, make_factory, play_game  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402
import pimc  # noqa: E402
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


class RulesOnly(Smart3Bot):
    PIMC_SAMPLES = 0


def test_games_are_legal_and_finish():
    stats = {}
    for seed in range(30):
        bots = [RulesOnly(), GreedyBot(), RandomBot(seed=seed)]
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
    res = duplicate(RulesOnly, RandomBot, range(5))
    assert res["games"] == 15
    assert res["unit_edge"] > 0


def test_variant_sets_attributes_and_runs_in_workers():
    make = make_factory("smart3:LEAD_GUARD=0,KEEP_BOSS=false,BOMB_REST_COST=0.5")
    bot = make()
    assert (bot.LEAD_GUARD, bot.KEEP_BOSS, bot.BOMB_REST_COST) == (0, False, 0.5)
    assert Smart3Bot.LEAD_GUARD == 2  # the class itself is unchanged
    res = duplicate(make, make_factory("smart3"), range(2), jobs=2)
    assert res["games"] == 6


def test_keeps_boss_when_landlord_is_close_to_out():
    # Farmer with 7 7 8 A + small joker; the big joker is gone and the landlord has 2 cards.
    # From replay g_9f126dae2d10 (the landlord holds 2 2). Leading the joker or the pair
    # loses; a single makes the landlord split the pair, and the kept joker wins the lead back.
    st = GameState(
        game="ddz",
        seat=1,
        hand=parse_short("778A") + ["BJ"],
        phase="playing",
        landlord=2,
        to_beat=None,
        can_pass=False,
        cards_left=[11, 5, 2],
        history=[{"seat": 2, "cards": ["RJ"], "pattern": None}],
    )
    m = Smart3Bot().on_play(st)
    assert m.pattern.type == "single" and m.cards != ["BJ"]


def test_endgame_search_finds_the_winning_lead():
    # The g_9f126dae2d10 position with a full card history: the landlord has 2 cards,
    # 13 cards are unseen. Without KEEP_BOSS the rules lead the small joker and lose;
    # the endgame search leads a single that wins (8 or A).
    deck = [r + s for r in "3456789TJQKA2" for s in "SHCD"] + ["BJ", "RJ"]
    mine = ["7S", "7H", "8S", "AS", "BJ"]
    hidden = "3S 3H 4S 5S 6S 7C 8H 9S TS JS QS 2S 2H".split()
    played = [c for c in deck if c not in mine + hidden and c != "RJ"]
    st = GameState(
        game="ddz",
        seat=1,
        hand=mine,
        phase="playing",
        landlord=2,
        to_beat=None,
        can_pass=False,
        cards_left=[11, 5, 2],
        history=[
            {"seat": 0, "cards": played, "pattern": None},
            {"seat": 2, "cards": ["RJ"], "pattern": None},
        ],
    )

    class Rules(Smart3Bot):
        KEEP_BOSS = False
        ENDGAME_TOTAL = 0
        PIMC_SAMPLES = 0

    class Search(Smart3Bot):
        KEEP_BOSS = False

    assert Rules().on_play(st).cards == ["BJ"]
    assert Search().on_play(st).cards in (["8S"], ["AS"])


def test_bid_by_win_chance():
    bot = Smart3Bot()
    strong = parse_short("2222AAKKQ3456789") + ["RJ"]
    weak = parse_short("33445667899TJQKA5")
    assert bot.win_chance(strong) > 0.8 > 0.3 > bot.win_chance(weak)
    st = GameState(game="ddz", seat=0, hand=strong, phase="bidding")
    assert bot.on_bid(st) == 3
    st = GameState(game="ddz", seat=0, hand=weak, phase="bidding")
    assert bot.on_bid(st) == 0


def test_rollout_finishes_the_game():
    # Seat 1 can go out at once by leading its pair; any other lead gives the game away.
    st = GameState(
        game="ddz",
        seat=1,
        hand=parse_short("KK"),
        phase="playing",
        landlord=0,
        to_beat=None,
        can_pass=False,
        cards_left=[1, 2, 5],
        history=[],
    )
    hands = (("2S",), tuple(st.hand), tuple(parse_short("34567")))
    pair, single = None, None
    for m in st.legal_moves():
        if m.pattern.type == "pair":
            pair = m
        else:
            single = m
    rule = Smart3Bot().rule_move
    assert pimc.rollout(st, hands, pair, rule, win_only=True) == 1
    assert pimc.rollout(st, hands, single, rule, win_only=True) == -1
    # Landlord-side stake: a farmer win against a bid of 1 with no bombs is +1.
    assert pimc.rollout(st, hands, pair, rule) == 1


def test_monte_carlo_keeps_games_legal():
    class Quick(Smart3Bot):
        PIMC_SAMPLES = 4
        PIMC_POOL = 8

    stats = {}
    for seed in range(4):
        r = play_game([Quick(), Smart3Bot(), GreedyBot()], seed, stats=stats)
        assert sum(r["scores"]) == 0
    assert stats == {}
