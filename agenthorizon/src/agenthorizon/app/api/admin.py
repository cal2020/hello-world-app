"""Operator routes: data jobs, job control, workers, audit log, users, capability refresh."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from agenthorizon.app import jobs as J
from agenthorizon.app.api.auth import ROLES, Principal, audit, create_user, require
from agenthorizon.app.api.common import dec_cursor, enc_cursor, eng, err
from agenthorizon.app.schema import audit_events, jobs, workers

router = APIRouter(prefix="/api/admin")


class IngestIn(BaseModel):
    source: str = Field("hf", pattern="^(hf|local)$")
    revision: str = "main"
    local_dir: str | None = None
    media: str = Field("none", pattern="^(none|all)$")


class MaterializeIn(BaseModel):
    limit: int | None = Field(None, ge=1)
    recording_id: str | None = None


class UserIn(BaseModel):
    user_id: str = Field(pattern=r"^[a-z0-9_.-]{2,64}$")
    role: str
    display_name: str | None = None


def _iso(d: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in d.items()}


@router.post("/datasets/ingest", status_code=202)
def ingest(body: IngestIn, request: Request, p: Principal = Depends(require("data.write"))):
    jid, created = J.enqueue(eng(request), "ingest", body.model_dump(), created_by=p.user_id,
                             dedupe_key=f"ingest:{body.source}:{body.revision}:{body.local_dir}", max_attempts=2)
    audit(eng(request), p, "data.ingest", body.source, body.model_dump(), request.state.request_id)
    return {"job_id": jid, "job_created": created}


@router.post("/datasets/{dv}/materialize", status_code=202)
def materialize(dv: str, body: MaterializeIn, request: Request, p: Principal = Depends(require("data.write"))):
    jid, created = J.enqueue(eng(request), "materialize", {"dataset_version_id": dv, **body.model_dump()},
                             created_by=p.user_id, dedupe_key=f"materialize:{dv}:{body.recording_id or ''}", max_attempts=3)
    audit(eng(request), p, "data.materialize", dv, body.model_dump(), request.state.request_id)
    return {"job_id": jid, "job_created": created}


@router.post("/datasets/{dv}/index", status_code=202)
def index(dv: str, request: Request, p: Principal = Depends(require("data.write"))):
    jid, created = J.enqueue(eng(request), "index", {"dataset_version_id": dv}, created_by=p.user_id,
                             dedupe_key=f"index:{dv}", max_attempts=2)
    return {"job_id": jid, "job_created": created}


@router.get("/jobs")
def list_jobs(request: Request, status: str | None = None, queue: str | None = None, limit: int = Query(100, ge=1, le=500),
              p: Principal = Depends(require("jobs.admin"))):
    q = select(jobs.c.job_id, jobs.c.queue, jobs.c.kind, jobs.c.status, jobs.c.attempts, jobs.c.max_attempts,
               jobs.c.lease_owner, jobs.c.last_error, jobs.c.created_by, jobs.c.created_at, jobs.c.started_at,
               jobs.c.finished_at, jobs.c.result)
    if status:
        q = q.where(jobs.c.status == status)
    if queue:
        q = q.where(jobs.c.queue == queue)
    with eng(request).connect() as c:
        rows = c.execute(q.order_by(jobs.c.job_id.desc()).limit(limit)).mappings().all()
    return {"items": [_iso(dict(r)) for r in rows]}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, request: Request, p: Principal = Depends(require("jobs.admin"))):
    if J.get(eng(request), job_id) is None:
        raise err(404, "not_found", "job not found")
    J.request_cancel(eng(request), job_id)
    audit(eng(request), p, "job.cancel", str(job_id), None, request.state.request_id)
    return {"job_id": job_id, "cancel_requested": True}


@router.get("/workers")
def list_workers(request: Request, p: Principal = Depends(require("jobs.admin"))):
    with eng(request).connect() as c:
        rows = c.execute(select(workers).order_by(workers.c.last_seen.desc())).mappings().all()
    return {"items": [_iso(dict(r)) for r in rows]}


@router.get("/audit")
def audit_log(request: Request, cursor: str | None = None, limit: int = Query(100, ge=1, le=500),
              p: Principal = Depends(require("audit.read"))):
    q = select(audit_events)
    after = dec_cursor(cursor)
    if after:
        q = q.where(audit_events.c.id < after["id"])
    with eng(request).connect() as c:
        rows = c.execute(q.order_by(audit_events.c.id.desc()).limit(limit + 1)).mappings().all()
    items = [_iso(dict(r)) for r in rows[:limit]]
    return {"items": items, "next_cursor": enc_cursor({"id": items[-1]["id"]}) if len(rows) > limit else None}


@router.post("/users", status_code=201)
def add_user(body: UserIn, request: Request, p: Principal = Depends(require("users.admin"))):
    if body.role not in ROLES:
        raise err(422, "bad_role", f"role must be one of {ROLES}")
    tok = create_user(eng(request), body.user_id, body.role, body.display_name, label=f"created by {p.user_id}")
    audit(eng(request), p, "user.create", body.user_id, {"role": body.role}, request.state.request_id)
    return {"user_id": body.user_id, "role": body.role, "token": tok, "note": "shown once; store it securely"}


@router.post("/judges/doctor")
def refresh_capabilities(request: Request, p: Principal = Depends(require("judges.refresh"))):
    from agenthorizon.app.api.catalog import EVIDENCE
    from agenthorizon.judging.doctor import doctor
    from agenthorizon.util.io import atomic_write_json

    rep = doctor(probe_network=True, live=False)
    atomic_write_json(EVIDENCE / "MODEL_CAPABILITIES.json", rep)
    audit(eng(request), p, "judges.doctor", None, rep["counts"], request.state.request_id)
    return rep
