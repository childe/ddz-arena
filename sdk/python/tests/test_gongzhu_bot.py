"""Offline tests for GongzhuBot event tracking, exposing, playing and fallbacks."""

from ddz_sdk import ApiError, GongzhuBot, GongzhuState


class FakeClient:
    def __init__(self, state=None, play_errors=None, expose_errors=None):
        self.calls = []
        self.state = state or {}
        self.play_errors = list(play_errors or [])
        self.expose_errors = list(expose_errors or [])
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

    def expose(self, gid, cards, seq=None):
        self.calls.append(("expose", gid, list(cards), seq))
        if self.expose_errors:
            raise self.expose_errors.pop(0)
        return {"ok": True}

    def play_card(self, gid, card, seq=None):
        self.calls.append(("play", gid, card, seq))
        if self.play_errors:
            raise self.play_errors.pop(0)
        return {"ok": True}


def make_bot(bot_cls=GongzhuBot, **kw):
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
HAND = "QS 3S 7S 2H AH 9H 2C TC KC 4D 8D JD AD".split()


def start(b, hand=HAND, first_leader=0):
    b._handle(
        ev(
            1,
            "game.started",
            {
                "game": "gongzhu",
                "players": PLAYERS,
                "hand_no": 2,
                "totals": [-100, 50, 0, 50],
                "first_leader": first_leader,
                "cards_left": [13, 13, 13, 13],
                "hand": list(hand),
            },
        )
    )


def turn(b, seq, seat, phase="playing", trick=None, trick_no=1):
    b._handle(
        ev(
            seq,
            "turn",
            {
                "seat": seat,
                "phase": phase,
                "trick_no": trick_no,
                "led_suit": trick["plays"][0]["card"][1] if trick else None,
                "trick": trick,
            },
        )
    )


def played(b, seq, seat, card, left):
    b._handle(
        ev(
            seq,
            "played",
            {"seat": seat, "card": card, "trick_no": 1, "cards_left": left},
        )
    )


def test_game_started_tracking():
    b = make_bot()
    start(b)
    st = b.state
    assert st.phase == "expose" and st.hand_no == 2 and st.totals == [-100, 50, 0, 50]
    assert st.first_leader == 0 and st.seat == 1
    assert st.hand[:3] == ["3S", "7S", "QS"]  # sorted S H C D, 2..A
    assert st.exposable_cards() == ["QS", "JD", "TC", "AH"]


def test_expose_turn_calls_choose_expose():
    class B(GongzhuBot):
        def choose_expose(self, state):
            return ["JD", "TC"]

    b = make_bot(B)
    start(b)
    turn(b, 2, 0, "expose")
    b._maybe_act()
    assert calls(b, "expose") == []  # not our turn
    b._handle(ev(3, "exposed", {"seat": 0, "cards": ["AH"], "auto": False}))
    assert b.state.exposed[0] == ["AH"] and b.state.exposes_done == 1
    turn(b, 4, 1, "expose")
    b._maybe_act()
    assert calls(b, "expose") == [("expose", "g_1", ["JD", "TC"], 4)]
    b._maybe_act()
    assert len(calls(b, "expose")) == 1  # only once per turn


def test_illegal_expose_falls_back_to_nothing():
    class B(GongzhuBot):
        def choose_expose(self, state):
            return ["KS"]

    b = make_bot(B)
    start(b)
    turn(b, 2, 1, "expose")
    b._maybe_act()
    assert calls(b, "expose") == [("expose", "g_1", [], 2)]
    assert b.state.__class__ is GongzhuState and b.stats["fallbacks"] == 1


def test_trick_tracking_and_follow_suit():
    seen = []

    class B(GongzhuBot):
        def choose_card(self, state):
            seen.append((state.led_suit, state.legal_cards(), state.trick_winner()))
            return "KC"

    b = make_bot(B)
    start(b)
    for s, seq in zip(range(4), (2, 3, 4, 5)):
        b._handle(ev(seq, "exposed", {"seat": s, "cards": ["QS"] if s == 1 else []}))
    assert b.state.my_exposed == ["QS"]
    trick = {"leader": 0, "plays": [{"seat": 0, "card": "5C"}], "winner": None}
    played(b, 6, 0, "5C", [12, 13, 13, 13])
    turn(b, 7, 1, trick=trick)
    b._maybe_act()
    assert seen == [("C", ["2C", "TC", "KC"], 0)]
    assert calls(b, "play") == [("play", "g_1", "KC", 7)]
    played(b, 8, 1, "KC", [12, 12, 13, 13])
    played(b, 9, 2, "AC", [12, 12, 12, 13])
    played(b, 10, 3, "3D", [12, 12, 12, 12])
    b._handle(
        ev(
            11,
            "trick.won",
            {
                "seat": 2,
                "trick_no": 1,
                "plays": [
                    {"seat": 0, "card": "5C"},
                    {"seat": 1, "card": "KC"},
                    {"seat": 2, "card": "AC"},
                    {"seat": 3, "card": "3D"},
                ],
                "cards": [],
            },
        )
    )
    st = b.state
    assert "KC" not in st.hand and len(st.hand) == 12
    assert st.trick is None and st.trick_no == 2 and len(st.tricks) == 1
    assert st.led_before() == {"C"} and st.voids()[3] == {"C"}
    assert len(st.unseen_cards()) == 52 - 12 - 4
    # spades not led yet: the exposed pig is locked when leading
    st.turn = 1
    assert "QS" not in st.legal_cards() and "AH" in st.legal_cards()


