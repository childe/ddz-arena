"""Fit the landlord win model behind Smart4Bot's bids (4-player Dou Dizhu).

Same method as ddz3_bidfit.py: for every simulated deal each seat in turn is made the
landlord (bid 3, bottom cards added) and the game is played out by rule-only smart4 bots.
Each game gives one example: the features of that seat's 25 dealt cards
(:func:`smart4_bot.bid_features`) and whether the landlord won. Paste the printed
coefficients into ``Smart4Bot.BID_MODEL``.

Usage:
    python smart/ddz4_bidfit.py --deals 15000 --jobs 4
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz3_bidfit import Example, fit, predict  # noqa: E402
from ddz4_sim import deal, make_factory, play_game  # noqa: E402
from smart4_bot import BID_FEATURES, bid_features  # noqa: E402


def examples(seed: int) -> List[Example]:
    """One example per seat of deal ``seed``: (features, landlord won)."""
    hands, _, _ = deal(seed)
    make = make_factory("smart4:ENDGAME_TOTAL=0,PIMC_SAMPLES=0")
    out: List[Example] = []
    for seat in range(4):
        r = play_game([make() for _ in range(4)], seed, forced_landlord=seat)
        out.append((bid_features(hands[seat]), int(r["winner_seat"] == seat)))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deals", type=int, default=15000)
    ap.add_argument("--start", type=int, default=1_000_000, help="first deal number")
    ap.add_argument("--jobs", type=int, default=1)
    args = ap.parse_args()
    t0 = time.time()
    seeds = range(args.start, args.start + args.deals)
    if args.jobs > 1:
        import multiprocessing

        with multiprocessing.Pool(args.jobs) as pool:
            rows = [e for chunk in pool.imap(examples, seeds, 50) for e in chunk]
    else:
        rows = [e for s in seeds for e in examples(s)]
    print("%d examples in %.0fs" % (len(rows), time.time() - t0))
    split = len(rows) * 4 // 5
    w = fit(rows[:split])
    test = rows[split:]
    ll = -sum(
        math.log(predict(w, x) if y else 1 - predict(w, x)) for x, y in test
    ) / len(test)
    base = sum(y for _, y in rows[:split]) / split
    ll0 = -sum(math.log(base if y else 1 - base) for _, y in test) / len(test)
    print("held-out log loss %.4f (constant %.3f: %.4f)" % (ll, base, ll0))
    print("calibration on held-out hands (predicted -> actual):")
    buckets: List[List[int]] = [[0, 0] for _ in range(10)]
    for x, y in test:
        b = min(9, int(predict(w, x) * 10))
        buckets[b][0] += 1
        buckets[b][1] += y
    for i, (n, won) in enumerate(buckets):
        if n:
            print(
                "  %.1f-%.1f  %5d hands  won %.3f" % (i / 10, (i + 1) / 10, n, won / n)
            )
    print("BID_MODEL = (")
    print("    %.4f,  # intercept" % w[0])
    for name, c in zip(BID_FEATURES, w[1:]):
        print("    %.4f,  # %s" % (c, name))
    print(")")


if __name__ == "__main__":
    main()
