"""PostgreSQL run store: the same interface as :class:`agenthorizon.runs.store.FileRunStore`, so the application's
workers run the identical orchestrator. Artifacts still live on the shared runs volume under ``<runs_dir>/<run_id>``.

Exclusive execution uses a session-level advisory lock held on a dedicated connection: if the worker dies, the
connection drops and the lock is released, so another worker can recover the run. Attempt rows are inserted with
status ``running`` before dispatch and completed in place; a primary key on (run, example, attempt) and an
insert-if-absent final record make duplicate finalization impossible.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, and_, bindparam, func, select, text, update
from sqlalchemy.dialects.postgresql import JSONB, insert

from agenthorizon.app.schema import run_attempts, run_events, run_finals, runs
from agenthorizon.runs.identity import RunDefinition
from agenthorizon.runs.store import AttemptRecord, RunLocked, RunStoreError
from agenthorizon.scoring.protocol import PredictionSet, SelectedPrediction
from agenthorizon.util.io import utcnow_iso


def _jsonable(d: dict) -> dict:
    return json.loads(json.dumps(d))


class PgRunStore:
    def __init__(self, engine: Engine, run_id: str, runs_dir: Path):
        self.engine = engine
        self._run_id = run_id
        self.dir = Path(runs_dir) / run_id

    # ---- creation / identity ------------------------------------------------------------------------------
    @classmethod
    def create_or_open(cls, engine: Engine, runs_dir: Path, definition: RunDefinition, controls: dict, *,
                       created_by: str | None = None, plan: dict | None = None, label: str | None = None
                       ) -> tuple[PgRunStore, bool]:
        d = _jsonable(definition.to_dict())
        with engine.begin() as c:
            row = c.execute(insert(runs).values(
                run_id=definition.run_id, definition=d, dataset_version_id=definition.dataset_version_id,
                config_id=definition.judge["config_id"], result_kind=definition.classification.get("result_kind", "unknown"),
                n_tasks=len(definition.example_ids), label=label, status="created",
                status_history=[{"status": "created", "at": utcnow_iso()}], controls=controls,
                budget={"limit_usd": controls.get("budget_usd"), "reserved_usd": 0.0, "spent_billed_usd": 0.0,
                        "spent_estimated_usd": 0.0, "unknown_cost_attempts": 0},
                plan=plan, created_by=created_by,
            ).on_conflict_do_nothing(index_elements=["run_id"]).returning(runs.c.run_id)).first()
            created = row is not None
            if not created:
                existing = c.execute(select(runs.c.definition).where(runs.c.run_id == definition.run_id)).scalar_one()
                if existing != d:
                    raise RunStoreError(f"{definition.run_id}: stored definition differs from the requested one")
                c.execute(update(runs).where(runs.c.run_id == definition.run_id).values(
                    controls=runs.c.controls.op("||")(bindparam(None, controls, type_=JSONB))))
        store = cls(engine, definition.run_id, runs_dir)
        store.dir.mkdir(parents=True, exist_ok=True)
        if created:
            store.emit("run_created", run_id=definition.run_id, n_tasks=len(definition.example_ids))
        return store, created

    @property
    def run_id(self) -> str:
        return self._run_id

    def exists(self) -> bool:
        with self.engine.connect() as c:
            return c.execute(select(runs.c.run_id).where(runs.c.run_id == self.run_id)).first() is not None

    def definition(self) -> RunDefinition:
        with self.engine.connect() as c:
            d = c.execute(select(runs.c.definition).where(runs.c.run_id == self.run_id)).scalar_one()
        return RunDefinition.from_dict(d)

    # ---- state & events -----------------------------------------------------------------------------------
    def _state_row(self, c, lock: bool = False) -> dict:
        q = select(runs).where(runs.c.run_id == self.run_id)
        if lock:
            q = q.with_for_update()
        r = c.execute(q).mappings().one()
        return {"run_id": r["run_id"], "status": r["status"], "created_at": r["created_at"].isoformat(),
                "updated_at": r["updated_at"].isoformat(), "controls": r["controls"], "pause_reason": r["pause_reason"],
                "status_history": r["status_history"], "budget": r["budget"]}

    def state(self) -> dict:
        with self.engine.connect() as c:
            return self._state_row(c)

    def update_state(self, fn) -> dict:
        with self.engine.begin() as c:
            st = self._state_row(c, lock=True)
            fn(st)
            c.execute(update(runs).where(runs.c.run_id == self.run_id).values(
                status=st["status"], pause_reason=st["pause_reason"], status_history=st["status_history"],
                controls=st["controls"], budget=_jsonable(st["budget"]), updated_at=func.now()))
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
        with self.engine.begin() as c:
            c.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"ahev:{self.run_id}"})
            seq = c.execute(select(func.coalesce(func.max(run_events.c.seq), 0) + 1)
                            .where(run_events.c.run_id == self.run_id)).scalar_one()
            c.execute(insert(run_events).values(run_id=self.run_id, seq=seq, type=type_, data=_jsonable(data)))
            c.execute(text("SELECT pg_notify('ah_run_events', :p)"), {"p": f"{self.run_id}:{seq}"})
        return seq

    def events(self, after: int = 0, limit: int | None = None) -> list[dict]:
        q = (select(run_events).where(and_(run_events.c.run_id == self.run_id, run_events.c.seq > after))
             .order_by(run_events.c.seq))
        if limit:
            q = q.limit(limit)
        with self.engine.connect() as c:
            return [{"seq": r["seq"], "ts": r["at"].isoformat(), "type": r["type"], **r["data"]}
                    for r in c.execute(q).mappings()]

    # ---- control requests ----------------------------------------------------------------------------------
    def request(self, action: str, by: str = "operator", reason: str | None = None) -> None:
        if action not in ("cancel", "pause"):
            raise ValueError(action)
        entry = {action: {"requested_at": utcnow_iso(), "by": by, "reason": reason}}
        with self.engine.begin() as c:
            c.execute(update(runs).where(runs.c.run_id == self.run_id).values(
                control_requests=runs.c.control_requests.op("||")(bindparam(None, entry, type_=JSONB))))
        self.emit(f"{action}_requested", by=by, reason=reason)

    def control(self) -> dict:
        with self.engine.connect() as c:
            return c.execute(select(runs.c.control_requests).where(runs.c.run_id == self.run_id)).scalar_one() or {}

    def clear_control(self) -> None:
        with self.engine.begin() as c:
            c.execute(update(runs).where(runs.c.run_id == self.run_id).values(control_requests={}))

    # ---- exclusive execution -----------------------------------------------------------------------------------
    @contextmanager
    def execution_lock(self) -> Iterator[None]:
        conn = self.engine.connect()
        try:
            got = conn.execute(text("SELECT pg_try_advisory_lock(hashtext(:k))"), {"k": f"ahrun:{self.run_id}"}).scalar_one()
            conn.commit()
            if not got:
                raise RunLocked(f"{self.run_id} is being executed by another worker")
            try:
                yield
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(hashtext(:k))"), {"k": f"ahrun:{self.run_id}"})
                conn.commit()
        finally:
            conn.close()

    # ---- tasks & attempts ----------------------------------------------------------------------------------------
    def task_dir(self, example_id: str, attempt_no: int) -> Path:
        if "/" in example_id or example_id.startswith("."):
            raise RunStoreError(f"unsafe example id {example_id!r}")
        return self.dir / "tasks" / example_id / f"a{attempt_no}"

    @staticmethod
    def _rec(r) -> AttemptRecord:
        return AttemptRecord(r["run_id"], r["example_id"], r["attempt_no"], r["status"], r["outcome_class"],
                             bool(r["counts_toward_limit"]), r["started_at"], r["finished_at"] or "", r["outcome"] or {},
                             cost=r["cost"] or {}, worker=r["worker"], notes=r["notes"] or [])

    def attempts(self, example_id: str) -> list[AttemptRecord]:
        q = (select(run_attempts).where(and_(run_attempts.c.run_id == self.run_id, run_attempts.c.example_id == example_id,
                                             run_attempts.c.status != "running")).order_by(run_attempts.c.attempt_no))
        with self.engine.connect() as c:
            return [self._rec(r) for r in c.execute(q).mappings()]

    def begin_attempt(self, example_id: str, attempt_no: int, worker: str) -> str:
        at = utcnow_iso()
        with self.engine.begin() as c:
            r = c.execute(insert(run_attempts).values(run_id=self.run_id, example_id=example_id, attempt_no=attempt_no,
                                                      status="running", started_at=at, worker=worker)
                          .on_conflict_do_nothing().returning(run_attempts.c.attempt_no)).first()
        if r is None:
            raise RunStoreError(f"attempt {attempt_no} of {example_id} already exists")
        self.emit("attempt_started", example_id=example_id, attempt=attempt_no, worker=worker)
        return at

    def record_attempt(self, rec: AttemptRecord) -> None:
        vals = dict(status=rec.status, outcome_class=rec.outcome_class, counts_toward_limit=rec.counts_toward_limit,
                    started_at=rec.started_at, finished_at=rec.finished_at, outcome=_jsonable(rec.outcome),
                    cost=_jsonable(rec.cost), worker=rec.worker, notes=rec.notes)
        stmt = insert(run_attempts).values(run_id=self.run_id, example_id=rec.example_id, attempt_no=rec.attempt_no, **vals)
        stmt = stmt.on_conflict_do_update(index_elements=["run_id", "example_id", "attempt_no"], set_=vals,
                                          where=run_attempts.c.status == "running").returning(run_attempts.c.attempt_no)
        with self.engine.begin() as c:
            if c.execute(stmt).first() is None:
                raise RunStoreError(f"attempt record {rec.example_id}#{rec.attempt_no} already exists")
        self.emit("attempt_finished", example_id=rec.example_id, attempt=rec.attempt_no, status=rec.status,
                  outcome_class=rec.outcome_class)

    def final(self, example_id: str) -> dict | None:
        with self.engine.connect() as c:
            r = c.execute(select(run_finals.c.final, run_finals.c.finalized_at).where(and_(
                run_finals.c.run_id == self.run_id, run_finals.c.example_id == example_id))).first()
        if r is None or r[0] is None:
            return None
        return {**r[0], "finalized_at": r[1].isoformat()}

    def finalize(self, example_id: str, final: dict) -> bool:
        stmt = insert(run_finals).values(run_id=self.run_id, example_id=example_id, final=_jsonable(final))
        stmt = stmt.on_conflict_do_update(index_elements=["run_id", "example_id"],
                                          set_={"final": stmt.excluded.final, "finalized_at": func.now()},
                                          where=run_finals.c.final.is_(None)).returning(run_finals.c.example_id)
        with self.engine.begin() as c:
            done = c.execute(stmt).first() is not None
        if not done:
            existing = self.final(example_id) or {}
            if existing.get("selected_attempt") != final.get("selected_attempt"):
                raise RunStoreError(f"{example_id} already finalized with attempt {existing.get('selected_attempt')}")
            return False
        self.emit("task_finalized", example_id=example_id, selected_attempt=final.get("selected_attempt"),
                  final_class=final.get("final_class"), has_response=final.get("has_response"))
        return True

    def supersede_final(self, example_id: str, pass_no: int) -> None:
        with self.engine.begin() as c:
            r = c.execute(text(
                "UPDATE run_finals SET superseded = superseded || jsonb_build_array(final || jsonb_build_object('pass_no', "
                "CAST(:p AS integer))), final = NULL WHERE run_id = :r AND example_id = :e AND final IS NOT NULL "
                "RETURNING example_id"), {"p": pass_no, "r": self.run_id, "e": example_id}).first()
        if r is None:
            raise RunStoreError(f"{example_id} has no final record to supersede")
        self.emit("final_superseded", example_id=example_id, pass_no=pass_no)

    def recover_interrupted(self) -> list[tuple[str, int]]:
        """Called under the execution lock: any attempt still 'running' belongs to a dead worker."""
        with self.engine.connect() as c:
            rows = c.execute(select(run_attempts).where(and_(run_attempts.c.run_id == self.run_id,
                                                             run_attempts.c.status == "running"))).mappings().all()
        found = []
        for r in rows:
            rec = AttemptRecord(self.run_id, r["example_id"], r["attempt_no"], "interrupted", "interrupted", False,
                                r["started_at"], utcnow_iso(),
                                {"status": "interrupted", "error": "worker stopped before the attempt ended"},
                                worker=r["worker"], notes=["recorded on recovery; partial artifacts remain on disk"])
            self.record_attempt(rec)
            found.append((r["example_id"], r["attempt_no"]))
        return found

    # ---- views ----------------------------------------------------------------------------------------------------------
    def task_summary(self, example_id: str) -> dict:
        with self.engine.connect() as c:
            rows = c.execute(select(run_attempts.c.attempt_no, run_attempts.c.status).where(and_(
                run_attempts.c.run_id == self.run_id, run_attempts.c.example_id == example_id))
                .order_by(run_attempts.c.attempt_no)).all()
        fin = self.final(example_id)
        done = [r for r in rows if r[1] != "running"]
        if fin:
            status = "finalized"
        elif any(r[1] == "running" for r in rows):
            status = "running"
        elif done and done[-1][1] == "cancelled":
            status = "cancelled"
        elif done and done[-1][1] == "blocked":
            status = "blocked"
        elif done:
            status = "pending_retry"
        else:
            status = "queued"
        return {"example_id": example_id, "status": status, "attempts": len(done),
                "last_status": done[-1][1] if done else None, "final": fin}

    def prediction_set(self, known_example_ids: frozenset[str] | None = None) -> PredictionSet:
        d = self.definition()
        q = (select(run_finals.c.example_id, run_finals.c.final, run_attempts.c.outcome)
             .join(run_attempts, and_(run_attempts.c.run_id == run_finals.c.run_id,
                                      run_attempts.c.example_id == run_finals.c.example_id,
                                      run_attempts.c.attempt_no == func.cast(run_finals.c.final["selected_attempt"].astext,
                                                                             run_attempts.c.attempt_no.type)))
             .where(and_(run_finals.c.run_id == self.run_id, run_finals.c.final.is_not(None))))
        records = []
        with self.engine.connect() as c:
            for eid, fin, outcome in c.execute(q):
                if not fin.get("has_response"):
                    continue
                v = outcome.get("verdict")
                from agenthorizon.judging.parsing import Verdict

                records.append(SelectedPrediction(eid, Verdict(**v) if isinstance(v, dict) else None,
                                                  attempt=fin["selected_attempt"],
                                                  record_ref=f"pg:{self.run_id}/{eid}#{fin['selected_attempt']}"))
        known = known_example_ids if known_example_ids is not None else frozenset(d.example_ids)
        return PredictionSet(self.run_id, d.dataset_version_id, known, sorted(records, key=lambda r: r.example_id))
