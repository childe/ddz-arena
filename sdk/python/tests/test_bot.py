"""Offline tests for Bot event tracking and fallback behaviour (no server needed)."""

from ddz_sdk import ApiError, Bot
from ddz_sdk.cards import parse_short


class FakeClient:
    def __init__(self, state=None, play_errors=None, me=None):
        self.calls = []
        self.state = state or {}
        self.play_errors = list(play_errors or [])
        self._me = me or {
            "bot_id": "b_me",
            "room_id": "r_1",
            "seat": 1,
            "game_id": None,
        }
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

    def bid(self, gid, score, seq=None):
        self.calls.append(("bid", gid, score, seq))
        return {"ok": True, "seq": seq}

    def play(self, gid, cards, pattern_type=None, seq=None):
        self.calls.append(("play", gid, list(cards), pattern_type, seq))
        if self.play_errors:
            raise self.play_errors.pop(0)
        return {"ok": True}


def make_bot(bot_cls=Bot, **kw):
    b = bot_cls()
    b.client = FakeClient(**kw)
    b.bot_id = "b_me"
    b.state.room_id = "r_1"
    b.state.seat = 1
    return b


def ev(seq, type_, data, gid="g_1"):
    return {"type": type_, "seq": seq, "room_id": "r_1", "game_id": gid, "data": data}


PLAYERS = [
    {"seat": 0, "bot_id": "b_a"},
    {"seat": 1, "bot_id": "b_me"},
    {"seat": 2, "bot_id": "b_c"},
]
HAND = parse_short("3456789TJQKA2XD33")  # 17 cards


def start(b):
    b._handle(
        ev(
            1,
            "game.started",
            {
                "players": PLAYERS,
                "first_bidder": 0,
                "cards_left": [17, 17, 17],
                "hand": HAND,
            },
        )
    )


def test_tracks_hand_and_bids_only_on_own_turn():
    class B(Bot):
        def on_bid(self, state):
            return 2

    b = make_bot(B)
    start(b)
    assert b.state.seat == 1 and len(b.state.hand) == 17
    b._handle(ev(2, "bid.turn", {"seat": 0, "high_bid": 0, "remaining_ms": 9000}))
    b._maybe_act()
    assert not [c for c in b.client.calls if c[0] == "bid"]
    b._handle(ev(3, "bid.made", {"seat": 0, "score": 1, "auto": False}))
    b._handle(ev(4, "bid.turn", {"seat": 1, "high_bid": 1, "remaining_ms": 9000}))
    b._maybe_act()
    assert ("bid", "g_1", 2, 4) in b.client.calls
    b._maybe_act()  # no double action for the same turn
    assert len([c for c in b.client.calls if c[0] == "bid"]) == 1


def test_invalid_bid_falls_back_to_zero():
    class B(Bot):
        def on_bid(self, state):
            return 1

    b = make_bot(B)
    start(b)
    b._handle(ev(2, "bid.made", {"seat": 0, "score": 2, "auto": False}))
    b._handle(ev(3, "bid.turn", {"seat": 1, "high_bid": 2}))
    b._maybe_act()
    assert ("bid", "g_1", 0, 3) in b.client.calls


def test_landlord_gets_bottom_and_play_removes_cards():
    b = make_bot()
    start(b)
    b._handle(
        ev(
            2,
            "landlord.decided",
            {"landlord": 1, "bottom": ["4H", "4C", "5H"], "high_bid": 3},
        )
    )
    assert len(b.state.hand) == 20 and b.state.is_landlord
    assert b.state.cards_left == [17, 20, 17]
    b._handle(ev(3, "turn", {"seat": 1, "to_beat": None, "can_pass": False}))
    b._maybe_act()
    play = [c for c in b.client.calls if c[0] == "play"][0]
    assert play[2] == ["3S"] and play[4] == 3  # default bot plays the smallest single
    b._handle(
        ev(
            4,
            "played",
            {
                "seat": 1,
                "cards": ["3S"],
                "pattern": {"type": "single", "rank": "3", "length": 1},
                "cards_left": [17, 19, 17],
                "multiplier": 1,
                "auto": False,
            },
        )
    )
    assert "3S" not in b.state.hand and len(b.state.hand) == 19
    assert b.state.to_beat["seat"] == 1


