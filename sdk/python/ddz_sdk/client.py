"""HTTP client for the card-game platform (``/api/v1``), stdlib ``urllib`` only.

Every method returns the decoded JSON response body (a ``dict``). Non-2xx responses
raise :class:`ApiError` with the server's ``code`` / ``message`` / ``details``.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterator, List, Optional, Sequence

USER_AGENT = "ddz-sdk-python/0.4.0"


class ApiError(Exception):
    """A non-2xx response. ``status`` is the HTTP status (0 for network errors)."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str = "",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__("%s %s: %s" % (status, code, message))
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def _ws_base(base_url: str) -> str:
    u = base_url.rstrip("/")
    if u.startswith("https://"):
        return "wss://" + u[len("https://") :]
    if u.startswith("http://"):
        return "ws://" + u[len("http://") :]
    return u


def request(
    base_url: str,
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
    timeout: float = 15.0,
) -> Dict[str, Any]:
    """Low-level JSON request. ``path`` is relative to ``/api/v1`` (e.g. ``"/me"``)."""
    url = base_url.rstrip("/") + "/api/v1" + path
    data = None
    # A custom User-Agent: CDNs such as Cloudflare block the default "Python-urllib/x.y".
    headers = {"accept": "application/json", "user-agent": USER_AGENT}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read() or b""
        code, message, details = "HTTP_%d" % e.code, raw.decode("utf-8", "replace"), {}
        try:
            err = json.loads(raw.decode("utf-8")).get("error") or {}
            code = err.get("code", code)
            message = err.get("message", message)
            details = err.get("details") or {}
        except (ValueError, AttributeError):
            pass
        raise ApiError(e.code, code, message, details) from None
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
        raise ApiError(0, "NETWORK_ERROR", str(e)) from None
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


