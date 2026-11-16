"""Offline 3-player Dou Dizhu simulator and duplicate evaluation, no server needed.

The simulator follows the server engine (``packages/engine/src/game.ts``): one deck,
17 cards each plus a 3-card bottom, bids 0-3 (a 3 ends bidding), every bomb doubles the
stake, spring / anti-spring double it once more, the landlord wins or loses 2x.
It drives any :class:`ddz_sdk.Bot` through ``on_bid`` / ``on_play`` with a filled-in
:class:`ddz_sdk.GameState`; illegal answers fall back to pass / lowest single and are counted.

Duplicate evaluation removes most of the luck of the deal: every deal is played once with
three baseline bots, then three more times with the candidate bot in seat 0, 1 and 2. The
candidate's edge on that deal is its score minus the baseline's score from the same seat.

Usage:
    python smart/ddz3_sim.py --deals 500                     # smart3 vs greedy
    python smart/ddz3_sim.py --deals 500 --bot greedy --baseline random
"""

from __future__ import annotations

import argparse
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz_sdk import GameState, Move  # noqa: E402
from ddz_sdk.cards import (
    RANK_CHARS,
    contains_all,
    remove_cards,
    sort_cards,
)  # noqa: E402
from ddz_sdk.rules import RuleError, lowest_single, resolve  # noqa: E402

DECK3: List[str] = [r + s for r in RANK_CHARS for s in "SHCD"] + ["BJ", "RJ"]
N = 3


def deal(seed: int):
    """(hands, bottom, first_bidder) for a deal number."""
    rng = random.Random(seed)
    deck = list(DECK3)
    rng.shuffle(deck)
    hands = [sort_cards(deck[i * 17 : (i + 1) * 17]) for i in range(N)]
    return hands, sort_cards(deck[51:]), rng.randrange(N)


