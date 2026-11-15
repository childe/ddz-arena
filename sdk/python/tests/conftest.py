import sys
from pathlib import Path

# Make `ddz_sdk` importable without installing the package (e.g. `pytest sdk/python/tests`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
