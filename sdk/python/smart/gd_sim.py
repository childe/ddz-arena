"""Offline Guandan simulator and duplicate evaluation, no server needed.

One deal is one hand at a given level with a random first leader and no tribute (tribute
only redistributes one or two cards and would make deals depend on each other). The play
rules follow the server engine (docs/guandan.md): skip seats that are out, 接风 when the
player who went out wins the trick, the hand ends when a team is out or three players are.

Duplicate evaluation: each deal is played twice with the same cards, level and leader:
candidate bots on team 0 (seats 0, 2) against the baseline, then the other way round. The
candidate's result on a deal is the mean of its team's two results, where a team result is
``+upgrade`` (3/2/1) when it takes first place and ``-upgrade`` otherwise.

Usage:
    python smart/gd_sim.py --deals 300                       # smart_gd vs greedy
    python smart/gd_sim.py --deals 300 --bot greedy --baseline random
"""

from __future__ import annotations

import argparse
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz_sdk import GuandanState, Move  # noqa: E402
from ddz_sdk.cards import contains_all, remove_cards  # noqa: E402
from ddz_sdk.rules import RuleError  # noqa: E402
from ddz_sdk.rules_gd import (  # noqa: E402
    GdPattern,
    NAT_RANKS,
    lowest_single_gd,
    resolve_gd,
    sort_cards_gd,
)

DECK: List[str] = [r + s for r in NAT_RANKS for s in "SHCD"] * 2 + ["BJ", "RJ"] * 2
LEVELS = NAT_RANKS  # "23456789TJQKA"


def deal(seed: int):
    """(hands, level, first leader) for a deal number."""
    rng = random.Random(seed)
    deck = list(DECK)
    rng.shuffle(deck)
    level = LEVELS[rng.randrange(13)]
    hands = [sort_cards_gd(deck[i * 27 : (i + 1) * 27], level) for i in range(4)]
    return hands, level, rng.randrange(4)


def play_hand(
    bots: Sequence[Any], seed: int, stats: Optional[Dict[str, int]] = None
) -> Dict[str, Any]:
    """Play one deal; returns ``{"order", "winner_team", "upgrade", "team_score"}``."""
    stats = stats if stats is not None else {}
    hands, level, turn = deal(seed)
    order: List[int] = []
    history: List[Dict[str, Any]] = []
    last: Optional[Dict[str, Any]] = None  # {"seat", "cards", "pattern"(api)}
    passed: set = set()
    active = lambda s: s not in order  # noqa: E731
    for _ in range(2000):
        to_beat = last if last is not None and last["seat"] != turn else None
        st = GuandanState(
            seat=turn,
            hand=list(hands[turn]),
            phase="playing",
            level=level,
            turn=turn,
            to_beat=to_beat,
            can_pass=to_beat is not None,
            cards_left=[len(h) for h in hands],
            order=list(order),
            history=list(history),
        )
        try:
            ret = bots[turn].on_play(st)
            hint = ret.pattern if isinstance(ret, Move) else None
            cards = list(ret.cards) if isinstance(ret, Move) else list(ret or [])
            if cards:
                if not contains_all(hands[turn], cards):
                    raise RuleError("NOT_IN_HAND", "cards not in hand")
                pattern = resolve_gd(
                    cards,
                    GdPattern.from_api(to_beat["pattern"], level) if to_beat else None,
                    level,
                    hint,
                )
            elif to_beat is None:
                raise RuleError("MUST_PLAY", "cannot pass when leading")
        except Exception:
            stats["fallbacks"] = stats.get("fallbacks", 0) + 1
            cards = [] if to_beat is not None else lowest_single_gd(hands[turn], level)
            pattern = resolve_gd(cards, None, level, None) if cards else None
        if cards:
            hands[turn] = remove_cards(hands[turn], cards)
            last = {"seat": turn, "cards": cards, "pattern": pattern.to_api()}
            history.append(last)
            passed = set()
            if not hands[turn]:
                order.append(turn)
                partner = (turn + 2) % 4
                if len(order) == 3 or partner in order:
                    break
        else:
            history.append({"seat": turn, "cards": [], "pattern": None})
            passed.add(turn)
        # Next seat, or the end of the trick.
        leader = last["seat"]
        waiting = [s for s in range(4) if s != leader and active(s) and s not in passed]
        if last is not None and not waiting:
            passed = set()
            if active(leader):
                turn = leader
            else:  # 接风: the partner of the player who went out leads
                p = (leader + 2) % 4
                turn = (
                    p
                    if active(p)
                    else next(
                        s for s in ((leader + k) % 4 for k in (1, 2, 3)) if active(s)
                    )
                )
            last = None
            continue
        turn = next(s for s in ((turn + k) % 4 for k in (1, 2, 3)) if active(s))
    else:
        raise RuntimeError("hand did not end")
    first = order[0]
    partner = (first + 2) % 4
    place = order.index(partner) + 1 if partner in order else 4
    upgrade = {2: 3, 3: 2}.get(place, 1)
    team = first % 2
    return {
        "order": order,
        "winner_team": team,
        "upgrade": upgrade,
        "team_score": [upgrade if t == team else -upgrade for t in (0, 1)],
    }


def duplicate(
    make_bot: Callable[[], Any],
    make_base: Callable[[], Any],
    seeds: Sequence[int],
    progress: bool = False,
) -> Dict[str, Any]:
    stats: Dict[str, int] = {}
    edges: List[float] = []
    firsts = 0
    t0 = time.time()
    for n, seed in enumerate(seeds):
        a = play_hand([make_bot(), make_base(), make_bot(), make_base()], seed, stats)
        b = play_hand([make_base(), make_bot(), make_base(), make_bot()], seed, stats)
        edges.append((a["team_score"][0] + b["team_score"][1]) / 2)
        firsts += (a["winner_team"] == 0) + (b["winner_team"] == 1)
        if progress and (n + 1) % 50 == 0:
            print(
                "  %d deals, edge %.3f, %.0fs"
                % (n + 1, statistics.mean(edges), time.time() - t0),
                flush=True,
            )
    return {
        "deals": len(edges),
        "edge": statistics.mean(edges),
        "stderr": statistics.stdev(edges) / len(edges) ** 0.5,
        "first_rate": firsts / (2 * len(edges)),
        "stats": stats,
    }


def make_factory(name: str) -> Callable[[], Any]:
    if name == "smart_gd":
        from smart_gd_bot import SmartGuandanBot

        return SmartGuandanBot
    if name == "greedy":
        from guandan_bot import GreedyGuandanBot

        return GreedyGuandanBot
    if name == "random":
        from guandan_bot import RandomGuandanBot

        return RandomGuandanBot
    raise SystemExit("unknown bot %r" % name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot", default="smart_gd")
    ap.add_argument("--baseline", default="greedy")
    ap.add_argument("--deals", type=int, default=200)
    ap.add_argument("--start", type=int, default=0)
    args = ap.parse_args()
    r = duplicate(
        make_factory(args.bot),
        make_factory(args.baseline),
        range(args.start, args.start + args.deals),
        progress=True,
    )
    print(
        "%s vs %s: %d deals x2, edge %.3f ± %.3f levels per hand, takes first place %.1f%%"
        % (
            args.bot,
            args.baseline,
            r["deals"],
            r["edge"],
            r["stderr"],
            100 * r["first_rate"],
        )
    )
    print("  stats", r["stats"])


if __name__ == "__main__":
    main()
