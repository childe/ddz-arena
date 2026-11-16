"""Offline tests for HoldemBot / HoldemState event tracking and fallbacks (no server needed)."""

import pytest

from ddz_sdk import Action, ApiError, HoldemBot, HoldemState


class FakeClient:
    def __init__(self, state=None, action_errors=None, me=None):
        self.calls = []
        self.state = state or {}
        self.action_errors = list(action_errors or [])
        self._me = me or {
            "bot_id": "b_me",
            "room_id": "r_1",
            "seat": 2,
            "game_id": None,
        }
        self.token = "t"

    def me(self):
        self.calls.append(("me",))
        return self._me

    def game_state(self, gid):
        self.calls.append(("state", gid))
        if isinstance(self.state, Exception):
            raise self.state
        return self.state

    def ready(self, rid, ready=True):
        self.calls.append(("ready", rid))
        return {}

    def action(self, gid, action, amount=None, seq=None):
        self.calls.append(("action", gid, action, amount, seq))
        if self.action_errors:
            raise self.action_errors.pop(0)
        return {"ok": True, "seq": seq}


def make_bot(bot_cls=HoldemBot, **kw):
    b = bot_cls()
    b.client = FakeClient(**kw)
    b.bot_id = "b_me"
    b.state.room_id = "r_1"
    b.state.seat = 2
    return b


def ev(seq, type_, data, gid="g_1"):
    return {"type": type_, "seq": seq, "room_id": "r_1", "game_id": gid, "data": data}


def actions(b):
    return [c[1:] for c in b.client.calls if c[0] == "action"]


# 6-seat table, seats 0, 2, 4 play; button 0, SB 2 (me), BB 4.
PLAYERS = [
    {"seat": 0, "bot_id": "b_a", "name": "a"},
    {"seat": 2, "bot_id": "b_me", "name": "me"},
    {"seat": 4, "bot_id": "b_c", "name": "c"},
]


def start(b, hole=("AS", "AD")):
    b._handle(
        ev(
            1,
            "game.started",
            {
                "players": PLAYERS,
                "button": 0,
                "small_blind_seat": 2,
                "big_blind_seat": 4,
                "small_blind": 1,
                "big_blind": 2,
                "stacks": [200, None, 199, None, 198, None],
                "bets": [0, None, 1, None, 2, None],
                "pot": 3,
                "hole": list(hole),
            },
        )
    )


def turn(seq, seat, **kw):
    d = {
        "seat": seat,
        "deadline": 0,
        "remaining_ms": 15000,
        "phase": "preflop",
        "to_call": 2,
        "can_check": False,
        "min_raise_to": 4,
        "max_raise_to": 200,
        "current_bet": 2,
        "pot": 3,
    }
    d.update(kw)
    return ev(seq, "turn", d)


def test_tracks_hand_and_acts_only_on_own_turn():
    seen = []

    class B(HoldemBot):
        def on_action(self, state):
            seen.append((state.to_call, state.min_raise_to, list(state.hole)))
            return Action.raise_to(6)

    b = make_bot(B)
    start(b)
    st = b.state
    assert st.phase == "preflop" and st.hole == ["AS", "AD"] and st.in_hand
    assert st.stacks == [200, None, 199, None, 198, None]
    assert st.committed == [0, None, 1, None, 2, None]
    assert st.folded == [False, None, False, None, False, None]
    assert [h["action"] for h in st.history] == ["small_blind", "big_blind"]
    assert st.current_bet == 2 and st.pot == 3 and st.my_stack == 199 and st.my_bet == 1
    b._handle(turn(2, 0, to_call=2))
    b._maybe_act()
    assert actions(b) == []
    b._handle(
        ev(
            3,
            "acted",
            {
                "seat": 0,
                "phase": "preflop",
                "action": "call",
                "amount": 2,
                "all_in": False,
                "auto": False,
                "stack": 198,
                "bet": 2,
                "pot": 5,
            },
        )
    )
    assert st.stacks[0] == 198 and st.bets[0] == 2 and st.committed[0] == 2
    assert st.pot == 5
    b._handle(turn(4, 2, to_call=1, min_raise_to=4, max_raise_to=200, pot=5))
    b._maybe_act()
    assert actions(b) == [("g_1", "raise", 6, 4)]
    assert seen == [(1, 4, ["AS", "AD"])]
    b._maybe_act()  # one action per turn
    assert len(actions(b)) == 1


