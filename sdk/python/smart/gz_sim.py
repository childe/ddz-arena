"""Offline Gongzhu (拱猪) simulator and duplicate evaluation, no server needed.

One deal is one hand of a fresh match: the holder of ``2C`` leads, every seat decides what to
expose in turn from the leader, then tricks are played until all 13 are done or all 16 scoring
cards are taken (the rules of the server engine, docs/gongzhu.md, via ``ddz_sdk.rules_gz``).
Bots see a :class:`ddz_sdk.GongzhuState` built the way the SDK builds it from events.

Duplicate evaluation: each deal is first played by four baseline bots. Then the candidate takes
each seat in turn (the other three are baseline bots) and plays the same deal again. The
candidate's result on a deal is the mean, over the four seats, of its platform score
``(4 x points - sum of points) / 10`` minus the baseline's score in that seat.

Usage:
    python smart/gz_sim.py --deals 200                         # smart_gz vs greedy
    python smart/gz_sim.py --deals 200 --bot greedy --baseline random
    python smart/gz_sim.py --deals 200 --budget-ms 100         # faster, weaker smart bot
    python smart/gz_sim.py --deals 1000 --jobs 8               # deals in 8 processes
"""

from __future__ import annotations

import argparse
import functools
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz_sdk import GongzhuState  # noqa: E402
from ddz_sdk import rules_gz  # noqa: E402
from ddz_sdk.rules import RuleError  # noqa: E402


def deal(seed: int) -> List[List[str]]:
    rng = random.Random(seed)
    deck = list(rules_gz.DECK)
    rng.shuffle(deck)
    return [rules_gz.sort_cards_gz(deck[i * 13 : (i + 1) * 13]) for i in range(4)]


def play_hand(
    bots: Sequence[Any],
    seed: int,
    stats: Optional[Dict[str, int]] = None,
    hands: Optional[List[List[str]]] = None,
) -> Dict[str, Any]:
    """Play one deal; returns the ``game.finished`` result plus ``"hands"`` (cards left)."""
    stats = stats if stats is not None else {}
    hands = [list(h) for h in (hands or deal(seed))]
    leader = next(s for s in range(4) if "2C" in hands[s])
    exposed: List[List[str]] = [[], [], [], []]
    tricks: List[Dict[str, Any]] = []
    taken: List[List[str]] = [[], [], [], []]

    def state(seat: int, phase: str, trick) -> GongzhuState:
        return GongzhuState(
            game_id="sim-%d" % seed,
            seat=seat,
            hand=list(hands[seat]),
            phase=phase,
            first_leader=leader,
            exposed=[list(e) for e in exposed],
            exposes_done=4,
            turn=seat,
            trick_no=len(tricks) + 1,
            trick=trick,
            tricks=list(tricks),
            taken=[list(t) for t in taken],
            cards_left=[len(h) for h in hands],
        )

    for k in range(4):
        s = (leader + k) % 4
        st = state(s, "expose", None)
        st.exposes_done = k
        try:
            cards = list(bots[s].choose_expose(st) or [])
            ok = rules_gz.exposable(hands[s])
            if len(set(cards)) != len(cards) or any(c not in ok for c in cards):
                raise RuleError("BAD_EXPOSE", "bad expose %r" % cards)
        except Exception:
            stats["fallbacks"] = stats.get("fallbacks", 0) + 1
            cards = []
        exposed[s] = [c for c in rules_gz.EXPOSABLE if c in cards]
    forced = rules_gz.forced_expose(hands, exposed)
    if forced:
        s, card = forced
        exposed[s] = [c for c in rules_gz.EXPOSABLE if c in exposed[s] or c == card]

    led_before: set = set()
    turn = leader
    while len(tricks) < 13 and sum(len(t) for t in taken) < rules_gz.SCORING_COUNT:
        trick = {"leader": turn, "plays": [], "winner": None}
        for _ in range(4):
            led = trick["plays"][0]["card"][1] if trick["plays"] else None
            st = state(turn, "playing", trick if trick["plays"] else None)
            try:
                card = bots[turn].choose_card(st)
                rules_gz.check_play(card, hands[turn], led, exposed[turn], led_before)
            except Exception:
                stats["fallbacks"] = stats.get("fallbacks", 0) + 1
                card = rules_gz.lowest_safe_card(
                    rules_gz.legal_cards(hands[turn], led, exposed[turn], led_before)
                )
            hands[turn].remove(card)
            trick = {
                "leader": trick["leader"],
                "plays": trick["plays"] + [{"seat": turn, "card": card}],
                "winner": None,
            }
            turn = (turn + 1) % 4
        w = rules_gz.trick_winner(trick["plays"])
        trick["winner"] = w
        tricks.append(trick)
        led_before.add(trick["plays"][0]["card"][1])
        taken[w] += [
            p["card"] for p in trick["plays"] if rules_gz.is_scoring(p["card"])
        ]
        turn = w
    result = rules_gz.settle(taken, exposed)
    result["hands"] = hands
    return result


