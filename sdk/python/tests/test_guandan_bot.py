"""Offline tests for GuandanBot event tracking, tribute / return, hints and fallbacks."""

from ddz_sdk import ApiError, GuandanBot, GuandanState, Move
from ddz_sdk.rules_gd import GdPattern


class FakeClient:
    def __init__(self, state=None, play_errors=None, return_errors=None):
        self.calls = []
        self.state = state or {}
        self.play_errors = list(play_errors or [])
        self.return_errors = list(return_errors or [])
        self._me = {"bot_id": "b_me", "room_id": "r_1", "seat": 1, "game_id": None}
        self.token = "t"

    def me(self):
        self.calls.append(("me",))
        return self._me

    def game_state(self, gid):
        self.calls.append(("state", gid))
        return self.state

    def ready(self, rid, ready=True):
        self.calls.append(("ready", rid))
        return {}

    def play(self, gid, cards, pattern_type=None, seq=None, pattern_rank=None):
        self.calls.append(("play", gid, list(cards), pattern_type, pattern_rank, seq))
        if self.play_errors:
            raise self.play_errors.pop(0)
        return {"ok": True}

    def return_card(self, gid, card, seq=None):
        self.calls.append(("return", gid, card, seq))
        if self.return_errors:
            raise self.return_errors.pop(0)
        return {"ok": True}


def make_bot(bot_cls=GuandanBot, **kw):
    b = bot_cls()
    b.client = FakeClient(**kw)
    b.bot_id = "b_me"
    b.state.room_id = "r_1"
    b.state.seat = 1
    return b


def ev(seq, type_, data, gid="g_1"):
    return {"type": type_, "seq": seq, "room_id": "r_1", "game_id": gid, "data": data}


def calls(b, kind):
    return [x for x in b.client.calls if x[0] == kind]


PLAYERS = [{"seat": s, "bot_id": "b_me" if s == 1 else "b_%d" % s} for s in range(4)]
# 27 cards for seat 1, level 7 (7H is the wildcard)
HAND = (
    "3S 3H 4S 5S 6S 7H 8D 9C TS JS QS KS AS 2C 2D "
    "4D 5D 6D 9S 9H JC JD QC KC AC BJ RJ"
).split()


def start(b, hand_no=2, level="7", hand=HAND):
    b._handle(
        ev(
            1,
            "game.started",
            {
                "game": "guandan",
                "players": PLAYERS,
                "hand_no": hand_no,
                "level": level,
                "level_team": 1,
                "team_levels": ["2", level],
                "a_attempts": [0, 0],
                "cards_left": [27, 27, 27, 27],
                "hand": list(hand),
            },
        )
    )


def test_game_started_tracking_and_teams():
    b = make_bot()
    start(b)
    st = b.state
    assert len(HAND) == 27
    assert (st.seat, st.level, st.level_team, st.team_levels, st.hand_no) == (
        1,
        "7",
        1,
        ["2", "7"],
        2,
    )
    assert st.teammate == 3 and st.is_teammate(3) and not st.is_teammate(0)
    assert st.opponents() == [2, 0] and st.team == 1 and st.is_level_team
    # sorted by value at level 7: 2s first, the level card (7H) just below the jokers
    assert st.hand[:2] == ["2C", "2D"] and st.hand[-3:] == ["7H", "BJ", "RJ"]
    assert st.wildcard == "7H" and st.wildcards == 1


def test_tribute_receiver_returns_smallest_card():
    b = make_bot()
    start(b)
    b._handle(
        ev(
            2,
            "tribute",
            {"anti": False, "tributes": [{"from": 0, "to": 1, "card": "RJ"}]},
        )
    )
    st = b.state
    assert st.hand.count("RJ") == 2 and len(st.hand) == 28
    assert st.cards_left == [26, 28, 27, 27]
    assert st.phase == "return" and st.return_to == 0
    b._handle(
        ev(
            3,
            "turn",
            {"seat": 1, "phase": "return", "to_beat": None, "can_pass": False},
        )
    )
    b._maybe_act()
    assert calls(b, "return") == [("return", "g_1", "2C", 3)]
    b._maybe_act()  # only once per turn
    assert len(calls(b, "return")) == 1
    b._handle(ev(4, "returned", {"from": 1, "to": 0, "card": "2C"}))
    assert "2C" not in st.hand and len(st.hand) == 27
    assert st.cards_left == [27, 27, 27, 27] and st.return_to is None


