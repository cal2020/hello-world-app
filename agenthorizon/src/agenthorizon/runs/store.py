"""File-backed run store (single host). The PostgreSQL store implements the same interface for the application.

Layout of ``<runs_dir>/<run_id>/``::

    definition.json             immutable run definition (its digest is the run id)
    state.json                  run status, controls, budget ledger (atomic replace)
    events.jsonl                append-only event log with sequence numbers (resumable event stream)
    tasks/<example_id>/
        attempt-<n>.start.json  written before an attempt is dispatched
        attempt-<n>.json        the attempt record, written atomically when the attempt ends
        final.json              the task's finalization (selected attempt), written once
        a<n>/                   the attempt's private task directory (fresh workspace, home, artifacts)

A start marker without a record means the worker died mid-attempt; recovery records it as ``interrupted``.
Partial output never appears under a final name: records are written to a temporary file and renamed.
"""

from __future__ import annotations

import fcntl
import json
import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.judging.parsing import Verdict
from agenthorizon.runs.identity import RunDefinition
from agenthorizon.scoring.protocol import PredictionSet, SelectedPrediction
from agenthorizon.util.io import atomic_write_json, utcnow_iso


class RunStoreError(RuntimeError):
    pass


class RunLocked(RunStoreError):
    pass


@dataclass
class AttemptRecord:
    run_id: str
    example_id: str
    attempt_no: int
    status: str
    outcome_class: str
    counts_toward_limit: bool
    started_at: str
    finished_at: str
    outcome: dict
    cost: dict = field(default_factory=dict)
    worker: str | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def verdict(self) -> Verdict | None:
        v = self.outcome.get("verdict")
        return Verdict(**v) if isinstance(v, dict) else None