def test_acted_board_and_fold_updates():
    b = make_bot()
    start(b)
    st = b.state
    b._handle(
        ev(
            2,
            "acted",
            {
                "seat": 0,
                "phase": "preflop",
                "action": "raise",
                "amount": 6,
                "all_in": False,
                "stack": 194,
                "bet": 6,
                "pot": 9,
            },
        )
    )
    b._handle(
        ev(
            3,
            "acted",
            {
                "seat": 2,
                "phase": "preflop",
                "action": "fold",
                "amount": 0,
                "all_in": False,
                "stack": 199,
                "bet": 1,
                "pot": 9,
            },
        )
    )
    b._handle(
        ev(
            4,
            "acted",
            {
                "seat": 4,
                "phase": "preflop",
                "action": "call",
                "amount": 4,
                "all_in": False,
                "stack": 194,
                "bet": 6,
                "pot": 13,
            },
        )
    )
    assert st.folded == [False, None, True, None, False, None]
    assert st.committed == [6, None, 1, None, 6, None]
    assert st.current_bet == 6 and st.active_seats() == [0, 4]
    assert st.opponents() == [0, 4]
    b._handle(
        ev(
            5,
            "board",
            {"phase": "flop", "cards": ["KS", "7D", "2C"], "board": ["KS", "7D", "2C"]},
        )
    )
    assert st.phase == "flop" and st.board == ["KS", "7D", "2C"]
    assert st.bets == [0, None, 0, None, 0, None] and st.current_bet == 0
    assert st.hand_value()[1] == "pair"  # AA + K72
    b._handle(
        ev(
            6,
            "board",
            {"phase": "turn", "cards": ["AH"], "board": ["KS", "7D", "2C", "AH"]},
        )
    )
    assert st.hand_value()[1] == "three_of_a_kind"
    assert [h["action"] for h in st.history][-3:] == ["raise", "fold", "call"]


@pytest.mark.parametrize(
    "ret,expected",
    [
        (("call", None), ("call", None)),
        ("fold", ("fold", None)),
        (Action.call(), ("call", None)),
        (["raise", 10], ("raise", 10)),
        (("raise", 200), ("raise", 200)),
    ],
)
def test_return_forms(ret, expected):
    class B(HoldemBot):
        def on_action(self, state):
            return ret

    b = make_bot(B)
    start(b)
    b._handle(turn(2, 2, to_call=1))
    b._maybe_act()
    assert actions(b) == [("g_1",) + expected + (2,)]
    assert b.stats["fallbacks"] == 0


def test_call_with_nothing_to_call_is_sent_as_check():
    class B(HoldemBot):
        def on_action(self, state):
            return "call"

    b = make_bot(B)
    start(b)
    b._handle(turn(2, 2, to_call=0, can_check=True))
    b._maybe_act()
    assert actions(b) == [("g_1", "check", None, 2)]
    assert b.stats["fallbacks"] == 0


@pytest.mark.parametrize(
    "ret,turn_kw,expected",
    [
        (("check", None), {"to_call": 1}, "fold"),  # can't check facing a bet
        (("raise", 3), {"to_call": 1}, "fold"),  # below min_raise_to
        (("raise", 201), {"to_call": 0, "can_check": True}, "check"),  # above max
        (("raise", 5.5), {"to_call": 0, "can_check": True}, "check"),  # not an integer
        (
            ("raise", 10),
            {"to_call": 1, "min_raise_to": None, "max_raise_to": None},
            "fold",
        ),
        (("bet", 10), {"to_call": 0, "can_check": True}, "check"),  # unknown action
        (None, {"to_call": 0, "can_check": True}, "check"),
    ],
)
def test_illegal_returns_fall_back(ret, turn_kw, expected):
    class B(HoldemBot):
        def on_action(self, state):
            return ret

    b = make_bot(B)
    start(b)
    b._handle(turn(2, 2, **turn_kw))
    b._maybe_act()
    assert actions(b) == [("g_1", expected, None, 2)]
    assert b.stats["fallbacks"] == 1