def test_tribute_payer_gets_return_card():
    b = make_bot()
    start(b)
    b._handle(
        ev(
            2,
            "tribute",
            {
                "anti": False,
                "tributes": [
                    {"from": 1, "to": 0, "card": "BJ"},
                    {"from": 3, "to": 2, "card": "AS"},
                ],
            },
        )
    )
    st = b.state
    assert "BJ" not in st.hand and len(st.hand) == 26
    b._handle(ev(3, "turn", {"seat": 0, "phase": "return"}))
    b._maybe_act()
    assert calls(b, "return") == []  # not our turn
    b._handle(ev(4, "returned", {"from": 0, "to": 1, "card": "5H"}))
    assert "5H" in st.hand and len(st.hand) == 27 and st.returns[-1]["card"] == "5H"


def test_anti_tribute_changes_nothing():
    b = make_bot()
    start(b)
    b._handle(ev(2, "tribute", {"anti": True, "tributes": []}))
    st = b.state
    assert st.tribute == {"anti": True, "tributes": []}
    assert st.phase == "playing" and len(st.hand) == 27 and st.return_to is None


def test_illegal_return_falls_back():
    class Bad(GuandanBot):
        def on_return(self, state):
            return "7H"  # the wildcard may not be returned

    b = make_bot(Bad)
    start(b)
    b._handle(
        ev(
            2,
            "tribute",
            {"anti": False, "tributes": [{"from": 0, "to": 1, "card": "RJ"}]},
        )
    )
    b._handle(ev(3, "turn", {"seat": 1, "phase": "return"}))
    b._maybe_act()
    assert calls(b, "return") == [("return", "g_1", "2C", 3)]
    assert b.stats["fallbacks"] == 1


def test_return_422_retries_with_fallback():
    class B(GuandanBot):
        def on_return(self, state):
            return state.returnable_cards()[-1]

    b = make_bot(B, return_errors=[ApiError(422, "INVALID_RETURN", "nope")])
    start(b)
    b._handle(
        ev(
            2,
            "tribute",
            {"anti": False, "tributes": [{"from": 0, "to": 1, "card": "RJ"}]},
        )
    )
    b._handle(ev(3, "turn", {"seat": 1, "phase": "return"}))
    b._maybe_act()
    cards = [x[2] for x in calls(b, "return")]
    assert cards == ["TS", "2C"]
    assert "7H" not in b.state.returnable_cards()


def test_move_hint_sends_type_and_rank_and_played_updates_hand():
    class B(GuandanBot):
        def on_play(self, state):
            # 3 4 5 6 + wildcard as the straight 2-6 (not 3-7)
            for m in state.legal_moves():
                if m.pattern.type == "straight" and m.pattern.rank == "6":
                    if "7H" in m.cards and "2C" not in m.cards:
                        return m
            raise AssertionError("move not found")

    b = make_bot(B)
    start(b, hand_no=1)
    b._handle(ev(2, "turn", {"seat": 1, "phase": "playing", "to_beat": None}))
    b._maybe_act()
    play = calls(b, "play")[0]
    assert play[3:] == ("straight", "6", 2)
    assert play[2] == ["3S", "4S", "5S", "6S", "7H"]
    b._handle(
        ev(
            3,
            "played",
            {
                "seat": 1,
                "cards": play[2],
                "pattern": {"type": "straight", "rank": "6", "length": 1},
                "cards_left": [27, 22, 27, 27],
            },
        )
    )
    st = b.state
    assert len(st.hand) == 22 and "7H" not in st.hand
    assert st.to_beat_pattern == GdPattern("straight", 5, 1, "7")


def test_never_bomb_by_default_and_pass_fallback():
    hand = "3S 3H 3C 3D 5S 6S".split()
    b = make_bot()
    start(b, hand=hand)
    st = b.state
    st.cards_left = [27, 6, 27, 27]
    to_beat = {
        "seat": 0,
        "cards": ["AS"],
        "pattern": {"type": "single", "rank": "A", "length": 1},
    }
    b._handle(
        ev(
            2,
            "turn",
            {"seat": 1, "phase": "playing", "to_beat": to_beat, "can_pass": True},
        )
    )
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_1", [], None, None, 2)]


def test_illegal_lead_falls_back_to_lowest_non_wild_single():
    class Bad(GuandanBot):
        def on_play(self, state):
            return ["9S", "9H", "9C", "9D"]  # no 9D in hand

    b = make_bot(Bad)
    start(b)
    b._handle(ev(2, "turn", {"seat": 1, "phase": "playing", "to_beat": None}))
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_1", ["2C"], None, None, 2)]
    assert b.stats["fallbacks"] == 1


def test_wildcard_lead_fallback_only_when_nothing_else():
    b = make_bot(GuandanBot)
    start(b, hand=["7H", "7H"])
    b.state.cards_left = [27, 2, 27, 27]
    assert b._fallback_cards() == ["7H"]
    b.state.hand = ["7H", "AS"]
    assert b._fallback_cards() == ["AS"]


