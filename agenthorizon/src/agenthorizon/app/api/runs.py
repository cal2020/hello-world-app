"""Run routes: plan (dry run), create, monitor, events (SSE), control, scoring, exports, comparison."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, select, text

from agenthorizon.app import jobs as J
from agenthorizon.app.api.auth import Principal, audit, require
from agenthorizon.app.api.common import dec_cursor, enc_cursor, eng, err, idempotent
from agenthorizon.app.runstore import PgRunStore
from agenthorizon.app.schema import exports, jobs, run_attempts, run_finals, runs, score_reports, workers
from agenthorizon.runs.store import RunLocked, RunStoreError

router = APIRouter(prefix="/api")
ARTIFACT_MAX = 4 * 1024 * 1024


class RunConfigIn(BaseModel):
    dataset_version: str
    judge_config: str
    manifest: str | None = None
    example_ids: list[str] | None = None
    smoke_n: int | None = Field(None, ge=1, le=100000)
    scoring_manifest: str | None = None
    provider_model_id: str | None = None
    route: str | None = None
    base_url: str | None = None
    effort: str | None = None
    instructions: str = "rubric-extension"
    preprocessing: str | None = None
    staging_mode: str = Field("paper-paths", pattern="^(paper-paths|opaque-paths)$")
    attempt_policy: str | None = None
    timeout_s: int | None = Field(None, ge=10, le=7200)
    trial: int = Field(1, ge=1, le=1000)
    label: str | None = None


class PriceIn(BaseModel):
    input_per_mtok: float = Field(ge=0)
    output_per_mtok: float = Field(ge=0)
    source: str = Field(min_length=3)


class RunCreateIn(BaseModel):
    config: RunConfigIn
    budget_usd: float | None = Field(None, ge=0)
    concurrency: int = Field(2, ge=1, le=64)
    max_tasks: int | None = Field(None, ge=1)
    price_override: PriceIn | None = None


class ResumeIn(BaseModel):
    budget_usd: float | None = Field(None, ge=0)
    concurrency: int = Field(2, ge=1, le=64)
    max_tasks: int | None = Field(None, ge=1)


class ScoreIn(BaseModel):
    manifest_id: str | None = None


class ExportIn(BaseModel):
    with_score: bool = False
    include_artifacts: bool = False


def worker_caps(engine) -> dict:
    cutoff = datetime.now(UTC) - timedelta(seconds=90)
    with engine.connect() as c:
        rows = c.execute(select(workers.c.worker_id, workers.c.info).where(and_(workers.c.queue == "judge",
                                                                               workers.c.last_seen > cutoff))).all()
    creds: set[str] = set()
    harness: dict = {}
    iso = {"ok": False, "detail": "no live judge worker"}
    for _wid, info in rows:
        creds |= set(info.get("credentials", []))
        for k, v in (info.get("harness") or {}).items():
            harness.setdefault(k, v)
        if (info.get("isolation") or {}).get("ok"):
            iso = info["isolation"]
    return {"workers": [r[0] for r in rows], "credentials": sorted(creds), "harness": harness, "isolation": iso}


def _resolve(request: Request, cfg: RunConfigIn, budget: float | None, price: PriceIn | None):
    from agenthorizon.data.dataset import DatasetNotFound
    from agenthorizon.runs.plan import PlanError, RunConfig, preflight, resolve

    s = request.app.state.settings
    rc = RunConfig(**{k: v for k, v in cfg.model_dump().items() if k != "label"}, label=cfg.label)
    try:
        definition, info = resolve(s, rc)
    except (PlanError, DatasetNotFound, KeyError, ValueError) as exc:
        raise err(422, "invalid_config", str(exc)) from exc
    override = price.model_dump() if price else None
    plan = preflight(s, definition, info["dataset_version"], info["problems"], budget_usd=budget, price_override=override,
                     worker_caps=worker_caps(eng(request)))
    return definition, plan, override


@router.post("/runs/plan")
def plan_run(body: RunCreateIn, request: Request, p: Principal = Depends(require("runs.write"))):
    _, plan, _ = _resolve(request, body.config, body.budget_usd, body.price_override)
    return plan


@router.post("/runs", status_code=202)
def create_run(body: RunCreateIn, request: Request, p: Principal = Depends(require("runs.write"))):
    def produce():
        definition, plan, override = _resolve(request, body.config, body.budget_usd, body.price_override)
        if not plan["ready_for_live_run"]:
            return 409, {"error": {"code": "not_ready", "message": "run not executable; see plan.blocked"}, "plan": plan}
        store, created = PgRunStore.create_or_open(eng(request), request.app.state.settings.runs_dir, definition,
                                                   {"budget_usd": body.budget_usd, "concurrency": body.concurrency},
                                                   created_by=p.user_id, plan=plan, label=body.config.label)
        jid, new_job = J.enqueue(eng(request), "run", {"run_id": store.run_id, "budget_usd": body.budget_usd,
                                                        "concurrency": body.concurrency, "max_tasks": body.max_tasks,
                                                        "price_override": override},
                                 created_by=p.user_id, dedupe_key=f"run:{store.run_id}", max_attempts=5)
        audit(eng(request), p, "run.create" if created else "run.resume", store.run_id,
              {"job_id": jid, "budget_usd": body.budget_usd}, request.state.request_id)
        return 202, {"run_id": store.run_id, "created": created, "job_id": jid, "job_created": new_job,
                     "classification": definition.classification}
    return idempotent(request, p.user_id, body.model_dump(), produce)


def _run_row(c, run_id: str) -> dict:
    r = c.execute(select(runs).where(runs.c.run_id == run_id)).mappings().first()
    if r is None:
        raise err(404, "not_found", f"run {run_id} not found")
    return dict(r)


@router.get("/runs")
def list_runs(request: Request, cursor: str | None = None, limit: int = Query(50, ge=1, le=200),
              p: Principal = Depends(require("runs.read"))):
    after = dec_cursor(cursor)
    q = select(runs.c.run_id, runs.c.status, runs.c.config_id, runs.c.dataset_version_id, runs.c.result_kind, runs.c.n_tasks,
               runs.c.label, runs.c.created_at, runs.c.updated_at, runs.c.pause_reason, runs.c.created_by,
               runs.c.definition["trial"].label("trial"))
    if after:
        q = q.where(runs.c.created_at < datetime.fromisoformat(after["t"]))
    with eng(request).connect() as c:
        rows = c.execute(q.order_by(runs.c.created_at.desc()).limit(limit + 1)).mappings().all()
    items = [{**dict(r), "created_at": r["created_at"].isoformat(), "updated_at": r["updated_at"].isoformat()} for r in rows[:limit]]
    return {"items": items, "next_cursor": enc_cursor({"t": items[-1]["created_at"]}) if len(rows) > limit else None}


TASK_STATE_SQL = text("""
WITH ids AS (SELECT jsonb_array_elements_text(definition->'selection'->'example_ids') AS eid FROM runs WHERE run_id = :r),
last AS (SELECT DISTINCT ON (example_id) example_id, status FROM run_attempts WHERE run_id = :r
         ORDER BY example_id, attempt_no DESC),
