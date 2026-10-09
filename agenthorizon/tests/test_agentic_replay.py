"""Agentic adapters end to end with replay stand-ins inside the real sandbox (no model calls, no credentials).

Exercises: per-task staging from an ingested (synthetic) dataset version, each adapter's command line and
environment, the namespace sandbox, verbatim-ported output parsers, telemetry with coverage flags, the egress
audit trail, and artifact persistence. Model behaviour is NOT under test here.
"""

from __future__ import annotations

import json
import shutil
import stat
from pathlib import Path

import pytest

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.data.media import LocalMediaStore
from agenthorizon.judging.agentic import run_agentic_attempt
from agenthorizon.judging.harnesses import (
    ClaudeCodeAdapter,
    CodexAdapter,
    GeminiCliAdapter,
    HarnessRun,
    OpenCodeAdapter,
    OpenHandsAdapter,
)
from agenthorizon.judging.isolation.sandbox import isolation_available
from agenthorizon.judging.prompts import official_agentic_prompt, rubric_extension_instructions
from agenthorizon.judging.workspace import stage_workspace
from agenthorizon.testing.fixture import build_fixture

REPLAY = Path(__file__).resolve().parents[1] / "src" / "agenthorizon" / "testing" / "replay_harness.py"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    ok, why = isolation_available()
    if not ok:
        pytest.skip(why)
    base = tmp_path_factory.mktemp("agentic")
    fx = base / "fx"
    build_fixture(fx)
    s = Settings(var_dir=base / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=fx, media="all"))
    tools = base / "replay-tools"
    tools.mkdir()
    shutil.copy(REPLAY, tools / "replay_harness.py")
    for kind in ("claude", "codex", "gemini", "opencode", "openhands"):
        w = tools / f"{kind}-replay"
        w.write_text(f'#!/bin/sh\nAH_REPLAY_KIND={kind} exec /usr/bin/python3 -I {tools}/replay_harness.py "$@"\n')
        w.chmod(0o755)
    return s, DatasetVersion(Path(r.root)), tools


@pytest.mark.isolation
@pytest.mark.reference
@pytest.mark.parametrize("adapter_cls,kind,route,model", [
    (ClaudeCodeAdapter, "claude", "anthropic", "claude-opus-4-7"),
    (CodexAdapter, "codex", "openrouter", "google/gemini-3.1-flash-lite-preview"),
    (GeminiCliAdapter, "gemini", "google", "gemini-3.1-pro-preview"),
    (OpenCodeAdapter, "opencode", "vllm", "qwen36_vllm/Qwen/Qwen3.6-27B"),
    (OpenHandsAdapter, "openhands", "google", "gemini/gemini-3.1-flash-lite-preview"),
])
def test_adapter_end_to_end_with_replay(env, tmp_path, adapter_cls, kind, route, model):
    s, dv, tools = env
    ex = sorted(dv.examples(), key=lambda e: e["example_id"])[0]
    prompt = official_agentic_prompt()
    task_dir = tmp_path / "task"
    staged = stage_workspace(dv, LocalMediaStore(s.media_dir), ex["example_id"], task_dir, prompt=prompt,
                             instructions=rubric_extension_instructions())
    assert not staged.missing_media and all(f["pixels_verified"] for f in staged.files if f["kind"] == "image")
    md = staged.workspace / "agenthorizon_md" / f"{ex['example_id']}.md"
    assert md.read_bytes() == (dv.root / "raw" / ex["source_files"]["markdown"]["path"]).read_bytes()  # byte-identical
    assert not (stat.S_IMODE(md.stat().st_mode) & 0o222)
    adapter = adapter_cls(binary_override=str(tools / f"{kind}-replay"))
    run = HarnessRun(model=model, route=route, prompt_text=prompt.render(TRAJECTORY_ID=ex["example_id"]),
                     base_url="https://vllm.invalid/v1" if route == "vllm" else None)
    secrets = {"ANTHROPIC_API_KEY": "sk-ant-test-0000000000000000", "OPENROUTER_API_KEY": "sk-or-test-000000000000000000",
               "GEMINI_API_KEY": "AIzaTEST000000000000000000000000000000", "VLLM_API_KEY": "vllm-test-token-0001"}
    out = run_agentic_attempt(adapter, run, staged, secrets, run_dir=tmp_path, timeout_s=120,
                              extra_tool_dirs=[str(tools)])
    assert out.status == "completed", (out.error, out.artifacts)
    assert out.verdict.binary_valid and out.verdict.full_contract_valid
    assert "screenshot" in out.verdict.reasoning and "a screenshot" in out.verdict.reasoning
    t = out.telemetry
    assert t.wall_time_s is not None and t.coverage["wall_time_s"] == "reported"
    if kind == "claude":
        assert (t.input_tokens, t.tool_calls, t.images_viewed) == (1234, 2, 1)
    if kind == "codex":
        assert (t.input_tokens, t.tool_calls, t.images_viewed) == (999, 2, 1)
    if kind == "openhands":
        assert t.input_tokens is None and t.coverage["input_tokens"] == "unavailable"  # unknown stays unknown
    # the replay tried a non-allowlisted host; the proxy refused and logged it
    audit = json.loads((tmp_path / out.artifacts["egress_audit"].path).read_text())
    assert any(d["host"] == "example.com" and not d["allowed"] for d in audit)
    # secrets never land in stored artifacts or the audit copy of the sandbox spec
    for ref in out.artifacts.values():
        text = (tmp_path / ref.path).read_text(errors="ignore")
        for v in secrets.values():
            assert v not in text, ref.path
    assert out.lineage["staging_manifest_digest"] == staged.manifest_digest
