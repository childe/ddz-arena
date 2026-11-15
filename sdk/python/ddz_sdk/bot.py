"""Bot framework: subclass :class:`Bot`, override :meth:`Bot.on_bid` and :meth:`Bot.on_play`,
then call :meth:`Bot.run`.

``run`` takes care of the protocol: it joins a room (quick-join or a given room), connects the
player WebSocket (reconnecting with backoff and ``since=last_seq``), handles ``resync``, readies
up, tracks the game from events (falling back to ``GET /games/{gid}/state`` when unsure), and
calls your hooks only when ``bid.turn`` / ``turn`` names your seat. Moves are validated locally
with :mod:`ddz_sdk.rules`; if the hook raises, returns an illegal move, or the server answers
422, the bot falls back to a safe action (bid 0 / pass if allowed / lowest single) so it never
stalls.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

import websocket  # websocket-client

from . import rules
from .cards import contains_all, remove_cards, sort_cards
from .client import ApiError, Client
from .rules import Move, Pattern

log = logging.getLogger("ddz_sdk.bot")


@dataclass
class GameState:
    """What your bot knows about the current game. Passed to ``on_bid`` / ``on_play``.

    Seats are 0, 1, 2 and play order is 0 -> 1 -> 2 -> 0.
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
    bottom: List[str] = field(default_factory=list)  # the 3 bottom cards once revealed
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

    # ---- convenience ----
    @property
    def to_beat_pattern(self) -> Optional[Pattern]:
        """Pattern you must beat, or ``None`` if you lead."""
        if not self.to_beat:
            return None
        p = self.to_beat.get("pattern")
        if p:
            return Pattern.from_api(p)
        cards = self.to_beat.get("cards") or []
        return rules.resolve(cards) if cards else None

    @property
    def is_landlord(self) -> bool:
        return self.landlord is not None and self.landlord == self.seat

    @property
    def leading(self) -> bool:
        """True if you are free to lead (nothing to beat)."""
        return self.to_beat is None

    def teammates(self) -> List[int]:
        """Seats on your side (empty for the landlord)."""
        if self.landlord is None or self.seat is None or self.is_landlord:
            return []
        return [s for s in (0, 1, 2) if s not in (self.seat, self.landlord)]

    def is_teammate(self, seat: Optional[int]) -> bool:
        return seat is not None and seat in self.teammates()

    def legal_moves(self) -> List[Move]:
        """All legal non-pass plays from your hand against ``to_beat`` (computed locally)."""
        return rules.legal_moves(self.hand, self.to_beat_pattern)


PlayReturn = Union[Sequence[str], Move, None]


