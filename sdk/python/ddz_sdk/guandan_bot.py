"""Guandan (掼蛋) bot framework: subclass :class:`GuandanBot`, override :meth:`GuandanBot.on_play`
(and optionally :meth:`GuandanBot.on_return`), then call :meth:`GuandanBot.run`.

The lifecycle is the same as :class:`ddz_sdk.Bot` (see :mod:`ddz_sdk.base`): quick-join a
``guandan`` room (or join ``room_id``), connect the WebSocket, ready up, reconnect with
``since``, resync from ``GET /games/{gid}/state``. Each hand of a match is one game: the SDK
tracks it in :class:`GuandanState` -- the dealt hand, the tribute (贡牌 move between hands as
soon as the ``tribute`` event arrives), returns, plays, players going out -- and calls your hooks
when a ``turn`` event names your seat:

* ``phase == "return"``: ``on_return(state)`` returns one card from
  ``state.returnable_cards()`` to give back to your tribute payer;
* ``phase == "playing"``: ``on_play(state)`` returns the cards to play, a
  :class:`~ddz_sdk.rules.Move` from ``state.legal_moves()`` (its pattern type and rank are sent
  so the server uses exactly that interpretation, e.g. which straight a wildcard completes), or
  ``[]`` to pass.

Moves are validated locally with :mod:`ddz_sdk.rules_gd`. If a hook raises, returns something
illegal, or the server answers 422, the SDK falls back to a safe action -- the smallest
returnable card; pass if allowed, else the lowest single (no wildcard unless only wildcards are
left) -- so the bot never stalls.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

from . import rules_gd
from .base import BaseBot
from .cards import contains_all, remove_cards
from .client import ApiError
from .rules import Move, Pattern, RuleError
from .rules_gd import GdPattern, bomb_tier

log = logging.getLogger("ddz_sdk.bot")

HAND_SIZE = rules_gd.HAND_SIZE_GD
SEATS = rules_gd.SEATS_GD


@dataclass
class GuandanState:
    """What your bot knows about the current hand. Passed to ``on_return`` / ``on_play``.

    Seats 0 and 2 are team 0, seats 1 and 3 team 1 (your teammate sits opposite). Play order is
    0 -> 1 -> 2 -> 3 -> 0, skipping seats that are out.
    """

    game_id: Optional[str] = None
    room_id: Optional[str] = None
    seat: Optional[int] = None  # your seat
    hand: List[str] = field(
        default_factory=list
    )  # your cards, ascending by value at level
    phase: str = "waiting"  # waiting | return | playing | finished
    players: List[Dict[str, Any]] = field(default_factory=list)
    hand_no: int = 1  # hand number within the match (1 = first hand: no tribute)
    level: str = "2"  # level rank of this hand (级牌)
    level_team: int = 0  # team whose level is played (主打队)
    team_levels: List[str] = field(default_factory=lambda: ["2", "2"])
    a_attempts: List[int] = field(default_factory=lambda: [0, 0])
    # {"anti": bool, "tributes": [{"from","to","card"}]} or None (first hand / not yet known)
    tribute: Optional[Dict[str, Any]] = None
    returns: List[Dict[str, Any]] = field(
        default_factory=list
    )  # [{"from","to","card"}]
    turn: Optional[int] = None  # seat whose turn it is (None between events)
    turn_seq: Optional[int] = None  # seq of the current turn event
    remaining_ms: Optional[int] = None
    # Play to beat: {"seat", "cards", "pattern"} or None when the player to act leads.
    to_beat: Optional[Dict[str, Any]] = None
    can_pass: bool = False
    cards_left: List[int] = field(default_factory=lambda: [HAND_SIZE] * SEATS)
    order: List[int] = field(
        default_factory=list
    )  # seats that went out, first place first
    history: List[Dict[str, Any]] = field(
        default_factory=list
    )  # plays; cards [] = pass
    seq: int = 0  # latest event seq seen in this room
    result: Optional[Dict[str, Any]] = None
    game: str = "guandan"

    # ---- teams and seats
    @property
    def team(self) -> Optional[int]:
        return None if self.seat is None else self.seat % 2

    @property
    def teammate(self) -> Optional[int]:
        """Seat of your teammate (opposite you)."""
        return None if self.seat is None else (self.seat + 2) % SEATS

    def is_teammate(self, seat: Optional[int]) -> bool:
        return seat is not None and seat == self.teammate

    def opponents(self) -> List[int]:
        if self.seat is None:
            return []
        return [(self.seat + 1) % SEATS, (self.seat + 3) % SEATS]

    def is_out(self, seat: int) -> bool:
        return seat in self.order

    def next_seat(self, seat: Optional[int] = None) -> Optional[int]:
        """Next seat still in play after ``seat`` (default: after you)."""
        s = self.seat if seat is None else seat
        if s is None:
            return None
        for i in range(1, SEATS + 1):
            n = (s + i) % SEATS
            if n not in self.order:
                return n
        return None

    @property
    def is_level_team(self) -> bool:
        """True if your team's level is played this hand."""
        return self.team is not None and self.team == self.level_team

    # ---- cards
    @property
    def wildcard(self) -> str:
        """The wildcard code this hand (heart level card, e.g. ``"7H"``)."""
        return rules_gd.wildcard(self.level)

    @property
    def wildcards(self) -> int:
        """Number of wildcards in your hand."""
        return self.hand.count(self.wildcard)

    def value(self, card: str) -> int:
        """Single value of ``card`` at this hand's level (see :mod:`ddz_sdk.rules_gd`)."""
        return rules_gd.card_value(card, self.level)

    @property
    def leading(self) -> bool:
        """True if you are free to lead (nothing to beat)."""
        return self.to_beat is None

    @property
    def to_beat_pattern(self) -> Optional[Pattern]:
        """:class:`~ddz_sdk.rules_gd.GdPattern` you must beat, or ``None`` if you lead."""
        if not self.to_beat:
            return None
        p = self.to_beat.get("pattern")
        if p:
            try:
                return GdPattern.from_api(p, self.level)
            except (KeyError, ValueError):
                pass
        cards = self.to_beat.get("cards") or []
        return self.resolve(cards) if cards else None

    def resolve(
        self, cards: Sequence[str], last: Any = None, hint: Any = None
    ) -> GdPattern:
        """:func:`ddz_sdk.rules_gd.resolve_gd` at this hand's level."""
        return rules_gd.resolve_gd(cards, last, self.level, hint)

    def legal_moves(self) -> List[Move]:
        """All legal non-pass plays from your hand against ``to_beat`` (computed locally)."""
        return rules_gd.legal_moves_gd(self.hand, self.to_beat_pattern, self.level)

    def returnable_cards(self) -> List[str]:
        """Distinct cards you may return (natural 2..10, no wildcard), smallest first."""
        return rules_gd.returnable_cards(self.hand, self.level)

    @property
    def return_to(self) -> Optional[int]:
        """Seat you owe a return card to (it paid you a tribute), or None."""
        if not self.tribute or self.tribute.get("anti"):
            return None
        done = {(r.get("from"), r.get("to")) for r in self.returns}
        for t in self.tribute.get("tributes") or []:
            if t.get("to") == self.seat and (self.seat, t.get("from")) not in done:
                return t.get("from")
        return None

    def sort_hand(self) -> None:
        self.hand = rules_gd.sort_cards_gd(self.hand, self.level)