def test_hook_exception_falls_back_and_default_hook():
    class Boom(HoldemBot):
        def on_action(self, state):
            raise RuntimeError("bug")

    b = make_bot(Boom)
    start(b)
    b._handle(turn(2, 2, to_call=0, can_check=True))
    b._maybe_act()
    assert actions(b) == [("g_1", "check", None, 2)]
    assert b.stats["fallbacks"] == 1
    d = make_bot()  # default: check else fold
    start(d)
    d._handle(turn(2, 2, to_call=1))
    d._maybe_act()
    assert actions(d) == [("g_1", "fold", None, 2)]


def test_server_422_falls_back_and_429_is_retried():
    class B(HoldemBot):
        def on_action(self, state):
            return Action.raise_to(50)

    rl = ApiError(429, "RATE_LIMITED", "slow down")
    b = make_bot(B, action_errors=[rl, ApiError(422, "BAD_AMOUNT", "no")])
    start(b)
    b._handle(turn(2, 2, to_call=0, can_check=True))
    b._maybe_act()
    assert actions(b) == [
        ("g_1", "raise", 50, 2),
        ("g_1", "raise", 50, 2),
        ("g_1", "check", None, 2),
    ]
    assert b.stats["fallbacks"] == 1
    assert b.api_errors == {"429 RATE_LIMITED": 1, "422 BAD_AMOUNT": 1}


def test_stale_seq_conflict_refreshes_instead_of_retrying():
    state = {
        "game_id": "g_1",
        "phase": "flop",
        "seat": 2,
        "turn": 4,
        "turn_seq": 9,
        "players": PLAYERS,
        "hole": ["AS", "AD"],
        "seq": 10,
    }
    b = make_bot(state=state, action_errors=[ApiError(409, "STALE_SEQ", "old")])
    start(b)
    b._handle(turn(2, 2, to_call=0, can_check=True))
    b._maybe_act()
    assert len(actions(b)) == 1 and ("state", "g_1") in b.client.calls
    assert b.state.turn == 4 and b.state.seq == 10


def test_resync_rebuilds_from_state_with_legal_block():
    state = {
        "game_id": "g_2",
        "room_id": "r_1",
        "game": "holdem",
        "phase": "turn",
        "players": PLAYERS,
        "turn": 2,
        "turn_seq": 40,
        "button": 0,
        "small_blind_seat": 2,
        "big_blind_seat": 4,
        "small_blind": 1,
        "big_blind": 2,
        "board": ["KS", "7D", "2C", "AH"],
        "pot": 40,
        "current_bet": 10,
        "min_raise_to": 20,
        "stacks": [180, None, 190, None, 180, None],
        "bets": [10, None, 0, None, 10, None],
        "committed": [20, None, 10, None, 20, None],
        "folded": [False, None, False, None, False, None],
        "all_in": [False, None, False, None, False, None],
        "history": [
            {
                "seat": 2,
                "phase": "preflop",
                "action": "small_blind",
                "amount": 1,
                "all_in": False,
            }
        ],
        "seq": 41,
        "seat": 2,
        "hole": ["AS", "AD"],
        "legal": {
            "phase": "turn",
            "to_call": 10,
            "can_check": False,
            "min_raise_to": 20,
            "max_raise_to": 190,
            "current_bet": 10,
            "pot": 40,
        },
    }

    class B(HoldemBot):
        def on_action(self, state):
            assert state.hand_value()[1] == "three_of_a_kind"
            return Action.raise_to(state.max_raise_to)

    b = make_bot(
        B,
        state=state,
        me={"bot_id": "b_me", "room_id": "r_1", "seat": 2, "game_id": "g_2"},
    )
    b._handle({"type": "resync", "room_id": "r_1", "game_id": "g_2"})
    st = b.state
    assert st.game_id == "g_2" and st.phase == "turn" and st.seq == 41
    assert st.to_call == 10 and st.min_raise_to == 20 and st.max_raise_to == 190
    assert st.committed == [20, None, 10, None, 20, None] and b.game_type == "holdem"
    b._maybe_act()
    assert actions(b) == [("g_2", "raise", 190, 41)]
    # replayed older events are ignored
    b._handle(turn(30, 2, phase="preflop"))
    assert st.phase == "turn"


