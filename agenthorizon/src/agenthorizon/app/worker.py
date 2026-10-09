"""Worker processes: ``judge`` (runs; ah_worker role; provider credentials) and ``trusted`` (ingest, index,
materialize, score, export; ah_scorer role; no provider credentials).

Each claimed job is held under a lease extended by a heartbeat thread. If the job is cancelled while running, the
heartbeat forwards the cancel to the run (running attempts stop; history is kept). A worker that dies simply stops
heartbeating: the lease expires and another worker re-claims the job, which resumes idempotently.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import traceback
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Engine, delete, insert

from agenthorizon.app import jobs as J
from agenthorizon.app.schema import exports, score_item_outcomes, score_reports
from agenthorizon.config import Settings
from agenthorizon.util.hashing import digest_json
from agenthorizon.util.io import utcnow_iso


@dataclass
class WorkerContext:
    settings: Settings
    engine: Engine  # this worker's identity (ah_worker or ah_scorer)
    worker_id: str
    secrets_env: dict | None = None  # judge credentials (judge queue only); None = process environment
    judge_kw: dict | None = None  # test hooks (e.g. replay binary override / injected provider)


Handler = Callable[[dict, WorkerContext, threading.Event], dict]


# ---- handlers -------------------------------------------------------------------------------------------------
def handle_run(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    from agenthorizon.app.runstore import PgRunStore
    from agenthorizon.data.dataset import DatasetVersion
    from agenthorizon.data.media import LocalMediaStore
    from agenthorizon.runs.judges import build_judge, estimate_items, load_secrets, required_secret_names
    from agenthorizon.runs.orchestrator import Orchestrator, RunControls
    from agenthorizon.runs.policy import POLICIES
    from agenthorizon.runs.pricing import price_for, route_cost_basis

    p = job["payload"]
    s = ctx.settings
    store = PgRunStore(ctx.engine, p["run_id"], s.runs_dir)
    d = store.definition()
    dv = DatasetVersion(s.datasets_dir / d.dataset_version_id)
    j = d.judge
    secrets, missing = load_secrets(required_secret_names(j["interface"], j["route"]), ctx.secrets_env)
    if missing:
        store.set_status("paused", f"blocked: missing credential(s) {missing} in the judge worker environment")
        return {"status": "paused", "reason": "missing credentials", "missing": missing}
    override = p.get("price_override")
    price = price_for(j["route"], j["provider_model_id"], override)
    metered = route_cost_basis(j["route"], price).get("metered", True)
    est = estimate_items(d, dv, override)
    controls = RunControls(concurrency=p.get("concurrency", 2), budget_usd=p.get("budget_usd"), metered=metered,
                           max_new_tasks=p.get("max_tasks"))
    judge = build_judge(d, dv, LocalMediaStore(s.media_dir), secrets, **(ctx.judge_kw or {}))
    orch = Orchestrator(store, judge, POLICIES[d.attempt_policy["policy_id"]], controls=controls,
                        item_cost={i["example_id"]: i["cost_usd"] for i in est["items"]}, price=price, worker_id=ctx.worker_id)

    def relay_cancel():
        cancel.wait()
        if not orch.stop.is_set():
            store.request("cancel", by="job-cancel")

    threading.Thread(target=relay_cancel, daemon=True).start()
    summary = orch.run()
    return {k: v for k, v in summary.items() if k != "tasks"}


def handle_doctor(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    """Capability report measured in this judge worker's own environment: harness installs, isolation, credential
    NAMES and route egress belong to the process that executes runs, not to the API. No model is called."""
    from agenthorizon.judging.doctor import doctor

    p = job["payload"]
    rep = doctor(environ=ctx.secrets_env, probe_network=bool(p.get("network", True)), live=False,
                 base_urls=p.get("base_urls"))
    return {**rep, "measured_by": ctx.worker_id}


def handle_index(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    from agenthorizon.app.indexer import index_dataset_version
    from agenthorizon.data.dataset import DatasetVersion, PrivateStore

    dvid = job["payload"]["dataset_version_id"]
    dv = DatasetVersion(ctx.settings.datasets_dir / dvid)
    return index_dataset_version(ctx.engine, dv, PrivateStore(ctx.settings.private_dir, dvid))


def handle_ingest(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    from pathlib import Path

    from agenthorizon.data.ingest import IngestOptions, ingest
    from agenthorizon.sources.hf import HFError

    p = job["payload"]
    opts = IngestOptions(source=p.get("source", "hf"), revision=p.get("revision", "main"),
                         local_dir=Path(p["local_dir"]) if p.get("local_dir") else None, media=p.get("media", "none"))
    try:
        r = ingest(ctx.settings, opts)
    except HFError as exc:
        return {"status": "blocked", "kind": exc.kind, "detail": str(exc)}
    out = handle_index({"payload": {"dataset_version_id": r.dataset_version_id}}, ctx, cancel)
    return {"status": r.status, "dataset_version_id": r.dataset_version_id, "summary": r.summary, "index": out}


def handle_materialize(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    from agenthorizon.app.indexer import refresh_media_counts
    from agenthorizon.data.dataset import DatasetVersion
    from agenthorizon.data.materialize import materialize_media, media_coverage

    p = job["payload"]
    dv = DatasetVersion(ctx.settings.datasets_dir / p["dataset_version_id"])
    out = materialize_media(ctx.settings, dv, recording_id=p.get("recording_id"), limit=p.get("limit"))
    refresh_media_counts(ctx.engine, dv)
    return {"result": out, "coverage": media_coverage(dv)}


def score_run(ctx: WorkerContext, run_id: str, manifest_id: str | None, created_by: str | None) -> dict:
    from agenthorizon.app.runstore import PgRunStore
    from agenthorizon.data.dataset import DatasetVersion, PrivateStore
    from agenthorizon.scoring.protocol import SCORER_ID, score, score_with_selection

    store = PgRunStore(ctx.engine, run_id, ctx.settings.runs_dir)
    d = store.definition()
    mid = manifest_id or d.scoring_manifest_id or d.selection.get("manifest_id")
    if not mid:
        raise ValueError("this run has no scoring manifest; give one explicitly")
    dv = DatasetVersion(ctx.settings.datasets_dir / d.dataset_version_id)
    sm = PrivateStore(ctx.settings.private_dir, dv.id).scoring_manifest(dv.manifest(mid))
    ps = store.prediction_set(dv.example_ids())
    sel = set(d.example_ids) & {i.example_id for i in sm.items}
    if sel != {i.example_id for i in sm.items}:
        both = score_with_selection(sm, ps, sel)
        rep = both["canonical_full_manifest"]
        sub = both["selection_subset"]
        sub.pop("_per_item_outcome", None)
        rep["selection_subset"] = sub
    else:
        rep = score(sm, ps)
    per_item = rep.pop("_per_item_outcome", {})
    rep["run_id"] = run_id
    rep["result_kind"] = d.classification.get("result_kind")
    if dv.synthetic:
        rep["warning"] = "SYNTHETIC FIXTURE dataset — not a benchmark result"
    with ctx.engine.begin() as c:
        sid = c.execute(insert(score_reports).values(run_id=run_id, manifest_id=mid, dataset_version_id=dv.id,
                                                     scorer_id=SCORER_ID, report=json.loads(json.dumps(rep, default=str)),
                                                     report_digest=rep.get("report_digest") or digest_json(rep),
                                                     created_by=created_by).returning(score_reports.c.score_id)).scalar_one()
        c.execute(delete(score_item_outcomes).where(score_item_outcomes.c.score_id == sid))
        rows = [{"score_id": sid, "example_id": e, "outcome": o} for e, o in sorted(per_item.items())]
        for i in range(0, len(rows), 2000):
            c.execute(insert(score_item_outcomes), rows[i:i + 2000])
    return {"score_id": sid, "manifest_id": mid, "balanced_accuracy": rep["metrics"]["balanced_accuracy"]}


def handle_score(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    p = job["payload"]
    return score_run(ctx, p["run_id"], p.get("manifest_id"), job.get("created_by"))


def handle_export(job: dict, ctx: WorkerContext, cancel: threading.Event) -> dict:
    from agenthorizon.app.runstore import PgRunStore
    from agenthorizon.runs.export import build_bundle, write_tar_gz
    from agenthorizon.scoring.report import render_markdown

    p = job["payload"]
    store = PgRunStore(ctx.engine, p["run_id"], ctx.settings.runs_dir)
    rep = md = None
    if p.get("with_score"):
        from sqlalchemy import select

        with ctx.engine.connect() as c:
            row = c.execute(select(score_reports.c.report).where(score_reports.c.run_id == p["run_id"])
                            .order_by(score_reports.c.score_id.desc()).limit(1)).first()
        if row is None:
            score_run(ctx, p["run_id"], None, job.get("created_by"))
            with ctx.engine.connect() as c:
                row = c.execute(select(score_reports.c.report).where(score_reports.c.run_id == p["run_id"])
                                .order_by(score_reports.c.score_id.desc()).limit(1)).first()
        rep = row[0]
        md = render_markdown(rep)
    files, man = build_bundle(ctx.settings, store, score_report=rep, score_markdown=md,
                              include_artifacts=bool(p.get("include_artifacts")))
    out = ctx.settings.exports_dir / f"{p['run_id']}-{job['job_id']}.tar.gz"
    sha = write_tar_gz(files, out)
    with ctx.engine.begin() as c:
        eid = c.execute(insert(exports).values(run_id=p["run_id"], path=str(out), sha256=sha, with_score=bool(p.get("with_score")),
                                               manifest=man, created_by=job.get("created_by"))
                        .returning(exports.c.export_id)).scalar_one()
    return {"export_id": eid, "sha256": sha, "files": len(man["files"])}


HANDLERS: dict[str, Handler] = {"run": handle_run, "doctor": handle_doctor, "index": handle_index, "ingest": handle_ingest,
                                "materialize": handle_materialize, "score": handle_score, "export": handle_export}


# ---- loop ------------------------------------------------------------------------------------------------------------
def default_worker_id(queue: str) -> str:
    return f"{queue}@{socket.gethostname()}:{os.getpid()}"


def process_one(ctx: WorkerContext, queue: str, *, lease_s: float = 60.0) -> dict | None:
    job = J.claim(ctx.engine, queue, ctx.worker_id, lease_s)
    if job is None:
        return None
    cancel = threading.Event()
    stop_hb = threading.Event()

    def beat():
        while not stop_hb.wait(max(1.0, lease_s / 3)):
            hb = J.heartbeat(ctx.engine, job["job_id"], ctx.worker_id, lease_s)
            if hb["cancel_requested"] or not hb["owner"]:
                cancel.set()

    hb_thread = threading.Thread(target=beat, daemon=True)
    hb_thread.start()
    try:
        result = HANDLERS[job["kind"]](job, ctx, cancel)
        status = "cancelled" if cancel.is_set() else "succeeded"
        J.complete(ctx.engine, job["job_id"], ctx.worker_id, {**result, "finished_at": utcnow_iso()}, status=status)
        return {"job_id": job["job_id"], "status": status, "result": result}
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[-6000:]}"
        new = J.fail(ctx.engine, job["job_id"], ctx.worker_id, err, retryable=not isinstance(exc, (ValueError, KeyError)))
        return {"job_id": job["job_id"], "status": new, "error": str(exc)}
    finally:
        stop_hb.set()
        hb_thread.join(timeout=5)


def presence_info(queue: str, environ: dict | None = None) -> dict:
    """What a worker can do — credential NAMES only (never values), harness versions, isolation."""
    if queue != "judge":
        return {}
    from agenthorizon.judging.harnesses import ADAPTERS
    from agenthorizon.judging.isolation.sandbox import isolation_available
    from agenthorizon.runs.judges import ROUTE_SECRETS, load_secrets

    names = sorted({n for ns in ROUTE_SECRETS.values() for n in ns})
    present, _ = load_secrets(names, environ)
    iso_ok, iso_detail = isolation_available()
    return {"credentials": sorted(k for k in present if k in names),
            "harness": {k: {"version": a.version()} for k, a in ADAPTERS.items()},
            "isolation": {"ok": iso_ok, "detail": iso_detail}}


def update_presence(ctx: WorkerContext, queue: str, info: dict) -> None:
    from sqlalchemy import func
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from agenthorizon.app.schema import workers

    with ctx.engine.begin() as c:
        c.execute(pg_insert(workers).values(worker_id=ctx.worker_id, queue=queue, info=info)
                  .on_conflict_do_update(index_elements=["worker_id"], set_={"info": info, "last_seen": func.now()}))


def run_worker(ctx: WorkerContext, queue: str, stop: threading.Event, *, poll_s: float = 1.0, lease_s: float = 60.0,
               log=print) -> None:
    import time

    log(f"[worker {ctx.worker_id}] queue={queue}")
    info = presence_info(queue, ctx.secrets_env)
    last_presence = 0.0
    while not stop.is_set():
        if time.monotonic() - last_presence > 15:
            update_presence(ctx, queue, info)
            last_presence = time.monotonic()
        r = process_one(ctx, queue, lease_s=lease_s)
        if r is None:
            stop.wait(poll_s)
        else:
            log(f"[worker {ctx.worker_id}] job {r['job_id']} -> {r['status']}")
