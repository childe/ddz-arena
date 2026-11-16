"""Game-independent bot lifecycle shared by :class:`ddz_sdk.Bot` (Dou Dizhu, 3 or 4 players),
:class:`ddz_sdk.GuandanBot` (Guandan) and :class:`ddz_sdk.HoldemBot` (Texas Hold'em).

:class:`BaseBot` handles the protocol: it joins a room (quick-join for a game type, or a given
room), connects the player WebSocket first-come (reconnecting with backoff and
``since=last_seq``), handles ``resync``, readies up, de-duplicates events by ``seq``, retries
``429`` and network errors, and refreshes from ``GET /games/{gid}/state`` when unsure.
Subclasses implement the game-specific state tracking and acting.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from typing import Any, Dict, Optional, Tuple

import websocket  # websocket-client

from .client import USER_AGENT, ApiError, Client

log = logging.getLogger("ddz_sdk.bot")

#: game types known to the SDK
GAME_TYPES = ("ddz", "ddz4", "holdem", "guandan")


class BaseBot:
    """Lifecycle base class. Use :class:`ddz_sdk.Bot` or :class:`ddz_sdk.HoldemBot`."""

    #: name used in log messages
    name: str = "bot"
    #: game types this bot class can play (empty = any)
    games: Tuple[str, ...] = ()
    #: game type passed to quick-join when ``run(game=None)`` (None = server default, ``ddz``)
    default_game: Optional[str] = None

    def __init__(self, name: Optional[str] = None):
        if name:
            self.name = name
        self.state: Any = self._new_state()
        self.client: Optional[Client] = None
        self.bot_id: Optional[str] = None
        #: game type of the room we sit in (``"ddz"``, ``"ddz4"``, ``"holdem"``,
        #: ``"guandan"``), once known
        self.game_type: Optional[str] = None
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
    def on_event(self, event: Dict[str, Any]) -> None:
        """Called for every WebSocket message after the SDK updated ``self.state``."""

    def on_game_over(self, result: Dict[str, Any]) -> None:
        """Called on ``game.finished`` with the ``result`` object."""

    # ------------------------------------------------------ subclass interface
    def _new_state(self, **kw: Any) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError

    def _apply_game_event(
        self, t: Any, ev: Dict[str, Any], data: Dict[str, Any], seq: Any
    ) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _apply_state(self, g: Dict[str, Any]) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _maybe_act(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _my_turn(self) -> bool:  # pragma: no cover - abstract
        raise NotImplementedError

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
        game: Optional[str] = None,
    ) -> None:
        """Join a room and play until :meth:`stop` is called or ``max_games`` games finish.

        ``room_id=None`` uses quick-join for ``game`` (default: the class's
        ``default_game``), or stays in the room you are already seated in if it is of that
        game type. Raises ``ValueError`` if the room's game type is not one this bot plays.
        """
        game = game or self.default_game
        if game is not None and self.games and game not in self.games:
            raise ValueError(
                "%s plays %s, not %r"
                % (type(self).__name__, "/".join(self.games), game)
            )
        self.client = Client(base_url, token)
        self.max_games = max_games
        me = self._call(self.client.me)
        self.bot_id = me.get("bot_id")
        if me.get("name"):
            self.name = me["name"]
        self._join(me, room_id, game)
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

    def _set_game_type(self, game: Optional[str]) -> None:
        if not game:
            return
        self.game_type = game
        if hasattr(self.state, "game"):
            self.state.game = game

    def _check_game_type(self) -> None:
        if self.games and self.game_type and self.game_type not in self.games:
            room = self.state.room_id
            try:
                if room:
                    self.client.leave_room(room)
            except ApiError:
                pass
            self.state.room_id = None
            raise ValueError(
                "room %s is a %r room; %s plays %s"
                % (room, self.game_type, type(self).__name__, "/".join(self.games))
            )

    def _join(
        self, me: Dict[str, Any], room_id: Optional[str], game: Optional[str] = None
    ) -> None:
        cur = me.get("room_id")
        if cur and (room_id is None or room_id == cur):
            cur_game = None
            try:
                cur_game = (
                    self._call(self.client.get_room, cur).get("room") or {}
                ).get("game")
            except ApiError:
                pass
            if room_id is not None or game is None or cur_game in (None, game):
                self.state.room_id = cur
                self.state.seat = me.get("seat")
                self._set_game_type(cur_game)
                self._check_game_type()
                self._info("already seated in %s seat %s", cur, self.state.seat)
                return
            self._info(
                "seated in a %s room %s; leaving to play %s", cur_game, cur, game
            )
        if cur:
            self._call(self.client.leave_room, cur)
        if room_id:
            r = self._call(self.client.join_room, room_id)
        elif game is not None:
            r = self._call(self.client.quick_join, game)
        else:
            r = self._call(self.client.quick_join)
        room = r.get("room") or {}
        self.state.room_id = room.get("id")
        self.state.seat = r.get("seat")
        self._set_game_type(room.get("game") or "ddz")
        self._check_game_type()
        self._info(
            "joined %s room %s seat %s",
            self.game_type,
            self.state.room_id,
            self.state.seat,
        )

    def _connect(self, since: Optional[int], events: "queue.Queue[tuple]") -> None:
        url = self.client.ws_url + "/ws?token=" + self.client.token
        if since:
            url += "&since=%d" % since
        ws = websocket.create_connection(
            url, timeout=10, header=["User-Agent: " + USER_AGENT]
        )
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
        if t == "resync":
            self._refresh_state(force=True)
        elif t == "room.updated":
            self._on_room(data.get("room") or {})
        elif t == "game.finished":
            st = self.state
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
        else:
            self._apply_game_event(t, ev, data, seq)

    def _new_game(self, game_id: Optional[str]) -> None:
        old = self.state
        self.state = self._new_state(
            game_id=game_id, room_id=old.room_id, seat=old.seat, seq=old.seq
        )
        if self.game_type and hasattr(self.state, "game"):
            self.state.game = self.game_type

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
        if room.get("game"):
            self._set_game_type(room["game"])
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
            if e.code == "NOT_A_PLAYER":
                # e.g. seated at a poker table mid-hand: we join from the next hand
                self._info("not a player in the current game")
            else:
                self._warn("state refresh failed: %s", e)
            return
        if g.get("game"):
            self._set_game_type(g["game"])
        self._apply_state(g)

    def _handle_conflict(self, e: ApiError) -> bool:
        """Handle 409/403/404 responses. Returns True if the caller should stop retrying."""
        if e.status in (409, 403, 404):
            if e.code != "STALE_SEQ":
                self._info("action conflict: %s", e)
            self._refresh_state(force=True)
            return True
        return False