def test_illegal_hook_and_422_fall_back_to_pass():
    class Bad(Bot):
        def on_play(self, state):
            return ["9S", "9H"]  # not in hand

    b = make_bot(Bad)
    start(b)
    b._handle(
        ev(
            2,
            "landlord.decided",
            {"landlord": 0, "bottom": ["4H", "4C", "5H"], "high_bid": 1},
        )
    )
    to_beat = {
        "seat": 0,
        "cards": ["2S"],
        "pattern": {"type": "single", "rank": "2", "length": 1},
    }
    b._handle(ev(3, "turn", {"seat": 1, "to_beat": to_beat, "can_pass": True}))
    b._maybe_act()
    plays = [c for c in b.client.calls if c[0] == "play"]
    assert plays == [("play", "g_1", [], None, 3)]
    assert b.stats["fallbacks"] == 1


def test_server_422_triggers_fallback_lowest_single_when_leading():
    class B(Bot):
        def on_play(self, state):
            return ["4S", "5S", "6S", "7S", "8S"]

    b = make_bot(B, play_errors=[ApiError(422, "INVALID_PATTERN", "nope")])
    start(b)
    b._handle(
        ev(
            2,
            "landlord.decided",
            {"landlord": 0, "bottom": ["4H", "4C", "5H"], "high_bid": 1},
        )
    )
    b._handle(ev(3, "turn", {"seat": 1, "to_beat": None, "can_pass": False}))
    b._maybe_act()
    plays = [c[2] for c in b.client.calls if c[0] == "play"]
    assert plays == [["4S", "5S", "6S", "7S", "8S"], ["3S"]]


def test_resync_and_unknown_game_refresh_from_state():
    state = {
        "game_id": "g_2",
        "room_id": "r_1",
        "phase": "playing",
        "seat": 1,
        "hand": ["5S", "6S"],
        "landlord": 0,
        "bottom": ["3S", "3H", "3C"],
        "turn": 1,
        "turn_seq": 50,
        "to_beat": None,
        "can_pass": False,
        "cards_left": [5, 2, 9],
        "history": [],
        "bids": [{"seat": 0, "score": 3}],
        "high_bid": 3,
        "seq": 51,
    }
    b = make_bot(
        state=state,
        me={"bot_id": "b_me", "room_id": "r_1", "seat": 1, "game_id": "g_2"},
    )
    b._handle({"type": "resync", "room_id": "r_1", "game_id": "g_2"})
    assert b.state.game_id == "g_2" and b.state.hand == ["5S", "6S"]
    assert b.state.seq == 51
    b._maybe_act()
    assert [c for c in b.client.calls if c[0] == "play"] == [
        ("play", "g_2", ["5S"], None, 51)
    ]
    # older replayed events are ignored
    b._handle(
        ev(
            40,
            "played",
            {"seat": 1, "cards": ["6S"], "cards_left": [5, 1, 9]},
            gid="g_2",
        )
    )
    assert b.state.hand == ["5S", "6S"]


def test_game_finished_counts_and_stops_at_max_games():
    seen = []

    class B(Bot):
        def on_game_over(self, result):
            seen.append(result)

    b = make_bot(B)
    b.max_games = 1
    start(b)
    b._handle(
        ev(9, "game.finished", {"result": {"kind": "win", "scores": [2, -1, -1]}})
    )
    assert seen and b.games_finished == 1 and b._stop.is_set()


def test_state_helpers():
    b = make_bot()
    start(b)
    b._handle(
        ev(
            2,
            "landlord.decided",
            {"landlord": 0, "bottom": ["4H", "4C", "5H"], "high_bid": 1},
        )
    )
    st = b.state
    assert not st.is_landlord and st.teammates() == [2] and st.is_teammate(2)
    assert st.leading and st.to_beat_pattern is None
    assert len(st.legal_moves()) > 0


def test_rate_limited_play_is_retried():
    rl = ApiError(429, "RATE_LIMITED", "too many requests")
    b = make_bot(play_errors=[rl, rl])
    start(b)
    b._handle(
        ev(
            2,
            "landlord.decided",
            {"landlord": 1, "bottom": ["4H", "4C", "5H"], "high_bid": 3},
        )
    )
    b._handle(ev(3, "turn", {"seat": 1, "to_beat": None, "can_pass": False}))
    b._maybe_act()
    plays = [c[2] for c in b.client.calls if c[0] == "play"]
    assert plays == [["3S"], ["3S"], ["3S"]]  # same move retried, no fallback
    assert b.stats["fallbacks"] == 0
    assert b.api_errors == {"429 RATE_LIMITED": 2}
