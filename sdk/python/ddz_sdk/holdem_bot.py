"""Texas Hold'em bot framework: subclass :class:`HoldemBot`, override :meth:`HoldemBot.on_action`,
then call :meth:`HoldemBot.run`.

The lifecycle is the same as :class:`ddz_sdk.Bot` (see :mod:`ddz_sdk.base`): register, connect
the WebSocket before joining, quick-join a ``holdem`` table (or join ``room_id``), ready up,
reconnect with ``since``, resync from ``GET /games/{gid}/state``. The SDK tracks every hand in
:class:`HoldemState` and calls ``on_action`` once per turn when a ``turn`` event names your seat.

``on_action`` returns what to do; any of these forms works::

    return Action.raise_to(12)        # or Action("raise", 12)
    return ("raise", 12)              # (action, amount)
    return ("call", None)             # amount ignored for fold / check / call
    return "check"                    # bare action name

``raise`` amounts are raise-to totals for the current street (see ``state.min_raise_to`` /
``state.max_raise_to``; all-in = ``max_raise_to``). ``call`` with nothing to call is sent as
``check``. If the hook raises, returns something illegal, or the server rejects it with 400/422,
the SDK falls back to the safe action -- check if possible, else fold -- so it never stalls.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union

from . import holdem
from .base import BaseBot
from .client import ApiError

log = logging.getLogger("ddz_sdk.bot")

ACTIONS = ("fold", "check", "call", "raise")
STREETS = ("preflop", "flop", "turn", "river")


@dataclass(frozen=True)
class Action:
    """A Hold'em decision. ``amount`` is the raise-to total (only for ``raise``)."""

    action: str
    amount: Optional[int] = None

    @classmethod
    def fold(cls) -> "Action":
        return cls("fold")

    @classmethod
    def check(cls) -> "Action":
        return cls("check")

    @classmethod
    def call(cls) -> "Action":
        return cls("call")

    @classmethod
    def raise_to(cls, amount: int) -> "Action":
        return cls("raise", int(amount))


ActionReturn = Union[Action, Tuple[str, Optional[int]], str, None]


@dataclass
class HoldemState:
    """What your bot knows about the current hand. Passed to ``on_action``.

    Per-seat lists (``stacks``, ``bets``, ``committed``, ``folded``, ``all_in``) are indexed
    by room seat and hold ``None`` for seats not in this hand.
    """

    game_id: Optional[str] = None
    room_id: Optional[str] = None
    seat: Optional[int] = None  # your seat
    hole: List[str] = field(default_factory=list)  # your 2 hole cards
    board: List[str] = field(default_factory=list)  # community cards (0, 3, 4 or 5)
    phase: str = "waiting"  # waiting | preflop | flop | turn | river | finished
    players: List[Dict[str, Any]] = field(
        default_factory=list
    )  # [{"seat","bot_id",..}]
    button: Optional[int] = None
    small_blind_seat: Optional[int] = None
    big_blind_seat: Optional[int] = None
    small_blind: int = 1
    big_blind: int = 2
    pot: int = 0  # all chips committed this hand
    current_bet: int = 0  # highest bet on this street
    stacks: List[Optional[int]] = field(default_factory=list)
    bets: List[Optional[int]] = field(default_factory=list)  # bets on this street
    committed: List[Optional[int]] = field(default_factory=list)  # chips in this hand
    folded: List[Optional[bool]] = field(default_factory=list)
    all_in: List[Optional[bool]] = field(default_factory=list)
    # history: [{"seat","phase","action","amount","all_in"}]; action also small_blind /
    # big_blind; amount = raise-to total for raise, chips added for call / blinds
    history: List[Dict[str, Any]] = field(default_factory=list)
    turn: Optional[int] = None  # seat to act (None between events)
    turn_seq: Optional[int] = None  # seq of the current turn event
    remaining_ms: Optional[int] = None
    # Options of the seat on turn (yours when turn == seat):
    to_call: int = 0  # chips needed to call; 0 = you may check
    can_check: bool = False
    min_raise_to: Optional[int] = None  # None when raising is not allowed
    max_raise_to: Optional[int] = None  # all-in raise-to total
    seq: int = 0  # latest event seq seen in this room
    result: Optional[Dict[str, Any]] = None
    game: str = "holdem"

    # ---- convenience
    @property
    def in_hand(self) -> bool:
        """True if you were dealt into this hand (players who sat down mid-hand wait)."""
        return self.seat is not None and any(
            p and p.get("seat") == self.seat for p in self.players
        )

    @property
    def can_raise(self) -> bool:
        return self.min_raise_to is not None and self.max_raise_to is not None

    @property
    def my_stack(self) -> int:
        return self._at(self.stacks) or 0

    @property
    def my_bet(self) -> int:
        return self._at(self.bets) or 0

    def _at(self, lst: List[Any]) -> Any:
        if self.seat is None or self.seat >= len(lst):
            return None
        return lst[self.seat]

    def active_seats(self) -> List[int]:
        """Seats still in the hand (dealt in and not folded)."""
        return [
            p["seat"]
            for p in self.players
            if p
            and not (p["seat"] < len(self.folded) and self.folded[p["seat"]] is True)
        ]

    def opponents(self) -> List[int]:
        """Active seats other than yours."""
        return [s for s in self.active_seats() if s != self.seat]

    def hand_value(self) -> Optional[Tuple[int, str, List[str]]]:
        """:func:`ddz_sdk.holdem.evaluate` of hole + board, or None before the flop."""
        cards = list(self.hole) + list(self.board)
        if len(self.hole) != 2 or len(cards) < 5:
            return None
        return holdem.evaluate(cards)

    def pot_odds(self) -> float:
        """to_call / (pot + to_call): the share of the final pot you must put in to call."""
        return self.to_call / float(self.pot + self.to_call) if self.to_call else 0.0

    def clamp_raise(self, amount: int) -> Optional[int]:
        """Clamp a raise-to amount into [min_raise_to, max_raise_to] (None if no raise)."""
        if not self.can_raise:
            return None
        return max(self.min_raise_to, min(self.max_raise_to, int(amount)))  # type: ignore


