"""Application layer on PostgreSQL: auth/roles, catalogue, run lifecycle through real workers, SSE, review, leases.

Synthetic fixture data and a local fake model endpoint only (TEST ONLY; nothing here is a benchmark result).
"""

from __future__ import annotations

import io
import json
import secrets
import tarfile
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text

from agenthorizon.app import jobs as J
from agenthorizon.app.api.auth import create_user
from agenthorizon.app.api.main import create_app
from agenthorizon.app.db import migrate
from agenthorizon.app.indexer import index_dataset_version
from agenthorizon.app.schema import audit_events, workers
from agenthorizon.app.worker import WorkerContext, process_one
from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.testing.fake_llm import FakeLLMServer, openai_response
from agenthorizon.testing.fixture import build_fixture

pytestmark = pytest.mark.postgres
VALID_T = json.dumps({"success": True, "reasoning": "r", "confidence": "high", "mistake_type": None})
CSRF = {"X-AH-Request": "1"}


@pytest.fixture(scope="module")
def env(pg_cluster, tmp_path_factory):
    db = f"ahapp_{secrets.token_hex(4)}"
    pg_cluster.psql(f"CREATE DATABASE {db} OWNER agenthorizon")
    owner_url = pg_cluster.url(db=db)
    migrate(url=owner_url)
    base = tmp_path_factory.mktemp("app")
    fx = base / "fx"
    build_fixture(fx)
    s = Settings(mode="local", var_dir=base / "var", database_url=owner_url)  # never the ambient AH_MODE
    r = ingest(s, IngestOptions(source="local", local_dir=fx, media="all"))
    dv = DatasetVersion(Path(r.root))
    scorer = create_engine(pg_cluster.url("ah_scorer", db=db))
    index_dataset_version(scorer, dv, PrivateStore(s.private_dir, dv.id))
    owner = create_engine(owner_url)
    toks = {role: create_user(owner, f"{role}-1", role) for role in ("viewer", "reviewer", "researcher", "operator")}
    app = create_app(s)
    worker_engine = create_engine(pg_cluster.url("ah_worker", db=db))
    yield {"s": s, "dv": dv, "app": app, "toks": toks, "owner": owner, "scorer": scorer, "worker": worker_engine,
           "cluster": pg_cluster, "db": db}
    for e in (scorer, owner, worker_engine, app.state.engine):
        e.dispose()


def client(env, role: str) -> TestClient:
    c = TestClient(env["app"])
    r = c.post("/api/auth/login", json={"token": env["toks"][role]})
    assert r.status_code == 200, r.text
    return c


def bearer(env, role: str) -> dict:
    return {"Authorization": f"Bearer {env['toks'][role]}"}


def test_auth_roles_csrf_and_audit(env):
    anon = TestClient(env["app"])
    assert anon.get("/api/datasets").status_code == 401
    assert anon.post("/api/auth/login", json={"token": "aht_wrong"}).status_code == 401
    v = client(env, "viewer")
    assert v.get("/api/auth/me").json()["role"] == "viewer"
    assert "httponly" in v.cookies.jar._cookies.__repr__().lower() or True  # cookie flags asserted below
    raw = TestClient(env["app"]).post("/api/auth/login", json={"token": env["toks"]["viewer"]}).headers["set-cookie"].lower()
    assert "httponly" in raw and "samesite=strict" in raw
    dv = env["dv"].id
    eid = sorted(env["dv"].example_ids())[0]
    assert v.get(f"/api/research/datasets/{dv}/examples/{eid}").status_code == 403  # labels are privileged
    r = client(env, "researcher")
    assert r.post("/api/runs/plan", json={}).status_code == 403  # cookie mutation without the CSRF header
    assert r.get(f"/api/research/datasets/{dv}/examples/{eid}").status_code == 200
    with env["owner"].connect() as c:
        acts = c.execute(select(audit_events.c.action).where(audit_events.c.actor == "researcher-1")).scalars().all()
    assert "research.view_labels" in acts
    plain = TestClient(env["app"])
    assert plain.get("/api/datasets", headers=bearer(env, "viewer")).status_code == 200  # bearer tokens for scripts
    assert plain.get("/api/nope", headers=bearer(env, "viewer")).status_code == 404  # unknown API path is not the SPA


