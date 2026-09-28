"""Regression tests for review findings on replay/ and traces/ (round 1)."""

from __future__ import annotations

import json

import pytest

from hexis_service.artifacts.efsm import load_machine
from hexis_service.artifacts.package import MachinePackage
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK
from hexis_service.replay.replay import replay
from hexis_service.traces.model import Record, Trace, export_run_trace
from hexis_service.traces.normalize import eligibility, normalize
from hexis_service.traces.update import apply_ops, policy_widening, propose_update

from ..conftest import approve, run_to_approval


@pytest.fixture
def archive(env, pkg):
    alice = env.principal("user:alice")
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.service.run_until_blocked(run_id, alice)
    h = env.service.start_run(pkg.artifact_hash, dict(TASK, supplier_ref="SUP-55555"), alice)
    env.service.run_until_blocked(h.run_id, alice)
    return [export_run_trace(env.service, run_id, alice, "accepted"),
            export_run_trace(env.service, h.run_id, alice, "accepted")]


def _step_of(t: Trace, state: str) -> int:
    return next(i for i, r in enumerate(t.records) if r.state == state)


# --------------------------------------------------------------------------- C29
def test_C29_deleted_record_rejected_by_replay_and_update(pkg, catalog, archive):
    t = archive[0]
    lines = t.to_jsonl().splitlines()
    idx = _step_of(t, "REPAIR_DRAFT")  # zero-width record: structural replay does not need it
    forged, errs = Trace.from_jsonl("\n".join(lines[:idx + 1] + lines[idx + 2:]) + "\n")
    assert any("records_digest mismatch" in e for e in errs)
    assert replay(pkg, forged, "structural").status == "REJECTED"
    assert replay(pkg, forged, "recorded").status == "REJECTED"
    prop = propose_update(pkg, forged, archive, [], catalog, R.FixtureAligner())
    assert prop.status == "EXCLUDED" and "integrity" in prop.diagnostics[0]
    # in-memory removal is caught too: the seal travels with the trace
    t2 = t.model_copy(deep=True)
    del t2.records[idx]
    assert replay(pkg, t2, "structural").status == "REJECTED"
    # an untampered load still passes
    ok, errs = Trace.from_jsonl(t.to_jsonl())
    assert errs == [] and replay(pkg, ok, "structural").status == "PASS"


# --------------------------------------------------------------------------- C30
def test_C30_derived_approval_resolves_states_for_stateless_traces(pkg):
    task = dict(TASK)
    x = R.ReferenceExecutor()
    d = x.tool("documents.read", {"document_ids": task["document_ids"]})
    lk = x.tool("supplier.lookup", {"supplier_ref": task["supplier_ref"], "business_unit": task["business_unit"]})
    draft = x.model_step("EXTRACT_DRAFT", {"documents": d["documents"], "supplier_ref": task["supplier_ref"],
                                           "business_unit": task["business_unit"],
                                           "required_fields": task["required_fields"],
                                           "existing_supplier": lk["existing"]})["draft"]
    v = x.tool("draft.validate", {"draft": draft, "required_fields": task["required_fields"],
                                  "policy_version": task["policy_version"]})
    x.user("approval", {"approval_decision": "approved"})
    x.user("input", {"supplier_ref": "SUP-OTHER"})  # approval-scoped variable changes after approval
    x.happy_tail(draft, v["draft_digest"], "SUP-OTHER")
    tr = x.trace("c30", task)
    assert all(not r.state for r in tr.records)
    codes = [(e["code"], e.get("requirement")) for e in eligibility(tr, pkg)]
    assert ("ORDERING_VIOLATION", "derived:approval:REQUEST_APPROVAL") in codes
    # without the post-approval scope change the derived requirement is satisfied
    ok = R.missing_docs_trace()
    assert not [e for e in eligibility(ok, pkg) if e.get("requirement") == "derived:approval:REQUEST_APPROVAL"]


# --------------------------------------------------------------------------- C31
def test_C31_missing_observable_model_output_is_a_placeholder(pkg, archive):
    md = pkg.machine.to_json()
    md["states"]["EXTRACT_DRAFT"]["action"]["observable"] = True
    p2 = MachinePackage(machine=load_machine(md), source_manifest=pkg.source_manifest,
                        compiler_manifest=pkg.compiler_manifest, contracts=pkg.contracts,
                        execution_policy=pkg.execution_policy).sealed()
    t = archive[0].model_copy(deep=True)
    i = _step_of(t, "EXTRACT_DRAFT")
    t.records[i].meta["observable"] = True
    t.records[i].output = {}
    rep = replay(p2, t.seal(), "structural")
    assert {"state": "EXTRACT_DRAFT", "variable": "draft", "reason": "model output missing from trace"} \
        in rep.placeholders


# --------------------------------------------------------------------------- X06
@pytest.mark.parametrize("kind", ["orchestration", "log", "tool_call"])
def test_X06_hidden_write_in_noise_or_unknown_record_rejected(pkg, catalog, archive, kind):
    t = archive[0]
    recs = [r.model_copy(deep=True) for r in t.records]
    recs.insert(1, Record(step=1000, action={"kind": kind, "name": "erp.create_draft",
                                             "input": {"supplier_ref": "EVIL"}},
                          output={"status": "created", "draft_id": "D-9"}))
    t2 = t.model_copy(update={"records": recs}, deep=True).seal()
    assert replay(pkg, t2, "structural").status == "REJECTED"
    assert any(v["code"] == "UNRECOGNIZED_RECORD" and v["step"] == 1000 for v in eligibility(t2, pkg))
    assert propose_update(pkg, t2, archive, [], catalog, R.FixtureAligner()).status == "EXCLUDED"