class HoldemBot(BaseBot):
    """Texas Hold'em base class. Override ``on_action``; ``on_event`` / ``on_game_over``
    are optional."""

    games = ("holdem",)
    default_game = "holdem"

    # ------------------------------------------------------------------ hooks
    def on_action(self, state: HoldemState) -> ActionReturn:
        """Decide on your turn. Return an :class:`Action`, ``(action, amount)`` or an action
        name (see the module docs). The default checks when possible, else folds."""
        return Action.check() if state.can_check else Action.fold()

    # ------------------------------------------------------------- internals
    def _new_state(self, **kw: Any) -> HoldemState:
        return HoldemState(**kw)

    def _apply_game_event(
        self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any
    ) -> None:
        st = self.state
        if t == "game.started":
            self._new_game(ev.get("game_id"))
            st = self.state
            st.phase = "preflop"
            st.players = data.get("players") or []
            for p in st.players:
                if p and p.get("bot_id") == self.bot_id:
                    st.seat = p.get("seat")
            st.button = data.get("button")
            st.small_blind_seat = data.get("small_blind_seat")
            st.big_blind_seat = data.get("big_blind_seat")
            st.small_blind = data.get("small_blind", st.small_blind)
            st.big_blind = data.get("big_blind", st.big_blind)
            st.stacks = list(data.get("stacks") or [])
            st.bets = list(data.get("bets") or [])
            st.committed = list(st.bets)
            st.folded = [False if b is not None else None for b in st.bets]
            st.all_in = [
                (s == 0) if s is not None else None for s in st.stacks
            ]  # tiny stacks only
            st.pot = data.get("pot", 0) or 0
            st.current_bet = max([b for b in st.bets if b is not None] or [0])
            for s, kind in (
                (st.small_blind_seat, "small_blind"),
                (st.big_blind_seat, "big_blind"),
            ):
                if s is not None and s < len(st.bets):
                    st.history.append(
                        {
                            "seat": s,
                            "phase": "preflop",
                            "action": kind,
                            "amount": st.bets[s],
                            "all_in": bool(st.all_in[s]),
                        }
                    )
            if data.get("hole") is not None:
                st.hole = list(data["hole"])
            elif st.in_hand:
                self._refresh_state(force=True)
        elif t == "turn":
            if self._sync_game(ev):
                return
            st.phase = data.get("phase", st.phase)
            st.turn = data.get("seat")
            st.turn_seq = seq
            st.remaining_ms = data.get("remaining_ms")
            st.to_call = data.get("to_call") or 0
            st.can_check = bool(data.get("can_check"))
            st.min_raise_to = data.get("min_raise_to")
            st.max_raise_to = data.get("max_raise_to")
            if data.get("current_bet") is not None:
                st.current_bet = data["current_bet"]
            if data.get("pot") is not None:
                st.pot = data["pot"]
        elif t == "acted":
            s = data.get("seat")
            st.history.append(
                {
                    "seat": s,
                    "phase": data.get("phase", st.phase),
                    "action": data.get("action"),
                    "amount": data.get("amount", 0),
                    "all_in": bool(data.get("all_in")),
                }
            )
            if isinstance(s, int) and s < len(st.bets):
                old_bet = st.bets[s] or 0
                new_bet = data.get("bet", old_bet) or 0
                if st.committed[s] is not None:
                    st.committed[s] += max(0, new_bet - old_bet)
                st.bets[s] = new_bet
                if data.get("stack") is not None:
                    st.stacks[s] = data["stack"]
                if data.get("action") == "fold":
                    st.folded[s] = True
                if data.get("all_in"):
                    st.all_in[s] = True
            if data.get("pot") is not None:
                st.pot = data["pot"]
            st.current_bet = max([b for b in st.bets if b is not None] or [0])
            st.turn = None
        elif t == "board":
            st.phase = data.get("phase", st.phase)
            if data.get("board") is not None:
                st.board = list(data["board"])
            else:
                st.board = st.board + list(data.get("cards") or [])
            st.bets = [0 if b is not None else None for b in st.bets]
            st.current_bet = 0
            st.turn = None

    def _apply_state(self, g: Dict[str, Any]) -> None:
        st = self.state
        if g.get("game_id") != st.game_id:
            self._new_game(g.get("game_id"))
            st = self.state
        st.room_id = g.get("room_id", st.room_id)
        st.seat = g.get("seat", st.seat)
        st.hole = list(g.get("hole") or st.hole)
        st.board = list(g.get("board") or [])
        st.phase = g.get("phase", st.phase)
        st.players = g.get("players") or st.players
        for k in ("button", "small_blind_seat", "big_blind_seat"):
            setattr(st, k, g.get(k, getattr(st, k)))
        st.small_blind = g.get("small_blind") or st.small_blind
        st.big_blind = g.get("big_blind") or st.big_blind
        st.pot = g.get("pot") or 0
        st.current_bet = g.get("current_bet") or 0
        for k in ("stacks", "bets", "committed", "folded", "all_in"):
            if g.get(k) is not None:
                setattr(st, k, list(g[k]))
        st.history = list(g.get("history") or [])
        st.result = g.get("result")
        live = st.phase in STREETS
        st.turn = g.get("turn") if live else None
        st.turn_seq = g.get("turn_seq")
        st.remaining_ms = g.get("remaining_ms")
        legal = g.get("legal")
        if legal and live:
            st.to_call = legal.get("to_call") or 0
            st.can_check = bool(legal.get("can_check"))
            st.min_raise_to = legal.get("min_raise_to")
            st.max_raise_to = legal.get("max_raise_to")
        elif st.turn == st.seat and live:
            # No legal block although it's our turn: derive the call amount, no raise info.
            st.to_call = max(0, min(st.current_bet - st.my_bet, st.my_stack))
            st.can_check = st.to_call == 0
            st.min_raise_to = st.max_raise_to = None
        if isinstance(g.get("seq"), int):
            st.seq = max(st.seq, g["seq"])

    # ---- acting
    def _my_turn(self) -> bool:
        st = self.state
        return (
            st.game_id is not None
            and st.seat is not None
            and st.turn == st.seat
            and st.phase in STREETS
            and st.in_hand
            and self._acted_turn_seq != self._turn_key()
        )

    def _turn_key(self) -> tuple:
        st = self.state
        return (st.game_id, st.turn_seq, st.phase, len(st.history))

    def _maybe_act(self) -> None:
        if not self._my_turn():
            return
        key = self._turn_key()
        if self._do_action():
            self._acted_turn_seq = key

    def _normalize(self, ret: ActionReturn) -> Tuple[str, Optional[int]]:
        if isinstance(ret, Action):
            return ret.action, ret.amount
        if isinstance(ret, str):
            return ret, None
        if isinstance(ret, (tuple, list)) and ret:
            amount = ret[1] if len(ret) > 1 else None
            return str(ret[0]), amount
        raise ValueError("on_action returned %r" % (ret,))

    def _check_local(
        self, action: str, amount: Optional[int]
    ) -> Optional[Tuple[str, Optional[int]]]:
        """Validate against the current turn's options; returns the request or None."""
        st = self.state
        if action == "fold":
            return ("fold", None)
        if action == "check":
            return ("check", None) if st.can_check else None
        if action == "call":
            if st.to_call > 0:
                return ("call", None)
            return ("check", None) if st.can_check else None
        if action == "raise":
            if not st.can_raise or isinstance(amount, bool):
                return None
            try:
                if amount is None or int(amount) != amount:
                    return None
            except (TypeError, ValueError):
                return None
            if st.min_raise_to <= int(amount) <= st.max_raise_to:  # type: ignore
                return ("raise", int(amount))
        return None

    def _fallback(self) -> Tuple[str, Optional[int]]:
        """Safe action: check if possible, else fold."""
        return ("check", None) if self.state.can_check else ("fold", None)

    def _do_action(self) -> bool:
        st = self.state
        req: Optional[Tuple[str, Optional[int]]] = None
        try:
            action, amount = self._normalize(self.on_action(st))
            req = self._check_local(action, amount)
            if req is None:
                self._warn(
                    "on_action returned illegal %s %s (to_call=%s raise=%s..%s); "
                    "using fallback",
                    action,
                    amount,
                    st.to_call,
                    st.min_raise_to,
                    st.max_raise_to,
                )
                self.stats["fallbacks"] += 1
        except Exception:
            log.exception("[%s] on_action raised; using fallback", self.name)
            self.stats["fallbacks"] += 1
        if req is None:
            req = self._fallback()
        for attempt in range(3):
            try:
                self._call(self.client.action, st.game_id, req[0], req[1], seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("action %s %s rejected: %s", req[0], req[1], e)
                self.stats["fallbacks"] += 1
                if attempt >= 1:
                    self._refresh_state(force=True)
                    if not self._my_turn():
                        return True
                    st = self.state
                req = self._fallback()
        return True  # give up for this turn; the server acts for us on timeout