def deal_edge(
    make_bot: Callable[[], Any], make_base: Callable[[], Any], seed: int
) -> Dict[str, Any]:
    """One deal of the duplicate evaluation (see the module docstring)."""
    stats: Dict[str, int] = {}
    base = play_hand([make_base() for _ in range(4)], seed, stats)
    diff = 0.0
    pig = [0, 0]  # the pig ends with the candidate / with the baseline in that seat
    for s in range(4):
        bots = [make_bot() if i == s else make_base() for i in range(4)]
        r = play_hand(bots, seed, stats)
        diff += r["scores"][s] - base["scores"][s]
        pig[0] += r["pig"] == s
        pig[1] += base["pig"] == s
    return {"edge": diff / 4, "pig": pig, "stats": stats}


def _deal_edge(args):
    return deal_edge(*args)


def duplicate(
    make_bot: Callable[[], Any],
    make_base: Callable[[], Any],
    seeds: Sequence[int],
    progress: bool = False,
    jobs: int = 1,
) -> Dict[str, Any]:
    """Duplicate evaluation over ``seeds``; ``jobs > 1`` plays deals in worker processes
    (the factories must then be picklable, e.g. classes or ``functools.partial``)."""
    stats: Dict[str, int] = {}
    edges: List[float] = []
    pig_rate = [0, 0]
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
            edges.append(r["edge"])
            pig_rate[0] += r["pig"][0]
            pig_rate[1] += r["pig"][1]
            for k, v in r["stats"].items():
                stats[k] = stats.get(k, 0) + v
            if progress and (n + 1) % 25 == 0:
                print(
                    "  %d deals, edge %.2f, %.0fs"
                    % (n + 1, statistics.mean(edges), time.time() - t0),
                    flush=True,
                )
    finally:
        if pool is not None:
            pool.close()
    return {
        "deals": len(edges),
        "edge": statistics.mean(edges),
        "stderr": statistics.stdev(edges) / len(edges) ** 0.5 if len(edges) > 1 else 0,
        "pig_bot": pig_rate[0] / (4 * len(edges)),
        "pig_base": pig_rate[1] / (4 * len(edges)),
        "stats": stats,
        "seconds": time.time() - t0,
    }


def make_factory(name: str, budget_ms: Optional[int] = None) -> Callable[[], Any]:
    if name == "smart_gz":
        from smart_gz_bot import SmartGongzhuBot

        if budget_ms is None:
            return SmartGongzhuBot
        return functools.partial(SmartGongzhuBot, budget=budget_ms / 1000)
    if name == "greedy":
        from gongzhu_bot import GreedyGongzhuBot

        return GreedyGongzhuBot
    if name == "random":
        from gongzhu_bot import RandomGongzhuBot

        return RandomGongzhuBot
    raise SystemExit("unknown bot %r" % name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot", default="smart_gz")
    ap.add_argument("--baseline", default="greedy")
    ap.add_argument("--deals", type=int, default=100)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument(
        "--budget-ms", type=int, default=None, help="smart bot time per card"
    )
    ap.add_argument("--jobs", type=int, default=1, help="worker processes")
    args = ap.parse_args()
    r = duplicate(
        make_factory(args.bot, args.budget_ms),
        make_factory(args.baseline, args.budget_ms),
        range(args.start, args.start + args.deals),
        progress=True,
        jobs=args.jobs,
    )
    print(
        "%s vs %s: %d deals x4 seats, edge %.2f ± %.2f platform points per hand; "
        "takes the pig %.1f%% (baseline %.1f%%); %.0fs"
        % (
            args.bot,
            args.baseline,
            r["deals"],
            r["edge"],
            r["stderr"],
            100 * r["pig_bot"],
            100 * r["pig_base"],
            r["seconds"],
        )
    )
    print("  stats", r["stats"])


if __name__ == "__main__":
    main()
