"""examples/run_table.py plus the smart strategies: ``smart3`` (ddz), ``smart4`` (ddz4) and
``smart_gd`` (guandan).

Extra option ``--pause-ms N``: smart bots wait N ms before each bid / play, so humans can follow
the game on the web page (the per-game timeout is raised to 600 s unless given).

Usage:
    python smart/table.py --base http://localhost:8080 --game ddz4 --bots smart4,greedy --games 10
    python smart/table.py --base https://ddz.ohmycat.me --game ddz4 --bots smart4 \
        --games 100 --pause-ms 1500 --prefix 智能 --invite CODE
"""

import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "examples"))
sys.path.insert(0, str(HERE))

import run_table  # noqa: E402
from smart3_bot import Smart3Bot  # noqa: E402
from smart4_bot import Smart4Bot  # noqa: E402
from smart_gd_bot import SmartGuandanBot  # noqa: E402


def pop_pause(argv):
    """Remove ``--pause-ms N`` from ``argv`` and return N in seconds (0 if absent)."""
    if "--pause-ms" not in argv:
        return 0.0
    i = argv.index("--pause-ms")
    value = float(argv[i + 1]) / 1000
    del argv[i : i + 2]
    if value and "--per-game-timeout" not in argv:
        argv += ["--per-game-timeout", "600"]
    return value


PAUSE = pop_pause(sys.argv)


def paused(cls):
    """Subclass of ``cls`` that waits PAUSE seconds before each bid / play."""

    class Paused(cls):
        def on_bid(self, state):
            time.sleep(PAUSE)
            return super().on_bid(state)

        def on_play(self, state):
            time.sleep(PAUSE)
            return super().on_play(state)

        def on_return(self, state):
            time.sleep(PAUSE)
            return super().on_return(state)

    return Paused if PAUSE else cls


run_table.KINDS["ddz"] = {**run_table.KINDS["ddz"], "smart3": paused(Smart3Bot)}
run_table.KINDS["ddz4"] = {**run_table.KINDS["ddz4"], "smart4": paused(Smart4Bot)}
run_table.KINDS["guandan"] = {
    **run_table.KINDS["guandan"],
    "smart_gd": paused(SmartGuandanBot),
}

if __name__ == "__main__":
    sys.exit(run_table.main())
