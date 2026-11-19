"""Offline 4-player Dou Dizhu simulator and duplicate evaluation, no server needed.

The simulator follows the server engine (``packages/engine/src/ddz4/game4.ts``): two decks,
25 cards each plus an 8-card bottom, bids 0-3 (a 3 ends bidding), every bomb doubles the
stake, spring / anti-spring double it once more, the landlord wins or loses 3x.
It drives any :class:`ddz_sdk.Bot` through ``on_bid`` / ``on_play`` with a filled-in
:class:`ddz_sdk.GameState`; illegal answers fall back to pass / lowest single and are counted.

Duplicate evaluation removes most of the luck of the deal: every deal is played once with
four baseline bots, then four more times with the candidate bot in seat 0, 1, 2 and 3. The
candidate's edge on that deal is its score minus the baseline's score from the same seat.

Usage:
    python smart/ddz4_sim.py --deals 500                     # smart4 vs greedy
    python smart/ddz4_sim.py --deals 500 --bot greedy --baseline random
    python smart/ddz4_sim.py --deals 500 --bot smart4:PIMC_SAMPLES=32 --baseline smart4 --jobs 4
"""

from __future__ import annotations

import argparse
import functools
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

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
from ddz_sdk.rules import RuleError, lowest_single  # noqa: E402
from ddz_sdk.rules4 import resolve4  # noqa: E402
from ddz3_sim import _literal, _top_level_split, _variant  # noqa: E402

DECK4: List[str] = [r + s for r in RANK_CHARS for s in "SHCD"] * 2 + ["BJ", "RJ"] * 2


