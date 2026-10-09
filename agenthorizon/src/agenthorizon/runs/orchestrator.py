"""Run execution: bounded concurrency, budget reservation, cancellation, pause/resume, crash recovery.

* Only one process executes a run at a time (an exclusive lock on the run directory).
* On start, attempts left behind by a dead worker are recorded as ``interrupted`` (history is never discarded).
* Each attempt reserves its forecast cost before dispatch; the reservation is settled with the billed amount when
  the harness reports one, else a token-based estimate, else it is kept as an unknown-cost charge. A dispatch that
  would exceed the explicit budget pauses the run instead.
* ``pause`` stops dispatching and lets running attempts finish; ``cancel`` additionally stops running attempts (they
  are recorded as ``cancelled``). Resuming continues the same run identity from the recorded history.
* A ``blocked`` outcome (missing credential, unknown model, missing media) pauses the whole run rather than turning
  every remaining item into a missing prediction.
"""

from __future__ import annotations

import os
import queue
import socket
import threading
import time
import traceback
from dataclasses import dataclass, field

from agenthorizon.judging.contract import AttemptOutcome, Telemetry
from agenthorizon.runs.policy import (
    INFRASTRUCTURE_CLASSES,
    RESPONSE_CLASSES,
    AttemptPolicy,
    classify,
    decide,
    select,
)
from agenthorizon.runs.pricing import Price, cost
from agenthorizon.runs.store import AttemptRecord, FileRunStore
from agenthorizon.util.io import utcnow_iso

REDISPATCHABLE = frozenset({"process_failed", "timed_out", "rate_limited", "transport_failed"})


@dataclass
class RunControls:
    concurrency: int = 1
    budget_usd: float | None = None
    metered: bool = True
    max_new_tasks: int | None = None  # pilot: start at most this many unfinished tasks in this invocation
    poll_s: float = 0.5


@dataclass
class _Ledger:
    limit: float | None
    reserved: float = 0.0
    billed: float = 0.0
    estimated: float = 0.0
    unknown_reserved: float = 0.0
    unknown_attempts: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def committed(self) -> float:
        return self.reserved + self.billed + self.estimated + self.unknown_reserved

    def try_reserve(self, amount: float) -> bool:
        with self.lock:
            if self.limit is not None and self.committed() + amount > self.limit + 1e-12:
                return False
            self.reserved += amount
            return True

    def settle(self, reserved: float, billed: float | None, estimated: float | None) -> dict:
        with self.lock:
            self.reserved -= reserved
            if billed is not None:
                self.billed += billed
                return {"basis": "billed", "charged_usd": billed}
            if estimated is not None:
                self.estimated += estimated
                return {"basis": "estimated_from_tokens", "charged_usd": estimated}
            self.unknown_reserved += reserved
            self.unknown_attempts += 1
            return {"basis": "unknown_usage_kept_reservation", "charged_usd": reserved}

    def to_dict(self) -> dict:
        return {"limit_usd": self.limit, "reserved_usd": round(self.reserved, 6), "spent_billed_usd": round(self.billed, 6),
                "spent_estimated_usd": round(self.estimated, 6), "unknown_cost_reserved_usd": round(self.unknown_reserved, 6),
                "unknown_cost_attempts": self.unknown_attempts, "committed_usd": round(self.committed(), 6)}


def _effective(classes: list[str]) -> list[str]:
    """Attempt classes since the last explicit re-open (an audited retry-errors pass starts a fresh sequence)."""
    if "reopened" in classes:
        return classes[len(classes) - classes[::-1].index("reopened"):]
    return classes


