"""CLI workflow on the synthetic fixture: ingest -> dry run -> run (local fake endpoint) -> score -> export.

The "model" is a local fake OpenAI-compatible endpoint (TEST ONLY); every number produced here is test output.
"""

from __future__ import annotations

import io
import json
import tarfile

import pytest
from typer.testing import CliRunner

from agenthorizon.config import reset_settings_cache
from agenthorizon.testing.fake_llm import FakeLLMServer, openai_response

VALID = json.dumps({"success": True, "reasoning": "r", "confidence": "high", "mistake_type": None})


@pytest.fixture()
def cli(tmp_path, monkeypatch):
    # Reuse the pinned checkouts (prompts are read from them) instead of cloning inside the test.
    from agenthorizon.config import Settings
    from agenthorizon.sources.cache import locked_revision

    pinned = Settings().sources_dir
    if not (pinned / f"ServiceNow__agenthorizon@{locked_revision('agenthorizon-repo')}" / ".git").exists():
        pytest.skip("pinned authors' checkout unavailable (agenthorizon sources checkout agenthorizon-repo)")
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "sources").symlink_to(pinned, target_is_directory=True)
    monkeypatch.setenv("AH_VAR_DIR", str(tmp_path / "var"))
    for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "VLLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    reset_settings_cache()
    from agenthorizon.cli import app

    runner = CliRunner()

    def invoke(*args, ok=True):
        r = runner.invoke(app, list(args), catch_exceptions=False)
        if ok:
            assert r.exit_code == 0, r.output
        return r

    yield invoke, tmp_path
    reset_settings_cache()


def test_cli_ingest_plan_run_score_export(cli):
    invoke, tmp = cli
    invoke("fixture", "build", "--out", str(tmp / "fx"))
    out = invoke("data", "ingest", "--source", "local", "--local-dir", str(tmp / "fx"), "--media", "all").output
    dv = json.loads(out[out.index("{"):])["dataset_version_id"]
    manifest = f"{dv}:full-release"

    # paid route without credentials or budget: planned, never executed
    r = invoke("run", "--dataset-version", dv, "--judge", "claude_code:claude-opus-4.7", "--manifest", manifest,
               "--smoke", "3", ok=False)
    assert r.exit_code == 3 and "NOT EXECUTED" in r.output and "ANTHROPIC_API_KEY" in r.output
    assert not list((tmp / "var" / "runs").glob("run-*"))  # nothing was created for a blocked run

    with FakeLLMServer() as srv:
        srv.default = (200, {}, openai_response(VALID, model="Qwen/Qwen3.6-27B"))
        dry = invoke("run", "--dataset-version", dv, "--judge", "direct:qwen3.6-27b:native-512x332", "--manifest", manifest,
                     "--smoke", "4", "--base-url", f"{srv.url}/v1", "--dry-run").output
        plan = json.loads(dry[dry.index("{"):dry.index("\nforecast")])
        assert plan["ready_for_live_run"] and plan["classification"]["result_kind"] == "test_fixture"
        assert not srv.requests  # a dry run sends nothing
        live = invoke("run", "--dataset-version", dv, "--judge", "direct:qwen3.6-27b:native-512x332", "--manifest",
                      manifest, "--smoke", "4", "--base-url", f"{srv.url}/v1").output
        assert '"status": "completed"' in live and len(srv.requests) == 4
    run_id = plan["run_id"]
    assert f"resuming {run_id}" not in live and f"created {run_id}" in live
    listed = invoke("runs", "list").output
    assert run_id in listed and "completed" in listed

    rep_path = tmp / "score.json"
    md = invoke("score", "--run", run_id, "--output", str(rep_path)).output
    rep = json.loads(rep_path.read_text())
    assert rep["warning"].startswith("SYNTHETIC") and rep["run_id"] == run_id
    assert rep["coverage"]["of"] == 15 and not rep["coverage"]["complete"]  # canonical score counts 11 missing
    assert rep["selection_subset"]["coverage"]["of"] == 4
    assert "SYNTHETIC" in md

    b1, b2 = tmp / "b1.tar.gz", tmp / "b2.tar.gz"
    e1 = json.loads(invoke("export", "--run", run_id, "--output", str(b1), "--with-score").output)
    e2 = json.loads(invoke("export", "--run", run_id, "--output", str(b2), "--with-score").output)
    assert e1["sha256"] == e2["sha256"]  # deterministic bytes
    with tarfile.open(fileobj=io.BytesIO(b1.read_bytes())) as tar:
        names = tar.getnames()
        man = json.loads(tar.extractfile("MANIFEST.json").read())
        preds = tar.extractfile("predictions.jsonl").read().decode().splitlines()
    assert {"run/definition.json", "run/attempts.jsonl", "score/report.json", "provenance.json"} <= set(names)
    assert len(preds) == 4 and all(json.loads(p)["success"] is True for p in preds)
    assert all(f["sha256"] for f in man["files"])
