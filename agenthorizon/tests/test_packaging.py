"""Container packaging keeps the trust boundaries (static checks on the resolved compose model and the seccomp file).

The running stack is exercised separately by docker/smoke.py (images, migrations, workers, a run, scoring, export).
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CREDENTIALS = {"ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "CODEX_AUTH_JSON"}


def _compose_config() -> dict:
    if not (ROOT / "compose.yaml").is_file():
        pytest.skip("needs the repository checkout (images carry src/ and tests/ only)")
    if shutil.which("docker") is None:
        pytest.skip("docker CLI not installed")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}
    env |= {k: "0123456789abcdef" for k in ("AH_OWNER_DB_PASSWORD", "AH_API_DB_PASSWORD", "AH_WORKER_DB_PASSWORD",
                                             "AH_SCORER_DB_PASSWORD")}
    r = subprocess.run(["docker", "compose", "--project-directory", str(ROOT), "-f", str(ROOT / "compose.yaml"),
                        "--profile", "tools", "--profile", "vllm", "config", "--format", "json"],
                       capture_output=True, text=True, env=env, timeout=60, check=False)
    if r.returncode != 0 and ("not a docker command" in r.stderr or "unknown command" in r.stderr):
        pytest.skip("docker compose plugin not installed")
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _volumes(service: dict) -> dict[str, dict]:
    return {v["target"]: v for v in service.get("volumes", [])}


def test_compose_trust_boundaries():
    cfg = _compose_config()
    sv = cfg["services"]
    for name, s in sv.items():  # nothing mounts the Docker socket or runs privileged
        assert not any("docker.sock" in (v.get("source") or "") for v in s.get("volumes", [])), name
        assert not s.get("privileged"), name

    judge = sv["worker-judge"]
    vols = _volumes(judge)
    assert set(vols) == {"/data/sources", "/data/datasets", "/data/media", "/data/runs"}  # no labels, exports, reports
    assert all(v.get("read_only") for t, v in vols.items() if t != "/data/runs")
    assert judge["cap_drop"] == ["ALL"] and not judge.get("cap_add")
    assert "no-new-privileges:true" in judge["security_opt"]
    assert any(o.startswith("seccomp=") and o.endswith("docker/seccomp-judge.json") for o in judge["security_opt"])
    assert judge["read_only"] is True
    env = judge["environment"]
    assert env["AH_WORKER_DATABASE_URL"].startswith("postgresql+psycopg://ah_worker:")
    assert not {"AH_DATABASE_URL", "AH_SCORER_DATABASE_URL", "AH_API_DATABASE_URL"} & set(env)

    for name, s in sv.items():  # provider credentials reach the judge worker only
        if name != "worker-judge":
            assert not CREDENTIALS & set(s.get("environment") or {}), name
        has_private = any(v.get("source") == "private" for v in s.get("volumes", []))
        assert has_private == (name in {"worker-trusted", "admin"}), name

    api = sv["api"]
    assert api["environment"]["AH_API_DATABASE_URL"].startswith("postgresql+psycopg://ah_api:")
    assert all(v.get("read_only") for t, v in _volumes(api).items() if t != "/data/cache")
    assert [p["host_ip"] for p in api["ports"]] == ["127.0.0.1"]  # loopback unless the operator opts in
    assert not sv["postgres"].get("ports")
    assert cfg["networks"]["backend"]["internal"] is True
    assert set(sv["postgres"]["networks"]) == {"backend"}
    assert sv["worker-trusted"]["environment"]["AH_SCORER_DATABASE_URL"].startswith("postgresql+psycopg://ah_scorer:")


@pytest.mark.skipif(not (ROOT / "docker" / "harnesses" / "package.json").is_file(),
                    reason="needs the repository checkout (images carry src/ and tests/ only)")
def test_harness_pins_agree_everywhere():
    """The adapters' verified releases are what the judge image installs and checks, with recorded --help evidence."""
    from agenthorizon.judging.harnesses import ADAPTERS

    pins = {k: a.verified_version for k, a in ADAPTERS.items()}
    h = ROOT / "docker" / "harnesses"
    deps = json.loads((h / "package.json").read_text())["dependencies"]
    assert {a.package: pins[k] for k, a in ADAPTERS.items() if a.package in deps} == deps and len(deps) == 4
    lock = json.loads((h / "package-lock.json").read_text())["packages"]
    assert {p: lock[f"node_modules/{p}"]["version"] for p in deps} == deps
    assert f"openhands=={pins['openhands']}" in (h / "openhands-constraints.txt").read_text().splitlines()
    dockerfile = (ROOT / "docker" / "Dockerfile").read_text()
    help_files = " ".join(f.name for f in (ROOT / "evidence" / "harness_cli").iterdir())
    for k, v in pins.items():
        assert v.replace(".", "\\.") in dockerfile, (k, v)  # the build fails unless --version reports the pin
        assert f"-{v}-" in help_files, (k, v)


@pytest.mark.skipif(not (ROOT / "docker" / "seccomp-judge.json").is_file(),
                    reason="needs the repository checkout (images carry src/ and tests/ only)")
def test_seccomp_profile_derivation():
    """The judge profile is Docker's default plus exactly one unconditional rule for the sandbox's syscalls."""
    spec = importlib.util.spec_from_file_location("make_seccomp", ROOT / "docker" / "make_seccomp.py")
    mk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mk)
    prof = json.loads((ROOT / "docker" / "seccomp-judge.json").read_text())
    added = prof["syscalls"][-1]
    assert added["names"] == mk.NESTED_SANDBOX_SYSCALLS and added["action"] == "SCMP_ACT_ALLOW"
    assert not {"args", "includes", "excludes"} & set(added)
    base = {**prof, "syscalls": prof["syscalls"][:-1]}
    assert mk.canonical_sha256(base) == mk.BASE_CANONICAL_SHA256  # the rest is the recorded upstream default
    assert mk.build(base) == prof
    assert prof["defaultAction"] == "SCMP_ACT_ERRNO"
    allowed = {n for r in prof["syscalls"] if r["action"] == "SCMP_ACT_ALLOW" and not r.get("includes") for n in r["names"]}
    assert not {"setns", "bpf", "keyctl", "ptrace", "kexec_load", "open_by_handle_at"} & allowed