class Orchestrator:
    def __init__(self, store: FileRunStore, judge, policy: AttemptPolicy, *, controls: RunControls,
                 item_cost: dict[str, float | None], price: Price | None, worker_id: str | None = None):
        self.store, self.judge, self.policy, self.controls = store, judge, policy, controls
        self.item_cost, self.price = item_cost, price
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self.cancel = threading.Event()  # stops running attempts
        self.stop = threading.Event()  # stops dispatching
        self.stop_reason: str | None = None
        self.stop_status: str | None = None
        st = store.state()["budget"]
        self.ledger = _Ledger(controls.budget_usd, 0.0, st.get("spent_billed_usd", 0.0), st.get("spent_estimated_usd", 0.0),
                              st.get("unknown_cost_reserved_usd", 0.0), st.get("unknown_cost_attempts", 0))
        self._started = 0
        self._started_lock = threading.Lock()

    # ---- public ----------------------------------------------------------------------------------------------
    def run(self) -> dict:
        with self.store.execution_lock():
            recovered = self.store.recover_interrupted()
            self.store.clear_control()
            self.store.set_status("running")
            if recovered:
                self.store.emit("recovered_interrupted", attempts=[{"example_id": e, "attempt": n} for e, n in recovered])
                if self.controls.metered:  # usage of a dead worker's attempt is unknown: charge its forecast
                    for e, _ in recovered:
                        self.ledger.unknown_reserved += self.item_cost.get(e) or 0.0
                        self.ledger.unknown_attempts += 1
            work = self._initial_queue()
            q: queue.Queue = queue.Queue()
            for eid in work:
                q.put(eid)
            watcher = threading.Thread(target=self._watch, daemon=True)
            watcher.start()
            workers = [threading.Thread(target=self._worker, args=(q,), name=f"judge-{i}")
                       for i in range(max(1, self.controls.concurrency))]
            for w in workers:
                w.start()
            for w in workers:
                w.join()
            self.stop.set()
            watcher.join(timeout=5)
            self._persist_budget()
            return self._conclude()

    # ---- internals ---------------------------------------------------------------------------------------------
    def _initial_queue(self) -> list[str]:
        out = []
        for eid in self.store.definition().example_ids:
            if self.store.final(eid):
                continue
            classes = _effective([r.outcome_class for r in self.store.attempts(eid)])
            d = decide(self.policy, classes)
            if d.action == "finalize":  # history complete but the final record was not written (crash)
                self._finalize(eid, d.reason)
                continue
            out.append(eid)
        return out

    def _watch(self) -> None:
        while not self.stop.is_set():
            ctl = self.store.control()
            if "cancel" in ctl:
                self._halt("cancelled", f"cancel requested by {ctl['cancel'].get('by')}")
                self.cancel.set()
            elif "pause" in ctl:
                self._halt("paused", f"pause requested by {ctl['pause'].get('by')}")
            self.stop.wait(self.controls.poll_s)

    def _halt(self, status: str, reason: str) -> None:
        if self.stop_status in ("cancelled",):
            return
        if self.stop_status is None or status == "cancelled":
            self.stop_status, self.stop_reason = status, reason
        self.stop.set()

    def _worker(self, q: queue.Queue) -> None:
        while not self.stop.is_set():
            try:
                eid = q.get_nowait()
            except queue.Empty:
                return
            if self.controls.max_new_tasks is not None:
                with self._started_lock:
                    if self._started >= self.controls.max_new_tasks:
                        self._halt("paused", f"pilot limit of {self.controls.max_new_tasks} tasks reached")
                        return
                    self._started += 1
            try:
                self._run_task(eid)
            except Exception as exc:  # an orchestrator bug must not lose history or silently skip items
                self.store.emit("worker_error", example_id=eid, error=repr(exc), traceback=traceback.format_exc()[-4000:])
                self._halt("paused", f"internal error on {eid}: {exc!r}")
                return

    def _run_task(self, eid: str) -> None:
        while True:
            history = self.store.attempts(eid)
            classes = _effective([r.outcome_class for r in history])
            while classes and classes[-1] == "blocked":  # blocked in an earlier invocation; the operator resumed
                classes = classes[:-1]
            d = decide(self.policy, classes)
            if d.action == "finalize":
                self._finalize(eid, d.reason)
                return
            if self.stop.is_set():
                return
            reserve = self._reservation(eid)
            if reserve is None:
                self._halt("paused", "no cost forecast for a metered route; supply a price to enforce the budget")
                return
            if not self.ledger.try_reserve(reserve):
                self._halt("paused", f"budget exhausted: committing ${reserve:.4f} more would exceed the "
                                     f"${self.ledger.limit:.2f} limit")
                return
            self._persist_budget()
            n = max((r.attempt_no for r in history), default=0) + 1
            started = self.store.begin_attempt(eid, n, self.worker_id)
            try:
                outcome = self.judge.attempt(eid, n, self.store.task_dir(eid, n), self.store.dir, self.cancel)
            except Exception as exc:
                outcome = AttemptOutcome("interrupted", error=f"orchestrator exception: {exc!r}",
                                         telemetry=Telemetry().finalize(),
                                         lineage={"traceback": traceback.format_exc()[-4000:]})
            cls = "interrupted" if outcome.status == "interrupted" else classify(outcome, self.policy)
            charge = self._settle(reserve, outcome)
            rec = AttemptRecord(self.store.run_id, eid, n, outcome.status, cls, cls not in INFRASTRUCTURE_CLASSES,
                                started, utcnow_iso(), outcome.to_dict(), cost=charge, worker=self.worker_id)
            self.store.record_attempt(rec)
            self._persist_budget()
            if cls == "interrupted":
                self._halt("paused", f"internal error on {eid}: {outcome.error}")
                return
            if cls == "blocked":
                self._halt("paused", f"blocked on {eid}: {outcome.error}")
                return
            if cls == "cancelled":
                return

    def _reservation(self, eid: str) -> float | None:
        if not self.controls.metered:
            return 0.0
        return self.item_cost.get(eid)

    def _settle(self, reserved: float, outcome: AttemptOutcome) -> dict:
        t = outcome.telemetry
        base = {"reserved_usd": reserved, "currency": "USD", "priced_at": utcnow_iso(),
                "price_source": self.price.source if self.price else None}
        if not self.controls.metered:
            self.ledger.settle(reserved, 0.0, None)
            return {**base, "basis": "unmetered_route", "charged_usd": 0.0}
        billed = t.cost_billed_usd
        est = cost(self.price, t.input_tokens, t.output_tokens, t.cached_input_tokens)
        if billed is None and est is None and outcome.status in ("serving_incompatible", "blocked") \
                and not outcome.transport_retries:
            est = 0.0  # rejected before a billable request completed
        return {**base, **self.ledger.settle(reserved, billed, est)}

    def _persist_budget(self) -> None:
        led = self.ledger.to_dict()
        self.store.update_state(lambda st: st["budget"].update(led))

    def _finalize(self, eid: str, reason: str) -> None:
        recs = self.store.attempts(eid)
        classes = [r.outcome_class for r in recs]
        start = len(classes) - classes[::-1].index("reopened") if "reopened" in classes else 0
        eff = recs[start:]
        n, has_resp = select(self.policy, [(r.attempt_no, r.outcome_class) for r in eff])
        final_cls = next((r.outcome_class for r in eff if r.attempt_no == n), None)
        self.store.finalize(eid, {"selected_attempt": n, "has_response": has_resp, "final_class": final_cls,
                                  "selection_rule": self.policy.selection_rule, "policy": self.policy.policy_id,
                                  "decision": reason, "attempts_total": len(recs),
                                  "counted_attempts": sum(1 for r in eff if r.counts_toward_limit)})

    def _conclude(self) -> dict:
        d = self.store.definition()
        finals = sum(1 for eid in d.example_ids if self.store.final(eid))
        if self.stop_status == "cancelled":
            status = "cancelled"
        elif finals == len(d.example_ids):
            status = "completed"
        else:
            status = self.stop_status or "paused"
        reason = self.stop_reason if status != "completed" else None
        if status == "paused" and reason is None:
            reason = "stopped with unfinished tasks"
        self.store.set_status(status, reason)
        summary = run_summary(self.store)
        self.store.emit("run_summary", **{k: v for k, v in summary.items() if k != "tasks"})
        return summary