fin AS (SELECT f.example_id, f.final, a.outcome->'verdict'->>'binary_valid' AS valid
        FROM run_finals f LEFT JOIN run_attempts a ON a.run_id = f.run_id AND a.example_id = f.example_id
             AND a.attempt_no = (f.final->>'selected_attempt')::int
        WHERE f.run_id = :r AND f.final IS NOT NULL)
SELECT ids.eid AS example_id,
  CASE WHEN fin.final IS NOT NULL THEN
         CASE WHEN (fin.final->>'has_response') = 'true' AND fin.valid = 'true' THEN 'completed'
              WHEN (fin.final->>'has_response') = 'true' THEN 'invalid'
              ELSE 'missing' END
       WHEN last.status = 'running' THEN 'running'
       WHEN last.status = 'cancelled' THEN 'cancelled'
       WHEN last.status = 'blocked' THEN 'blocked'
       WHEN last.status IS NOT NULL THEN 'pending_retry'
       ELSE 'queued' END AS state,
  fin.final->>'final_class' AS final_class
FROM ids LEFT JOIN last ON last.example_id = ids.eid LEFT JOIN fin ON fin.example_id = ids.eid
""")


@router.get("/runs/{run_id}")
def run_detail(run_id: str, request: Request, p: Principal = Depends(require("runs.read"))):
    with eng(request).connect() as c:
        r = _run_row(c, run_id)
        states = c.execute(TASK_STATE_SQL, {"r": run_id}).mappings().all()
        att = c.execute(text("""
            SELECT count(*) AS attempts,
                   count(*) FILTER (WHERE status = 'running') AS running,
                   count(*) FILTER (WHERE outcome->'telemetry'->'coverage'->>'input_tokens' = 'reported') AS tokens_reported,
                   count(*) FILTER (WHERE outcome->'telemetry'->'coverage'->>'images_viewed' IN ('reported','estimated')) AS images_reported,
                   count(*) FILTER (WHERE outcome->'telemetry'->'coverage'->>'cost_billed_usd' = 'reported') AS cost_reported,
                   sum((outcome->'telemetry'->>'input_tokens')::bigint) AS input_tokens,
                   sum((outcome->'telemetry'->>'output_tokens')::bigint) AS output_tokens,
                   sum((outcome->'telemetry'->>'wall_time_s')::float) AS wall_time_s
            FROM run_attempts WHERE run_id = :r AND status <> 'running'"""), {"r": run_id}).mappings().first()
        jrows = c.execute(select(jobs.c.job_id, jobs.c.status, jobs.c.attempts, jobs.c.last_error, jobs.c.created_at,
                                 jobs.c.started_at, jobs.c.finished_at, jobs.c.lease_owner)
                          .where(and_(jobs.c.kind == "run", jobs.c.payload["run_id"].astext == run_id))
                          .order_by(jobs.c.job_id.desc()).limit(10)).mappings().all()
    counts: dict[str, int] = {}
    classes: dict[str, int] = {}
    for s in states:
        counts[s["state"]] = counts.get(s["state"], 0) + 1
        if s["final_class"]:
            classes[s["final_class"]] = classes.get(s["final_class"], 0) + 1
    d = r["definition"]
    started = next((h["at"] for h in r["status_history"] if h["status"] == "running"), None)
    done = sum(counts.get(k, 0) for k in ("completed", "invalid", "missing"))
    return {
        "run_id": run_id, "status": r["status"], "pause_reason": r["pause_reason"], "label": r["label"],
        "created_at": r["created_at"].isoformat(), "updated_at": r["updated_at"].isoformat(), "created_by": r["created_by"],
        "status_history": r["status_history"], "controls": r["controls"], "budget": r["budget"],
        "control_requests": r["control_requests"], "definition": d, "plan": r["plan"],
        "task_states": counts, "final_classes": classes, "n_tasks": r["n_tasks"], "finalized": done,
        "coverage": {"finalized_fraction": done / r["n_tasks"] if r["n_tasks"] else None,
                     "note": "the canonical full-manifest score counts every unfinished or missing item as an error"},
        "telemetry": {k: att[k] for k in att.keys()}, "first_started_at": started, "jobs": [
            {**dict(j), **{k: (j[k].isoformat() if j[k] else None) for k in ("created_at", "started_at", "finished_at")}}
            for j in jrows],
        "scoring_manifest_id": d.get("scoring_manifest_id") or d["selection"].get("manifest_id"),
    }


@router.get("/runs/{run_id}/tasks")
def run_tasks(run_id: str, request: Request, state: str | None = None, cursor: str | None = None,
              limit: int = Query(100, ge=1, le=500), p: Principal = Depends(require("runs.read"))):
    after = (dec_cursor(cursor) or {}).get("id", "")
    with eng(request).connect() as c:
        _run_row(c, run_id)
        rows = [dict(r) for r in c.execute(TASK_STATE_SQL, {"r": run_id}).mappings().all()]
    rows = sorted((r for r in rows if (state is None or r["state"] == state) and r["example_id"] > after),
                  key=lambda r: r["example_id"])
    page = rows[:limit]
    return {"items": page, "next_cursor": enc_cursor({"id": page[-1]["example_id"]}) if len(rows) > limit else None}


@router.get("/runs/{run_id}/tasks/{example_id}")
def run_task(run_id: str, example_id: str, request: Request, p: Principal = Depends(require("runs.read"))):
    with eng(request).connect() as c:
        _run_row(c, run_id)
        att = c.execute(select(run_attempts).where(and_(run_attempts.c.run_id == run_id, run_attempts.c.example_id == example_id))
                        .order_by(run_attempts.c.attempt_no)).mappings().all()
        fin = c.execute(select(run_finals).where(and_(run_finals.c.run_id == run_id, run_finals.c.example_id == example_id))
                        ).mappings().first()
    return {"example_id": example_id, "attempts": [dict(a) for a in att],
            "final": fin["final"] if fin else None, "superseded": fin["superseded"] if fin else []}


@router.get("/runs/{run_id}/artifact")
def run_artifact(run_id: str, path: str, request: Request, p: Principal = Depends(require("runs.read"))):
    base = (request.app.state.settings.runs_dir / run_id).resolve()
    target = (base / path).resolve()
    if base not in target.parents or "workspace" in target.relative_to(base).parts or "home" in target.relative_to(base).parts:
        raise err(400, "bad_path", "artifact path outside the run's artifact area")
    if not target.is_file():
        raise err(404, "not_found", "artifact not found")
    data = target.read_bytes()[:ARTIFACT_MAX]
    return PlainTextResponse(data.decode("utf-8", errors="replace"),
                             headers={"Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff",
                                      "X-Truncated": str(target.stat().st_size > ARTIFACT_MAX).lower()})


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request, last_event_id: str | None = Header(None),
                     after: int = Query(0, ge=0), p: Principal = Depends(require("runs.read"))):
    store = PgRunStore(eng(request), run_id, request.app.state.settings.runs_dir)
    if not await run_in_threadpool(store.exists):
        raise err(404, "not_found", f"run {run_id} not found")
    start = int(last_event_id) if last_event_id and last_event_id.isdigit() else after

    async def gen():
        cur, idle = start, 0.0
        yield "retry: 2000\n\n"
        while not await request.is_disconnected():
            evs = await run_in_threadpool(store.events, cur, 500)
            for e in evs:
                cur = e["seq"]
                yield f"id: {cur}\nevent: {e['type']}\ndata: {json.dumps(e, default=str)}\n\n"
            if not evs:
                idle += 0.5
                if idle >= 15:
                    idle = 0.0
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.5)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _active_run_job(c, run_id: str):
    return c.execute(select(jobs.c.job_id).where(and_(jobs.c.kind == "run", jobs.c.payload["run_id"].astext == run_id,
                                                      jobs.c.status.in_(["queued", "running"])))).scalar()


@router.post("/runs/{run_id}/pause")
def pause_run(run_id: str, request: Request, p: Principal = Depends(require("runs.write"))):
    store = PgRunStore(eng(request), run_id, request.app.state.settings.runs_dir)
    with eng(request).connect() as c:
        _run_row(c, run_id)
    store.request("pause", by=p.user_id)
    audit(eng(request), p, "run.pause", run_id, None, request.state.request_id)
    return {"run_id": run_id, "requested": "pause"}


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, request: Request, p: Principal = Depends(require("runs.write"))):
    store = PgRunStore(eng(request), run_id, request.app.state.settings.runs_dir)
    with eng(request).connect() as c:
        _run_row(c, run_id)
        jid = _active_run_job(c, run_id)
    store.request("cancel", by=p.user_id)
    if jid:
        J.request_cancel(eng(request), jid)
    audit(eng(request), p, "run.cancel", run_id, {"job_id": jid}, request.state.request_id)
    return {"run_id": run_id, "requested": "cancel", "job_id": jid}


@router.post("/runs/{run_id}/resume", status_code=202)
def resume_run(run_id: str, body: ResumeIn, request: Request, p: Principal = Depends(require("runs.write"))):
    with eng(request).connect() as c:
        r = _run_row(c, run_id)
    if r["status"] == "completed":
        raise err(409, "completed", "run already completed")
    plan = r["plan"] or {}
    metered = ((plan.get("checks") or {}).get("cost") or {}).get("basis", {}).get("metered", True)
    if metered and body.budget_usd is None:
        raise err(422, "budget_required", "a paid route needs an explicit budget to resume")
    jid, created = J.enqueue(eng(request), "run", {"run_id": run_id, "budget_usd": body.budget_usd,
                                                   "concurrency": body.concurrency, "max_tasks": body.max_tasks},
                             created_by=p.user_id, dedupe_key=f"run:{run_id}", max_attempts=5)
    audit(eng(request), p, "run.resume", run_id, {"job_id": jid}, request.state.request_id)
    return {"run_id": run_id, "job_id": jid, "job_created": created}


@router.post("/runs/{run_id}/retry-errors")
def retry_errors_route(run_id: str, request: Request, reason: str = Query(..., min_length=3),
                       p: Principal = Depends(require("runs.write"))):
    from agenthorizon.runs.orchestrator import retry_errors
    from agenthorizon.runs.policy import POLICIES

    store = PgRunStore(eng(request), run_id, request.app.state.settings.runs_dir)
    with eng(request).connect() as c:
        _run_row(c, run_id)
        if _active_run_job(c, run_id):
            raise err(409, "run_active", "pause or wait for the run job to finish first")
    try:
        ids = retry_errors(store, POLICIES[store.definition().attempt_policy["policy_id"]], by=p.user_id, reason=reason)
    except RunLocked as exc:
        raise err(409, "run_active", str(exc)) from exc
    audit(eng(request), p, "run.retry_errors", run_id, {"reopened": ids, "reason": reason}, request.state.request_id)
    return {"run_id": run_id, "reopened": ids}


@router.post("/runs/{run_id}/score", status_code=202)
def score_run(run_id: str, body: ScoreIn, request: Request, p: Principal = Depends(require("scores.write"))):
    with eng(request).connect() as c:
        _run_row(c, run_id)
    jid, created = J.enqueue(eng(request), "score", {"run_id": run_id, "manifest_id": body.manifest_id},
                             created_by=p.user_id, dedupe_key=f"score:{run_id}:{body.manifest_id or ''}", max_attempts=2)
    return {"job_id": jid, "job_created": created}


@router.get("/runs/{run_id}/scores")
def run_scores(run_id: str, request: Request, p: Principal = Depends(require("scores.read"))):
    with eng(request).connect() as c:
        rows = c.execute(select(score_reports).where(score_reports.c.run_id == run_id)
                         .order_by(score_reports.c.score_id.desc())).mappings().all()
    return {"items": [{**dict(r), "created_at": r["created_at"].isoformat()} for r in rows]}


@router.post("/runs/{run_id}/exports", status_code=202)
def export_run(run_id: str, body: ExportIn, request: Request, p: Principal = Depends(require("exports.write"))):
    with eng(request).connect() as c:
        _run_row(c, run_id)
    jid, created = J.enqueue(eng(request), "export", {"run_id": run_id, **body.model_dump()}, created_by=p.user_id,
                             dedupe_key=f"export:{run_id}:{body.with_score}:{body.include_artifacts}", max_attempts=2)
    return {"job_id": jid, "job_created": created}


@router.get("/runs/{run_id}/exports")
def run_exports(run_id: str, request: Request, p: Principal = Depends(require("runs.read"))):
    with eng(request).connect() as c:
        rows = c.execute(select(exports.c.export_id, exports.c.sha256, exports.c.with_score, exports.c.created_at,
                                exports.c.created_by).where(exports.c.run_id == run_id)
                         .order_by(exports.c.export_id.desc())).mappings().all()
    return {"items": [{**dict(r), "created_at": r["created_at"].isoformat(),
                       "download_url": f"/api/exports/{r['export_id']}/download"} for r in rows]}


@router.get("/exports/{export_id}/download")
def download_export(export_id: int, request: Request, p: Principal = Depends(require("runs.read"))):
    with eng(request).connect() as c:
        r = c.execute(select(exports).where(exports.c.export_id == export_id)).mappings().first()
    if r is None or not r["path"]:
        raise err(404, "not_found", "export not found")
    if r["with_score"] and not p.can("research.labels"):
        raise err(403, "forbidden", "bundles with score reports carry label-derived outcomes")
    return FileResponse(r["path"], media_type="application/gzip", filename=f"{r['run_id']}-{export_id}.tar.gz")


@router.get("/jobs/{job_id}")
def job_status(job_id: int, request: Request, p: Principal = Depends(require("runs.read"))):
    j = J.get(eng(request), job_id)
    if j is None:
        raise err(404, "not_found", "job not found")
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in j.items() if k != "payload"} | \
        {"payload": {k: v for k, v in j["payload"].items() if k != "price_override"}}


PROTOCOL_FIELDS = (("judge", "config_id"), ("judge", "provider_model_id"), ("judge", "route"), ("judge", "effort"),
                   ("judge", "harness"), ("judge", "sampling"), ("prompt", "prompt_id"), ("instructions", "prompt_id"),
                   ("preprocessing", "preprocessing_id"), ("attempt_policy", "policy_id"), ("staging_mode", None),
                   ("execution", "isolation"), ("dataset_version_id", None), ("scoring_manifest_id", None))


def protocol_diff(a: dict, b: dict) -> list[dict]:
    out = []
    for top, sub in PROTOCOL_FIELDS:
        va, vb = a.get(top), b.get(top)
        if sub:
            va = (va or {}).get(sub) if isinstance(va, dict) or va is None else va
            vb = (vb or {}).get(sub) if isinstance(vb, dict) or vb is None else vb
        if va != vb:
            out.append({"field": f"{top}.{sub}" if sub else top, "a": va, "b": vb})
    if sorted(a["selection"]["example_ids"]) != sorted(b["selection"]["example_ids"]):
        out.append({"field": "selection.example_ids", "a": len(a["selection"]["example_ids"]),
                    "b": len(b["selection"]["example_ids"])})
    return out


@router.get("/compare")
def compare(request: Request, runs_: str = Query(..., alias="runs"), p: Principal = Depends(require("scores.read"))):
    ids = [r for r in runs_.split(",") if r][:8]
    with eng(request).connect() as c:
        rows = {r["run_id"]: dict(r) for r in c.execute(select(runs).where(runs.c.run_id.in_(ids))).mappings()}
        scores = {}
        for rid in ids:
            s = c.execute(select(score_reports.c.score_id, score_reports.c.report, score_reports.c.manifest_id)
                          .where(score_reports.c.run_id == rid).order_by(score_reports.c.score_id.desc()).limit(1)).first()
            scores[rid] = {"score_id": s[0], "manifest_id": s[2], "report": s[1]} if s else None
    missing = [r for r in ids if r not in rows]
    if missing:
        raise err(404, "not_found", f"unknown runs {missing}")
    base = rows[ids[0]]["definition"]
    return {"runs": [{"run_id": rid, "label": rows[rid]["label"], "status": rows[rid]["status"],
                      "dataset_version_id": rows[rid]["dataset_version_id"],
                      "result_kind": rows[rid]["result_kind"], "config_id": rows[rid]["config_id"], "score": scores[rid],
                      "differences_from_first": protocol_diff(base, rows[rid]["definition"])} for rid in ids],
            "note": "Only runs with no protocol differences (same manifest, prompt, preprocessing, policy) are directly comparable."}


__all__ = ["router", "worker_caps", "protocol_diff", "RunStoreError"]