def test_taken_and_points():
    b = make_bot()
    start(b)
    b._handle(ev(2, "exposed", {"seat": 0, "cards": ["AH"]}))
    b._handle(
        ev(
            3,
            "trick.won",
            {
                "seat": 1,
                "trick_no": 1,
                "plays": [
                    {"seat": 0, "card": "5H"},
                    {"seat": 1, "card": "AH"},
                    {"seat": 2, "card": "QS"},
                    {"seat": 3, "card": "2H"},
                ],
                "cards": ["5H", "AH", "QS", "2H"],
            },
        )
    )
    st = b.state
    assert st.taken[1] == ["5H", "AH", "QS", "2H"]
    assert st.points() == (-10 - 50) * 2 - 100
    assert "QS" not in st.scoring_out() and len(st.scoring_out()) == 12


def test_illegal_card_falls_back_to_lowest_safe_card():
    class B(GongzhuBot):
        def choose_card(self, state):
            return "AD"  # must follow clubs

    b = make_bot(B)
    start(b)
    trick = {"leader": 0, "plays": [{"seat": 0, "card": "5C"}], "winner": None}
    played(b, 2, 0, "5C", [12, 13, 13, 13])
    turn(b, 3, 1, trick=trick)
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_1", "2C", 3)]
    assert b.stats["fallbacks"] == 1


def test_hook_exception_and_server_422():
    class B(GongzhuBot):
        def choose_card(self, state):
            raise RuntimeError("boom")

    err = ApiError(422, "EXPOSED_CARD_LOCKED", "locked")
    b = make_bot(B, play_errors=[err])
    start(b, first_leader=1)
    for s, seq in zip((1, 2, 3, 0), (2, 3, 4, 5)):
        b._handle(ev(seq, "exposed", {"seat": s, "cards": []}))
    turn(b, 6, 1)
    b._maybe_act()
    plays = calls(b, "play")
    # falls back to the lowest non-scoring card (2C), retried after the 422
    assert [p[2] for p in plays] == ["2C", "2C"]
    assert b.stats["fallbacks"] == 2


def test_default_choose_card_is_timeout_rule():
    b = make_bot()
    start(b, first_leader=1)
    for s, seq in zip((1, 2, 3, 0), (2, 3, 4, 5)):
        b._handle(ev(seq, "exposed", {"seat": s, "cards": []}))
    turn(b, 6, 1)
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_1", "2C", 6)]


def test_apply_state_resync():
    view = {
        "game_id": "g_2",
        "room_id": "r_1",
        "game": "gongzhu",
        "phase": "playing",
        "seat": 1,
        "hand": ["3S", "2C"],
        "hand_no": 3,
        "totals": [0, -300, 100, 200],
        "first_leader": 2,
        "exposed": [[], ["QS"], [], []],
        "turn": 1,
        "turn_seq": 77,
        "trick_no": 12,
        "trick": {"leader": 0, "plays": [{"seat": 0, "card": "9S"}], "winner": None},
        "tricks": [
            {
                "leader": 2,
                "plays": [
                    {"seat": 2, "card": "4S"},
                    {"seat": 3, "card": "5S"},
                    {"seat": 0, "card": "6S"},
                    {"seat": 1, "card": "QS"},
                ],
                "winner": 1,
            }
        ],
        "taken": [[], ["QS"], [], []],
        "cards_left": [2, 2, 3, 3],
        "seq": 80,
    }
    b = make_bot(state=view)
    b.state.game_id = "g_1"
    b._refresh_state(force=True)
    st = b.state
    assert st.game_id == "g_2" and st.turn == 1 and st.turn_seq == 77
    assert st.led_suit == "S" and st.legal_cards() == ["3S"]
    assert st.points() == -200 and st.exposes_done == 4 and st.seq == 80
    b._maybe_act()
    assert calls(b, "play") == [("play", "g_2", "3S", 80)]


def test_hand_mismatch_triggers_refresh():
    b = make_bot(state={"game_id": "g_1", "phase": "finished", "hand": []})
    start(b, first_leader=1)
    for s, seq in zip((1, 2, 3, 0), (2, 3, 4, 5)):
        b._handle(ev(seq, "exposed", {"seat": s, "cards": []}))
    b.state.cards_left = [13, 12, 13, 13]
    turn(b, 6, 1)
    b._maybe_act()
    assert calls(b, "state") and not calls(b, "play")
