"""Execute one agentic-judge attempt inside the per-task sandbox.

Transport retries mirror the authors' runner: a rate-limit/quota message on *stderr* (never stdout, which holds
the model's own reasoning) triggers a wait and re-run of the same judgment, without consuming a judgment
attempt; detection is skipped for self-hosted and direct-Google routes as in the reference. Every re-run's output
is retained. A non-zero exit, timeout, or cancellation ends the attempt without a verdict (the reference writes no
result file in those cases, so the item is missing).
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path

from agenthorizon.config import PROJECT_ROOT
from agenthorizon.judging.contract import ArtifactRef, AttemptOutcome, Telemetry, redact
from agenthorizon.judging.harnesses import GeminiCliAdapter, HarnessAdapter, HarnessRun
from agenthorizon.judging.isolation.egress import default_upstream_proxy, endpoint_of
from agenthorizon.judging.isolation.sandbox import SandboxSpec, run_in_sandbox, run_unisolated
from agenthorizon.judging.parsing import parse_agentic
from agenthorizon.judging.workspace import READONLY_INPUTS, StagedWorkspace
from agenthorizon.util.hashing import sha256_file, sha256_text

RATE_LIMIT_MARKERS = ("usage limit", "rate limit", "quota")
NO_RATE_LIMIT_ROUTES = ("vllm", "google")
CA_BUNDLE_CANDIDATES = ("/root/.ccr/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt")


def tool_dirs() -> list[str]:
    dirs = [str(PROJECT_ROOT / "var" / "tools"), "/opt/node22"]
    return [d for d in dirs if os.path.isdir(d)]


def _artifact(run_dir: Path, path: Path) -> ArtifactRef:
    return ArtifactRef(str(path.relative_to(run_dir)), sha256_file(path), path.stat().st_size)


def _store_text(run_dir: Path, dest: Path, text: str) -> ArtifactRef:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)
    return _artifact(run_dir, dest)


def run_agentic_attempt(
    adapter: HarnessAdapter,
    run: HarnessRun,
    staged: StagedWorkspace,
    secrets: dict[str, str],
    *,
    run_dir: Path,
    isolation: str = "unshare",
    timeout_s: int = 1800,
    cancel: threading.Event | None = None,
    max_rate_limit_retries: int = 10,
    rate_limit_wait_s: float = 300.0,
    sleep=time.sleep,
    extra_tool_dirs: list[str] | None = None,
) -> AttemptOutcome:
    task_dir = staged.task_dir
    art_dir = task_dir / "artifacts"
    inv = adapter.invocation(run, secrets)
    home = task_dir / "home"
    for rel, (content, mode) in inv.home_files.items():
        p = home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        os.chmod(p, mode)
    ca = next((c for c in CA_BUNDLE_CANDIDATES if os.path.isfile(c)), None)
    spec = SandboxSpec(task_dir=task_dir, argv=inv.argv, env=inv.env, allowed_hosts=inv.allowed_hosts,
                       readonly_inputs=[r for r in READONLY_INPUTS if (staged.workspace / r).exists() or (staged.workspace / r).is_symlink()],
                       tool_dirs=tool_dirs() + list(extra_tool_dirs or []), timeout_s=timeout_s, stdin=inv.stdin,
                       upstream_proxy=default_upstream_proxy(), ca_bundle=ca, direct_endpoints=endpoint_of(run.base_url))
    lineage = {
        "interface": adapter.interface, "harness_binary": inv.argv[0], "harness_version": adapter.version(),
        "model_requested": run.model, "route": run.route, "effort": run.effort, "isolation": isolation,
        "allowed_hosts": sorted(inv.allowed_hosts),
        "self_hosted_endpoints": sorted(f"{h}:{p}" for h, p in endpoint_of(run.base_url)), "staging_mode": staged.mode, "staging_manifest_digest": staged.manifest_digest,
        "reference_parser": adapter.reference_parser, "deviations": inv.deviations + staged.deviations,
        "argv_redacted": [f"<prompt sha256={sha256_text(a)[:16]}>" if a == run.prompt_text else redact(a, secrets)
                          for a in inv.argv],
        "prompt_sha256": sha256_text(run.prompt_text),
    }
    retries: list[dict] = []
    t_start = time.monotonic()
    while True:
        result = (run_in_sandbox if isolation == "unshare" else run_unisolated)(spec, cancel)
        stderr = result.stderr()
        limited = (not result.timed_out and not result.cancelled and run.route not in NO_RATE_LIMIT_ROUTES
                   and any(m in stderr.lower() for m in RATE_LIMIT_MARKERS))
        if not limited:
            break
        n = len(retries) + 1
        keep = art_dir / f"transport-retry-{n}"
        keep.mkdir(parents=True, exist_ok=True)
        retries.append({"n": n, "reason": "rate-limit marker on stderr", "exit_code": result.exit_code,
                        "stdout": _store_text(run_dir, keep / "stdout.txt", redact(result.stdout(), secrets)).__dict__,
                        "stderr": _store_text(run_dir, keep / "stderr.txt", redact(stderr, secrets)).__dict__})
        if n > max_rate_limit_retries:
            return AttemptOutcome("rate_limited", transport_retries=retries, error="rate limited too many times",
                                  lineage=lineage, telemetry=Telemetry(wall_time_s=time.monotonic() - t_start).finalize())
        sleep(rate_limit_wait_s)
        if cancel is not None and cancel.is_set():
            break
        shutil.rmtree(home, ignore_errors=True)
        home.mkdir(parents=True, exist_ok=True)
        for rel, (content, mode) in inv.home_files.items():
            p = home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            os.chmod(p, mode)

    stdout = result.stdout()
    artifacts = {
        "stdout": _store_text(run_dir, art_dir / "stdout.txt", redact(stdout, secrets)),
        "stderr": _store_text(run_dir, art_dir / "stderr.txt", redact(result.stderr(), secrets)),
        "egress_audit": _store_text(run_dir, art_dir / "egress-audit.json", json.dumps(result.egress_audit, indent=1)),
        "sandbox_init_log": _store_text(run_dir, art_dir / "sandbox-init.log", result.init_log),
    }
    for f in ("staging.json", "sandbox-spec.json"):
        if (task_dir / f).is_file():
            artifacts[f.split(".")[0]] = _artifact(run_dir, task_dir / f)
    lineage["egress_decisions"] = {"allowed": sum(1 for d in result.egress_audit if d["allowed"]),
                                   "denied": sum(1 for d in result.egress_audit if not d["allowed"])}
    wall = time.monotonic() - t_start
    if result.setup_failed:
        return AttemptOutcome("blocked", error="sandbox setup failed; harness not run", artifacts=artifacts,
                              transport_retries=retries, lineage=lineage, telemetry=Telemetry(wall_time_s=wall).finalize())
    if result.cancelled:
        return AttemptOutcome("cancelled", artifacts=artifacts, transport_retries=retries, lineage=lineage,
                              telemetry=Telemetry(wall_time_s=wall).finalize())
    if result.timed_out:
        return AttemptOutcome("timed_out", error=f"exceeded {timeout_s}s", artifacts=artifacts, transport_retries=retries,
                              lineage=lineage, telemetry=Telemetry(wall_time_s=wall).finalize())
    text, meta = adapter.parse(stdout, home, run)
    if isinstance(adapter, GeminiCliAdapter):
        v0 = parse_agentic(text)
        if not v0.extracted:
            fb = adapter.fallback_text(meta)
            if fb:
                text = fb
                lineage["gemini_session_fallback"] = True
    for p in sorted(home.rglob("*.json*")):
        is_transcript = ".claude/projects" in str(p) or "/chats/" in str(p) or "/.codex/sessions/" in str(p)
        if p.is_file() and is_transcript and p.stat().st_size < 50_000_000:
            artifacts[f"transcript:{p.relative_to(home)}"] = _store_text(run_dir, art_dir / "transcripts" / p.name,
                                                                        redact(p.read_text(errors="replace"), secrets))
    telemetry = adapter.telemetry(meta, home, run)
    telemetry.wall_time_s = wall
    telemetry.coverage["wall_time_s"] = "reported"
    if result.exit_code != 0:
        return AttemptOutcome("process_failed", response_text=text or None, error=f"harness exit {result.exit_code}",
                              artifacts=artifacts, transport_retries=retries, lineage=lineage, telemetry=telemetry)
    response_ref = _store_text(run_dir, art_dir / "response.txt", text)
    artifacts["response"] = response_ref
    return AttemptOutcome("completed", response_text=text, verdict=parse_agentic(text), telemetry=telemetry,
                          transport_retries=retries, artifacts=artifacts, lineage=lineage)