def test_catalogue_search_pagination_steps_media(env):
    v = client(env, "viewer")
    dv = env["dv"].id
    d = v.get(f"/api/datasets/{dv}").json()
    assert d["synthetic"] and d["counts"]["examples"] == 15
    assert d["membership_status"]["revised_paper_partition"]["status"] in ("not_located", "unknown")
    assert any(m["partition"] == "legacy-submitted" for m in d["manifests"])
    seen, cur, total = [], None, None
    while True:
        page = v.get(f"/api/datasets/{dv}/examples", params={"limit": 4, **({"cursor": cur} if cur else {})}).json()
        total = page["total"]
        seen += [i["example_id"] for i in page["items"]]
        cur = page["next_cursor"]
        if not cur:
            break
    assert len(seen) == len(set(seen)) == total == 15  # keyset pages are complete and disjoint
    hit = v.get(f"/api/datasets/{dv}/examples", params={"q": "slide deck"}).json()
    assert hit["total"] >= 1 and all("slide deck" in i["instruction"].lower() for i in hit["items"])
    long_ = v.get(f"/api/datasets/{dv}/examples", params={"min_steps": 300}).json()
    assert long_["total"] >= 1 and all(i["n_steps"] == 320 for i in long_["items"])  # shared long recording
    eid = long_["items"][0]["example_id"]
    ex = v.get(f"/api/datasets/{dv}/examples/{eid}").json()
    assert ex["timing"]["observation_timing"] == "pre_action"
    st = v.get(f"/api/datasets/{dv}/examples/{eid}/steps", params={"offset": 300, "limit": 50}).json()
    assert len(st["steps"]) == 20 and st["steps"][0]["idx"] == 300  # a window, never the whole trajectory
    m = st["steps"][0]["media"]
    assert m["status"] == "materialized"
    thumb = v.get(m["thumb_url"])
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    assert "immutable" in thumb.headers["cache-control"]
    full = v.get(m["full_url"])
    assert full.content[:8] == b"\x89PNG\r\n\x1a\n"
    md = v.get(f"/api/datasets/{dv}/examples/{eid}/released/markdown")
    assert md.headers["content-type"].startswith("text/plain") and "default-src 'none'" in md.headers["content-security-policy"]
    assert v.get(f"/api/media/{dv}/{'0' * 64}").status_code == 404


def test_catalogue_responses_never_carry_labels(env):
    v = client(env, "viewer")
    dv = env["dv"].id
    gold = PrivateStore(env["s"].private_dir, dv).gold
    blobs = [v.get(f"/api/datasets/{dv}/examples", params={"limit": 200}).text]
    for eid in sorted(env["dv"].example_ids()):
        blobs.append(v.get(f"/api/datasets/{dv}/examples/{eid}").text)
    text_all = "\n".join(blobs)
    for key in ('"label"', '"mistake_type', '"paired_id"', '"original_id"', "Critical Mistake", "Bad Side Effect",
                "Misunderstanding of the Instruction"):
        assert key not in text_all, key  # ("category" alone is the released task-domain metadata, judge-visible)
    for g in gold.values():
        if g.get("original_id"):
            assert g["original_id"] not in text_all


def _register_judge_worker(env, creds=()):
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    with env["worker"].begin() as c:
        c.execute(pg_insert(workers).values(worker_id="judge@test", queue="judge",
                                            info={"credentials": list(creds), "harness": {},
                                                  "isolation": {"ok": True, "detail": "test"}})
                  .on_conflict_do_update(index_elements=["worker_id"], set_={"last_seen": text("now()")}))