def deal(seed: int):
    """(hands, bottom, first_bidder) for a deal number."""
    rng = random.Random(seed)
    deck = list(DECK4)
    rng.shuffle(deck)
    hands = [sort_cards(deck[i * 25 : (i + 1) * 25]) for i in range(4)]
    return hands, sort_cards(deck[100:]), rng.randrange(4)


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
        for i in range(4):
            seat = (first + i) % 4
            st = GameState(
                game="ddz4",
                seat=seat,
                hand=list(hands[seat]),
                phase="bidding",
                first_bidder=first,
                bids=list(bids),
                high_bid=high,
                turn=seat,
                cards_left=[25] * 4,
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
                "scores": [0] * 4,
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
    play_counts = [0] * 4
    bombs = 0
    while True:
        to_beat = last if last is not None and last["seat"] != turn else None
        st = GameState(
            game="ddz4",
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
                pattern = resolve4(cards, to_beat["pattern"] if to_beat else None, hint)
            elif to_beat is None:
                raise RuleError("MUST_PLAY", "cannot pass when leading")
        except Exception:
            stats["fallbacks"] = stats.get("fallbacks", 0) + 1
            cards = [] if to_beat is not None else lowest_single(hands[turn])
            pattern = resolve4(cards, None) if cards else None
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
        turn = (turn + 1) % 4
    landlord_wins = turn == landlord
    farmers = [s for s in range(4) if s != landlord]
    spring = landlord_wins and all(play_counts[s] == 0 for s in farmers)
    anti = (not landlord_wins) and play_counts[landlord] == 1
    unit = high * 2**bombs * (2 if spring or anti else 1)
    scores = [0] * 4
    for s in farmers:
        scores[s] = -unit if landlord_wins else unit
    scores[landlord] = 3 * unit if landlord_wins else -3 * unit
    return {
        "kind": "win",
        "landlord": landlord,
        "winner_seat": turn,
        "scores": scores,
        "bombs": bombs,
        "high_bid": high,
    }


def deal_edge(
    make_bot: Callable[[], Any], make_base: Callable[[], Any], seed: int
) -> Dict[str, Any]:
    """One deal of the duplicate evaluation: the candidate's edge in each seat."""
    stats: Dict[str, int] = {}
    base = play_game([make_base() for _ in range(4)], seed, stats=stats)
    diffs: List[float] = []
    units: List[float] = []
    sides: List[Tuple[str, int]] = []  # (landlord | farmer, score) per seat that played
    for seat in range(4):
        bots = [make_base() for _ in range(4)]
        bots[seat] = make_bot()
        r = play_game(bots, seed, stats=stats)
        diffs.append(r["scores"][seat] - base["scores"][seat])
        units.append(_units(r, seat) - _units(base, seat))
        if r["kind"] == "win":
            role = "landlord" if r["landlord"] == seat else "farmer"
            sides.append((role, r["scores"][seat]))
    return {"diffs": diffs, "units": units, "sides": sides, "stats": stats}


def _deal_edge(args):
    return deal_edge(*args)


def duplicate(
    make_bot: Callable[[], Any],
    make_base: Callable[[], Any],
    seeds: Sequence[int],
    progress: bool = False,
    jobs: int = 1,
) -> Dict[str, Any]:
    """Duplicate evaluation of ``make_bot`` against ``make_base`` (see the module docstring);
    ``jobs > 1`` plays deals in worker processes (the factories must then be picklable).
    """
    stats: Dict[str, int] = {}
    diffs: List[float] = []
    units: List[float] = []
    ll = {"games": 0, "wins": 0, "score": 0}
    fa = {"games": 0, "wins": 0, "score": 0}
    t0 = time.time()
    tasks = [(make_bot, make_base, seed) for seed in seeds]
    if jobs > 1:
        import multiprocessing

        pool = multiprocessing.Pool(jobs)
        results = pool.imap(_deal_edge, tasks)
    else:
        pool = None
        results = map(_deal_edge, tasks)
    try:
        for n, r in enumerate(results):
            diffs += r["diffs"]
            units += r["units"]
            for role, score in r["sides"]:
                side = ll if role == "landlord" else fa
                side["games"] += 1
                side["score"] += score
                side["wins"] += score > 0
            for k, v in r["stats"].items():
                stats[k] = stats.get(k, 0) + v
            if progress and (n + 1) % 50 == 0:
                print(
                    "  %d deals, edge %.3f/game, %.0fs"
                    % (n + 1, statistics.mean(diffs), time.time() - t0),
                    flush=True,
                )
    finally:
        if pool is not None:
            pool.close()
    return {
        "games": len(diffs),
        "edge": statistics.mean(diffs),
        "stderr": statistics.stdev(diffs) / len(diffs) ** 0.5,
        "unit_edge": statistics.mean(units),
        "unit_stderr": statistics.stdev(units) / len(units) ** 0.5,
        "landlord": ll,
        "farmer": fa,
        "stats": stats,
        "seconds": time.time() - t0,
    }


def _units(r: Dict[str, Any], seat: int) -> int:
    """Result ignoring bid and multiplier: landlord +-3, farmer +-1, 0 when nobody bid."""
    sc = r["scores"][seat]
    w = 3 if r["landlord"] == seat else 1
    return w if sc > 0 else -w if sc < 0 else 0


def make_factory(name: str) -> Callable[[], Any]:
    """A bot by name; ``smart4:A=1,B=0.5`` sets attributes A and B on each new bot."""
    if ":" in name:
        base, _, spec = name.partition(":")
        cls = make_factory(base)
        overrides: Dict[str, Any] = {}
        for item in _top_level_split(spec):
            k, _, v = item.partition("=")
            k = k.strip()
            if not hasattr(cls, k):
                raise SystemExit("%s has no attribute %r" % (base, k))
            overrides[k] = _literal(v.strip())
        return functools.partial(_variant, cls, overrides)
    if name == "smart4":
        from smart4_bot import Smart4Bot

        return Smart4Bot
    if name == "greedy":
        from greedy_bot import GreedyBot

        return GreedyBot
    if name == "random":
        from random_bot import RandomBot

        return RandomBot
    raise SystemExit("unknown bot %r" % name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot", default="smart4")
    ap.add_argument("--baseline", default="greedy")
    ap.add_argument("--deals", type=int, default=200)
    ap.add_argument("--start", type=int, default=0, help="first deal number")
    ap.add_argument("--jobs", type=int, default=1, help="worker processes")
    args = ap.parse_args()
    res = duplicate(
        make_factory(args.bot),
        make_factory(args.baseline),
        range(args.start, args.start + args.deals),
        progress=True,
        jobs=args.jobs,
    )
    print(
        "%s vs %s: %d games, edge %.3f ± %.3f per game, %.0fs"
        % (
            args.bot,
            args.baseline,
            res["games"],
            res["edge"],
            res["stderr"],
            res["seconds"],
        )
    )
    print(
        "  win/loss only (landlord +-3, farmer +-1): edge %.3f ± %.3f per game"
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
