"""Gongzhu (拱猪) bot framework: subclass :class:`GongzhuBot`, override
:meth:`GongzhuBot.choose_card` (and optionally :meth:`GongzhuBot.choose_expose`), then call
:meth:`GongzhuBot.run`.

The lifecycle is the same as :class:`ddz_sdk.Bot` (see :mod:`ddz_sdk.base`): quick-join a
``gongzhu`` room (or join ``room_id``), connect the WebSocket, ready up, reconnect with
``since``, resync from ``GET /games/{gid}/state``. Each hand of a match is one game. The SDK
tracks it in :class:`GongzhuState` -- the dealt hand, every seat's exposed cards, the trick in
progress, completed tricks and the scoring cards each seat took -- and calls your hooks when a
``turn`` event names your seat:

* ``phase == "expose"``: ``choose_expose(state)`` returns the cards to expose, a subset of
  ``state.exposable_cards()`` (``[]`` = expose nothing);
* ``phase == "playing"``: ``choose_card(state)`` returns one card from
  ``state.legal_cards()``.

Choices are validated locally with :mod:`ddz_sdk.rules_gz`. If a hook raises, returns something
illegal, or the server answers 422, the SDK falls back to the server's timeout action -- expose
nothing; play the lowest legal card, preferring cards that are not scoring cards -- so the bot
never stalls.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Set, Union

from . import rules_gz
from .base import BaseBot
from .client import ApiError
from .rules import RuleError

log = logging.getLogger("ddz_sdk.bot")

HAND_SIZE = rules_gz.HAND_SIZE_GZ
SEATS = rules_gz.SEATS_GZ


def _four(default) -> List[Any]:
    return [default() for _ in range(SEATS)]


@dataclass
class GongzhuState:
    """What your bot knows about the current hand. Passed to ``choose_expose`` / ``choose_card``.

    Play order is 0 -> 1 -> 2 -> 3 -> 0; everybody plays for themselves.
    """

    game_id: Optional[str] = None
    room_id: Optional[str] = None
    seat: Optional[int] = None  # your seat
    hand: List[str] = field(default_factory=list)  # your cards, sorted (S H C D, 2..A)
    phase: str = "waiting"  # waiting | expose | playing | finished
    players: List[Dict[str, Any]] = field(default_factory=list)
    hand_no: int = 1  # hand number within the match
    totals: List[int] = field(default_factory=lambda: [0] * SEATS)  # before this hand
    first_leader: Optional[int] = None  # exposes first and leads the first trick
    exposed: List[List[str]] = field(default_factory=lambda: _four(list))
    exposes_done: int = 0  # seats that have made their expose decision
    turn: Optional[int] = None  # seat whose turn it is (None between events)
    turn_seq: Optional[int] = None  # seq of the current turn event
    remaining_ms: Optional[int] = None
    trick_no: int = 1  # trick in progress or about to start, 1-based
    # Trick in progress {"leader", "plays": [{"seat","card"}], "winner": None}, or None
    trick: Optional[Dict[str, Any]] = None
    # Completed tricks {"leader", "plays", "winner"}
    tricks: List[Dict[str, Any]] = field(default_factory=list)
    taken: List[List[str]] = field(default_factory=lambda: _four(list))
    cards_left: List[int] = field(default_factory=lambda: [HAND_SIZE] * SEATS)
    seq: int = 0  # latest event seq seen in this room
    result: Optional[Dict[str, Any]] = None
    game: str = "gongzhu"

    # ---- the trick
    @property
    def plays(self) -> List[Dict[str, Any]]:
        """Plays of the trick in progress (``[]`` when you lead)."""
        return list((self.trick or {}).get("plays") or [])

    @property
    def leading(self) -> bool:
        """True if you lead the trick (nothing played yet)."""
        return not self.plays

    @property
    def led_suit(self) -> Optional[str]:
        """Suit led in the trick in progress, or None when you lead."""
        p = self.plays
        return p[0]["card"][1] if p else None

    @property
    def trick_cards(self) -> List[str]:
        return [p["card"] for p in self.plays]

    def trick_winner(self) -> Optional[int]:
        """Seat currently winning the trick in progress (None if it is empty)."""
        p = self.plays
        return rules_gz.trick_winner(p) if p else None

    def winning_card(self) -> Optional[str]:
        """Highest card of the led suit so far."""
        w = self.trick_winner()
        if w is None:
            return None
        return next(p["card"] for p in self.plays if p["seat"] == w)

    def led_before(self) -> Set[str]:
        """Suits led in completed tricks (an exposed card of these suits is free to play)."""
        return {t["plays"][0]["card"][1] for t in self.tricks if t.get("plays")}

    # ---- exposure
    @property
    def all_exposed(self) -> List[str]:
        """Every exposed card, whoever exposed it (exposure doubles for the taker)."""
        return [c for e in self.exposed for c in e]

    @property
    def my_exposed(self) -> List[str]:
        return list(self.exposed[self.seat]) if self.seat is not None else []

    def exposable_cards(self) -> List[str]:
        """Cards in your hand you may expose (``QS`` / ``JD`` / ``TC`` / ``AH``)."""
        return rules_gz.exposable(self.hand)

    # ---- cards
    def legal_cards(self) -> List[str]:
        """Cards you may play now (computed locally, see :func:`ddz_sdk.rules_gz.legal_cards`)."""
        return rules_gz.legal_cards(
            self.hand, self.led_suit, self.my_exposed, self.led_before()
        )

    def played_cards(self) -> List[str]:
        """Cards played in this hand so far, completed tricks first."""
        out = [p["card"] for t in self.tricks for p in t.get("plays") or []]
        return out + self.trick_cards

    def unseen_cards(self) -> List[str]:
        """Cards neither in your hand nor played: the other three hands together."""
        known = set(self.hand) | set(self.played_cards())
        return [c for c in rules_gz.DECK if c not in known]

    def voids(self) -> List[Set[str]]:
        """Suits each seat is known to be out of (it did not follow a led suit)."""
        out: List[Set[str]] = [set() for _ in range(SEATS)]
        for t in self.tricks + ([self.trick] if self.trick else []):
            plays = t.get("plays") or []
            if not plays:
                continue
            suit = plays[0]["card"][1]
            for p in plays[1:]:
                if p["card"][1] != suit:
                    out[p["seat"]].add(suit)
        return out

    def scoring_out(self) -> List[str]:
        """Scoring cards not yet taken by anybody (in hands or in the trick in progress)."""
        got = {c for t in self.taken for c in t}
        return [c for c in rules_gz.DECK if rules_gz.is_scoring(c) and c not in got]

    def points(self, seat: Optional[int] = None) -> int:
        """Points ``seat`` (default you) would score with what it has taken so far."""
        s = self.seat if seat is None else seat
        return rules_gz.score_taken(self.taken[s], self.all_exposed)

    def next_seat(self, seat: Optional[int] = None) -> Optional[int]:
        s = self.seat if seat is None else seat
        return None if s is None else (s + 1) % SEATS

    def sort_hand(self) -> None:
        self.hand = rules_gz.sort_cards_gz(self.hand)


ExposeReturn = Optional[Sequence[str]]
CardReturn = Union[str, Sequence[str], None]


class GongzhuBot(BaseBot):
    """Gongzhu base class. Override ``choose_card`` (and ``choose_expose`` if you like)."""

    games = ("gongzhu",)
    default_game = "gongzhu"

    # ------------------------------------------------------------------ hooks
    def choose_expose(self, state: GongzhuState) -> ExposeReturn:
        """Return the cards to expose, a subset of ``state.exposable_cards()``. The default
        exposes nothing."""
        return []

    def choose_card(self, state: GongzhuState) -> CardReturn:
        """Return one card of ``state.legal_cards()``. The default plays the server's timeout
        choice: the lowest legal card, preferring cards that are not scoring cards."""
        return rules_gz.lowest_safe_card(state.legal_cards())

    # ------------------------------------------------------------- internals
    def _new_state(self, **kw: Any) -> GongzhuState:
        return GongzhuState(**kw)

    def _apply_game_event(
        self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any
    ) -> None:
        st = self.state
        if t == "game.started":
            self._new_game(ev.get("game_id"))
            st = self.state
            st.phase = "expose"
            st.players = data.get("players") or []
            for p in st.players:
                if p and p.get("bot_id") == self.bot_id:
                    st.seat = p.get("seat")
            st.hand_no = data.get("hand_no") or 1
            if data.get("totals"):
                st.totals = list(data["totals"])
            st.first_leader = data.get("first_leader")
            if data.get("cards_left"):
                st.cards_left = list(data["cards_left"])
            if data.get("hand") is not None:
                st.hand = list(data["hand"])
                st.sort_hand()
            else:
                self._refresh_state(force=True)
        elif t == "turn":
            if self._sync_game(ev):
                return
            st.phase = data.get("phase") or "playing"
            st.turn = data.get("seat")
            st.turn_seq = seq
            st.remaining_ms = data.get("remaining_ms")
            if data.get("trick_no"):
                st.trick_no = data["trick_no"]
            if "trick" in data:
                st.trick = data.get("trick")
        elif t == "exposed":
            if self._sync_game(ev):
                return
            s = data.get("seat")
            if isinstance(s, int) and 0 <= s < SEATS:
                st.exposed[s] = list(data.get("cards") or [])
            st.exposes_done += 1
            st.turn = None
        elif t == "played":
            if self._sync_game(ev):
                return
            s = data.get("seat")
            card = data.get("card")
            if st.trick is None:
                st.trick = {"leader": s, "plays": [], "winner": None}
            st.trick["plays"] = list(st.trick.get("plays") or []) + [
                {"seat": s, "card": card}
            ]
            st.phase = "playing"
            if s == st.seat and card in st.hand:
                st.hand = [c for c in st.hand if c != card]
            if data.get("cards_left"):
                st.cards_left = list(data["cards_left"])
            st.turn = None
        elif t == "trick.won":
            if self._sync_game(ev):
                return
            plays = list(data.get("plays") or st.plays)
            w = data.get("seat")
            st.tricks.append(
                {
                    "leader": plays[0]["seat"] if plays else None,
                    "plays": plays,
                    "winner": w,
                }
            )
            if isinstance(w, int) and 0 <= w < SEATS:
                st.taken[w] = st.taken[w] + list(data.get("cards") or [])
            st.trick = None
            st.trick_no = len(st.tricks) + 1

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
        if g.get("totals"):
            st.totals = list(g["totals"])
        if g.get("first_leader") is not None:
            st.first_leader = g["first_leader"]
        if g.get("exposed"):
            st.exposed = [list(e or []) for e in g["exposed"]]
        st.hand = list(g.get("hand") or [])
        st.sort_hand()
        live = st.phase in ("expose", "playing")
        st.turn = g.get("turn") if live else None
        st.turn_seq = g.get("turn_seq")
        st.remaining_ms = g.get("remaining_ms")
        st.trick_no = g.get("trick_no") or st.trick_no
        st.trick = g.get("trick")
        st.tricks = list(g.get("tricks") or [])
        if g.get("taken"):
            st.taken = [list(t or []) for t in g["taken"]]
        if g.get("cards_left"):
            st.cards_left = list(g["cards_left"])
        if st.phase == "expose":
            # Seats decide in order from the first leader: the seat on turn is the next one.
            fl, tn = st.first_leader, st.turn
            st.exposes_done = (
                (tn - fl) % SEATS if fl is not None and tn is not None else 0
            )
        else:
            st.exposes_done = SEATS
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
            and st.phase in ("expose", "playing")
            and self._acted_turn_seq != self._turn_key()
        )

    def _turn_key(self) -> tuple:
        st = self.state
        return (
            st.game_id,
            st.turn_seq,
            st.phase,
            st.exposes_done,
            len(st.tricks),
            len(st.plays),
        )

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
        done = self._do_expose() if st.phase == "expose" else self._do_play()
        if done:
            self._acted_turn_seq = key

    # ---- expose (亮牌)
    def _do_expose(self) -> bool:
        st = self.state
        cards: List[str] = []
        try:
            ret = self.choose_expose(st)
            ret = [ret] if isinstance(ret, str) else list(ret or [])
            ok = st.exposable_cards()
            if len(set(ret)) == len(ret) and all(c in ok for c in ret):
                cards = ret
            else:
                self._warn("choose_expose returned illegal %r; exposing nothing", ret)
                self.stats["fallbacks"] += 1
        except Exception:
            log.exception("[%s] choose_expose raised; exposing nothing", self.name)
            self.stats["fallbacks"] += 1
        for attempt in range(3):
            try:
                self._call(self.client.expose, st.game_id, cards, seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("expose %s rejected: %s", cards, e)
                self.stats["fallbacks"] += 1
                if attempt >= 1:
                    self._refresh_state(force=True)
                    if not self._my_turn():
                        return True
                    st = self.state
                cards = []
        return True

    # ---- play
    def _check(self, card: Any) -> bool:
        st = self.state
        try:
            rules_gz.check_play(
                card, st.hand, st.led_suit, st.my_exposed, st.led_before()
            )
            return True
        except RuleError:
            return False

    def _fallback_card(self) -> Optional[str]:
        """The server's timeout choice: lowest legal card, non-scoring cards first."""
        legal = self.state.legal_cards()
        return rules_gz.lowest_safe_card(legal) if legal else None

    def _do_play(self) -> bool:
        st = self.state
        card: Optional[str] = None
        try:
            ret = self.choose_card(st)
            if isinstance(ret, (list, tuple)) and len(ret) == 1:
                ret = ret[0]
            if isinstance(ret, str) and self._check(ret):
                card = ret
            else:
                self._warn("choose_card returned illegal %r; using fallback", ret)
                self.stats["fallbacks"] += 1
        except Exception:
            log.exception("[%s] choose_card raised; using fallback", self.name)
            self.stats["fallbacks"] += 1
        if card is None:
            card = self._fallback_card()
        if card is None:
            return True  # nothing to play; the server acts on timeout
        for attempt in range(4):
            try:
                self._call(self.client.play_card, st.game_id, card, seq=st.seq)
                return True
            except ApiError as e:
                if self._handle_conflict(e):
                    return not self._my_turn()
                self._warn("play %s rejected: %s", card, e)
                self.stats["fallbacks"] += 1
                if attempt >= 1:
                    self._refresh_state(force=True)
                    if not self._my_turn():
                        return True
                    st = self.state
                card = self._fallback_card()
                if card is None:
                    return True
        return True
