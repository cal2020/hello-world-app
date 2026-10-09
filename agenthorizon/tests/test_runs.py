"""Run orchestration: attempt policy fidelity, identity, resume/cancel/pause, budget, fault recovery, scoring.

Judges here are either the authors' own runners driven with scripted outcomes (policy cross-check), a scripted
TEST-ONLY judge (orchestration semantics), or the real adapters against replay stand-ins / local fake endpoints
(end-to-end wiring). No model is called and no result here is a benchmark measurement.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.data.media import LocalMediaStore
from agenthorizon.judging.contract import AttemptOutcome
from agenthorizon.judging.isolation.sandbox import isolation_available
from agenthorizon.judging.parsing import parse_agentic, parse_direct
from agenthorizon.runs.identity import RunDefinition
from agenthorizon.runs.judges import AgenticJudge, DirectJudge
from agenthorizon.runs.orchestrator import Orchestrator, RunControls, retry_errors, run_summary
from agenthorizon.runs.plan import RunConfig, preflight, resolve
from agenthorizon.runs.policy import POLICIES, classify, decide, select
from agenthorizon.runs.store import FileRunStore, RunLocked, RunStoreError
from agenthorizon.scoring.protocol import score
from agenthorizon.testing.fake_judge import ScriptedJudge
from agenthorizon.testing.fake_llm import openai_response
from agenthorizon.testing.fixture import build_fixture

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "tests" / "drivers" / "reference_attempt_driver.py"
AGENTIC, DIRECT = POLICIES["ah-reference-agentic/1"], POLICIES["ah-reference-direct/1"]
VALID = json.dumps({"success": False, "reasoning": "r", "confidence": "high", "mistake_type": "Critical Mistake"})
GARBAGE = "I examined every step of the recording closely and considered the instruction. " * 4  # >200 chars, no JSON
T = {"kind": "text"}


# ---- 1. attempt policy == the authors' runners -------------------------------------------------------------
def _simulate(policy, scenario, family):
    seq, calls, classes = list(scenario), 0, []
    while decide(policy, classes).action == "attempt":
        limited = 0
        while True:
            o = seq.pop(0)
            calls += 1
            if o["kind"] == "ratelimit":
                limited += 1
                if limited > policy.rate_limit_resends_per_attempt:
                    out = AttemptOutcome("rate_limited")
                    break
                continue
            if o["kind"] == "error":
                out = AttemptOutcome("process_failed" if family == "agentic" else "transport_failed")
            elif o["kind"] == "timeout":
                out = AttemptOutcome("timed_out")
            else:
                parse = parse_agentic if family == "agentic" else parse_direct
                out = AttemptOutcome("completed", response_text=o["text"], verdict=parse(o["text"]))
            break
        classes.append(classify(out, policy))
    n, has_resp = select(policy, list(enumerate(classes, 1)))
    return {"calls": calls, "saved": has_resp, "has_success": has_resp and classes[n - 1] == "verdict"}


AGENTIC_SCENARIOS = [
    [{**T, "text": VALID}],
    [{**T, "text": GARBAGE}, {**T, "text": VALID}],
    [{**T, "text": GARBAGE}] * 3,
    [{**T, "text": "eb.json) PM"}],  # short truncation: the runner bails out instead of retrying
    [{**T, "text": GARBAGE}, {**T, "text": "eb.json) PM"}],
    [{**T, "text": json.dumps({"success": "false", "reasoning": "x"})}],  # invalid value, but final: never re-run
    [{"kind": "error"}],
    [{"kind": "timeout"}],
    [{**T, "text": GARBAGE}, {"kind": "error"}],  # an earlier response is not kept when the last attempt errors
    [{"kind": "ratelimit"}] * 2 + [{**T, "text": VALID}],
    [{"kind": "ratelimit"}] * 11,
    [{"kind": "ratelimit"}] * 10 + [{**T, "text": VALID}],
]
DIRECT_SCENARIOS = [
    [{**T, "text": VALID}],
    [{**T, "text": "not json at all"}, {**T, "text": VALID}],
    [{**T, "text": "not json"}] * 3,
    [{"kind": "error"}, {**T, "text": VALID}],
    [{"kind": "error"}] * 3,
    [{"kind": "ratelimit"}] * 4 + [{**T, "text": VALID}],
    [{"kind": "ratelimit"}] * 5,
    [{"kind": "error"}, {"kind": "ratelimit"}] + [{**T, "text": "garbage"}] + [{**T, "text": VALID}],
    [{**T, "text": "{\"success\": 1}"}],
]


@pytest.mark.reference
@pytest.mark.parametrize("family,scenarios", [("agentic", AGENTIC_SCENARIOS), ("direct", DIRECT_SCENARIOS)])
def test_attempt_policy_matches_released_runner(reference_checkout, tmp_path, family, scenarios):
    sc = tmp_path / "scenarios.json"
    sc.write_text(json.dumps(scenarios))
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    r = subprocess.run([sys.executable, "-I", str(DRIVER), str(reference_checkout), family, str(sc), str(tmp_path / "w")],
                       capture_output=True, text=True, timeout=300, env=env, cwd=tmp_path)
    assert r.returncode == 0, r.stderr[-3000:]
    theirs = [json.loads(line) for line in r.stdout.splitlines() if line.startswith("{")]
    assert len(theirs) == len(scenarios)
    policy = AGENTIC if family == "agentic" else DIRECT
    for t, s in zip(theirs, scenarios, strict=True):
        ours = _simulate(policy, s, family)
        assert ours == {k: t[k] for k in ("calls", "saved", "has_success")}, (s, t, ours)


# ---- 2. orchestration semantics with a scripted judge ------------------------------------------------------
def _definition(ids, policy=AGENTIC, model="m-1", trial=1) -> RunDefinition:
    return RunDefinition(
        dataset_version_id="dv-test", dataset_input_digest="0" * 64, normalizer_version="n/1", synthetic_data=True,
        selection={"source": "explicit", "example_ids": sorted(ids), "official": False}, scoring_manifest_id=None,
        judge={"config_id": "test", "interface": "claude_code", "provider_model_id": model, "route": "anthropic"},
        prompt={"prompt_id": "p", "sha256": "s"}, instructions=None, preprocessing=None, staging_mode="paper-paths",
        attempt_policy=policy.to_dict(), execution={"timeout_s": 60, "isolation": "none"}, code={"core_digest": "c"},
        trial=trial, classification={"result_kind": "test_fixture"})


def _orch(tmp_path, ids, judge, *, policy=AGENTIC, controls=None, item_cost=None, definition=None):
    d = definition or _definition(ids, policy)
    store, _ = FileRunStore.create_or_open(tmp_path / "runs", d, {"budget_usd": (controls or RunControls()).budget_usd})
    return store, Orchestrator(store, judge, policy, controls=controls or RunControls(metered=False),
                               item_cost=item_cost or {}, price=None)


def test_identity_resume_only_identical(tmp_path):
    a = _definition(["e1", "e2"])
    assert a.run_id == _definition(["e2", "e1"]).run_id  # canonical
    assert a.run_id != _definition(["e1", "e2"], model="m-2").run_id  # a new model is a new run
    assert a.run_id != _definition(["e1", "e2"], trial=2).run_id  # repeated trials are separate identities
    FileRunStore.create_or_open(tmp_path, a, {})
    _, created = FileRunStore.create_or_open(tmp_path, a, {"budget_usd": 5})  # controls may change on resume
    assert not created
    tampered = tmp_path / a.run_id / "definition.json"
    d = json.loads(tampered.read_text())
    d["judge"]["provider_model_id"] = "other"
    tampered.write_text(json.dumps(d))
    with pytest.raises(RunStoreError):
        FileRunStore.create_or_open(tmp_path, a, {})


def test_policy_sequences_selection_and_no_rerun_of_valid_judgments(tmp_path):
    script = {"a": ["verdict:false"], "b": ["unparseable", "verdict:true"], "c": ["unparseable"] * 3,
              "d": ["process_failed"], "e": ["short"], "f": ["verdict:str"], "g": ["unparseable", "timed_out"]}
    judge = ScriptedJudge(script)
    store, orch = _orch(tmp_path, list(script), judge, controls=RunControls(concurrency=3, metered=False))
    summary = orch.run()
    assert summary["status"] == "completed"
    calls = {}
    for eid, n in judge.calls:
        calls[eid] = max(calls.get(eid, 0), n)
    assert calls == {"a": 1, "b": 2, "c": 3, "d": 1, "e": 1, "f": 1, "g": 2}
    fin = {e: store.final(e) for e in script}
    assert fin["a"]["selected_attempt"] == 1 and fin["a"]["has_response"]  # wrong-looking verdict is never re-run
    assert fin["b"]["selected_attempt"] == 2
    assert fin["c"]["selected_attempt"] == 3 and fin["c"]["final_class"] == "unparseable"
    assert not fin["d"]["has_response"] and not fin["g"]["has_response"]
    ps = store.prediction_set()
    assert {r.example_id for r in ps.records} == {"a", "b", "c", "e", "f"}  # d, g missing
    by = ps.by_id()
    assert by["f"].verdict.has_success_key and not by["f"].verdict.binary_valid
    # every attempt is retained, and the event log is gap-free
    assert sum(len(store.attempts(e)) for e in script) == len(judge.calls)
    seqs = [e["seq"] for e in store.events()]
    assert seqs == list(range(1, len(seqs) + 1))


def test_crash_recovery_records_interrupted_and_never_duplicates_finals(tmp_path):
    ids = ["x1", "x2", "x3"]
    store, orch = _orch(tmp_path, ids, ScriptedJudge())
    store.begin_attempt("x2", 1, "dead-worker")  # a worker died mid-attempt
    store.finalize("x3", {"selected_attempt": None, "has_response": False, "final_class": None})  # finalized earlier
    orch.run()
    recs = store.attempts("x2")
    assert [(r.attempt_no, r.status, r.counts_toward_limit) for r in recs] == [(1, "interrupted", False), (2, "completed", True)]
    assert store.final("x2")["selected_attempt"] == 2
    assert store.attempts("x3") == []  # an already-finalized task is never re-executed
    with pytest.raises(RunStoreError):
        store.finalize("x2", {"selected_attempt": 1})


def test_killed_worker_process_resumes_without_duplicates(tmp_path):
    ids = [f"k{i}" for i in range(8)]
    store, _ = FileRunStore.create_or_open(tmp_path / "runs", _definition(ids), {})
    proc = subprocess.Popen([sys.executable, "-m", "agenthorizon.testing.fake_judge", str(tmp_path / "runs"), store.run_id,
                             "0.4", "2"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:  # wait until some tasks finished and others are in flight
        finals = sum(1 for e in ids if store.final(e))
        if finals >= 2 and any(e["type"] == "attempt_started" for e in store.events(after=0)[-3:]):
            break
        time.sleep(0.05)
    os.kill(proc.pid, signal.SIGKILL)
    proc.wait(timeout=10)
    finals_before = {e: store.final(e) for e in ids if store.final(e)}
    assert 2 <= len(finals_before) < len(ids)
    summary = Orchestrator(store, ScriptedJudge(), AGENTIC, controls=RunControls(concurrency=2, metered=False),
                           item_cost={}, price=None).run()
    assert summary["status"] == "completed"
    for e in ids:
        recs = store.attempts(e)
        assert sum(1 for r in recs if r.counts_toward_limit) == 1  # exactly one judgment per item
        if e in finals_before:
            assert store.final(e) == finals_before[e]  # finalized results untouched
    interrupted = [r for e in ids for r in store.attempts(e) if r.status == "interrupted"]
    assert interrupted and all(r.worker == "subprocess-worker" for r in interrupted)
    assert any(ev["type"] == "recovered_interrupted" for ev in store.events())


def test_cancel_stops_running_attempts_and_resume_completes(tmp_path):
    ids = [f"c{i}" for i in range(6)]
    judge = ScriptedJudge(delay_s=5.0)
    store, orch = _orch(tmp_path, ids, judge, controls=RunControls(concurrency=2, metered=False, poll_s=0.05))
    t = threading.Thread(target=orch.run)
    t.start()
    while not any(ev["type"] == "attempt_started" for ev in store.events()):
        time.sleep(0.02)
    store.request("cancel", by="tester", reason="test")
    t.join(timeout=20)
    assert not t.is_alive()
    st = run_summary(store)
    assert st["status"] == "cancelled"
    cancelled = [r for e in ids for r in store.attempts(e) if r.status == "cancelled"]
    assert cancelled and all(not r.counts_toward_limit for r in cancelled)
    assert not any(store.final(e) for e in ids)
    with pytest.raises(RunLocked):  # another process cannot execute the same run concurrently
        with store.execution_lock():
            with FileRunStore(store.dir).execution_lock():
                pass
    summary = Orchestrator(store, ScriptedJudge(), AGENTIC, controls=RunControls(concurrency=2, metered=False),
                           item_cost={}, price=None).run()
    assert summary["status"] == "completed"
    assert all(store.final(e)["has_response"] for e in ids)


def test_pause_lets_running_attempts_finish(tmp_path):
    ids = [f"p{i}" for i in range(6)]
    store, orch = _orch(tmp_path, ids, ScriptedJudge(delay_s=0.3), controls=RunControls(concurrency=2, metered=False, poll_s=0.02))
    t = threading.Thread(target=orch.run)
    t.start()
    while not any(ev["type"] == "attempt_started" for ev in store.events()):
        time.sleep(0.01)
    store.request("pause", by="tester")
    t.join(timeout=20)
    st = run_summary(store)
    assert st["status"] == "paused"
    recs = [r for e in ids for r in store.attempts(e)]
    assert recs and all(r.status == "completed" for r in recs)  # in-flight attempts completed, none cancelled
    assert 0 < sum(1 for e in ids if store.final(e)) < len(ids)


def test_budget_reservation_pauses_and_resume_with_higher_budget(tmp_path):
    ids = [f"b{i}" for i in range(5)]
    controls = RunControls(concurrency=1, budget_usd=2.5, metered=True)
    from agenthorizon.runs.pricing import PRICES

    price = PRICES[("anthropic", "claude-haiku-4-5")]  # 1000 in / 100 out tokens per scripted attempt -> $0.0015
    store, _ = FileRunStore.create_or_open(tmp_path / "runs", _definition(ids), {"budget_usd": 2.5})
    orch = Orchestrator(store, ScriptedJudge(tokens=None), AGENTIC, controls=controls,
                        item_cost={e: 1.0 for e in ids}, price=price)
    s = orch.run()
    assert s["status"] == "paused" and "budget exhausted" in s["reason"]
    assert sum(1 for e in ids if store.final(e)) == 2  # unknown usage keeps each $1 reservation as a charge
    b = store.state()["budget"]
    assert b["committed_usd"] <= 2.5 and b["unknown_cost_attempts"] == 2
    s2 = Orchestrator(store, ScriptedJudge(), AGENTIC, controls=RunControls(budget_usd=10.0, metered=True),
                      item_cost={e: 1.0 for e in ids}, price=price).run()
    assert s2["status"] == "completed"
    b2 = store.state()["budget"]
    assert abs(b2["spent_estimated_usd"] - 3 * (1000 * 1.0 + 100 * 5.0) / 1e6) < 1e-9  # token-priced settlements
    assert b2["reserved_usd"] == 0


def test_blocked_pauses_run_instead_of_mass_missing(tmp_path):
    ids = ["z1", "z2", "z3"]
    store, orch = _orch(tmp_path, ids, ScriptedJudge(default="blocked"))
    s = orch.run()
    assert s["status"] == "paused" and "blocked" in s["reason"]
    assert not any(store.final(e) for e in ids)
    s2 = Orchestrator(store, ScriptedJudge(), AGENTIC, controls=RunControls(metered=False), item_cost={}, price=None).run()
    assert s2["status"] == "completed"
    assert store.final("z1")["counted_attempts"] == 1


def test_retry_errors_is_explicit_bounded_and_skips_responses(tmp_path):
    script = {"r1": ["process_failed", "verdict:true"], "r2": ["unparseable"] * 3, "r3": ["timed_out", "timed_out"]}
    store, orch = _orch(tmp_path, list(script), ScriptedJudge(script))
    orch.run()
    assert not store.final("r1")["has_response"] and store.final("r2")["has_response"]
    reopened = retry_errors(store, AGENTIC, by="tester", reason="infrastructure outage")
    assert sorted(reopened) == ["r1", "r3"]  # r2 produced responses (invalid) and is never eligible
    again = ScriptedJudge({"r1": ["verdict:true"], "r3": ["timed_out"]})
    Orchestrator(store, again, AGENTIC, controls=RunControls(metered=False), item_cost={}, price=None).run()
    assert sorted(again.calls) == [("r1", 3), ("r3", 3)]  # attempt 2 is the audited re-open marker
    assert store.final("r1")["has_response"] and store.final("r1")["selected_attempt"] == 3
    assert not store.final("r3")["has_response"]
    assert (store.dir / "tasks" / "r1" / "final.superseded-1.json").is_file()
    assert retry_errors(store, AGENTIC, by="tester", reason="again") == []  # one pass per policy


# ---- 3. planning / dry run on the ingested synthetic fixture ------------------------------------------------
@pytest.fixture(scope="module")
def ingested(tmp_path_factory):
    base = tmp_path_factory.mktemp("runs-dv")
    fx = base / "fx"
    build_fixture(fx)
    s = Settings(var_dir=base / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=fx, media="all"))
    return s, DatasetVersion(Path(r.root))


@pytest.mark.reference
def test_dry_run_plan_is_honest_about_blocks_cost_and_classification(ingested):
    s, dv = ingested
    full = next(m for m in dv.manifests() if m.partition == "full-release")
    cfg = RunConfig(dataset_version=dv.id, judge_config="claude_code:claude-opus-4.7", manifest=full.manifest_id)
    d1, info = resolve(s, cfg)
    d2, _ = resolve(s, cfg)
    assert d1.run_id == d2.run_id and d1.judge["provider_model_id"] == "claude-opus-4-7"
    assert d1.classification["result_kind"] == "test_fixture"
    assert any("AGENTS.md" in r for r in d1.classification["reasons"])
    plan = preflight(s, d1, dv, info["problems"], budget_usd=None, environ={})
    assert not plan["ready_for_live_run"]
    assert any("ANTHROPIC_API_KEY" in b for b in plan["blocked"])
    assert plan["checks"]["budget"]["ok"] is False
    assert "S8.T1" in plan["forecast"]["basis"] and plan["forecast"]["price"]["input_per_mtok"] == 5.0
    assert plan["forecast"]["total_cost_usd"] > 0
    smoke = RunConfig(dataset_version=dv.id, judge_config="claude_code:claude-opus-4.7", manifest=full.manifest_id, smoke_n=3)
    d3, _ = resolve(s, smoke)
    assert len(d3.example_ids) == 3 and d3.selection["source"] == "engineering-smoke" and d3.run_id != d1.run_id
    unresolved, info4 = resolve(s, RunConfig(dataset_version=dv.id, judge_config="codex:gpt-5.5", manifest=full.manifest_id))
    assert any("model identifier" in p for p in info4["problems"])


# ---- 4. end to end through the real adapters, scored ---------------------------------------------------------
REPLAY = ROOT / "src" / "agenthorizon" / "testing" / "replay_harness.py"


@pytest.mark.isolation
@pytest.mark.reference
def test_agentic_run_end_to_end_in_sandbox_and_scored(ingested, tmp_path):
    ok, why = isolation_available()
    if not ok:
        pytest.skip(why)
    s, dv = ingested
    tools = tmp_path / "replay-tools"
    tools.mkdir()
    shutil.copy(REPLAY, tools / "replay_harness.py")
    w = tools / "claude-replay"
    w.write_text(f'#!/bin/sh\nAH_REPLAY_KIND=claude exec /usr/bin/python3 -I {tools}/replay_harness.py "$@"\n')
    w.chmod(0o755)
    full = next(m for m in dv.manifests() if m.partition == "full-release")
    d, _ = resolve(s, RunConfig(dataset_version=dv.id, judge_config="claude_code:claude-opus-4.7", manifest=full.manifest_id,
                                smoke_n=4, timeout_s=120))
    from agenthorizon.judging.harnesses import ClaudeCodeAdapter

    judge = AgenticJudge(d, dv, LocalMediaStore(s.media_dir), {"ANTHROPIC_API_KEY": "sk-ant-test-0000000000000000"},
                         adapter=ClaudeCodeAdapter(binary_override=str(w)), extra_tool_dirs=[str(tools)])
    store, _ = FileRunStore.create_or_open(s.runs_dir, d, {})
    summary = Orchestrator(store, judge, AGENTIC, controls=RunControls(concurrency=2, metered=False), item_cost={},
                           price=None).run()
    assert summary["status"] == "completed" and summary["finalized_by_class"] == {"verdict": 4}
    rep = score(PrivateStore(s.private_dir, dv.id).scoring_manifest(full), store.prediction_set(dv.example_ids()))
    outcomes = rep["_per_item_outcome"]
    assert sum(1 for o in outcomes.values() if o.startswith("valid:")) == 4
    assert rep["coverage"]["of"] == len(full.example_ids) and not rep["coverage"]["complete"]  # the rest are missing
    for e in d.example_ids:  # each attempt ran in its own fresh workspace containing only its own trajectory
        ws = store.task_dir(e, 1) / "workspace" / "agenthorizon_md"
        assert [p.name for p in ws.iterdir()] == [f"{e}.md"]


def test_direct_run_end_to_end_against_fake_endpoint_and_scored(ingested):
    s, dv = ingested
    full = next(m for m in dv.manifests() if m.partition == "full-release")
    d, _ = resolve(s, RunConfig(dataset_version=dv.id, judge_config="direct:qwen3.6-27b:native-512x332",
                                manifest=full.manifest_id, smoke_n=5, base_url="https://vllm.test/v1"))
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        n_img = sum(1 for c in body["messages"][1]["content"] if c["type"] == "image_url")
        return httpx.Response(200, json=openai_response(VALID if n_img % 2 else "no verdict here"))

    from agenthorizon.judging.direct.providers import OpenAICompatibleProvider

    prov = OpenAICompatibleProvider("vllm", "https://vllm.test/v1", "EMPTY", transport=httpx.MockTransport(handler))
    judge = DirectJudge(d, dv, LocalMediaStore(s.media_dir), {}, provider=prov)
    store, _ = FileRunStore.create_or_open(s.runs_dir, d, {})
    summary = Orchestrator(store, judge, DIRECT, controls=RunControls(concurrency=2, metered=False), item_cost={},
                           price=None).run()
    assert summary["status"] == "completed"
    for e in d.example_ids:
        recs = store.attempts(e)
        fin = store.final(e)
        if fin["final_class"] == "unparseable":
            assert len(recs) == 3  # parse failures get fresh attempts up to the cap, then are scored invalid
        else:
            assert len(recs) == 1
    assert all(b["model"] == "Qwen/Qwen3.6-27B" and b["temperature"] == 0.0 for b in seen)
    rep = score(PrivateStore(s.private_dir, dv.id).scoring_manifest(full), store.prediction_set(dv.example_ids()))
    outcomes = rep["_per_item_outcome"]
    assert sum(1 for o in outcomes.values() if o != "missing") == 5
    invalid = [e for e in d.example_ids if outcomes[e].startswith("invalid:")]
    assert invalid == [e for e in d.example_ids if store.final(e)["final_class"] == "unparseable"]
