"""Dou Dizhu bot framework: subclass :class:`Bot`, override :meth:`Bot.on_bid` and
:meth:`Bot.on_play`, then call :meth:`Bot.run`.

The same class plays 3-player (``ddz``) and 4-player (``ddz4``) rooms. ``run`` takes care of the
protocol (see :mod:`ddz_sdk.base`): it joins a room (quick-join or a given room), connects the
player WebSocket (reconnecting with backoff and ``since=last_seq``), handles ``resync``, readies
up, tracks the game from events (falling back to ``GET /games/{gid}/state`` when unsure), and
calls your hooks only when ``bid.turn`` / ``turn`` names your seat. The game type is read from
the room / game views and moves are validated locally with :mod:`ddz_sdk.rules` or
:mod:`ddz_sdk.rules4`; if the hook raises, returns an illegal move, or the server answers 422,
the bot falls back to a safe action (bid 0 / pass if allowed / lowest single) so it never stalls.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

from . import rules, rules4
from .base import BaseBot
from .cards import contains_all, remove_cards, sort_cards
from .client import ApiError
from .rules import Move, Pattern

log = logging.getLogger("ddz_sdk.bot")

#: cards dealt to each player / bottom cards, per game type
HAND_SIZE = {"ddz": 17, "ddz4": 25}
BOTTOM_SIZE = {"ddz": 3, "ddz4": 8}
SEATS = {"ddz": 3, "ddz4": 4}


@dataclass
class GameState:
    """What your bot knows about the current game. Passed to ``on_bid`` / ``on_play``.

    Seats are 0..num_seats-1 and play order is 0 -> 1 -> ... -> 0 (3 seats in ``ddz``,
    4 in ``ddz4``).
    """

    game_id: Optional[str] = None
    room_id: Optional[str] = None
    seat: Optional[int] = None  # your seat
    hand: List[str] = field(default_factory=list)  # your cards, sorted ascending
    phase: str = "waiting"  # waiting | bidding | playing | finished
    players: List[Dict[str, Any]] = field(
        default_factory=list
    )  # [{"seat","bot_id","name"}]
    first_bidder: Optional[int] = None
    bids: List[Dict[str, int]] = field(default_factory=list)  # [{"seat","score"}]
    high_bid: int = 0  # current highest bid (0 = nobody bid yet)
    landlord: Optional[int] = None  # landlord seat, None while bidding
    bottom: List[str] = field(default_factory=list)  # bottom cards once revealed
    turn: Optional[int] = None  # seat whose turn it is (None between events)
    turn_seq: Optional[int] = None  # seq of the current bid.turn / turn event
    remaining_ms: Optional[int] = None  # time left for the current turn when announced
    # Play to beat: {"seat", "cards", "pattern"} or None when the player to act leads.
    to_beat: Optional[Dict[str, Any]] = None
    can_pass: bool = False
    cards_left: List[int] = field(default_factory=lambda: [17, 17, 17])
    multiplier: int = 1
    history: List[Dict[str, Any]] = field(
        default_factory=list
    )  # plays; cards [] = pass
    seq: int = 0  # latest event seq seen in this room
    result: Optional[Dict[str, Any]] = None
    game: str = "ddz"  # "ddz" (3 players) or "ddz4" (4 players, two decks)

    # ---- convenience
    @property
    def is_ddz4(self) -> bool:
        return self.game == "ddz4"

    @property
    def num_seats(self) -> int:
        """3 for ``ddz``, 4 for ``ddz4``."""
        return SEATS.get(self.game, 3)

    @property
    def hand_size(self) -> int:
        """Cards dealt per player before the bottom is taken (17 or 25)."""
        return HAND_SIZE.get(self.game, 17)

    @property
    def to_beat_pattern(self) -> Optional[Pattern]:
        """Pattern you must beat, or ``None`` if you lead."""
        if not self.to_beat:
            return None
        p = self.to_beat.get("pattern")
        if p:
            return Pattern.from_api(p)
        cards = self.to_beat.get("cards") or []
        return self.resolve(cards) if cards else None

    @property
    def is_landlord(self) -> bool:
        return self.landlord is not None and self.landlord == self.seat

    @property
    def leading(self) -> bool:
        """True if you are free to lead (nothing to beat)."""
        return self.to_beat is None

    def next_seat(self, seat: Optional[int] = None) -> int:
        """Seat that plays after ``seat`` (default: after you)."""
        s = self.seat if seat is None else seat
        return ((s or 0) + 1) % self.num_seats

    def teammates(self) -> List[int]:
        """Seats on your side (empty for the landlord)."""
        if self.landlord is None or self.seat is None or self.is_landlord:
            return []
        return [s for s in range(self.num_seats) if s not in (self.seat, self.landlord)]

    def is_teammate(self, seat: Optional[int]) -> bool:
        return seat is not None and seat in self.teammates()

    def resolve(
        self, cards: Sequence[str], last: Any = None, hint: Optional[str] = None
    ) -> Pattern:
        """:func:`ddz_sdk.rules.resolve` or :func:`ddz_sdk.rules4.resolve4` for this game."""
        if self.is_ddz4:
            return rules4.resolve4(cards, last, hint)
        return rules.resolve(cards, last, hint)

    def legal_moves(self) -> List[Move]:
        """All legal non-pass plays from your hand against ``to_beat`` (computed locally,
        with the 4-player rules in a ``ddz4`` game)."""
        if self.is_ddz4:
            return rules4.legal_moves4(self.hand, self.to_beat_pattern)
        return rules.legal_moves(self.hand, self.to_beat_pattern)


PlayReturn = Union[Sequence[str], Move, None]


class Bot(BaseBot):
    """Dou Dizhu base class (3- or 4-player). Override ``on_bid`` and ``on_play``."""

    games = ("ddz", "ddz4")
    default_game: Optional[str] = None  # quick-join default: the server's (ddz)

    # ------------------------------------------------------------------ hooks
    def on_bid(self, state: GameState) -> int:
        """Return 0 (no bid) or a score 1..3 higher than ``state.high_bid``."""
        return 0

    def on_play(self, state: GameState) -> PlayReturn:
        """Return the cards to play, or ``[]`` to pass (only allowed when ``state.can_pass``).

        You may also return a :class:`ddz_sdk.rules.Move`; its pattern type is sent to the
        server to disambiguate. The default plays the smallest legal move.
        """
        moves = state.legal_moves()
        if not moves:
            return []
        return min(moves, key=lambda m: (len(m.cards) > 1, m.pattern.main)).cards

    # ------------------------------------------------------------- internals
    def _new_state(self, **kw: Any) -> GameState:
        game = getattr(self, "game_type", None) or "ddz"
        n = SEATS.get(game, 3)
        return GameState(game=game, cards_left=[HAND_SIZE.get(game, 17)] * n, **kw)

    def _detect_from_cards_left(self, cards_left: Any) -> None:
        """``cards_left`` has one entry per seat: 4 entries means a ddz4 game."""
        if isinstance(cards_left, list) and len(cards_left) in (3, 4):
            g = "ddz4" if len(cards_left) == 4 else "ddz"
            if self.game_type != g:
                self._set_game_type(g)

    def _apply_game_event(
        self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any
    ) -> None:
        st = self.state
        if t == "game.started":
            self._detect_from_cards_left(data.get("cards_left"))
            self._new_game(ev.get("game_id"))
            st = self.state
            st.phase = "bidding"
            st.players = data.get("players") or []
            for p in st.players:
                if p and p.get("bot_id") == self.bot_id:
                    st.seat = p.get("seat")
            st.first_bidder = data.get("first_bidder")
            if data.get("cards_left"):
                st.cards_left = list(data["cards_left"])
            if data.get("hand") is not None:
                st.hand = sort_cards(data["hand"])
            else:
                self._refresh_state(force=True)
        elif t == "bid.turn":
            if self._sync_game(ev):
                return
            st.phase = "bidding"
            st.turn = data.get("seat")
            st.turn_seq = seq
            st.remaining_ms = data.get("remaining_ms")
            st.high_bid = data.get("high_bid", st.high_bid) or 0
        elif t == "bid.made":
            st.bids.append({"seat": data.get("seat"), "score": data.get("score")})
            st.high_bid = max(st.high_bid, data.get("score") or 0)
            st.turn = None
        elif t == "landlord.decided":
            st.landlord = data.get("landlord")
            st.bottom = list(data.get("bottom") or [])
            st.high_bid = data.get("high_bid", st.high_bid)
            st.phase = "playing"
            if st.landlord is not None and st.landlord < len(st.cards_left):
                st.cards_left[st.landlord] = st.hand_size + len(st.bottom)
            if st.landlord == st.seat and st.hand and len(st.hand) == st.hand_size:
                st.hand = sort_cards(st.hand + st.bottom)
        elif t == "turn":
            if self._sync_game(ev):
                return
            st.phase = "playing"
            st.turn = data.get("seat")
            st.turn_seq = seq
            st.remaining_ms = data.get("remaining_ms")
            st.to_beat = data.get("to_beat")
            st.can_pass = bool(data.get("can_pass"))
        elif t == "played":
            s = data.get("seat")
            cards = list(data.get("cards") or [])
            entry = {"seat": s, "cards": cards, "pattern": data.get("pattern")}
            st.history.append(entry)
            st.to_beat = entry
            if s == st.seat:
                st.hand = remove_cards(st.hand, cards)
            if data.get("cards_left"):
                self._detect_from_cards_left(data["cards_left"])
                st.cards_left = list(data["cards_left"])
            if data.get("multiplier"):
                st.multiplier = data["multiplier"]
            st.turn = None
        elif t == "passed":
            st.history.append({"seat": data.get("seat"), "cards": [], "pattern": None})
            st.turn = None
        elif t == "redeal":
            st.phase = "waiting"
            st.turn = None

    def _apply_state(self, g: Dict[str, Any]) -> None:
        if not g.get("game"):
            self._detect_from_cards_left(g.get("cards_left"))
        st = self.state
        if g.get("game_id") != st.game_id:
            self._new_game(g.get("game_id"))
            st = self.state
        st.room_id = g.get("room_id", st.room_id)
        st.seat = g.get("seat", st.seat)
        st.hand = sort_cards(g.get("hand") or [])
        st.phase = g.get("phase", st.phase)
        st.players = g.get("players") or st.players
        st.first_bidder = g.get("first_bidder")
        st.bids = list(g.get("bids") or [])
        st.high_bid = g.get("high_bid") or 0
        st.landlord = g.get("landlord")
        st.bottom = list(g.get("bottom") or [])
        st.turn = g.get("turn") if st.phase in ("bidding", "playing") else None
        st.turn_seq = g.get("turn_seq")
        st.remaining_ms = g.get("remaining_ms")
        st.to_beat = g.get("to_beat")
        st.can_pass = bool(g.get("can_pass"))
        if g.get("cards_left"):
            st.cards_left = list(g["cards_left"])
        st.multiplier = g.get("multiplier") or st.multiplier
        st.history = list(g.get("history") or [])
        st.result = g.get("result")
        if isinstance(g.get("seq"), int):
            st.seq = max(st.seq, g["seq"])

    # ---- acting
    def _my_turn(self) -> bool:
        st = self.state
        return (
            st.game_id is not None
            and st.seat is not None
            and st.turn == st.seat
            and st.phase in ("bidding", "playing")
            and self._acted_turn_seq != self._turn_key()
        )

    def _turn_key(self) -> tuple:
        st = self.state
        return (st.game_id, st.turn_seq, st.phase, len(st.bids), len(st.history))

    def _maybe_act(self) -> None:
        if not self._my_turn():
            return
        st = self.state
        if (
            st.phase == "playing"
            and st.seat < len(st.cards_left)
            and len(st.hand) != st.cards_left[st.seat]
        ):
            self._info(
                "hand size %d != cards_left %d; refreshing",
                len(st.hand),
                st.cards_left[st.seat],
            )
            self._refresh_state(force=True)
            if not self._my_turn():
                return
        st = self.state
        key = self._turn_key()
        done = self._do_bid() if st.phase == "bidding" else self._do_play()
        if done:
            self._acted_turn_seq = key

    def _do_bid(self) -> bool:
        st = self.state
        try:
            score = int(self.on_bid(st))
        except Exception:
            log.exception("[%s] on_bid raised; bidding 0", self.name)
            score = 0
        if score != 0 and (score <= st.high_bid or score > 3):
            self._warn("bid %s invalid (high_bid=%s); bidding 0", score, st.high_bid)
            score = 0
        for attempt in range(3):
            try:
                self._call(self.client.bid, st.game_id, score, seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("bid %s rejected: %s", score, e)
                self.stats["fallbacks"] += 1
                score = 0
        return True  # give up for this turn; the server will auto-bid on timeout

    def _do_play(self) -> bool:
        st = self.state
        last = st.to_beat_pattern
        hint: Optional[str] = None
        try:
            ret = self.on_play(st)
            if isinstance(ret, Move):
                hint = ret.pattern.type
                cards = list(ret.cards)
            else:
                cards = list(ret or [])
        except Exception:
            log.exception("[%s] on_play raised; using fallback", self.name)
            self.stats["fallbacks"] += 1
            cards = self._fallback_cards()
        if not self._locally_ok(cards, last, hint):
            self._warn("on_play returned illegal %s vs %s; using fallback", cards, last)
            self.stats["fallbacks"] += 1
            cards, hint = self._fallback_cards(), None
        for attempt in range(4):
            try:
                self._call(self.client.play, st.game_id, cards, hint, seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("play %s rejected: %s", cards, e)
                self.stats["fallbacks"] += 1
                if attempt >= 1:
                    self._refresh_state(force=True)
                    if not self._my_turn():
                        return True
                    st = self.state
                cards, hint = self._fallback_cards(), None
        return True

    def _locally_ok(self, cards: List[str], last: Optional[Pattern], hint) -> bool:
        st = self.state
        if not cards:
            return st.can_pass and last is not None
        if not contains_all(st.hand, cards):
            return False
        try:
            st.resolve(cards, last, hint)
            return True
        except rules.RuleError:
            return False

    def _fallback_cards(self) -> List[str]:
        """Safe action: pass if allowed, else lowest single (or any legal move)."""
        st = self.state
        if st.can_pass and st.to_beat:
            return []
        if st.to_beat:
            moves = st.legal_moves()
            if moves:
                return min(moves, key=lambda m: len(m.cards)).cards
        return rules.lowest_single(st.hand)