def test_run_lifecycle_through_workers(env):
    s, dv = env["s"], env["dv"]
    full = f"{dv.id}:full-release"
    researcher, viewer = client(env, "researcher"), client(env, "viewer")
    with FakeLLMServer() as srv:
        srv.default = (200, {}, openai_response(VALID_T, model="Qwen/Qwen3.6-27B"))
        cfg = {"dataset_version": dv.id, "judge_config": "direct:qwen3.6-27b:native-512x332", "manifest": full,
               "smoke_n": 3, "base_url": f"{srv.url}/v1", "label": "test-fixture pilot"}
        plan = researcher.post("/api/runs/plan", json={"config": cfg}, headers=CSRF).json()
        assert not plan["ready_for_live_run"] and any("no judge worker" in b for b in plan["blocked"])
        _register_judge_worker(env)
        plan = researcher.post("/api/runs/plan", json={"config": cfg}, headers=CSRF).json()
        assert plan["ready_for_live_run"], plan["blocked"]
        key = {"Idempotency-Key": "create-1", **CSRF}
        r1 = researcher.post("/api/runs", json={"config": cfg, "concurrency": 2}, headers=key)
        r2 = researcher.post("/api/runs", json={"config": cfg, "concurrency": 2}, headers=key)
        assert r1.status_code == 202 and r2.json() == r1.json() and r2.headers.get("idempotent-replay") == "true"
        bad = researcher.post("/api/runs", json={"config": {**cfg, "smoke_n": 4}}, headers=key)
        assert bad.status_code == 422  # same key, different body
        run_id = r1.json()["run_id"]
        assert viewer.post(f"/api/runs/{run_id}/cancel", headers=CSRF).status_code == 403  # viewers cannot control runs
        ctx = WorkerContext(s, env["worker"], "judge@test", secrets_env={})
        out = process_one(ctx, "judge", lease_s=30)
        assert out["status"] == "succeeded", out
    det = viewer.get(f"/api/runs/{run_id}").json()
    assert det["status"] == "completed" and det["task_states"] == {"completed": 3}
    assert det["telemetry"]["attempts"] == 3 and det["telemetry"]["tokens_reported"] == 3
    tasks = viewer.get(f"/api/runs/{run_id}/tasks").json()["items"]
    one = viewer.get(f"/api/runs/{run_id}/tasks/{tasks[0]['example_id']}").json()
    assert one["final"]["selected_attempt"] == 1 and one["attempts"][0]["outcome"]["verdict"]["success"] is True
    art = one["attempts"][0]["outcome"]["artifacts"]["response"]["path"]
    assert viewer.get(f"/api/runs/{run_id}/artifact", params={"path": art}).text.strip().startswith("{")
    assert viewer.get(f"/api/runs/{run_id}/artifact", params={"path": "../../private/x"}).status_code == 400
    sj = researcher.post(f"/api/runs/{run_id}/score", json={}, headers=CSRF).json()
    tctx = WorkerContext(s, env["scorer"], "trusted@test")
    assert process_one(tctx, "trusted")["status"] == "succeeded"
    rep = viewer.get(f"/api/runs/{run_id}/scores").json()["items"][0]["report"]
    assert rep["warning"].startswith("SYNTHETIC") and rep["coverage"]["of"] == 15 and "selection_subset" in rep
    assert "_per_item_outcome" not in json.dumps(rep)  # per-item outcomes stay in the private schema
    items = researcher.get(f"/api/research/scores/{viewer.get(f'/api/runs/{run_id}/scores').json()['items'][0]['score_id']}/items").json()
    assert len(items["items"]) == 15 and sum(1 for i in items["items"] if i["outcome"] == "missing") == 12
    assert J.get(env["owner"], sj["job_id"])["status"] == "succeeded"
    ej = researcher.post(f"/api/runs/{run_id}/exports", json={"with_score": True}, headers=CSRF).json()
    assert process_one(tctx, "trusted")["status"] == "succeeded"
    exp = viewer.get(f"/api/runs/{run_id}/exports").json()["items"][0]
    assert viewer.get(exp["download_url"]).status_code == 403  # bundle carries label-derived outcomes
    blob = researcher.get(exp["download_url"]).content
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        assert "score/report.json" in tar.getnames()
    assert J.get(env["owner"], ej["job_id"])["status"] == "succeeded"
    cmp_ = viewer.get("/api/compare", params={"runs": f"{run_id},{run_id}"}).json()
    assert cmp_["runs"][1]["differences_from_first"] == []


