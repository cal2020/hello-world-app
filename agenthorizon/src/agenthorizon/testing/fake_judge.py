"""Scripted judge for orchestration and fault-injection tests (TEST ONLY — no model, no network).

``ScriptedJudge`` returns attempt outcomes from a per-item script, e.g. ``{"ex1": ["unparseable", "verdict:true"]}``.
Outcome kinds: ``verdict:true``, ``verdict:false``, ``verdict:str`` (success given as a string — invalid),
``unparseable``, ``short``, ``process_failed``, ``timed_out``, ``transport_failed``, ``rate_limited``,
``serving_incompatible``, ``blocked``, ``raise`` (an exception inside the judge). Items without a script get the
default. ``delay_s`` makes each attempt wait (honouring cancellation) so tests can interrupt work in flight.

Run as a module to execute a run in a separate worker process (used by the kill/restart test)::

    python -m agenthorizon.testing.fake_judge <runs_dir> <run_id> <delay_s> <concurrency> [<database_url>]
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

from agenthorizon.judging.contract import AttemptOutcome, Telemetry
from agenthorizon.judging.parsing import parse_agentic


def _verdict_text(success) -> str:
    obj = {"success": success, "reasoning": "scripted test outcome", "confidence": "medium",
           "mistake_type": None if success is True else "Critical Mistake"}
    return "Scripted.\n```json\n" + json.dumps(obj) + "\n```"


class ScriptedJudge:
    def __init__(self, script: dict[str, list[str]] | None = None, default: str = "verdict:true", delay_s: float = 0.0,
                 tokens: tuple[int, int] | None = (1000, 100), billed_usd: float | None = None):
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.default, self.delay_s, self.tokens, self.billed = default, delay_s, tokens, billed_usd
        self.calls: list[tuple[str, int]] = []
        self._lock = threading.Lock()

    def attempt(self, example_id: str, attempt_no: int, task_dir: Path, run_dir: Path,
                cancel: threading.Event) -> AttemptOutcome:
        with self._lock:
            self.calls.append((example_id, attempt_no))
            seq = self.script.get(example_id)
            kind = seq.pop(0) if seq else self.default
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "attempt.txt").write_text(f"{example_id} attempt {attempt_no}: {kind}\n")
        t0 = time.monotonic()
        if self.delay_s and cancel.wait(self.delay_s):
            return AttemptOutcome("cancelled", telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
        tel = Telemetry(input_tokens=self.tokens[0] if self.tokens else None,
                        output_tokens=self.tokens[1] if self.tokens else None,
                        cost_billed_usd=self.billed, wall_time_s=time.monotonic() - t0).finalize()
        if kind == "raise":
            raise RuntimeError("scripted judge failure")
        if kind.startswith("verdict:"):
            v = {"true": True, "false": False, "str": "false"}[kind.split(":", 1)[1]]
            text = _verdict_text(v)
            return AttemptOutcome("completed", response_text=text, verdict=parse_agentic(text), telemetry=tel)
        if kind == "unparseable":
            text = "I looked at the trajectory carefully. " * 10  # long, JSON-free: not a short truncation
            return AttemptOutcome("completed", response_text=text, verdict=parse_agentic(text), telemetry=tel)
        if kind == "short":
            return AttemptOutcome("completed", response_text="eb.json) PM", verdict=parse_agentic("eb.json) PM"), telemetry=tel)
        if kind in ("process_failed", "timed_out", "transport_failed", "rate_limited", "serving_incompatible", "blocked"):
            no_call = kind in ("serving_incompatible", "blocked")
            return AttemptOutcome(kind, error=f"scripted {kind}",
                                  telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize() if no_call else tel)
        raise ValueError(f"unknown scripted outcome {kind!r}")


def main(argv: list[str]) -> int:
    from agenthorizon.runs.orchestrator import Orchestrator, RunControls
    from agenthorizon.runs.policy import POLICIES
    from agenthorizon.runs.store import FileRunStore

    runs_dir, run_id, delay, conc = Path(argv[0]), argv[1], float(argv[2]), int(argv[3])
    if len(argv) > 4:  # PostgreSQL store (application worker path)
        from sqlalchemy import create_engine

        from agenthorizon.app.runstore import PgRunStore

        store = PgRunStore(create_engine(argv[4]), run_id, runs_dir)
    else:
        store = FileRunStore(runs_dir / run_id)
    d = store.definition()
    orch = Orchestrator(store, ScriptedJudge(delay_s=delay), POLICIES[d.attempt_policy["policy_id"]],
                        controls=RunControls(concurrency=conc, metered=False), item_cost={}, price=None,
                        worker_id="subprocess-worker")
    print(json.dumps(orch.run()["tasks_by_status"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