def test_turn_of_unknown_game_resyncs_first():
    state = {
        "game_id": "g_7",
        "phase": "preflop",
        "players": PLAYERS,
        "turn": 2,
        "turn_seq": 5,
        "seat": 2,
        "hole": ["7S", "2D"],
        "stacks": [200, None, 199, None, 198, None],
        "bets": [0, None, 1, None, 2, None],
        "current_bet": 2,
        "seq": 5,
        "legal": {
            "to_call": 1,
            "can_check": False,
            "min_raise_to": 4,
            "max_raise_to": 200,
        },
    }
    b = make_bot(state=state)
    b._handle(turn(5, 2, to_call=1) | {"game_id": "g_7"})
    assert b.state.game_id == "g_7" and b.state.hole == ["7S", "2D"]
    b._maybe_act()
    assert actions(b) == [("g_7", "fold", None, 5)]


def test_not_dealt_in_never_acts():
    b = make_bot()
    b.bot_id = "b_late"
    b.state.seat = 5  # sat down mid-hand: not among the players of this hand
    start(b)
    assert not b.state.in_hand
    b._handle(
        turn(2, 5, to_call=0, can_check=True)
    )  # (cannot really happen) still ignored
    b._maybe_act()
    assert actions(b) == []


def test_not_a_player_refresh_is_quiet():
    b = make_bot(
        state=ApiError(403, "NOT_A_PLAYER", "no"),
        me={"bot_id": "b_me", "room_id": "r_1", "seat": 5, "game_id": "g_1"},
    )
    b._refresh_state()
    assert b.api_errors == {"403 NOT_A_PLAYER": 1} and b.stats["errors"] == 0


def test_game_finished_counts_and_stops():
    seen = []

    class B(HoldemBot):
        def on_game_over(self, result):
            seen.append(result)

    b = make_bot(B)
    b.max_games = 2
    start(b)
    result = {
        "winners": [2],
        "scores": [-2, None, 4, None, -2, None],
        "pot": 6,
        "showdown": None,
    }
    b._handle(ev(9, "game.finished", {"result": result, "seed": "x"}))
    assert b.state.phase == "finished" and seen == [result] and not b._stop.is_set()
    b._handle(
        ev(
            10,
            "game.started",
            {
                "players": PLAYERS,
                "button": 2,
                "stacks": [200, None, 200, None, 200, None],
                "bets": [2, None, 0, None, 1, None],
                "small_blind_seat": 4,
                "big_blind_seat": 0,
                "pot": 3,
                "hole": ["2S", "3S"],
            },
            gid="g_2",
        )
    )
    assert (
        b.state.game_id == "g_2"
        and b.state.hole == ["2S", "3S"]
        and b.state.board == []
    )
    b._handle(ev(11, "game.finished", {"result": result}, gid="g_2"))
    assert b.games_finished == 2 and b._stop.is_set()


def test_state_helpers():
    st = HoldemState(
        seat=1,
        to_call=10,
        pot=30,
        min_raise_to=20,
        max_raise_to=100,
        hole=["AS", "KS"],
        board=["QS", "JS", "TS"],
    )
    assert st.pot_odds() == 0.25 and st.can_raise
    assert (
        st.clamp_raise(5) == 20
        and st.clamp_raise(500) == 100
        and st.clamp_raise(50) == 50
    )
    assert st.hand_value()[1] == "straight_flush"
    assert HoldemState().hand_value() is None and HoldemState().clamp_raise(10) is None


def test_bot_classes_refuse_other_game_types():
    with pytest.raises(ValueError):
        HoldemBot().run("http://127.0.0.1:1", "t", game="ddz")
    from ddz_sdk import Bot

    with pytest.raises(ValueError):
        Bot().run("http://127.0.0.1:1", "t", game="holdem")
