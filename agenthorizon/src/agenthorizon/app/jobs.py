"""Durable job queue in PostgreSQL.

Jobs are claimed with ``FOR UPDATE SKIP LOCKED`` and held under a lease that the worker extends with heartbeats.
A job whose lease expires (worker died) becomes claimable again; its attempt counter grows, and after
``max_attempts`` expired or failed tries it is marked failed. Work done inside a job is itself idempotent (a run job
resumes its run; finalized results are never duplicated), so re-claiming is safe. A partial unique index on
``dedupe_key`` prevents two active jobs for the same target.
"""

from __future__ import annotations

import json

from sqlalchemy import Engine, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError

from agenthorizon.app.schema import jobs

QUEUE_FOR_KIND = {"run": "judge", "ingest": "trusted", "index": "trusted", "materialize": "trusted", "score": "trusted",
                  "export": "trusted"}


def enqueue(engine: Engine, kind: str, payload: dict, *, created_by: str | None, dedupe_key: str | None = None,
            priority: int = 100, max_attempts: int = 3) -> tuple[int, bool]:
    """Returns (job_id, created). An active job with the same dedupe key is returned instead of a duplicate."""
    queue = QUEUE_FOR_KIND[kind]
    try:
        with engine.begin() as c:
            jid = c.execute(insert(jobs).values(queue=queue, kind=kind, payload=payload, priority=priority,
                                                dedupe_key=dedupe_key, max_attempts=max_attempts, created_by=created_by)
                            .returning(jobs.c.job_id)).scalar_one()
            c.execute(text("SELECT pg_notify('ah_jobs', :q)"), {"q": queue})
            return jid, True
    except IntegrityError:
        with engine.connect() as c:
            jid = c.execute(select(jobs.c.job_id).where((jobs.c.dedupe_key == dedupe_key)
                                                        & jobs.c.status.in_(["queued", "running"]))).scalar_one()
            return jid, False


CLAIM_SQL = text("""
UPDATE jobs SET status = 'running', lease_owner = :w, lease_expires_at = now() + make_interval(secs => :lease),
       attempts = attempts + 1, started_at = coalesce(started_at, now()), updated_at = now()
WHERE job_id = (
    SELECT job_id FROM jobs
    WHERE queue = :q AND attempts < max_attempts AND cancel_requested = false
      AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
    ORDER BY priority, job_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1)
RETURNING job_id, kind, payload, attempts, max_attempts, created_by
""")

EXPIRE_SQL = text("""
UPDATE jobs SET status = 'failed', finished_at = now(), updated_at = now(),
       last_error = coalesce(last_error, '') || 'lease expired after the final allowed attempt; '
WHERE status = 'running' AND lease_expires_at < now() AND attempts >= max_attempts
RETURNING job_id
""")

CANCEL_QUEUED_SQL = text("""
UPDATE jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
WHERE cancel_requested = true AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
RETURNING job_id
""")


def claim(engine: Engine, queue: str, worker_id: str, lease_s: float = 60.0) -> dict | None:
    with engine.begin() as c:
        c.execute(EXPIRE_SQL)
        c.execute(CANCEL_QUEUED_SQL)
        r = c.execute(CLAIM_SQL, {"w": worker_id, "lease": lease_s, "q": queue}).mappings().first()
        return dict(r) if r else None


def heartbeat(engine: Engine, job_id: int, worker_id: str, lease_s: float = 60.0) -> dict:
    """Extend the lease. Returns {"owner": bool, "cancel_requested": bool}."""
    with engine.begin() as c:
        r = c.execute(text("UPDATE jobs SET lease_expires_at = now() + make_interval(secs => :lease), updated_at = now() "
                           "WHERE job_id = :j AND lease_owner = :w AND status = 'running' RETURNING cancel_requested"),
                      {"lease": lease_s, "j": job_id, "w": worker_id}).first()
    return {"owner": r is not None, "cancel_requested": bool(r and r[0])}


def complete(engine: Engine, job_id: int, worker_id: str, result: dict, status: str = "succeeded") -> bool:
    with engine.begin() as c:
        r = c.execute(update(jobs).where((jobs.c.job_id == job_id) & (jobs.c.lease_owner == worker_id)
                                         & (jobs.c.status == "running"))
                      .values(status=status, result=json.loads(json.dumps(result, default=str)), finished_at=text("now()"),
                              updated_at=text("now()"), lease_expires_at=None).returning(jobs.c.job_id)).first()
    return r is not None


def fail(engine: Engine, job_id: int, worker_id: str, error: str, *, retryable: bool) -> str:
    with engine.begin() as c:
        row = c.execute(select(jobs.c.attempts, jobs.c.max_attempts).where(jobs.c.job_id == job_id)).first()
        final = (not retryable) or (row is not None and row[0] >= row[1])
        new = "failed" if final else "queued"
        c.execute(update(jobs).where((jobs.c.job_id == job_id) & (jobs.c.lease_owner == worker_id))
                  .values(status=new, last_error=error[-8000:], lease_owner=None, lease_expires_at=None,
                          finished_at=text("now()") if final else None, updated_at=text("now()")))
        return new


def request_cancel(engine: Engine, job_id: int) -> None:
    with engine.begin() as c:
        c.execute(update(jobs).where(jobs.c.job_id == job_id).values(cancel_requested=True, updated_at=text("now()")))
        c.execute(text("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE job_id = :j AND status = 'queued'"),
                  {"j": job_id})


def get(engine: Engine, job_id: int) -> dict | None:
    with engine.connect() as c:
        r = c.execute(select(jobs).where(jobs.c.job_id == job_id)).mappings().first()
        return dict(r) if r else None