class Bot:
    """Base class. Override ``on_bid`` and ``on_play``; the rest is optional."""

    #: name used in log messages
    name: str = "bot"

    def __init__(self, name: Optional[str] = None):
        if name:
            self.name = name
        self.state = GameState()
        self.client: Optional[Client] = None
        self.bot_id: Optional[str] = None
        self.games_finished = 0
        self.max_games: Optional[int] = None
        self._stop = threading.Event()
        self._acted_turn_seq: Optional[tuple] = None
        self._ws: Optional[websocket.WebSocket] = None
        #: counters: local/server-rejected fallbacks, handler errors, WS reconnects,
        #: and actions the server made for us ("auto": should stay 0)
        self.stats = {"fallbacks": 0, "errors": 0, "reconnects": 0, "auto": 0}
        #: count of API errors seen, keyed by "STATUS CODE" (e.g. "409 STALE_SEQ")
        self.api_errors: Dict[str, int] = {}

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

    def on_event(self, event: Dict[str, Any]) -> None:
        """Called for every WebSocket message after the SDK updated ``self.state``."""

    def on_game_over(self, result: Dict[str, Any]) -> None:
        """Called on ``game.finished`` with the ``result`` object."""

    # -------------------------------------------------------------- lifecycle
    def stop(self) -> None:
        """Ask :meth:`run` to return (thread-safe)."""
        self._stop.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def run(
        self,
        base_url: str,
        token: str,
        room_id: Optional[str] = None,
        max_games: Optional[int] = None,
        leave_on_exit: bool = True,
    ) -> None:
        """Join a room and play until :meth:`stop` is called or ``max_games`` games finish.

        ``room_id=None`` uses quick-join (or stays in the room you are already seated in).
        """
        self.client = Client(base_url, token)
        self.max_games = max_games
        me = self._call(self.client.me)
        self.bot_id = me.get("bot_id")
        if me.get("name"):
            self.name = me["name"]
        self._join(me, room_id)
        events: "queue.Queue[tuple]" = queue.Queue()
        backoff = 0.5
        try:
            while not self._stop.is_set():
                since = self.state.seq or None
                try:
                    self._connect(since, events)
                    backoff = 0.5
                except Exception as e:  # connect failed
                    self._info("ws connect failed: %s; retry in %.1fs", e, backoff)
                    self._stop.wait(backoff)
                    backoff = min(backoff * 2, 10.0)
                    continue
                self._ensure_ready()
                self._refresh_state()
                self._loop(events)
                if not self._stop.is_set():
                    self.stats["reconnects"] += 1
                    self._info("ws disconnected; reconnecting in %.1fs", backoff)
                    self._stop.wait(backoff)
                    backoff = min(backoff * 2, 10.0)
        finally:
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    pass
            if leave_on_exit and self.state.room_id:
                try:
                    self.client.leave_room(self.state.room_id)
                except ApiError:
                    pass

    # ------------------------------------------------------------- internals
    def _info(self, msg: str, *args: Any) -> None:
        log.info("[%s] " + msg, self.name, *args)

    def _warn(self, msg: str, *args: Any) -> None:
        log.warning("[%s] " + msg, self.name, *args)

    def _call(self, fn, *args, **kwargs):
        """Call a client method with retries.

        429 RATE_LIMITED: sleep ~100 ms and retry, up to 5 times. Network errors / 5xx:
        exponential backoff (0.2 s .. 3 s), up to 5 retries. Other errors raise immediately;
        after the retries are used up the last error is raised and the caller falls back.
        """
        delay = 0.2
        rate_retries = net_retries = 0
        while True:
            try:
                return fn(*args, **kwargs)
            except ApiError as e:
                k = "%d %s" % (e.status, e.code)
                self.api_errors[k] = self.api_errors.get(k, 0) + 1
                if self._stop.is_set():
                    raise
                if e.status == 429 and rate_retries < 5:
                    rate_retries += 1
                    time.sleep(0.1)
                    continue
                if (e.status == 0 or e.status >= 500) and net_retries < 5:
                    net_retries += 1
                    time.sleep(delay)
                    delay = min(delay * 2, 3.0)
                    continue
                raise

    def _join(self, me: Dict[str, Any], room_id: Optional[str]) -> None:
        cur = me.get("room_id")
        if cur and (room_id is None or room_id == cur):
            self.state.room_id = cur
            self.state.seat = me.get("seat")
            self._info("already seated in %s seat %s", cur, self.state.seat)
            return
        if cur:
            self._call(self.client.leave_room, cur)
        if room_id:
            r = self._call(self.client.join_room, room_id)
        else:
            r = self._call(self.client.quick_join)
        self.state.room_id = r["room"]["id"]
        self.state.seat = r.get("seat")
        self._info("joined %s seat %s", self.state.room_id, self.state.seat)

    def _connect(self, since: Optional[int], events: "queue.Queue[tuple]") -> None:
        url = self.client.ws_url + "/ws?token=" + self.client.token
        if since:
            url += "&since=%d" % since
        ws = websocket.create_connection(url, timeout=10)
        ws.settimeout(None)
        self._ws = ws
        # drain any stale items from a previous connection
        while not events.empty():
            try:
                events.get_nowait()
            except queue.Empty:
                break
        t = threading.Thread(
            target=self._reader, args=(ws, events), name="ddz-ws-" + self.name
        )
        t.daemon = True
        t.start()

    def _reader(self, ws: websocket.WebSocket, events: "queue.Queue[tuple]") -> None:
        try:
            while True:
                raw = ws.recv()
                if raw is None or raw == "":
                    break
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                try:
                    events.put(("msg", ws, json.loads(raw)))
                except ValueError:
                    continue
        except Exception as e:
            events.put(("closed", ws, str(e)))
            return
        events.put(("closed", ws, "eof"))

    def _loop(self, events: "queue.Queue[tuple]") -> None:
        ws = self._ws
        last_rx = time.time()
        last_ping = time.time()
        while not self._stop.is_set():
            try:
                kind, src, payload = events.get(timeout=0.5)
            except queue.Empty:
                kind = None
            now = time.time()
            if kind == "closed":
                if src is ws:
                    return
                continue
            if kind == "msg":
                if src is not ws:
                    continue
                last_rx = now
                self._handle(payload)
                if self._stop.is_set():
                    return
                if not events.empty():
                    continue  # process the whole batch (e.g. replay) before acting
            if now - last_ping > 15:
                last_ping = now
                try:
                    ws.send(json.dumps({"op": "ping"}))
                except Exception:
                    return
            if now - last_rx > 30 and self.state.game_id:
                # Quiet for too long during a game: make sure we did not miss anything.
                last_rx = now
                self._refresh_state()
            self._maybe_act()

    # ---- event handling
    def _handle(self, ev: Dict[str, Any]) -> None:
        st = self.state
        t = ev.get("type")
        data = ev.get("data") or {}
        seq = ev.get("seq")
        if isinstance(seq, int) and t not in ("hello", "pong", "reply"):
            if seq <= st.seq:
                return  # duplicate / already reflected in a state refresh
            st.seq = seq
        if data.get("auto") and data.get("seat") == st.seat:
            self.stats["auto"] += 1  # the server acted for us (timeout / trustee)
        if ev.get("room_id"):
            st.room_id = ev["room_id"]
        try:
            self._apply_event(t, ev, data, seq)
        except Exception:
            log.exception("[%s] error handling %s", self.name, t)
            self.stats["errors"] += 1
        try:
            self.on_event(ev)
        except Exception:
            log.exception("[%s] on_event raised", self.name)

    def _apply_event(self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any):
        st = self.state
        if t == "resync":
            self._refresh_state(force=True)
        elif t == "room.updated":
            self._on_room(data.get("room") or {})
        elif t == "game.started":
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
            if st.landlord is not None:
                st.cards_left[st.landlord] = 20
            if st.landlord == st.seat and st.hand and len(st.hand) == 17:
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
        elif t == "game.finished":
            st.phase = "finished"
            st.turn = None
            st.result = data.get("result")
            self.games_finished += 1
            try:
                self.on_game_over(st.result or {})
            except Exception:
                log.exception("[%s] on_game_over raised", self.name)
            if self.max_games is not None and self.games_finished >= self.max_games:
                self._stop.set()

    def _new_game(self, game_id: Optional[str]) -> None:
        old = self.state
        self.state = GameState(
            game_id=game_id, room_id=old.room_id, seat=old.seat, seq=old.seq
        )

    def _sync_game(self, ev: Dict[str, Any]) -> bool:
        """If an event belongs to a game we don't know, rebuild from the server.

        Returns True if the state was rebuilt (it then already reflects this event).
        """
        gid = ev.get("game_id")
        if gid and gid != self.state.game_id:
            self.state.game_id = gid
            self._refresh_state(force=True)
            return True
        return False

    def _on_room(self, room: Dict[str, Any]) -> None:
        if not room:
            return
        self.state.room_id = room.get("id", self.state.room_id)
        mine = None
        for s in room.get("seats") or []:
            if s and s.get("bot_id") == self.bot_id:
                mine = s
                self.state.seat = s.get("seat")
        if (
            mine is not None
            and room.get("status") == "waiting"
            and not mine.get("ready")
            and not self._stop.is_set()
        ):
            self._ensure_ready()

    def _ensure_ready(self) -> None:
        if not self.state.room_id:
            return
        try:
            self._call(self.client.ready, self.state.room_id, True)
        except ApiError as e:
            if e.code not in ("GAME_IN_PROGRESS", "WRONG_PHASE"):
                self._warn("ready failed: %s", e)

    def _refresh_state(self, force: bool = False) -> None:
        """Rebuild ``self.state`` from ``/me`` + ``GET /games/{gid}/state``."""
        try:
            gid = self.state.game_id
            if force is False or not gid:
                me = self._call(self.client.me)
                if me.get("room_id"):
                    self.state.room_id = me["room_id"]
                if me.get("seat") is not None:
                    self.state.seat = me["seat"]
                gid = me.get("game_id") or gid
            if not gid:
                return
            g = self._call(self.client.game_state, gid)
        except ApiError as e:
            self._warn("state refresh failed: %s", e)
            return
        self._apply_state(g)

    def _apply_state(self, g: Dict[str, Any]) -> None:
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
        if st.phase == "playing" and len(st.hand) != st.cards_left[st.seat]:
            self._info(
                "hand size %d != cards_left %d; refreshing",
                len(st.hand),
                st.cards_left[st.seat],
            )
            self._refresh_state(force=True)
            if not self._my_turn():
                return
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
                cards, hint = self._fallback_cards(), None
        return True

    def _locally_ok(self, cards: List[str], last: Optional[Pattern], hint) -> bool:
        st = self.state
        if not cards:
            return st.can_pass and last is not None
        if not contains_all(st.hand, cards):
            return False
        try:
            rules.resolve(cards, last, hint)
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

    def _handle_conflict(self, e: ApiError) -> bool:
        """Handle 409/403/404 responses. Returns True if the caller should stop retrying."""
        if e.status in (409, 403, 404):
            if e.code != "STALE_SEQ":
                self._info("action conflict: %s", e)
            self._refresh_state(force=True)
            return True
        return False
