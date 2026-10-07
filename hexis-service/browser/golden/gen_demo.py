"""Golden vectors for HX.demo (src/80_demo.js): the real ``demo/procurement_demo.py::run_demo``.

Setup (mirrors the other runtime goldens):
  * ``procurement_demo.ManualClock`` starts at 1790000000.25;
  * ``time.perf_counter`` is a fake timer returning ``0.125 * n`` on its n-th call (``build_env`` takes
    ``timer or time.perf_counter`` at call time, and ``Env.restart`` carries it over);
  * ``uuid.uuid4`` is gen_runtime's ``seq_uuids`` (the n-th id is ``f"{n:016x}{n:016x}"``, ``HX.env.make_seq_ids(1)``
    in JS). ``_common.deterministic_uuids()`` cannot be used: every run id would be ``run_0000000000000000`` and the
    demo's second run collides (deviations/runtime.md, "Notes for golden authors");
  * a temporary ``out_dir``.

Recorded per scenario: the ``say`` lines grouped by their ``== N. ...`` heading, the returned summary, and every file
``run_demo`` writes outside ``state/`` (JSON parsed and normalized with ``_common.ints``, other files as text). The
out-dir path in the final line is normalized to ``<OUT>``.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from _common import ints, write

from hexis_service.demo import procurement_demo as PD
from hexis_service.demo.env import ManualClock

CLOCK0 = 1790000000.25
SCENARIOS = ["full", "timeout-after-commit", "no-fault"]
HEAD = re.compile(r"^== (\d\w*)\. ")


@contextmanager
def seq_uuids(start: int = 1):
    counter = {"n": start}
    real = uuid.uuid4

    def fake():
        n = counter["n"]
        counter["n"] += 1
        return uuid.UUID(hex=f"{n:016x}{n:016x}")

    uuid.uuid4 = fake
    try:
        yield counter
    finally:
        uuid.uuid4 = real


@contextmanager
def patched():
    """ManualClock at CLOCK0 inside procurement_demo, time.perf_counter = 0.125*n, seq uuids."""
    n = {"n": 0}

    def fake_timer() -> float:
        n["n"] += 1
        return 0.125 * n["n"]

    class Clock(ManualClock):
        def __init__(self, t: float = CLOCK0):
            super().__init__(t)

    real_clock, real_timer = PD.ManualClock, time.perf_counter
    PD.ManualClock = Clock
    time.perf_counter = fake_timer
    try:
        with seq_uuids() as ids:
            yield {"timer": n, "ids": ids}
    finally:
        PD.ManualClock = real_clock
        time.perf_counter = real_timer


def group(lines: list[str]) -> list[dict]:
    steps: list[dict] = []
    for ln in lines:
        m = HEAD.match(ln)
        if m or not steps:
            steps.append({"id": m.group(1) if m else None, "lines": []})
        steps[-1]["lines"].append(ln)
    return steps


def run(scenario: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp, patched() as counters:
        out = Path(tmp) / "demo"
        lines: list[str] = []
        summary = PD.run_demo(str(out), scenario, say=lines.append)
        files = {}
        for p in sorted(out.rglob("*")):
            rel = p.relative_to(out).as_posix()
            if p.is_dir() or rel.startswith("state/"):
                continue
            text = p.read_text()
            files[rel] = ints(json.loads(text)) if p.suffix == ".json" else text
        state = sorted(p.relative_to(out).as_posix() for p in (out / "state").rglob("*"))
        lines = [ln.replace(str(out), "<OUT>") for ln in lines]
        return {"scenario": scenario, "lines": lines, "steps": group(lines), "summary": ints(summary),
                "files": files, "state_files": state, "timer_calls": counters["timer"]["n"],
                "ids_used": counters["ids"]["n"] - 1}


def main() -> None:
    out = {"clock0": CLOCK0, "scenarios": [run(s) for s in SCENARIOS]}
    # the two fault scenarios differ only in the summary's scenario name
    a, b = out["scenarios"][0], out["scenarios"][1]
    assert a["lines"] == b["lines"] and a["files"].keys() == b["files"].keys()
    p = write("demo", out)
    print(f"wrote {p} ({p.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