def test_X06_plain_noise_still_dropped(pkg, archive):
    t = archive[0]
    recs = [r.model_copy(deep=True) for r in t.records]
    recs.insert(1, Record(step=1000, action={"kind": "heartbeat"}))
    t2 = t.model_copy(update={"records": recs}, deep=True).seal()
    _, dropped = normalize(t2)
    assert {"step": 1000, "reason": "orchestration noise (heartbeat)"} in dropped
    assert replay(pkg, t2, "structural").status == "PASS" and eligibility(t2, pkg) == []


# --------------------------------------------------------------------------- X07
def test_X07_recorded_replay_binds_visible_record_to_observation(pkg, archive):
    t = archive[0].model_copy(deep=True)
    i = _step_of(t, "PERSIST_DRAFT")
    t.records[i].output = {**t.records[i].output, "draft_id": "D-FORGED"}
    t = t.seal()
    assert replay(pkg, t, "structural").status == "PASS"  # structural sees only the visible record
    rep = replay(pkg, t, "recorded")
    assert rep.status == "FAIL" and rep.divergence["record"] == t.records[i].step


def test_X07_recorded_replay_requires_checkpoint_digests(pkg, archive):
    t = archive[0].model_copy(deep=True)
    for r in t.records:
        r.meta.pop("checkpoint_digest_before", None)
        r.meta.pop("checkpoint_digest_after", None)
    v = _step_of(t, "VERIFY_PERSISTED")
    t.records[v].meta["observation"]["outputs"]["status"] = "mismatch"
    t.records[-1].meta["observation"]["state_id"] = "END_UNVERIFIED"
    rep = replay(pkg, t.seal(), "recorded")
    assert rep.status != "PASS"


# --------------------------------------------------------------------------- X08
def _edit_header(t: Trace, fn) -> tuple[Trace, list[str]]:
    lines = t.to_jsonl().splitlines()
    head = json.loads(lines[0])
    fn(head)
    return Trace.from_jsonl("\n".join([json.dumps(head, sort_keys=True)] + lines[1:]) + "\n")


def test_X08_header_fields_are_sealed(pkg, catalog, archive):
    t = archive[0]
    flipped, errs = _edit_header(t, lambda h: h.update(verdict="rejected"))
    assert any("header digest mismatch" in e for e in errs)
    assert replay(pkg, flipped, "structural").status == "REJECTED"

    def seed(h):
        h["task"]["initial_checkpoint"]["variables"]["repair_count"] = -10
    seeded, errs = _edit_header(t, seed)
    assert errs and replay(pkg, seeded, "structural").status == "REJECTED"
    assert propose_update(pkg, seeded, archive, [], catalog, R.FixtureAligner()).status == "EXCLUDED"


def test_X08_resealed_initial_counter_cannot_shift_loop_bound(pkg, archive):
    t = archive[0].model_copy(deep=True)
    t.task["initial_checkpoint"]["variables"]["repair_count"] = -10
    rep = replay(pkg, t.seal(), "structural")
    assert rep.status != "PASS" and "repair_count" in rep.detail


# --------------------------------------------------------------------------- X09
def test_X09_same_lid_distinct_writes_not_merged(pkg, archive):
    t = archive[0]
    recs = [r.model_copy(deep=True) for r in t.records]
    idx = _step_of(t, "PERSIST_DRAFT")
    w2 = recs[idx].model_copy(deep=True)
    w2.action["input"] = {"supplier_ref": "SUP-EVIL", "draft": {"x": 1}}
    w2.output = {"status": "created", "draft_id": "D-0999", "version": 1}
    new = recs[:idx + 1] + [w2] + recs[idx + 1:]
    for i, r in enumerate(new):
        r.step = i
    t2 = t.model_copy(update={"records": new}, deep=True).seal()
    events, _ = normalize(t2)
    assert len([e for e in events if e.tool == "erp.create_draft"]) == 2
    assert replay(pkg, t2, "structural").status == "FAIL"


def test_X09_merge_does_not_skip_over_other_records():
    t = R.duplicate_write_trace().model_copy(deep=True)
    t.records[1].meta["logical_action_id"] = t.records[0].meta["logical_action_id"]
    t.records[1].action["input"] = t.records[0].action["input"]
    t.records.insert(1, Record(step=99, action={"kind": "model"}, output={"draft": {}}, meta={"observable": False}))
    events, _ = normalize(t.seal())
    assert len([e for e in events if e.tool == "erp.create_draft"]) == 2


# --------------------------------------------------------------------------- X10
@pytest.mark.parametrize("clause,coverage", [
    ("S0.1", {"classification": "non_material", "justification": "x", "states": [], "critical": False}),
    ("S4.1", {"classification": "executable_control", "justification": "x", "states": ["REQUEST_APPROVAL"],
              "critical": False}),
    ("S3.1", {"classification": "executable_control", "justification": "x", "states": ["END_UNVERIFIED"],
              "critical": True}),
    ("S2.1", {"classification": "unsupported", "justification": "x", "states": [], "critical": False}),
])
def test_X10_set_coverage_cannot_weaken_clause(pkg, clause, coverage):
    cand = apply_ops(pkg, [{"op": "set_coverage", "clause": clause, "coverage": coverage}])
    findings = policy_widening(pkg, cand)
    assert any(clause in f for f in findings), findings


def test_X10_strengthening_coverage_allowed(pkg):
    cov = {"classification": "executable_control", "justification": "x", "states": ["READ_INTAKE"],
           "critical": False}
    cand = apply_ops(pkg, [{"op": "set_coverage", "clause": "S1.2", "coverage": cov}])
    assert policy_widening(pkg, cand) == []