PlayReturn = Union[Sequence[str], Move, None]


def _wilds_in(m: Move, level: str) -> int:
    w = rules_gd.wildcard(level)
    return sum(1 for c in m.cards if c == w)


class GuandanBot(BaseBot):
    """Guandan base class. Override ``on_play`` (and ``on_return`` if you like)."""

    games = ("guandan",)
    default_game = "guandan"

    # ------------------------------------------------------------------ hooks
    def on_return(self, state: GuandanState) -> str:
        """Return the card to give back (one of ``state.returnable_cards()``). The default
        returns the smallest."""
        return state.returnable_cards()[0]

    def on_play(self, state: GuandanState) -> PlayReturn:
        """Return the cards to play, a :class:`~ddz_sdk.rules.Move`, or ``[]`` to pass (only
        allowed when ``state.can_pass``). The default plays the smallest non-bomb move, keeping
        wildcards, and passes rather than bombing."""
        moves = state.legal_moves()
        if not moves:
            return []
        best = min(
            moves,
            key=lambda m: (
                bomb_tier(m.pattern),
                _wilds_in(m, state.level),
                len(m.cards) > 1,
                m.pattern.main,
            ),
        )
        if state.can_pass and bomb_tier(best.pattern) >= 0:
            return []
        return best

    # ------------------------------------------------------------- internals
    def _new_state(self, **kw: Any) -> GuandanState:
        return GuandanState(**kw)

    def _move_cards(self, frm: Any, to: Any, card: Any) -> None:
        """A tribute or return card goes from seat ``frm`` to seat ``to``."""
        st = self.state
        if not isinstance(card, str):
            return
        if frm == st.seat:
            st.hand = remove_cards(st.hand, [card])
        if to == st.seat:
            st.hand = rules_gd.sort_cards_gd(st.hand + [card], st.level)
        for s, d in ((frm, -1), (to, 1)):
            if isinstance(s, int) and 0 <= s < len(st.cards_left):
                st.cards_left[s] += d

    def _apply_game_event(
        self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any
    ) -> None:
        st = self.state
        if t == "game.started":
            self._new_game(ev.get("game_id"))
            st = self.state
            st.phase = "playing"
            st.players = data.get("players") or []
            for p in st.players:
                if p and p.get("bot_id") == self.bot_id:
                    st.seat = p.get("seat")
            st.hand_no = data.get("hand_no") or 1
            st.level = str(data.get("level") or "2")
            st.level_team = data.get("level_team") or 0
            st.team_levels = list(data.get("team_levels") or st.team_levels)
            st.a_attempts = list(data.get("a_attempts") or st.a_attempts)
            if data.get("cards_left"):
                st.cards_left = list(data["cards_left"])
            if data.get("hand") is not None:
                st.hand = list(data["hand"])
                st.sort_hand()
            else:
                self._refresh_state(force=True)
        elif t == "tribute":
            if self._sync_game(ev):
                return
            st.tribute = {
                "anti": bool(data.get("anti")),
                "tributes": list(data.get("tributes") or []),
            }
            for tr in st.tribute["tributes"]:
                self._move_cards(tr.get("from"), tr.get("to"), tr.get("card"))
            if st.tribute["tributes"] and not st.tribute["anti"]:
                st.phase = "return"
        elif t == "turn":
            if self._sync_game(ev):
                return
            st.phase = data.get("phase") or "playing"
            st.turn = data.get("seat")
            st.turn_seq = seq
            st.remaining_ms = data.get("remaining_ms")
            st.to_beat = data.get("to_beat")
            st.can_pass = bool(data.get("can_pass"))
        elif t == "returned":
            r = {
                "from": data.get("from"),
                "to": data.get("to"),
                "card": data.get("card"),
            }
            st.returns.append(r)
            self._move_cards(r["from"], r["to"], r["card"])
            st.turn = None
        elif t == "played":
            s = data.get("seat")
            cards = list(data.get("cards") or [])
            entry = {"seat": s, "cards": cards, "pattern": data.get("pattern")}
            st.history.append(entry)
            st.to_beat = entry
            st.phase = "playing"
            if s == st.seat:
                st.hand = remove_cards(st.hand, cards)
            if data.get("cards_left"):
                st.cards_left = list(data["cards_left"])
            st.turn = None
        elif t == "passed":
            st.history.append({"seat": data.get("seat"), "cards": [], "pattern": None})
            st.turn = None
        elif t == "player.out":
            s = data.get("seat")
            if s is not None and s not in st.order:
                st.order.append(s)

    def _apply_state(self, g: Dict[str, Any]) -> None:
        st = self.state
        if g.get("game_id") != st.game_id:
            self._new_game(g.get("game_id"))
            st = self.state
        st.room_id = g.get("room_id", st.room_id)
        st.seat = g.get("seat", st.seat)
        st.phase = g.get("phase", st.phase)
        st.players = g.get("players") or st.players
        st.hand_no = g.get("hand_no") or st.hand_no
        st.level = str(g.get("level") or st.level)
        if g.get("level_team") is not None:
            st.level_team = g["level_team"]
        st.team_levels = list(g.get("team_levels") or st.team_levels)
        st.a_attempts = list(g.get("a_attempts") or st.a_attempts)
        st.tribute = g.get("tribute")
        st.returns = list(g.get("returns") or [])
        st.hand = list(g.get("hand") or [])
        st.sort_hand()
        live = st.phase in ("return", "playing")
        st.turn = g.get("turn") if live else None
        st.turn_seq = g.get("turn_seq")
        st.remaining_ms = g.get("remaining_ms")
        st.to_beat = g.get("to_beat")
        st.can_pass = bool(g.get("can_pass"))
        if g.get("cards_left"):
            st.cards_left = list(g["cards_left"])
        st.order = list(g.get("order") or [])
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
            and st.phase in ("return", "playing")
            and self._acted_turn_seq != self._turn_key()
        )

    def _turn_key(self) -> tuple:
        st = self.state
        return (st.game_id, st.turn_seq, st.phase, len(st.returns), len(st.history))

    def _maybe_act(self) -> None:
        if not self._my_turn():
            return
        st = self.state
        if st.seat < len(st.cards_left) and len(st.hand) != st.cards_left[st.seat]:
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
        done = self._do_return() if st.phase == "return" else self._do_play()
        if done:
            self._acted_turn_seq = key

    # ---- return (还贡)
    def _fallback_return(self) -> Optional[str]:
        """Smallest returnable card (the server's timeout choice)."""
        st = self.state
        opts = st.returnable_cards()
        if opts:
            return opts[0]
        single = rules_gd.lowest_single_gd(st.hand, st.level)
        return single[0] if single else None

    def _do_return(self) -> bool:
        st = self.state
        card: Optional[str] = None
        try:
            ret = self.on_return(st)
            if isinstance(ret, (list, tuple)) and len(ret) == 1:
                ret = ret[0]
            if isinstance(ret, str) and ret in st.returnable_cards():
                card = ret
            else:
                self._warn("on_return returned illegal %r; using fallback", ret)
                self.stats["fallbacks"] += 1
        except Exception:
            log.exception("[%s] on_return raised; using fallback", self.name)
            self.stats["fallbacks"] += 1
        if card is None:
            card = self._fallback_return()
        if card is None:
            return True  # nothing to return; the server acts on timeout
        for attempt in range(3):
            try:
                self._call(self.client.return_card, st.game_id, card, seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("return %s rejected: %s", card, e)
                self.stats["fallbacks"] += 1
                if attempt >= 1:
                    self._refresh_state(force=True)
                    if not self._my_turn():
                        return True
                    st = self.state
                card = self._fallback_return()
                if card is None:
                    return True
        return True

    # ---- play
    def _do_play(self) -> bool:
        st = self.state
        last = st.to_beat_pattern
        hint: Optional[Pattern] = None
        try:
            ret = self.on_play(st)
            if isinstance(ret, Move):
                hint = ret.pattern if isinstance(ret.pattern, GdPattern) else None
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
                self._call(
                    self.client.play,
                    st.game_id,
                    cards,
                    hint.type if hint else None,
                    seq=st.seq,
                    pattern_rank=hint.rank if hint else None,
                )
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
        except RuleError:
            return False

    def _fallback_cards(self) -> List[str]:
        """Safe action: pass if allowed, else the lowest single (or any legal move)."""
        st = self.state
        if st.can_pass and st.to_beat:
            return []
        if st.to_beat:
            moves = st.legal_moves()
            if moves:
                return min(moves, key=lambda m: len(m.cards)).cards
        return rules_gd.lowest_single_gd(st.hand, st.level)
