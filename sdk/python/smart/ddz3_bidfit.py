"""Fit the landlord win model behind Smart3Bot's bids (3-player Dou Dizhu).

For every simulated deal each seat in turn is made the landlord (bid 3, bottom cards
added) and the game is played out by rule-only smart3 bots. Each game gives one example:
the features of that seat's 17 dealt cards (:func:`smart3_bot.bid_features`) and whether
the landlord won. A logistic regression on these examples estimates the chance that a
17-card hand wins as landlord, the bottom cards included on average. Paste the printed
coefficients into ``Smart3Bot.BID_MODEL``.

Usage:
    python smart/ddz3_bidfit.py --deals 20000 --jobs 8
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path
from typing import List, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ddz3_sim import deal, make_factory, play_game  # noqa: E402
from smart3_bot import BID_FEATURES, bid_features  # noqa: E402

Example = Tuple[List[float], int]


def examples(seed: int) -> List[Example]:
    """One example per seat of deal ``seed``: (features, landlord won)."""
    hands, _, _ = deal(seed)
    make = make_factory("smart3:ENDGAME_TOTAL=0")
    out: List[Example] = []
    for seat in range(3):
        r = play_game([make() for _ in range(3)], seed, forced_landlord=seat)
        out.append((bid_features(hands[seat]), int(r["winner_seat"] == seat)))
    return out


def fit(data: Sequence[Example], l2: float = 1.0, iters: int = 30) -> List[float]:
    """Logistic regression by Newton's method; returns [intercept, *weights]."""
    k = len(data[0][0]) + 1
    w = [0.0] * k
    for _ in range(iters):
        grad = [-l2 * w[j] if j else 0.0 for j in range(k)]
        hess = [[(l2 if i == j and i else 0.0) for j in range(k)] for i in range(k)]
        for x, y in data:
            v = [1.0] + list(x)
            p = 1 / (1 + math.exp(-sum(a * b for a, b in zip(w, v))))
            for i in range(k):
                grad[i] += (y - p) * v[i]
                for j in range(k):
                    hess[i][j] += p * (1 - p) * v[i] * v[j]
        step = _solve(hess, grad)
        w = [a + b for a, b in zip(w, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    return w


def _solve(a: List[List[float]], b: List[float]) -> List[float]:
    """Solve a x = b by Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c and m[c][c]:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def predict(w: Sequence[float], x: Sequence[float]) -> float:
    return 1 / (1 + math.exp(-(w[0] + sum(a * b for a, b in zip(w[1:], x)))))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deals", type=int, default=20000)
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
