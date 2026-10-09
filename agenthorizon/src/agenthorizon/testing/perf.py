"""Application performance measurement at release scale (TEST ONLY — synthetic catalogue rows).

Builds a throwaway PostgreSQL catalogue with the release's example count (1,373) and a synthetic step-length
distribution, serves the real API with uvicorn, and measures warm request latency for catalogue search/filter/page
queries, example detail, and step windows of the longest trajectory. The rows are synthetic; only the latency
measurements are reported (with the machine description). Targets (MP §11): warm catalogue queries p95 < 500 ms.

    python -m agenthorizon.testing.perf --out evidence/PERFORMANCE.json
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import socket
import statistics
import tempfile
import threading
import time
from pathlib import Path

N_EXAMPLES = 1373
WORDS = ("open settings export slide deck email team calendar meeting room browser spreadsheet column chart filter "
         "rename folder download invoice compress archive terminal install package print document margin font table "
         "share link presentation notes reminder timezone schedule format currency pivot image crop resize upload").split()


def _p(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1)))]


def build_catalogue(engine, dv: str, seed: int = 1) -> dict:
    from sqlalchemy import insert

    from agenthorizon.app.schema import assets, dataset_versions, examples, steps

    rng = random.Random(seed)
    with engine.begin() as c:
        c.execute(insert(dataset_versions).values(dataset_version_id=dv, benchmark="perf-synthetic", synthetic=True,
                                                  info={"note": "synthetic performance catalogue"}))
        ex_rows, st_rows, as_rows = [], [], []
        total_steps = 0
        for i in range(N_EXAMPLES):
            n = max(3, min(420, int(rng.lognormvariate(4.3, 0.7))))
            if i == 0:
                n = 420  # one long trajectory
            total_steps += n
            instr = " ".join(rng.choice(WORDS) for _ in range(rng.randint(8, 18)))
            rec = f"rec-{i:05d}"
            ex_rows.append({"dataset_version_id": dv, "example_id": f"ex-{i:05d}", "recording_id": rec, "instruction": instr,
                            "n_steps": n, "os": rng.choice(["windows", "macos"]), "application": rng.choice(["Excel", "Chrome", "Slides", "Mail, Calendar"]),
                            "domain": rng.choice(["Tool Usage", "Office", "Communication"]), "length_bin": "1-50" if n <= 50 else "51-100" if n <= 100 else "101-150" if n <= 150 else "151-200" if n <= 200 else "201-300" if n <= 300 else "301+",
                            "media_total": n, "media_materialized": n, "search_text": (instr + " " + " ".join(rng.choice(WORDS) for _ in range(n))).lower()[:20000]})
            for j in range(n):
                key = f"{rec}/step_{j + 1}.png"
                st_rows.append({"dataset_version_id": dv, "recording_id": rec, "idx": j, "step_id": j, "action_type": "click",
                                "action_text": f"left-click ({rng.randint(0, 1700)}, {rng.randint(0, 1100)})",
                                "action_text_full": None, "action": {"type": "click"}, "asset_key": key, "timestamp_us": j * 1_200_000,
                                "observation_timing": "pre_action"})
                as_rows.append({"dataset_version_id": dv, "asset_key": key, "sha256": f"{(i * 1000 + j):064x}", "status": "materialized",
                                "width": 1710, "height": 1112, "bytes": 200_000})
        for rows, t in ((ex_rows, examples), (st_rows, steps), (as_rows, assets)):
            for k in range(0, len(rows), 5000):
                c.execute(insert(t), rows[k:k + 5000])
    with engine.connect() as c:
        c.exec_driver_sql("ANALYZE")
    return {"examples": N_EXAMPLES, "steps": total_steps, "longest": 420}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--requests", type=int, default=200)
    a = ap.parse_args()
    import httpx
    import uvicorn
    from sqlalchemy import create_engine

    from agenthorizon.app.api.auth import create_user
    from agenthorizon.app.api.main import create_app
    from agenthorizon.app.db import migrate
    from agenthorizon.app.pgcluster import LocalCluster
    from agenthorizon.config import Settings

    root = Path(tempfile.mkdtemp(prefix="ahperf-"))
    os.chmod(root, 0o755)
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    cluster = LocalCluster(root / "pg", port=port + 1).ensure()
    try:
        migrate(url=cluster.url())
        owner = create_engine(cluster.url())
        t0 = time.perf_counter()
        scale = build_catalogue(owner, "perf-synthetic@1")
        build_s = time.perf_counter() - t0
        tok = create_user(owner, "perf", "viewer")
        s = Settings(var_dir=root / "var", database_url=cluster.url(), api_port=port)
        server = uvicorn.Server(uvicorn.Config(create_app(s), host="127.0.0.1", port=port, log_level="warning"))
        th = threading.Thread(target=server.run, daemon=True)
        th.start()
        while not server.started:
            time.sleep(0.05)
        base = f"http://127.0.0.1:{port}/api/datasets/perf-synthetic@1"
        h = {"Authorization": f"Bearer {tok}"}
        rng = random.Random(7)
        cases = {
            "catalogue_first_page": lambda: f"{base}/examples?limit=50",
            "catalogue_text_search": lambda: f"{base}/examples?limit=50&q={rng.choice(WORDS)}",
            "catalogue_filters": lambda: f"{base}/examples?limit=50&os=windows&min_steps=100&max_steps=300",
            "catalogue_deep_page": lambda: f"{base}/examples?limit=50&cursor=" + __import__("base64").urlsafe_b64encode(
                json.dumps({"id": f"ex-{rng.randint(0, N_EXAMPLES - 60):05d}"}).encode()).decode().rstrip("="),
            "example_detail": lambda: f"{base}/examples/ex-{rng.randint(0, N_EXAMPLES - 1):05d}",
            "step_window_longest": lambda: f"{base}/examples/ex-00000/steps?offset={rng.choice([0, 100, 200, 300, 400])}&limit=100",
            "facets": lambda: f"{base}/facets",
        }
        results = {}
        with httpx.Client(headers=h, timeout=30) as cl:
            for name, mk in cases.items():
                for _ in range(10):  # warm-up
                    cl.get(mk()).raise_for_status()
                lat, srv = [], []
                for _ in range(a.requests):
                    t = time.perf_counter()
                    r = cl.get(mk())
                    lat.append((time.perf_counter() - t) * 1000)
                    r.raise_for_status()
                    st = r.headers.get("server-timing", "")
                    if "dur=" in st:
                        srv.append(float(st.split("dur=")[1]))
                results[name] = {"n": len(lat), "p50_ms": round(_p(lat, 0.5), 2), "p95_ms": round(_p(lat, 0.95), 2),
                                 "max_ms": round(max(lat), 2), "server_p95_ms": round(_p(srv, 0.95), 2) if srv else None,
                                 "mean_ms": round(statistics.fmean(lat), 2)}
        server.should_exit = True
        th.join(timeout=10)
        cpu = next((ln.split(":", 1)[1].strip() for ln in open("/proc/cpuinfo") if ln.startswith("model name")), platform.processor())
        report = {
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "warning": "SYNTHETIC catalogue rows at release scale; latency measurements only — not benchmark data",
            "scale": scale, "catalogue_build_s": round(build_s, 1),
            "environment": {"cpu": cpu, "cores": os.cpu_count(), "python": platform.python_version(),
                            "postgres": owner.connect().exec_driver_sql("show server_version").scalar(),
                            "client": "httpx on the same host (loopback), sequential requests, warm caches"},
            "targets": {"warm_catalogue_p95_ms": 500, "first_visible_evidence_ms": 1500},
            "results": results,
            "met": {k: v["p95_ms"] < 500 for k, v in results.items()},
        }
        Path(a.out).write_text(json.dumps(report, indent=1))
        print(json.dumps(report["results"], indent=1))
        owner.dispose()
    finally:
        cluster.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
