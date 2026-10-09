"""End-to-end UI test environment (TEST ONLY — synthetic fixture data and a fake local model endpoint).

Provisions a throwaway PostgreSQL cluster and var directory, ingests and indexes the synthetic fixture, creates one
user per role, starts a local fake OpenAI-compatible endpoint, a judge worker and a trusted worker (threads), and
serves the API plus the built frontend. Writes ``<out>/e2e.json`` with the URL, tokens, and fake endpoint so the
Playwright suite can drive the real UI. Nothing produced here is a benchmark result.

    python -m agenthorizon.testing.e2e_server --out /tmp/ah-e2e --port 8799
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import tempfile
import threading
import time
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=8799)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    import uvicorn
    from sqlalchemy import create_engine

    from agenthorizon.app.api.auth import create_user
    from agenthorizon.app.api.main import create_app
    from agenthorizon.app.db import migrate
    from agenthorizon.app.indexer import index_dataset_version
    from agenthorizon.app.pgcluster import LocalCluster
    from agenthorizon.app.worker import WorkerContext, run_worker
    from agenthorizon.config import Settings
    from agenthorizon.data.dataset import DatasetVersion, PrivateStore
    from agenthorizon.data.ingest import IngestOptions, ingest
    from agenthorizon.testing.fake_llm import FakeLLMServer, openai_response
    from agenthorizon.testing.fixture import build_fixture

    root = Path(tempfile.mkdtemp(prefix="ahe2e-"))
    os.chmod(root, 0o755)
    cluster = LocalCluster(root / "pg", port=a.port + 1000).ensure()
    owner_url = cluster.url()
    migrate(url=owner_url)
    s = Settings(mode="local", var_dir=root / "var", database_url=owner_url, api_port=a.port)
    build_fixture(root / "fx")
    r = ingest(s, IngestOptions(source="local", local_dir=root / "fx", media="all"))
    dv = DatasetVersion(Path(r.root))
    scorer = create_engine(cluster.url("ah_scorer"))
    index_dataset_version(scorer, dv, PrivateStore(s.private_dir, dv.id))
    owner = create_engine(owner_url)
    tokens = {role: create_user(owner, f"{role}-e2e", role) for role in ("operator", "researcher", "reviewer", "viewer")}
    try:  # real supplemental sources from the pinned checkouts (annotation-only / task definitions)
        from agenthorizon.supplemental.pipeline import import_arb, import_osworld
        import_arb(s)
        import_osworld(s)
    except Exception as exc:  # noqa: BLE001 — checkouts unavailable: the UI shows the empty state
        print(f"supplemental import skipped: {exc}")

    fake = FakeLLMServer()
    verdict = json.dumps({"success": True, "reasoning": "Step 2 shows the export dialog; step 5 confirms the file was saved.",
                          "confidence": "medium", "mistake_type": None})
    fake.default = (200, {}, openai_response(verdict, model="Qwen/Qwen3.6-27B"))
    fake.__enter__()

    stop = threading.Event()
    judge = WorkerContext(s, create_engine(cluster.url("ah_worker")), "judge@e2e", secrets_env={})
    trusted = WorkerContext(s, scorer, "trusted@e2e")
    for ctx, q in ((judge, "judge"), (trusted, "trusted")):
        threading.Thread(target=run_worker, args=(ctx, q, stop), kwargs={"poll_s": 0.3, "lease_s": 30, "log": lambda *_: None},
                         daemon=True).start()

    # ready means the workers have registered: until a judge worker reports its presence, every plan is (correctly)
    # blocked with "no judge worker is running", and a judge worker's presence probes every harness first
    from sqlalchemy import select

    from agenthorizon.app.schema import workers

    deadline = time.monotonic() + 300
    while True:
        with owner.connect() as c:
            seen = set(c.execute(select(workers.c.worker_id)).scalars())
        if {"judge@e2e", "trusted@e2e"} <= seen:
            break
        if time.monotonic() > deadline:
            raise SystemExit(f"workers did not register within 300 s (seen: {sorted(seen)})")
        time.sleep(0.5)

    app = create_app(s)
    info = {"url": f"http://127.0.0.1:{a.port}", "tokens": tokens, "dataset_version": dv.id,
            "fake_llm": f"{fake.url}/v1", "full_manifest": f"{dv.id}:full-release", "root": str(root),
            "note": "TEST ONLY: synthetic fixture and fake model endpoint"}
    (out / "e2e.json").write_text(json.dumps(info, indent=1))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=a.port, log_level="warning"))

    def shutdown(*_):
        stop.set()
        server.should_exit = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.run()
    finally:
        stop.set()
        fake.__exit__(None, None, None)
        for e in (scorer, owner, judge.engine, app.state.engine):
            e.dispose()
        cluster.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
