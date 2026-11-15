"""Client tests against a tiny in-process HTTP stub."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ddz_sdk import ApiError, Client, register_bot


class Handler(BaseHTTPRequestHandler):
    log = []

    def log_message(self, *a):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    def do_GET(self):
        Handler.log.append(("GET", self.path, self.headers.get("authorization"), None))
        if self.path == "/api/v1/me":
            if self.headers.get("authorization") != "Bearer tok":
                return self._send(
                    401, {"error": {"code": "UNAUTHORIZED", "message": "bad token"}}
                )
            return self._send(200, {"bot_id": "b_1", "name": "x", "kind": "bot"})
        if self.path.startswith("/api/v1/games?"):
            return self._send(200, {"games": [{"game_id": "g_1"}]})
        if self.path == "/api/v1/leaderboard":
            return self._send(200, {"bots": [{"bot_id": "b_1"}]})
        self._send(404, {"error": {"code": "NOT_FOUND", "message": "nope"}})

    def do_POST(self):
        body = self._body()
        Handler.log.append(("POST", self.path, self.headers.get("authorization"), body))
        if self.path == "/api/v1/bots":
            if body.get("name") == "taken":
                return self._send(
                    409,
                    {
                        "error": {
                            "code": "NAME_TAKEN",
                            "message": "taken",
                            "details": {"name": "taken"},
                        }
                    },
                )
            return self._send(
                201,
                {"bot_id": "b_1", "name": body["name"], "kind": "bot", "token": "tok"},
            )
        if self.path.endswith("/play"):
            return self._send(
                422,
                {
                    "error": {
                        "code": "CANNOT_BEAT",
                        "message": "pair(5) cannot beat pair(7)",
                        "details": {"x": 1},
                    }
                },
            )
        return self._send(200, {"ok": True, "seq": 1})


@pytest.fixture(scope="module")
def base():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield "http://127.0.0.1:%d" % srv.server_port
    srv.shutdown()


def test_register_and_me(base):
    info = register_bot(base, "alpha", "INV")
    assert info["token"] == "tok"
    assert Handler.log[-1][3] == {"name": "alpha", "invite_code": "INV"}
    c = Client(base, "tok")
    assert c.me()["bot_id"] == "b_1"
    assert Handler.log[-1][2] == "Bearer tok"


def test_errors_raise_api_error(base):
    with pytest.raises(ApiError) as e:
        register_bot(base, "taken")
    assert (e.value.status, e.value.code, e.value.details) == (
        409,
        "NAME_TAKEN",
        {"name": "taken"},
    )
    with pytest.raises(ApiError) as e:
        Client(base, "bad").me()
    assert e.value.status == 401 and e.value.code == "UNAUTHORIZED"
    with pytest.raises(ApiError) as e:
        Client(base, "tok").play("g_1", ["5S", "5H"], seq=3)
    assert e.value.status == 422 and e.value.code == "CANNOT_BEAT"
    assert e.value.message == "pair(5) cannot beat pair(7)"
    assert Handler.log[-1][3] == {"cards": ["5S", "5H"], "seq": 3}


def test_request_bodies(base):
    c = Client(base, "tok")
    c.bid("g_1", 2, seq=7)
    assert Handler.log[-1][1:] == (
        "/api/v1/games/g_1/bid",
        "Bearer tok",
        {"score": 2, "seq": 7},
    )
    c.join_room("r_1", seat=2)
    assert Handler.log[-1][3] == {"seat": 2}
    c.ready("r_1")
    assert Handler.log[-1][3] == {"ready": True}
    with pytest.raises(ApiError):
        c.play("g_1", ["3S", "3H", "3C", "4S", "4H", "4C", "5S", "6S"], "plane_single")
    assert Handler.log[-1][3]["pattern"] == {"type": "plane_single"}
    assert c.list_games(limit=5, bot_id="b_1")[0]["game_id"] == "g_1"
    assert Handler.log[-1][1] == "/api/v1/games?limit=5&bot_id=b_1"
    assert c.leaderboard()[0]["bot_id"] == "b_1"


def test_network_error():
    with pytest.raises(ApiError) as e:
        Client("http://127.0.0.1:1", "tok", timeout=2).me()
    assert e.value.status == 0 and e.value.code == "NETWORK_ERROR"


def test_ws_url():
    assert Client("https://example.com/").ws_url == "wss://example.com"
    assert Client("http://h:8080").ws_url == "ws://h:8080"
