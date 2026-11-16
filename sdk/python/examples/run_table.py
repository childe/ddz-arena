"""Register N bots, seat them at one table of any game type and let them play K games.

Usage:
    python examples/run_table.py --base http://localhost:8080 --game ddz    --games 5
    python examples/run_table.py --base http://localhost:8080 --game ddz4   --games 3
    python examples/run_table.py --base http://localhost:8080 --game guandan --games 5
    python examples/run_table.py --base http://localhost:8080 --game holdem --players 6 --games 20
    options: [--invite CODE] [--bots greedy,random,...] [--timeout-ms 20000] [--chaos 2]
             [--strict] [-v]

``--players`` defaults to the table size (ddz 3, ddz4 4, guandan 4, holdem 6; holdem allows
2-6). ``--bots`` lists strategies, cycled over the seats: ddz/ddz4 ``greedy`` / ``random``
(default ``greedy,greedy,random``), guandan ``greedy`` / ``random`` (default ``greedy,random``:
team 0 greedy, team 1 random), holdem ``simple`` / ``random`` (default ``simple``).

All bots are seated before anybody readies, so the first game starts with the full table.
Prints one line per finished game, then per-bot SDK stats, the room scores and the leaderboard
rows of these bots. At every game end each bot's tracked state is compared with what the server
reveals (Dou Dizhu: remaining hand; Guandan: hand in GET /games/{gid}/state; Hold'em: own
showdown score via ddz_sdk.holdem.evaluate). Every Guandan hand of a match counts as one game.
Exit code is non-zero if a bot stalled or crashed; with ``--strict`` also if any bot used a
fallback, hit a handler error, the server acted for it (``auto``) or a state check failed.
"""

from __future__ import annotations

import argparse
import logging
import secrets
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from ddz_sdk import (  # noqa: E402
    ApiError,
    Client,
    GuandanState,
    HoldemState,
    evaluate,
    register_bot,
)
from ddz_sdk.cards import sort_cards  # noqa: E402
from greedy_bot import GreedyBot  # noqa: E402
from guandan_bot import GreedyGuandanBot, RandomGuandanBot  # noqa: E402
from holdem_bot import RandomHoldemBot, SimpleHoldemBot  # noqa: E402
from random_bot import RandomBot  # noqa: E402

KINDS = {
    "ddz": {"greedy": GreedyBot, "random": RandomBot},
    "holdem": {"simple": SimpleHoldemBot, "random": RandomHoldemBot},
    "guandan": {"greedy": GreedyGuandanBot, "random": RandomGuandanBot},
}
KINDS["ddz4"] = KINDS["ddz"]
DEFAULT_BOTS = {"ddz": "greedy,greedy,random", "ddz4": "greedy,greedy,random"}
DEFAULT_BOTS["holdem"] = "simple"
DEFAULT_BOTS["guandan"] = "greedy,random"
TABLE = {"ddz": 3, "ddz4": 4, "guandan": 4}


class Reporter:
    """Prints a line per finished game (only from the first bot to avoid duplicates)."""

    def __init__(self, game: str):
        self.game = game
        self.lock = threading.Lock()
        self.results = []

    def add(self, result):
        with self.lock:
            self.results.append(result)
            n = len(self.results)
            r = result
            if self.game == "holdem":
                sd = r.get("showdown")
                shown = (
                    " ".join("%s:%s" % (e["seat"], e["rank"]) for e in sd)
                    if sd
                    else "-"
                )
                line = "hand %3d: winners=%s pot=%s scores=%s showdown=%s" % (
                    n,
                    r.get("winners"),
                    r.get("pot"),
                    r.get("scores"),
                    shown,
                )
            elif self.game == "guandan":
                line = (
                    "hand %3d: level=%-2s order=%s winner_team=%s upgrade=%s levels=%s->%s "
                    "match_winner=%s scores=%s"
                    % (
                        n,
                        r.get("level"),
                        r.get("order"),
                        r.get("winner_team"),
                        r.get("upgrade"),
                        r.get("team_levels_before"),
                        r.get("team_levels_after"),
                        r.get("match_winner"),
                        r.get("scores"),
                    )
                )
            else:
                line = (
                    "game %3d: %-5s winner=%-8s landlord=%s base=%s bombs=%s x%s scores=%s"
                    % (
                        n,
                        r.get("kind"),
                        r.get("winner"),
                        r.get("landlord"),
                        r.get("base"),
                        r.get("bombs"),
                        r.get("multiplier"),
                        r.get("scores"),
                    )
                )
            print(line, flush=True)