class FileRunStore:
    def __init__(self, run_dir: Path):
        self.dir = Path(run_dir)
        self._lock = threading.RLock()
        self._lock_fh = None

    # ---- creation / identity ------------------------------------------------------------------------
    @classmethod
    def create_or_open(cls, runs_dir: Path, definition: RunDefinition, controls: dict) -> tuple[FileRunStore, bool]:
        run_dir = Path(runs_dir) / definition.run_id
        store = cls(run_dir)
        dpath = run_dir / "definition.json"
        if dpath.is_file():
            existing = json.loads(dpath.read_text())
            if existing != json.loads(json.dumps(definition.to_dict())):
                raise RunStoreError(f"{definition.run_id}: stored definition differs from the requested one; "
                                    "refusing to resume a different run")
            return store, False
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "tasks").mkdir(exist_ok=True)
        # selection and configuration are persisted before any job is dispatched
        atomic_write_json(dpath, definition.to_dict())
        atomic_write_json(run_dir / "state.json", {
            "run_id": definition.run_id, "status": "created", "created_at": utcnow_iso(), "updated_at": utcnow_iso(),
            "controls": controls, "pause_reason": None, "status_history": [{"status": "created", "at": utcnow_iso()}],
            "budget": {"limit_usd": controls.get("budget_usd"), "reserved_usd": 0.0, "spent_billed_usd": 0.0,
                       "spent_estimated_usd": 0.0, "unknown_cost_attempts": 0},
        })
        store.emit("run_created", run_id=definition.run_id, n_tasks=len(definition.example_ids))
        return store, True

    @property
    def run_id(self) -> str:
        return self.dir.name

    def definition(self) -> RunDefinition:
        return RunDefinition.from_dict(json.loads((self.dir / "definition.json").read_text()))

    def exists(self) -> bool:
        return (self.dir / "definition.json").is_file()

    # ---- state & events -----------------------------------------------------------------------------
    def state(self) -> dict:
        return json.loads((self.dir / "state.json").read_text())

    def update_state(self, fn) -> dict:
        with self._lock:
            st = self.state()
            fn(st)
            st["updated_at"] = utcnow_iso()
            atomic_write_json(self.dir / "state.json", st)
            return st

    def set_status(self, status: str, reason: str | None = None) -> dict:
        def f(st):
            if st["status"] != status:
                st["status_history"].append({"status": status, "at": utcnow_iso(), "reason": reason})
            st["status"] = status
            st["pause_reason"] = reason if status in ("paused", "blocked") else None
        st = self.update_state(f)
        self.emit("run_status", status=status, reason=reason)
        return st

    def emit(self, type_: str, **data) -> int:
        """Append one event. Sequence numbers are assigned under an exclusive file lock, so writers in several
        processes (the executing worker, a CLI cancel request) never collide."""
        with self._lock, open(self.dir / "events.jsonl", "a+b") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - 8192))
                seq = 0
                for line in reversed(fh.read().decode(errors="replace").splitlines()):
                    try:
                        seq = json.loads(line)["seq"]
                        break
                    except (ValueError, KeyError, TypeError):
                        continue
                ev = {"seq": seq + 1, "ts": utcnow_iso(), "type": type_, **data}
                fh.write((json.dumps(ev, sort_keys=True) + "\n").encode())
                fh.flush()
                os.fsync(fh.fileno())
                return seq + 1
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    # ---- operator control requests (cross-process) -----------------------------------------------------
    def request(self, action: str, by: str = "operator", reason: str | None = None) -> None:
        if action not in ("cancel", "pause"):
            raise ValueError(action)
        with self._lock:
            p = self.dir / "control.json"
            ctl = json.loads(p.read_text()) if p.is_file() else {}
            ctl[action] = {"requested_at": utcnow_iso(), "by": by, "reason": reason}
            atomic_write_json(p, ctl)
        self.emit(f"{action}_requested", by=by, reason=reason)

    def control(self) -> dict:
        p = self.dir / "control.json"
        return json.loads(p.read_text()) if p.is_file() else {}

    def clear_control(self) -> None:
        p = self.dir / "control.json"
        if p.is_file():
            p.unlink()

    def events(self, after: int = 0, limit: int | None = None) -> list[dict]:
        p = self.dir / "events.jsonl"
        if not p.is_file():
            return []
        out = []
        for line in p.read_text().splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue  # a torn final line from a crash is skipped, never fatal
            if ev["seq"] > after:
                out.append(ev)
                if limit and len(out) >= limit:
                    break
        return out

    # ---- exclusive execution ------------------------------------------------------------------------
    @contextmanager
    def execution_lock(self) -> Iterator[None]:
        fh = open(self.dir / ".lock", "a+")  # noqa: SIM115 — held for the duration of the context
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            fh.close()
            raise RunLocked(f"{self.run_id} is being executed by another process") from exc
        try:
            fh.seek(0)
            fh.truncate()
            fh.write(json.dumps({"pid": os.getpid(), "since": utcnow_iso()}))
            fh.flush()
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
            fh.close()

    # ---- tasks & attempts ---------------------------------------------------------------------------
    def _tdir(self, example_id: str) -> Path:
        if "/" in example_id or example_id.startswith("."):
            raise RunStoreError(f"unsafe example id {example_id!r}")
        return self.dir / "tasks" / example_id

    def task_dir(self, example_id: str, attempt_no: int) -> Path:
        return self._tdir(example_id) / f"a{attempt_no}"

    def attempts(self, example_id: str) -> list[AttemptRecord]:
        d = self._tdir(example_id)
        if not d.is_dir():
            return []
        recs = []
        for p in d.glob("attempt-*.json"):
            if p.name.endswith(".start.json"):
                continue
            recs.append(AttemptRecord(**json.loads(p.read_text())))
        return sorted(recs, key=lambda r: r.attempt_no)

    def begin_attempt(self, example_id: str, attempt_no: int, worker: str) -> str:
        d = self._tdir(example_id)
        d.mkdir(parents=True, exist_ok=True)
        start = d / f"attempt-{attempt_no}.start.json"
        if start.exists() or (d / f"attempt-{attempt_no}.json").exists():
            raise RunStoreError(f"attempt {attempt_no} of {example_id} already exists")
        at = utcnow_iso()
        atomic_write_json(start, {"attempt_no": attempt_no, "started_at": at, "worker": worker, "pid": os.getpid()})
        self.emit("attempt_started", example_id=example_id, attempt=attempt_no, worker=worker)
        return at

    def record_attempt(self, rec: AttemptRecord) -> None:
        p = self._tdir(rec.example_id) / f"attempt-{rec.attempt_no}.json"
        if p.exists():
            raise RunStoreError(f"attempt record {p} already exists")
        atomic_write_json(p, rec.to_dict())
        self.emit("attempt_finished", example_id=rec.example_id, attempt=rec.attempt_no, status=rec.status,
                  outcome_class=rec.outcome_class)

    def final(self, example_id: str) -> dict | None:
        p = self._tdir(example_id) / "final.json"
        return json.loads(p.read_text()) if p.is_file() else None

    def finalize(self, example_id: str, final: dict) -> bool:
        """Write the task's final record once. Returns False (and changes nothing) if already finalized."""
        with self._lock:
            p = self._tdir(example_id) / "final.json"
            if p.exists():
                existing = json.loads(p.read_text())
                if existing.get("selected_attempt") != final.get("selected_attempt"):
                    raise RunStoreError(f"{example_id} already finalized with attempt {existing.get('selected_attempt')}")
                return False
            atomic_write_json(p, {**final, "finalized_at": utcnow_iso()})
        self.emit("task_finalized", example_id=example_id, selected_attempt=final.get("selected_attempt"),
                  final_class=final.get("final_class"), has_response=final.get("has_response"))
        return True

    def supersede_final(self, example_id: str, pass_no: int) -> None:
        """Move a task's final record aside (kept for audit) so an explicit retry pass can re-finalize it."""
        d = self._tdir(example_id)
        os.replace(d / "final.json", d / f"final.superseded-{pass_no}.json")
        self.emit("final_superseded", example_id=example_id, pass_no=pass_no)

    def recover_interrupted(self) -> list[tuple[str, int]]:
        """Record attempts whose worker died (start marker, no record) as ``interrupted``. Idempotent."""
        found = []
        tasks = self.dir / "tasks"
        if not tasks.is_dir():
            return found
        for start in sorted(tasks.glob("*/attempt-*.start.json")):
            eid = start.parent.name
            n = int(start.name.split("-")[1].split(".")[0])
            if (start.parent / f"attempt-{n}.json").exists():
                continue
            meta = json.loads(start.read_text())
            rec = AttemptRecord(self.run_id, eid, n, "interrupted", "interrupted", False, meta.get("started_at", ""),
                                utcnow_iso(), {"status": "interrupted", "error": "worker stopped before the attempt ended"},
                                worker=meta.get("worker"),
                                notes=["recorded on recovery; any partial artifacts remain in the attempt directory"])
            self.record_attempt(rec)
            found.append((eid, n))
        return found

    # ---- views ---------------------------------------------------------------------------------------
    def task_summary(self, example_id: str) -> dict:
        recs = self.attempts(example_id)
        fin = self.final(example_id)
        d = self._tdir(example_id)
        running = [int(p.name.split("-")[1].split(".")[0]) for p in d.glob("attempt-*.start.json")
                   if not (d / p.name.replace(".start", "")).exists()] if d.is_dir() else []
        if fin:
            status = "finalized"
        elif running:
            status = "running"
        elif recs and recs[-1].status in ("cancelled",):
            status = "cancelled"
        elif recs and recs[-1].status == "blocked":
            status = "blocked"
        elif recs:
            status = "pending_retry"
        else:
            status = "queued"
        return {"example_id": example_id, "status": status, "attempts": len(recs),
                "last_status": recs[-1].status if recs else None, "final": fin}

    def prediction_set(self, known_example_ids: frozenset[str] | None = None) -> PredictionSet:
        d = self.definition()
        records = []
        for eid in d.example_ids:
            fin = self.final(eid)
            if not fin or not fin.get("has_response"):
                continue  # missing (never finished, or finished without a response) — counted in the denominator
            n = fin["selected_attempt"]
            rec = next(r for r in self.attempts(eid) if r.attempt_no == n)
            records.append(SelectedPrediction(eid, rec.verdict, attempt=n,
                                              record_ref=f"{self.run_id}/tasks/{eid}/attempt-{n}.json"))
        known = known_example_ids if known_example_ids is not None else frozenset(d.example_ids)
        return PredictionSet(self.run_id, d.dataset_version_id, known, records)


def list_runs(runs_dir: Path) -> list[dict]:
    out = []
    for p in sorted(Path(runs_dir).glob("run-*/definition.json")):
        st_path = p.parent / "state.json"
        st = json.loads(st_path.read_text()) if st_path.is_file() else {}
        d = json.loads(p.read_text())
        out.append({"run_id": p.parent.name, "status": st.get("status"), "created_at": st.get("created_at"),
                    "judge": d["judge"].get("config_id"), "dataset_version_id": d["dataset_version_id"],
                    "n_tasks": len(d["selection"]["example_ids"]), "trial": d.get("trial"),
                    "result_kind": d.get("classification", {}).get("result_kind")})
    return out