def test_sse_stream_resumes_from_last_event_id(env):
    import socket

    import uvicorn

    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(env["app"], host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    while not server.started:
        time.sleep(0.05)
    try:
        with env["owner"].connect() as c:
            run_id = c.execute(text("SELECT run_id FROM runs ORDER BY created_at LIMIT 1")).scalar_one()
        h = bearer(env, "viewer")

        def read(n, extra=None):
            got = []
            with httpx.stream("GET", f"http://127.0.0.1:{port}/api/runs/{run_id}/events", headers={**h, **(extra or {})},
                              timeout=10) as resp:
                assert resp.headers["content-type"].startswith("text/event-stream")
                for line in resp.iter_lines():
                    if line.startswith("id: "):
                        got.append(int(line[4:]))
                    if len(got) >= n:
                        break
            return got

        first = read(5)
        assert first == sorted(first) and first[0] == 1
        resumed = read(3, {"Last-Event-ID": str(first[-1])})
        assert resumed[0] == first[-1] + 1
    finally:
        server.should_exit = True
        th.join(timeout=10)


def test_blind_review_then_audited_reveal(env):
    rv = client(env, "reviewer")
    dv = env["dv"].id
    q = rv.get("/api/reviews/queue", params={"dv": dv, "limit": 3}).json()
    assert q["blind"] and q["items"] and "label" not in json.dumps(q)
    eid = q["items"][0]["example_id"]
    rub = rv.get("/api/reviews/rubric").json()["rubric_revision"]
    assert rv.post(f"/api/reviews/{dv}/{eid}/reveal", headers=CSRF).status_code == 409  # blind first
    a = rv.post(f"/api/reviews/{dv}/{eid}", headers=CSRF, json={"success": False, "mistake_type_native": "Critical Mistake",
                                                                 "rationale": "final state misses the goal",
                                                                 "evidence_steps": [3, 4], "rubric_revision": rub})
    assert a.status_code == 201 and a.json()["phase"] == "blind"
    bad = rv.post(f"/api/reviews/{dv}/{eid}", headers=CSRF, json={"success": True, "mistake_type_native": "Critical Mistake",
                                                                   "rationale": "x" * 5, "rubric_revision": rub})
    assert bad.status_code == 422  # success carries no failure category
    rev = rv.post(f"/api/reviews/{dv}/{eid}/reveal", headers=CSRF).json()
    assert rev["gold"]["label"] in ("positive", "negative") and isinstance(rev["blind_verdict_agrees_with_gold"], bool)
    corr = rv.post(f"/api/reviews/{dv}/{eid}", headers=CSRF, json={"rationale": "label looks wrong", "rubric_revision": rub,
                                                                    "proposed_correction": {"label": "positive", "why": "x"}})
    assert corr.json()["phase"] == "post_reveal"
    gold_now = PrivateStore(env["s"].private_dir, dv).gold[eid]["label"]
    assert gold_now == rev["gold"]["label"]  # official labels untouched
    stats = rv.get("/api/reviews/stats", params={"dv": dv}).json()
    assert stats["pairwise_agreement"] is None  # one reviewer: no agreement claim
    assert rv.get("/api/reviews/export", params={"dv": dv}).status_code == 403  # export needs researcher
    csv_ = client(env, "researcher").get("/api/reviews/export", params={"dv": dv, "format": "csv"}).text
    assert "rubric_revision" in csv_.splitlines()[0] and "reviewer-1" in csv_


def test_job_lease_expiry_reclaim_and_owner_checks(env):
    e = env["owner"]
    jid, created = J.enqueue(e, "index", {"dataset_version_id": "nope"}, created_by="t", dedupe_key="lease-test")
    jid2, created2 = J.enqueue(e, "index", {"dataset_version_id": "nope"}, created_by="t", dedupe_key="lease-test")
    assert created and not created2 and jid == jid2  # no duplicate active job
    a = J.claim(e, "trusted", "worker-A", lease_s=0.5)
    assert a["job_id"] == jid and a["attempts"] == 1
    assert J.claim(e, "trusted", "worker-B", lease_s=5) is None  # leased
    time.sleep(0.8)
    b = J.claim(e, "trusted", "worker-B", lease_s=5)
    assert b["job_id"] == jid and b["attempts"] == 2  # dead worker's job re-claimed
    assert not J.complete(e, jid, "worker-A", {"x": 1})  # the stale owner cannot finalize it
    assert J.complete(e, jid, "worker-B", {"x": 2})
    assert J.get(e, jid)["status"] == "succeeded"


def test_capability_probe_runs_on_a_judge_worker_and_never_carries_secret_values(env):
    """The admin probe is a judge-queue job: it measures the worker that executes runs (harnesses, isolation,
    credential names), not the API process; the report never contains a credential value."""
    op = client(env, "operator")
    assert client(env, "viewer").post("/api/admin/judges/doctor", headers=CSRF).status_code == 403
    r = op.post("/api/admin/judges/doctor", headers=CSRF)
    assert r.status_code == 202, r.text
    jid = r.json()["job_id"]
    assert op.post("/api/admin/judges/doctor", headers=CSRF).json()["job_id"] == jid  # deduplicated while queued
    assert J.get(env["owner"], jid)["queue"] == "judge"
    secret = "sk-ant-TEST-" + secrets.token_hex(8)
    ctx = WorkerContext(env["s"], env["worker"], "judge@doctor-test", secrets_env={"ANTHROPIC_API_KEY": secret})
    out = process_one(ctx, "judge", lease_s=30)
    assert out["status"] == "succeeded", out
    job = op.get(f"/api/jobs/{jid}").json()
    assert job["result"]["measured_by"] == "judge@doctor-test" and secret not in json.dumps(job)
    body = op.get("/api/judges").json()
    assert body["source"] == "judge worker" and body["measured_by"] == "judge@doctor-test"
    assert secret not in json.dumps(body)
    claude = next(c for c in body["configs"] if c["config_id"] == "claude_code:claude-opus-4.7")
    cred = claude["capability"]["checks"]["credentials"]
    assert cred["required"] == ["ANTHROPIC_API_KEY"] and cred["missing"] == []  # the worker's credential, by name
