"""Shared helpers for golden-vector generators.

Each generator imports this module first; it puts ``hexis-service/src`` on ``sys.path`` so the generators
run the real Python reference implementation. Golden files are written as UTF-8 JSON with sorted keys.

Numbers: the JS port has a single number type, so golden data must not contain integral floats (1.0)
or integers outside +/-(2**53-1); ``write`` rejects them so a mismatch can never come from transport.
"""

from __future__ import annotations

import json
import math
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

GOLDEN = Path(__file__).resolve().parent
BROWSER = GOLDEN.parent
ROOT = BROWSER.parent  # hexis-service/
sys.path.insert(0, str(ROOT / "src"))

SAFE = 2**53 - 1


def _check(v, where="$"):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return
    if isinstance(v, int):
        if abs(v) > SAFE:
            raise ValueError(f"{where}: integer {v} outside the JS-safe range")
        return
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError(f"{where}: non-finite float")
        if v.is_integer():
            raise ValueError(f"{where}: integral float {v!r} is not representable in the JS port; convert to int")
        return
    if isinstance(v, (list, tuple)):
        for i, x in enumerate(v):
            _check(x, f"{where}[{i}]")
        return
    if isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str):
                raise ValueError(f"{where}: non-string key {k!r}")
            _check(x, f"{where}.{k}")
        return
    raise TypeError(f"{where}: unsupported type {type(v).__name__}")


def ints(v):
    """Convert integral floats (e.g. SQLite REAL timestamps) to ints, recursively."""
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    if isinstance(v, list):
        return [ints(x) for x in v]
    if isinstance(v, tuple):
        return [ints(x) for x in v]
    if isinstance(v, dict):
        return {k: ints(x) for k, x in v.items()}
    return v


def write(name: str, obj) -> Path:
    _check(obj)
    p = GOLDEN / (name if name.endswith(".json") else name + ".json")
    p.write_text(json.dumps(obj, sort_keys=True, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return p


@contextmanager
def deterministic_uuids(start: int = 1):
    """Patch uuid.uuid4 so ids are reproducible: the n-th call returns UUID(int=n). The JS engine's default
    id source (HX.util.make_id_source) produces the same hex sequence."""
    counter = {"n": start}
    real = uuid.uuid4

    def fake():
        u = uuid.UUID(int=counter["n"])
        counter["n"] += 1
        return u

    uuid.uuid4 = fake
    try:
        yield counter
    finally:
        uuid.uuid4 = real