class Client:
    """Authenticated client. ``token`` may be ``None`` for public endpoints only."""

    def __init__(
        self, base_url: str, token: Optional[str] = None, timeout: float = 15.0
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @property
    def ws_url(self) -> str:
        """Base WebSocket URL (``ws://host:port``)."""
        return _ws_base(self.base_url)

    def _req(self, method: str, path: str, body: Optional[Dict[str, Any]] = None):
        return request(self.base_url, method, path, body, self.token, self.timeout)

    # ---- accounts ----
    def register_bot(
        self, name: str, invite_code: Optional[str] = None
    ) -> Dict[str, Any]:
        """``POST /bots`` -> ``{"bot_id","name","kind","token"}``."""
        body: Dict[str, Any] = {"name": name}
        if invite_code is not None:
            body["invite_code"] = invite_code
        return self._req("POST", "/bots", body)

    def register_guest(self, name: str) -> Dict[str, Any]:
        """``POST /guests`` (human web players)."""
        return self._req("POST", "/guests", {"name": name})

    def me(self) -> Dict[str, Any]:
        return self._req("GET", "/me")

    # ---- rooms ----
    def list_rooms(self) -> List[Dict[str, Any]]:
        return self._req("GET", "/rooms").get("rooms", [])

    def create_room(
        self,
        name: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        game: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /rooms`` -> ``Room``. ``game``: ``"ddz"`` (default), ``"ddz4"``, ``"holdem"``,
        ``"guandan"`` or ``"gongzhu"``.

        Example: ``create_room("table", {"seats": 6}, game="holdem")``.
        """
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if game is not None:
            body["game"] = game
        if config is not None:
            body["config"] = config
        return self._req("POST", "/rooms", body)

    def get_room(self, room_id: str) -> Dict[str, Any]:
        """-> ``{"room": Room, "game": PublicGame | None, "seq": int}``."""
        return self._req("GET", "/rooms/%s" % _q(room_id))

    def quick_join(self, game: Optional[str] = None) -> Dict[str, Any]:
        """-> ``{"room": Room, "seat": int}``. Only joins rooms of ``game`` (default ``ddz``;
        also ``ddz4``, ``holdem``, ``guandan``, ``gongzhu``)."""
        body: Dict[str, Any] = {}
        if game is not None:
            body["game"] = game
        return self._req("POST", "/rooms/quick-join", body)

    def join_room(self, room_id: str, seat: Optional[int] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if seat is not None:
            body["seat"] = seat
        return self._req("POST", "/rooms/%s/join" % _q(room_id), body)

    def leave_room(self, room_id: str) -> Dict[str, Any]:
        return self._req("POST", "/rooms/%s/leave" % _q(room_id), {})

    def dissolve_room(self, room_id: str) -> Dict[str, Any]:
        """Close a room you created: everyone is unseated and a running game is dropped."""
        return self._req("DELETE", "/rooms/%s" % _q(room_id))

    def ready(self, room_id: str, ready: bool = True) -> Dict[str, Any]:
        return self._req("POST", "/rooms/%s/ready" % _q(room_id), {"ready": ready})

    # ---- games ----
    def game_state(self, game_id: str) -> Dict[str, Any]:
        """``PlayerGame`` (public game + ``seat`` + ``hand``)."""
        return self._req("GET", "/games/%s/state" % _q(game_id))

    def legal_moves(self, game_id: str) -> Dict[str, Any]:
        """Dou Dizhu: ``{"moves": [{"cards","pattern"}], "can_pass"}``; Hold'em:
        ``{"actions": {"fold","check","call","raise"} | None}``; Guandan: like Dou Dizhu while
        playing, ``{"return_cards": [...]}`` while returning a tribute; Gongzhu:
        ``{"exposable": [...]}`` while exposing, ``{"cards": [...]}`` while playing. May 403
        LEGAL_MOVES_DISABLED.
        """
        return self._req("GET", "/games/%s/legal-moves" % _q(game_id))

    def bid(
        self, game_id: str, score: int, seq: Optional[int] = None
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"score": int(score)}
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/bid" % _q(game_id), body)

    def play(
        self,
        game_id: str,
        cards: Sequence[str],
        pattern_type: Optional[str] = None,
        seq: Optional[int] = None,
        pattern_rank: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Play ``cards`` (empty = pass). ``pattern_type`` disambiguates (e.g. ``"plane_single"``);
        Guandan also accepts ``pattern_rank`` (e.g. ``"7"`` for the straight 3-7 played with a
        wildcard) and answers 422 ``PATTERN_MISMATCH`` if that interpretation does not exist.
        """
        body: Dict[str, Any] = {"cards": list(cards)}
        if pattern_type:
            body["pattern"] = {"type": pattern_type}
            if pattern_rank:
                body["pattern"]["rank"] = pattern_rank
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/play" % _q(game_id), body)

    def return_card(
        self, game_id: str, card: str, seq: Optional[int] = None
    ) -> Dict[str, Any]:
        """Guandan: give one card back to your tribute payer (还贡), ``POST /games/{gid}/return``."""
        body: Dict[str, Any] = {"card": card}
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/return" % _q(game_id), body)

    def expose(
        self, game_id: str, cards: Sequence[str], seq: Optional[int] = None
    ) -> Dict[str, Any]:
        """Gongzhu: expose (亮牌) some of ``QS`` / ``JD`` / ``TC`` / ``AH``,
        ``POST /games/{gid}/expose``; ``cards=[]`` exposes nothing."""
        body: Dict[str, Any] = {"cards": list(cards)}
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/expose" % _q(game_id), body)

    def play_card(
        self, game_id: str, card: str, seq: Optional[int] = None
    ) -> Dict[str, Any]:
        """Gongzhu: play one card, ``POST /games/{gid}/play`` with ``{"card": ...}``."""
        body: Dict[str, Any] = {"card": card}
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/play" % _q(game_id), body)

    def pass_turn(self, game_id: str, seq: Optional[int] = None) -> Dict[str, Any]:
        return self.play(game_id, [], seq=seq)

    def action(
        self,
        game_id: str,
        action: str,
        amount: Optional[int] = None,
        seq: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Hold'em: ``POST /games/{gid}/action`` -> ``{"ok": true, "seq"}``.

        ``action`` is ``"fold"``, ``"check"``, ``"call"`` or ``"raise"``; for ``raise``,
        ``amount`` is your total bet for this street (raise-to), not the increment.
        """
        body: Dict[str, Any] = {"action": action}
        if amount is not None:
            body["amount"] = int(amount)
        if seq is not None:
            body["seq"] = seq
        return self._req("POST", "/games/%s/action" % _q(game_id), body)

    def get_game(self, game_id: str) -> Dict[str, Any]:
        """``PublicGame`` (spectator view)."""
        return self._req("GET", "/games/%s" % _q(game_id))

    def replay(self, game_id: str) -> Dict[str, Any]:
        return self._req("GET", "/games/%s/replay" % _q(game_id))

    def list_games(
        self,
        limit: int = 20,
        bot_id: Optional[str] = None,
        game: Optional[str] = None,
        room_id: Optional[str] = None,
        before: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Recent finished games (``GameSummary`` list, newest first), optionally only those
        of one bot, one ``game`` type and/or one room. ``before`` (a game id) returns the
        games that finished before that one; :meth:`iter_games` pages through all of them.
        """
        return self._games_page(limit, bot_id, game, room_id, before)["games"]

    def iter_games(
        self,
        bot_id: Optional[str] = None,
        game: Optional[str] = None,
        room_id: Optional[str] = None,
        page_size: int = 100,
    ) -> Iterator[Dict[str, Any]]:
        """Every finished game matching the filters, newest first, fetched page by page."""
        before = None
        while True:
            page = self._games_page(page_size, bot_id, game, room_id, before)
            yield from page["games"]
            before = page.get("next")
            if not before:
                return

    def _games_page(self, limit, bot_id, game, room_id, before) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit}
        if bot_id:
            params["bot_id"] = bot_id
        if game:
            params["game"] = game
        if room_id:
            params["room_id"] = room_id
        if before:
            params["before"] = before
        page = self._req("GET", "/games?" + urllib.parse.urlencode(params))
        return {"games": page.get("games", []), "next": page.get("next")}

    def leaderboard(self, game: Optional[str] = None) -> List[Dict[str, Any]]:
        """Leaderboard rows for one game type (server default ``ddz``; e.g. ``"guandan"``)."""
        path = "/leaderboard"
        if game:
            path += "?" + urllib.parse.urlencode({"game": game})
        return self._req("GET", path).get("bots", [])


def _q(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")


def register_bot(
    base_url: str, name: str, invite_code: Optional[str] = None
) -> Dict[str, Any]:
    """Register a bot and return ``{"bot_id","name","kind","token"}``. Save the token!"""
    return Client(base_url).register_bot(name, invite_code)