def run_summary(store: FileRunStore) -> dict:
    d = store.definition()
    by_status: dict[str, int] = {}
    finals: dict[str, int] = {}
    attempts = 0
    for eid in d.example_ids:
        t = store.task_summary(eid)
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
        attempts += t["attempts"]
        if t["final"]:
            k = t["final"]["final_class"] if t["final"]["has_response"] else f"missing:{t['final']['final_class']}"
            finals[k] = finals.get(k, 0) + 1
    st = store.state()
    return {"run_id": store.run_id, "status": st["status"], "reason": st.get("pause_reason"), "n_tasks": len(d.example_ids),
            "tasks_by_status": by_status, "finalized_by_class": finals, "attempts": attempts, "budget": st["budget"]}


def retry_errors(store: FileRunStore, policy: AttemptPolicy, *, by: str, reason: str) -> list[str]:
    """Explicit, audited operator action mirroring the reference runner's resume: tasks that ended WITHOUT any
    response because of an execution error get one fresh attempt sequence. Tasks with a response — valid or
    invalid — are never eligible, so no judgment is re-run to change its outcome."""
    reopened = []
    with store.execution_lock():
        for eid in store.definition().example_ids:
            fin = store.final(eid)
            if not fin or fin.get("has_response") or fin.get("final_class") not in REDISPATCHABLE:
                continue
            recs = store.attempts(eid)
            passes = sum(1 for r in recs if r.outcome_class == "reopened")
            if passes >= policy.error_redispatch_passes:
                continue
            n = max(r.attempt_no for r in recs) + 1
            store.supersede_final(eid, passes + 1)
            store.record_attempt(AttemptRecord(store.run_id, eid, n, "reopened", "reopened", False, utcnow_iso(),
                                               utcnow_iso(), {"status": "reopened", "error": None},
                                               worker=by, notes=[f"retry-errors pass {passes + 1}: {reason}"]))
            reopened.append(eid)
    if reopened:
        store.emit("tasks_reopened", by=by, reason=reason, example_ids=reopened)
        store.set_status("paused", f"{len(reopened)} tasks reopened by {by}; resume to execute")
    return reopened


def wait_until(predicate, timeout_s: float, interval_s: float = 0.05) -> bool:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_s:
        if predicate():
            return True
        time.sleep(interval_s)
    return predicate()


__all__ = ["Orchestrator", "RunControls", "retry_errors", "run_summary", "RESPONSE_CLASSES"]