def check_finished(bot, ev, mismatches) -> None:
    """On game.finished compare the bot's tracked state with the server's reveal."""
    if ev.get("type") != "game.finished":
        return
    st = bot.state
    data = ev.get("data") or {}
    if isinstance(st, HoldemState):
        for e in (data.get("result") or {}).get("showdown") or []:
            if e.get("seat") != st.seat:
                continue
            score, rank, best = evaluate(st.hole + st.board)
            if (score, rank, sorted(best)) != (
                e["score"],
                e["rank"],
                sorted(e["best"]),
            ):
                mismatches.append((bot.name, ev.get("game_id"), e, (score, rank, best)))
    elif isinstance(st, GuandanState):
        # game.finished carries no hands: ask the server for our view of this hand.
        gid = ev.get("game_id") or st.game_id
        try:
            view = bot.client.game_state(gid)
        except ApiError as e:
            mismatches.append((bot.name, gid, "state unavailable: %s" % e))
            return
        if view.get("game_id", gid) == st.game_id and sort_cards(
            view.get("hand") or []
        ) != sort_cards(st.hand):
            mismatches.append((bot.name, gid, view.get("hand"), st.hand))
    else:
        hands = data.get("hands")
        if hands and st.seat is not None and st.seat < len(hands):
            if sort_cards(hands[st.seat]) != sort_cards(st.hand):
                mismatches.append(
                    (bot.name, ev.get("game_id"), hands[st.seat], st.hand)
                )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument(
        "--game", choices=["ddz", "ddz4", "guandan", "holdem"], default="ddz"
    )
    ap.add_argument("--players", type=int, default=None)
    ap.add_argument("--games", type=int, default=5)
    ap.add_argument("--invite", default=None)
    ap.add_argument("--bots", default=None)
    ap.add_argument("--prefix", default="py")
    ap.add_argument(
        "--timeout-ms",
        type=int,
        default=None,
        help="turn time limit (play_timeout_ms / action_timeout_ms)",
    )
    ap.add_argument("--per-game-timeout", type=float, default=120.0)
    ap.add_argument(
        "--chaos",
        type=float,
        default=0,
        help="drop a random bot's WebSocket every N seconds (reconnect test)",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="fail on fallbacks, handler errors or server auto-actions",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    game = args.game
    n = args.players or TABLE.get(game, 6)
    if game in TABLE and n != TABLE[game]:
        ap.error("%s needs exactly %d players" % (game, TABLE[game]))
    if game == "holdem" and not 2 <= n <= 6:
        ap.error("holdem needs 2-6 players")
    kinds_list = (args.bots or DEFAULT_BOTS[game]).split(",")
    if any(k not in KINDS[game] for k in kinds_list):
        ap.error("--bots for %s must be of: %s" % (game, ",".join(KINDS[game])))
    kinds = [kinds_list[i % len(kinds_list)] for i in range(n)]

    suffix = secrets.token_hex(3)
    creds = []
    for i, k in enumerate(kinds):
        name = "%s-%s%d-%s" % (args.prefix, k, i, suffix)
        info = register_bot(args.base, name, args.invite)
        creds.append((name, info["bot_id"], info["token"], k))
        print("registered %s (%s)" % (name, info["bot_id"]))

    config = {}
    if game == "holdem":
        config["seats"] = n
        if args.timeout_ms:
            config["action_timeout_ms"] = args.timeout_ms
    elif args.timeout_ms:
        config["play_timeout_ms"] = args.timeout_ms
    room = Client(args.base, creds[0][2]).create_room(
        "run-%s-%s" % (game, suffix), config or None, game=game
    )
    rid = room["id"]
    print("room %s (%s, %d seats)" % (rid, room.get("game"), len(room["seats"])))
    # Seat everybody first: a holdem table starts as soon as 2 seated players are ready.
    for seat, (_name, _bid, token, _k) in enumerate(creds):
        Client(args.base, token).join_room(rid, seat=seat)

    reporter = Reporter(game)
    mismatches = []
    bots, threads, errors = [], [], []
    for idx, (name, _bid, token, k) in enumerate(creds):
        bot = KINDS[game][k](name)
        if idx == 0:
            bot.on_game_over = reporter.add  # type: ignore[method-assign]
        # Consistency check at the end of every game: the SDK's tracked state must match
        # what the server reveals (remaining hand / showdown score).
        bot.on_event = lambda ev, b=bot: check_finished(b, ev, mismatches)  # type: ignore
        bots.append(bot)

        def target(b=bot, t=token):
            try:
                b.run(args.base, t, rid, max_games=args.games, leave_on_exit=False)
            except Exception as e:  # pragma: no cover - reported below
                logging.exception("bot %s crashed", b.name)
                errors.append((b.name, e))

        th = threading.Thread(target=target, name=name, daemon=True)
        threads.append(th)
        th.start()

    started = time.time()
    deadline = started + 30 + args.games * args.per_game_timeout
    if args.chaos > 0:
        import random

        while any(th.is_alive() for th in threads) and time.time() < deadline:
            time.sleep(args.chaos)
            victim = random.choice(bots)
            ws = victim._ws
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
    for th in threads:
        th.join(max(0.0, deadline - time.time()))
    stalled = [b.name for b, th in zip(bots, threads) if th.is_alive()]
    for b in bots:
        b.stop()

    print()
    print("elapsed %.1fs" % (time.time() - started))
    print("games finished per bot: %s" % [b.games_finished for b in bots])
    print("SDK stats per bot: %s" % [b.stats for b in bots])
    print("API errors per bot: %s" % [b.api_errors for b in bots])
    pub = Client(args.base)
    try:
        info = pub.get_room(rid)["room"]
        print("room seats/scores:")
        for s in info["seats"]:
            if s:
                print("  seat %d %-28s score=%d" % (s["seat"], s["name"], s["score"]))
    except Exception as e:  # room may be closed already
        print("room info unavailable: %s" % e)
    for _name, _bid, token, _k in creds:
        try:
            Client(args.base, token).leave_room(rid)
        except Exception:
            pass
    ours = {c[1] for c in creds}
    print("leaderboard (%s):" % game)
    for row in pub.leaderboard(game=game):
        if row["bot_id"] in ours:
            print(
                "  %-28s games=%d wins=%d score=%d timeouts=%d"
                % (
                    row["name"],
                    row["games"],
                    row["wins"],
                    row["score"],
                    row["timeouts"],
                )
            )
    totals = {k: sum(b.stats[k] for b in bots) for k in ("fallbacks", "errors", "auto")}
    print(
        "TOTAL games=%d fallbacks=%d errors=%d auto=%d mismatches=%d stalled=%d crashed=%d"
        % (
            len(reporter.results),
            totals["fallbacks"],
            totals["errors"],
            totals["auto"],
            len(mismatches),
            len(stalled),
            len(errors),
        )
    )
    for m in mismatches[:5]:
        print("MISMATCH: %s" % (m,))
    if stalled or errors:
        print("STALLED: %s ERRORS: %s" % (stalled, errors))
        return 1
    if args.strict and (any(totals.values()) or mismatches):
        print("STRICT: fallbacks / errors / auto-actions / state mismatches present")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