def play_game(
    bots: Sequence[Any],
    seed: int,
    forced_landlord: Optional[int] = None,
    stats: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Play one deal. ``forced_landlord`` skips bidding (that seat becomes landlord at 3).

    Returns ``{"kind": "win"|"nobid", "landlord", "winner_seat", "scores", "bombs", "high_bid"}``.
    """
    stats = stats if stats is not None else {}
    hands, bottom, first = deal(seed)
    bids: List[Dict[str, int]] = []
    high, high_seat = 0, None
    if forced_landlord is None:
        for i in range(N):
            seat = (first + i) % N
            st = GameState(
                game="ddz",
                seat=seat,
                hand=list(hands[seat]),
                phase="bidding",
                first_bidder=first,
                bids=list(bids),
                high_bid=high,
                turn=seat,
                cards_left=[17] * N,
            )
            try:
                score = int(bots[seat].on_bid(st))
            except Exception:
                stats["errors"] = stats.get("errors", 0) + 1
                score = 0
            if score != 0 and (score <= high or score > 3):
                stats["bad_bids"] = stats.get("bad_bids", 0) + 1
                score = 0
            bids.append({"seat": seat, "score": score})
            if score:
                high, high_seat = score, seat
            if score == 3:
                break
        if high_seat is None:
            return {
                "kind": "nobid",
                "landlord": None,
                "winner_seat": None,
                "scores": [0] * N,
                "bombs": 0,
                "high_bid": 0,
            }
    else:
        high, high_seat = 3, forced_landlord
    landlord = high_seat
    hands[landlord] = sort_cards(hands[landlord] + bottom)
    turn = landlord
    last: Optional[Dict[str, Any]] = None  # {"seat", "cards", "pattern"(api)}
    history: List[Dict[str, Any]] = []
    play_counts = [0] * N
    bombs = 0
    while True:
        to_beat = last if last is not None and last["seat"] != turn else None
        st = GameState(
            game="ddz",
            seat=turn,
            hand=list(hands[turn]),
            phase="playing",
            first_bidder=first,
            bids=list(bids),
            high_bid=high,
            landlord=landlord,
            bottom=list(bottom),
            turn=turn,
            to_beat=to_beat,
            can_pass=to_beat is not None,
            cards_left=[len(h) for h in hands],
            multiplier=2**bombs,
            history=list(history),
        )
        pattern = None
        try:
            ret = bots[turn].on_play(st)
            hint = ret.pattern.type if isinstance(ret, Move) else None
            cards = list(ret.cards) if isinstance(ret, Move) else list(ret or [])
            if cards:
                if not contains_all(hands[turn], cards):
                    raise RuleError("NOT_IN_HAND", "cards not in hand")
                pattern = resolve(cards, to_beat["pattern"] if to_beat else None, hint)
            elif to_beat is None:
                raise RuleError("MUST_PLAY", "cannot pass when leading")
        except Exception:
            stats["fallbacks"] = stats.get("fallbacks", 0) + 1
            cards = [] if to_beat is not None else lowest_single(hands[turn])
            pattern = resolve(cards, None) if cards else None
        if cards:
            hands[turn] = remove_cards(hands[turn], cards)
            entry = {
                "seat": turn,
                "cards": sort_cards(cards),
                "pattern": pattern.to_api(),
            }
            history.append(entry)
            last = entry
            play_counts[turn] += 1
            if pattern.type in ("bomb", "rocket"):
                bombs += 1
            if not hands[turn]:
                break
        else:
            history.append({"seat": turn, "cards": [], "pattern": None})
        turn = (turn + 1) % N
    landlord_wins = turn == landlord
    farmers = [s for s in range(N) if s != landlord]
    spring = landlord_wins and all(play_counts[s] == 0 for s in farmers)
    anti = (not landlord_wins) and play_counts[landlord] == 1
    unit = high * 2**bombs * (2 if spring or anti else 1)
    scores = [0] * N
    for s in farmers:
        scores[s] = -unit if landlord_wins else unit
    scores[landlord] = 2 * unit if landlord_wins else -2 * unit
    return {
        "kind": "win",
        "landlord": landlord,
        "winner_seat": turn,
        "scores": scores,
        "bombs": bombs,
        "high_bid": high,
    }


def duplicate(
    make_bot: Callable[[], Any],
    make_base: Callable[[], Any],
    seeds: Sequence[int],
    progress: bool = False,
) -> Dict[str, Any]:
    """Duplicate evaluation of ``make_bot`` against ``make_base`` (see the module docstring)."""
    stats: Dict[str, int] = {}
    diffs: List[float] = []
    units: List[float] = []
    ll = {"games": 0, "wins": 0, "score": 0}
    fa = {"games": 0, "wins": 0, "score": 0}
    t0 = time.time()
    for n, seed in enumerate(seeds):
        base = play_game([make_base() for _ in range(N)], seed, stats=stats)
        for seat in range(N):
            bots = [make_base() for _ in range(N)]
            bots[seat] = make_bot()
            r = play_game(bots, seed, stats=stats)
            diffs.append(r["scores"][seat] - base["scores"][seat])
            units.append(_units(r, seat) - _units(base, seat))
            if r["kind"] != "win":
                continue
            side = ll if r["landlord"] == seat else fa
            side["games"] += 1
            side["score"] += r["scores"][seat]
            side["wins"] += r["scores"][seat] > 0
        if progress and (n + 1) % 50 == 0:
            print(
                "  %d deals, edge %.3f/game, %.0fs"
                % (n + 1, statistics.mean(diffs), time.time() - t0),
                flush=True,
            )
    return {
        "games": len(diffs),
        "edge": statistics.mean(diffs),
        "stderr": statistics.stdev(diffs) / len(diffs) ** 0.5,
        "unit_edge": statistics.mean(units),
        "unit_stderr": statistics.stdev(units) / len(units) ** 0.5,
        "landlord": ll,
        "farmer": fa,
        "stats": stats,
    }


def _units(r: Dict[str, Any], seat: int) -> int:
    """Result ignoring bid and multiplier: landlord +-2, farmer +-1, 0 when nobody bid."""
    sc = r["scores"][seat]
    w = 2 if r["landlord"] == seat else 1
    return w if sc > 0 else -w if sc < 0 else 0


def make_factory(name: str) -> Callable[[], Any]:
    if name == "smart3":
        from smart3_bot import Smart3Bot

        return Smart3Bot
    if name == "greedy":
        from greedy_bot import GreedyBot

        return GreedyBot
    if name == "random":
        from random_bot import RandomBot

        return RandomBot
    raise SystemExit("unknown bot %r" % name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot", default="smart3")
    ap.add_argument("--baseline", default="greedy")
    ap.add_argument("--deals", type=int, default=200)
    ap.add_argument("--start", type=int, default=0, help="first deal number")
    args = ap.parse_args()
    res = duplicate(
        make_factory(args.bot),
        make_factory(args.baseline),
        range(args.start, args.start + args.deals),
        progress=True,
    )
    print(
        "%s vs %s: %d games, edge %.3f ± %.3f per game"
        % (args.bot, args.baseline, res["games"], res["edge"], res["stderr"])
    )
    print(
        "  win/loss only (landlord +-2, farmer +-1): edge %.3f ± %.3f per game"
        % (res["unit_edge"], res["unit_stderr"])
    )
    for side in ("landlord", "farmer"):
        s = res[side]
        if s["games"]:
            print(
                "  as %-8s %5d games, win %.1f%%, avg score %.2f"
                % (
                    side,
                    s["games"],
                    100 * s["wins"] / s["games"],
                    s["score"] / s["games"],
                )
            )
    print("  stats", res["stats"])


if __name__ == "__main__":
    main()
