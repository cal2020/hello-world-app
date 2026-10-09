#!/usr/bin/env python3
"""End-to-end smoke test of compose.yaml (TEST ONLY: synthetic fixture and a fake model endpoint; nothing produced
here is a benchmark result).

Brings the stack up under a throwaway project name and drives it only through the real API, workers and CLI:

 1. operator token from the admin service (owner identity);
 2. the synthetic fixture written into the imports volume, ingested and indexed by the trusted worker;
 3. a direct-judge run on the OpenAI-compatible route against the fake endpoint, executed by the judge worker;
 4. scoring and an export bundle by the trusted worker; the bundle downloaded and checked;
 5. a capability probe executed by the judge worker (harness installs and the per-task sandbox inside the container);
 6. trust-boundary checks on the running containers (label volume, database role, capabilities, Docker socket,
    credential placement), then tears everything down, volumes included.

    python3 docker/smoke.py --out evidence/STACK_SMOKE.json        # images: docker compose build (or prebuilt)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import secrets
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HARNESS_CONFIGS = {"claude_code": "claude_code:claude-opus-4.7", "codex": "codex:gpt-5.5", "gemini_cli": "gemini_cli:gemini-3.1-pro",
                   "opencode": "opencode:qwen3.6-27b", "openhands": "openhands:qwen3.6-27b"}


class Smoke:
    def __init__(self, port: int, keep: bool) -> None:
        self.project = f"ahsmoke{secrets.token_hex(3)}"
        self.port, self.keep = port, keep
        self.base = f"http://127.0.0.1:{port}"
        self.dummy_key = "sk-ant-SMOKE-" + secrets.token_hex(8)  # must reach the judge worker only, never any output
        self.passwords = {k: secrets.token_hex(16) for k in ("AH_OWNER_DB_PASSWORD", "AH_API_DB_PASSWORD",
                                                             "AH_WORKER_DB_PASSWORD", "AH_SCORER_DB_PASSWORD")}
        fd = tempfile.NamedTemporaryFile("w", prefix="ahsmoke-", suffix=".env", delete=False)
        fd.write("".join(f"{k}={v}\n" for k, v in self.passwords.items()))
        fd.write(f"AH_API_PORT={port}\nANTHROPIC_API_KEY={self.dummy_key}\n")
        fd.close()
        self.env_file = fd.name
        self.token = ""
        self.out: dict = {"warning": "TEST ONLY: synthetic fixture and a fake model endpoint; not benchmark results",
                          "project": self.project, "steps": {}}

    # ---- plumbing ------------------------------------------------------------------------------------------
    def dc(self, *args: str, check: bool = True, timeout: int = 900) -> subprocess.CompletedProcess:
        cmd = ["docker", "compose", "-p", self.project, "--env-file", self.env_file, "-f", str(ROOT / "compose.yaml"),
               "-f", str(ROOT / "docker" / "compose.smoke.yaml"), *args]
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False)
        if check and r.returncode != 0:
            raise RuntimeError(f"{' '.join(args[:3])} failed ({r.returncode}): {r.stderr[-1500:]}")
        return r

    def api(self, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, bytes]:
        h = {"Authorization": f"Bearer {self.token}", **(headers or {})}
        data = None
        if body is not None:
            data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=h, method=method)
        try:
            with NO_PROXY.open(req, timeout=60) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def jget(self, path: str) -> dict:
        status, data = self.api("GET", path)
        if status != 200:
            raise RuntimeError(f"GET {path} -> {status}: {data[:500]!r}")
        return json.loads(data)

    def jpost(self, path: str, body: dict | None = None, headers: dict | None = None, ok=(200, 201, 202)) -> dict:
        status, data = self.api("POST", path, body if body is not None else {}, headers)
        if status not in ok:
            raise RuntimeError(f"POST {path} -> {status}: {data[:800]!r}")
        return json.loads(data)

    def wait_job(self, job_id: int, timeout: float = 600) -> dict:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            j = self.jget(f"/api/jobs/{job_id}")
            if j["status"] in ("succeeded", "failed", "cancelled"):
                if j["status"] != "succeeded":
                    raise RuntimeError(f"job {job_id} {j['status']}: {j.get('last_error')}")
                return j
            time.sleep(1)
        raise TimeoutError(f"job {job_id} did not finish in {timeout}s")

    def step(self, name: str, value) -> None:
        self.out["steps"][name] = value
        print(f"[smoke] {name}: {json.dumps(value)[:300]}", flush=True)

    # ---- the scenario --------------------------------------------------------------------------------------
    def run(self) -> dict:
        t0 = time.monotonic()
        self.dc("up", "-d", "--no-build", timeout=600)
        self._wait_healthy()
        self.step("stack_up_s", round(time.monotonic() - t0, 1))

        out = self.dc("run", "--rm", "-T", "admin", "users", "add", "smoke-operator", "--role", "operator").stdout
        self.token = [ln.strip() for ln in out.splitlines() if ln.strip()][-1]
        assert self.token.startswith("aht_"), out
        me = self.jget("/api/auth/me")
        self.step("operator", {"user": me["user_id"], "role": me["role"], "mode": me.get("mode")})

        self.dc("run", "--rm", "-T", "admin", "fixture", "build", "--out", "/data/imports/fixture")
        job = self.jpost("/api/admin/datasets/ingest", {"source": "local", "local_dir": "/data/imports/fixture", "media": "all"})
        res = self.wait_job(job["job_id"])["result"]
        dv = res["dataset_version_id"]
        self.step("ingest", {"dataset_version_id": dv, "status": res["status"], "indexed": res.get("index")})

        workers = self._wait_judge_worker()
        self.step("judge_worker_presence", workers)

        cfg = {"dataset_version": dv, "judge_config": "direct:qwen3.6-27b:native-512x332", "manifest": f"{dv}:full-release",
               "smoke_n": 4, "base_url": "http://fake-llm:8080/v1", "label": "stack smoke (TEST ONLY)"}
        status, body = self.api("POST", "/api/runs/plan", {"config": cfg})  # the prompt's pinned source is not there yet
        err = json.loads(body).get("error", {})
        assert status == 409 and err.get("code") == "source_unavailable", (status, body[:300])
        self.step("plan_without_pinned_source", {"status": status, "code": err["code"], "message": err["message"]})
        self._copy_pinned_checkout("agenthorizon-repo")
        # harness runs are planned in the API, which has no harness binaries: the definition must carry the judge
        # workers' harness identity, and the image's harnesses must be the releases the invocations were verified on
        agentic = {}
        for iface, cid in HARNESS_CONFIGS.items():
            p = self.jpost("/api/runs/plan", {"config": {"dataset_version": dv, "judge_config": cid,
                                                         "manifest": f"{dv}:full-release", "smoke_n": 1}})
            h = p["checks"].get("harness") or {}
            harness_blocks = [b for b in p["blocked"] if "harness" in b or "judge worker has" in b]
            assert h.get("ok") and h.get("matches_definition") and not harness_blocks, (cid, h, harness_blocks)
            assert not any("verified against" in r for r in p["classification"]["reasons"]), (cid, p["classification"])
            agentic[iface] = {"config": cid, "harness_version": h.get("worker_version"), "other_blocks": len(p["blocked"])}
        self.step("agentic_plans", agentic)
        plan = self.jpost("/api/runs/plan", {"config": cfg})
        assert plan["ready_for_live_run"], plan.get("blocked")
        run = self.jpost("/api/runs", {"config": cfg, "concurrency": 2}, headers={"Idempotency-Key": secrets.token_hex(8)})
        detail = self._wait_run(run["run_id"])
        self.step("run", {"run_id": run["run_id"], "status": detail["status"], "task_states": detail["task_states"],
                          "classification": run["classification"].get("result_kind")})

        self.wait_job(self.jpost(f"/api/runs/{run['run_id']}/score", {"manifest_id": None})["job_id"])
        rep = self.jget(f"/api/runs/{run['run_id']}/scores")["items"][0]
        self.step("score", {k: rep.get(k) for k in ("score_id", "manifest_id", "summary") if k in rep})

        self.wait_job(self.jpost(f"/api/runs/{run['run_id']}/exports", {"with_score": True})["job_id"])
        exp = self.jget(f"/api/runs/{run['run_id']}/exports")["items"][0]
        status, blob = self.api("GET", f"/api/exports/{exp['export_id']}/download")
        assert status == 200 and hashlib.sha256(blob).hexdigest() == exp["sha256"]
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
            names = tf.getnames()
            contents = b"".join(tf.extractfile(m).read() for m in tf.getmembers() if m.isfile())
        leaked = [k for k, v in {**self.passwords, "ANTHROPIC_API_KEY": self.dummy_key}.items() if v.encode() in contents]
        assert not leaked, leaked
        self.step("export", {"sha256": exp["sha256"], "files": len(names), "secret_values_found": leaked})

        self.wait_job(self.jpost("/api/admin/judges/doctor")["job_id"], timeout=900)
        judges = self.jget("/api/judges")
        caps = {c["config_id"]: c["capability"] for c in judges["configs"]}
        harness = {}
        for iface, cid in HARNESS_CONFIGS.items():
            ch = caps.get(cid, {}).get("checks", {})
            harness[iface] = {"config": cid, "installed": (ch.get("installation") or {}).get("ok"),
                              "version": (ch.get("installation") or {}).get("version"),
                              "isolation": (ch.get("isolation") or {}).get("ok")}
        anth = caps.get("claude_code:claude-opus-4.7", {}).get("checks", {}).get("credentials", {})
        self.step("capability_probe", {"source": judges["source"], "measured_by": judges["measured_by"],
                                       "harness": harness, "anthropic_credential_missing": anth.get("missing")})
        surfaces = json.dumps([judges, self.jget("/api/admin/workers")])
        assert self.dummy_key not in surfaces

        self.step("boundaries", self._boundaries())
        self.out["passed"] = True
        return self.out

    def _copy_pinned_checkout(self, source_id: str) -> None:
        """Offline path for pinned sources: copy an existing checkout into the sources volume (an operator with network
        access would run `docker compose run --rm admin sources checkout <id>` instead)."""
        lock = json.loads((ROOT / "evidence" / "SOURCE_LOCK.json").read_text())
        rev = next(s["resolved_revision"] for s in lock["sources"] if s["source_id"] == source_id)
        name = next(p.name for p in (ROOT / "var" / "sources").glob(f"*@{rev}"))
        self.dc("run", "--rm", "-T", "-v", f"{ROOT / 'var' / 'sources' / name}:/src:ro", "--entrypoint", "sh", "admin",
                "-c", f"cp -a /src /data/sources/{name}")
        self.step("pinned_source_copied", {"source_id": source_id, "revision": rev})

    def _wait_healthy(self, timeout: float = 300) -> None:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            try:
                with NO_PROXY.open(f"{self.base}/api/ready", timeout=5) as r:
                    if r.status == 200:
                        return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            ps = self.dc("ps", "-a", "--format", "json", check=False).stdout
            for line in ps.splitlines():
                c = json.loads(line) if line.startswith("{") else {}
                if c.get("Service") == "migrate" and c.get("State") == "exited" and c.get("ExitCode") not in (0, None):
                    raise RuntimeError("migrate failed: " + self.dc("logs", "migrate", check=False).stdout[-1500:])
            time.sleep(2)
        raise TimeoutError("API never became ready: " + self.dc("logs", "--tail", "40", check=False).stdout[-3000:])

    def _wait_judge_worker(self, timeout: float = 240) -> dict:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            for w in self.jget("/api/admin/workers")["items"]:
                if w["queue"] == "judge" and w["info"].get("isolation"):
                    return {"worker_id": w["worker_id"], "isolation": w["info"]["isolation"],
                            "credentials": w["info"].get("credentials"),
                            "harness": {k: v.get("version") for k, v in (w["info"].get("harness") or {}).items()}}
            time.sleep(2)
        raise TimeoutError("no judge worker registered")

    def _wait_run(self, run_id: str, timeout: float = 600) -> dict:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            d = self.jget(f"/api/runs/{run_id}")
            if d["status"] in ("completed", "failed", "cancelled", "paused"):
                if d["status"] != "completed":
                    raise RuntimeError(f"run {run_id} {d['status']}: {d.get('pause_reason')}")
                return d
            time.sleep(1)
        raise TimeoutError(f"run {run_id} did not complete")

    def _boundaries(self) -> dict:
        def sh(service: str, script: str) -> subprocess.CompletedProcess:
            return self.dc("exec", "-T", service, "sh", "-c", script, check=False)

        private_judge = sh("worker-judge", "ls -A /data/private | wc -l").stdout.strip()
        private_trusted = sh("worker-trusted", "ls -A /data/private | wc -l").stdout.strip()
        db = self.dc("exec", "-T", "worker-judge", "python", "-c",
                     "import os, sqlalchemy as sa\n"
                     "e = sa.create_engine(os.environ['AH_WORKER_DATABASE_URL'])\n"
                     "with e.connect() as c: c.execute(sa.text('SELECT count(*) FROM private.gold_labels'))", check=False)
        caps = sh("worker-judge", "grep CapEff /proc/self/status").stdout.split()
        sock = sh("worker-judge", "test -e /var/run/docker.sock && echo present || echo absent").stdout.strip()
        cred = {svc: sh(svc, "env | grep -c '^ANTHROPIC_API_KEY=sk-' || true").stdout.strip()
                for svc in ("worker-judge", "worker-trusted", "api")}
        out = {"judge_private_entries": int(private_judge or 0), "trusted_private_entries": int(private_trusted or 0),
               "judge_db_private_read": "denied" if db.returncode != 0 and "permission denied" in db.stderr.lower()
               else f"UNEXPECTED rc={db.returncode}", "judge_cap_eff": caps[-1] if caps else None,
               "judge_docker_socket": sock, "anthropic_key_present": cred}
        assert out["judge_private_entries"] == 0 and out["trusted_private_entries"] > 0
        assert out["judge_db_private_read"] == "denied" and out["judge_cap_eff"] == "0000000000000000"
        assert sock == "absent" and cred == {"worker-judge": "1", "worker-trusted": "0", "api": "0"}
        return out

    def down(self) -> None:
        if not self.keep:
            self.dc("down", "-v", "--remove-orphans", check=False, timeout=300)
        Path(self.env_file).unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--keep", action="store_true", help="leave the stack running for inspection")
    a = ap.parse_args()
    s = Smoke(a.port, a.keep)
    try:
        result = s.run()
    except Exception as exc:  # noqa: BLE001 — report, keep logs, then tear down
        s.out["passed"] = False
        s.out["error"] = f"{type(exc).__name__}: {exc}"[:3000]
        s.out["logs_tail"] = s.dc("logs", "--tail", "60", check=False).stdout[-6000:]
        result = s.out
    finally:
        s.down()
    result["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if a.out:
        a.out.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({"passed": result.get("passed"), "error": result.get("error")}))
    return 0 if result.get("passed") else 1


if __name__ == "__main__":
    sys.exit(main())