def test_server_422_falls_back():
    class B(GuandanBot):
        def on_play(self, state):
            return ["9S", "9H"]

    b = make_bot(B, play_errors=[ApiError(422, "PATTERN_MISMATCH", "nope")])
    start(b)
    b._handle(ev(2, "turn", {"seat": 1, "phase": "playing", "to_beat": None}))
    b._maybe_act()
    assert [x[2] for x in calls(b, "play")] == [["9S", "9H"], ["2C"]]


def test_hook_exception_falls_back_to_pass():
    class Boom(GuandanBot):
        def on_play(self, state):
            raise RuntimeError("x")

    b = make_bot(Boom)
    start(b)
    tb = {"seat": 2, "cards": ["3D"], "pattern": {"type": "single", "rank": "3"}}
    b._handle(
        ev(2, "turn", {"seat": 1, "phase": "playing", "to_beat": tb, "can_pass": True})
    )
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_1", [], None, None, 2)]


def test_player_out_and_next_seat():
    b = make_bot()
    start(b)
    st = b.state
    b._handle(
        ev(
            2,
            "played",
            {
                "seat": 2,
                "cards": ["AS"],
                "pattern": {"type": "single", "rank": "A", "length": 1},
                "cards_left": [27, 27, 0, 27],
            },
        )
    )
    b._handle(ev(3, "player.out", {"seat": 2, "place": 1}))
    assert st.order == [2] and st.is_out(2)
    assert st.next_seat() == 3 and st.next_seat(1) == 3 and st.next_seat(3) == 0
    assert st.to_beat_pattern.type == "single" and st.to_beat_pattern.rank == "A"
    b._handle(ev(4, "passed", {"seat": 3}))
    assert st.history[-1] == {"seat": 3, "cards": [], "pattern": None}


def test_game_finished_and_resync_from_state():
    view = {
        "game": "guandan",
        "game_id": "g_2",
        "room_id": "r_1",
        "phase": "return",
        "seat": 1,
        "hand_no": 3,
        "level": "T",
        "level_team": 0,
        "team_levels": ["T", "4"],
        "a_attempts": [0, 0],
        "tribute": {"anti": False, "tributes": [{"from": 0, "to": 1, "card": "BJ"}]},
        "returns": [],
        "turn": 1,
        "turn_seq": 9,
        "to_beat": None,
        "can_pass": False,
        "cards_left": [26, 3, 27, 27],
        "order": [],
        "history": [],
        "hand": ["TH", "3S", "BJ"],
        "seq": 9,
    }
    b = make_bot(state=view)
    start(b)
    b._handle(
        ev(2, "game.finished", {"result": {"order": [2, 0, 1, 3], "winner_team": 0}})
    )
    assert b.state.phase == "finished" and b.state.result["winner_team"] == 0
    assert b.games_finished == 1
    # an event for an unknown game: rebuild from GET /games/{gid}/state
    b._handle(ev(10, "turn", {"seat": 1, "phase": "return"}, gid="g_2"))
    st = b.state
    assert isinstance(st, GuandanState)
    assert (st.game_id, st.phase, st.level, st.hand_no, st.turn) == (
        "g_2",
        "return",
        "T",
        3,
        1,
    )
    assert st.hand == ["3S", "TH", "BJ"] and st.return_to == 0
    assert st.wildcard == "TH" and st.returnable_cards() == ["3S"]
    b._maybe_act()
    assert calls(b, "return")[-1] == ("return", "g_2", "3S", 10)


def test_hand_size_mismatch_refreshes():
    view = {
        "game_id": "g_1",
        "phase": "playing",
        "seat": 1,
        "level": "7",
        "hand": ["3S"],
        "turn": 1,
        "turn_seq": 5,
        "to_beat": None,
        "cards_left": [27, 1, 27, 27],
        "seq": 5,
    }
    b = make_bot(state=view)
    start(b)
    b._handle(ev(5, "turn", {"seat": 1, "phase": "playing", "to_beat": None}))
    b.state.cards_left = [27, 1, 27, 27]
    b._maybe_act()
    assert ("state", "g_1") in b.client.calls
    assert calls(b, "play")[-1][2] == ["3S"]


def test_default_on_play_prefers_no_wildcards_and_no_bombs():
    b = make_bot()
    start(b, hand="5S 5H 7H 8S 8H 8C 8D".split())
    st = b.state
    to_beat = {
        "seat": 0,
        "cards": ["4S", "4H"],
        "pattern": {"type": "pair", "rank": "4"},
    }
    st.to_beat, st.can_pass = to_beat, True
    m = b.on_play(st)
    assert isinstance(m, Move) and m.cards == ["5S", "5H"]
    st.to_beat = {
        "seat": 0,
        "cards": ["AS", "AH"],
        "pattern": {"type": "pair", "rank": "A"},
    }
    assert b.on_play(st) == []  # only bombs beat a pair of aces: pass instead
