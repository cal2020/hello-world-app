"""Replay modes and trace-driven refinement: A12-A18, A30 (recorded), A31."""

from __future__ import annotations

import socket

import pytest

from hexis_service.artifacts.registry import admit
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK, skill_source
from hexis_service.replay.replay import replay
from hexis_service.traces.model import Trace, export_run_trace
from hexis_service.traces.normalize import normalize
from hexis_service.traces.update import apply_ops, archive_manifest, evaluate_candidate, propose_update

from ..conftest import approve, run_to_approval


@pytest.fixture
def archive(env, pkg):
    """Protected traces from real runs: verified path (with repair) and registry-conflict review path."""
    alice = env.principal("user:alice")
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.service.run_until_blocked(run_id, alice)
    h = env.service.start_run(pkg.artifact_hash, dict(TASK, supplier_ref="SUP-55555"), alice)
    env.service.run_until_blocked(h.run_id, alice)
    return [export_run_trace(env.service, run_id, alice, "accepted"),
            export_run_trace(env.service, h.run_id, alice, "accepted")]


def test_protected_run_traces_pass_both_modes(pkg, archive):
    for t in archive:
        assert replay(pkg, t, "structural").status == "PASS"
        assert replay(pkg, t, "recorded").status == "PASS"


def test_A12_structural_placeholders_marked_never_evidence(pkg, archive):
    rep = replay(pkg, archive[0], "structural")
    assert rep.status == "PASS"
    assert {p["state"] for p in rep.placeholders} == {"EXTRACT_DRAFT", "REPAIR_DRAFT"}
    assert all("zero-width" in p["reason"] for p in rep.placeholders)
    # a trace missing the approval response still gets placeholders, not a fabricated approval
    t = archive[0].model_copy(deep=True)
    for r in t.records:
        if r.action.get("kind") == "user":
            r.output = {}
    t = t.seal()
    rep2 = replay(pkg, t, "structural")
    assert any(p["reason"] == "user response missing" for p in rep2.placeholders)
    assert "evidence" not in rep2.to_json()


def test_A13_recorded_replay_blocks_external_calls(env, pkg, archive):
    before = env.erp.count("acme")

    def rogue(cp, obs):
        socket.create_connection(("example.com", 443), timeout=1)

    rep = replay(pkg, archive[0], "recorded", on_step=rogue)
    assert rep.status == "ERROR" and "EXTERNAL_CALL_ATTEMPTED" in rep.detail
    assert env.erp.count("acme") == before


def test_A30_recorded_replay_reproduces_exactly(pkg, archive):
    reps = [replay(pkg, archive[0], "recorded").to_json() for _ in range(3)]
    assert reps[0]["status"] == "PASS" and reps[0] == reps[1] == reps[2]


def test_A31_tampered_or_incomplete_traces(pkg, archive):
    t = archive[0]
    bad = Trace.from_jsonl(t.to_jsonl().replace('"approved"', '"rejected"', 1))
    assert bad[1]  # integrity errors reported at load
    assert replay(pkg, bad[0], "structural").status == "REJECTED"
    assert replay(pkg, bad[0], "recorded").status == "REJECTED"
    stripped = t.model_copy(deep=True)
    stripped.records[3].meta.pop("observation")
    stripped = stripped.seal()
    rep = replay(pkg, stripped, "recorded")
    assert rep.status == "INCOMPLETE"


def test_A31_tampered_trace_excluded_from_update(pkg, catalog, archive):
    t = R.missing_docs_trace()
    forged = Trace.from_jsonl(t.to_jsonl().replace('"missing"', '"available"', 1))[0]
    prop = propose_update(pkg, forged, archive, [], catalog, R.FixtureAligner())
    assert prop.status == "EXCLUDED" and "integrity" in prop.diagnostics[0]


def test_new_trace_accepted_and_admitted_atomically(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    assert replay(pkg, dev, "structural").status == "FAIL"
    prop = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)
    assert prop.status == "CANDIDATE", prop.gates
    assert prop.gates["protected_replay"]["count"] == 2
    assert prop.diff["states_added"] == ["REQUEST_INPUT"] and prop.diff["newly_reachable_effects"] == []
    assert prop.candidate.lineage.parent_hash == pkg.artifact_hash
    res = admit(env.store, prop.candidate, catalog, expected_parent_hash=pkg.artifact_hash,
                approver=env.principal("user:dana"), environment="sandbox",
                archive_manifest=archive_manifest(archive + [dev], []), now=env.clock(), skill_text=skill_source().text)
    assert res.status == "ADMITTED" and res.archive_version == 2
    assert env.store.get_active("sandbox", "supplier-onboarding-draft") == (prop.candidate.artifact_hash, 2)
    assert len(env.store.archive("supplier-onboarding-draft")["protected"]) == 3


def test_A14_candidate_breaking_protected_trace_rejected(env, pkg, catalog, archive):
    active = env.store.get_active("sandbox", "supplier-onboarding-draft")
    manifest = env.store.archive("supplier-onboarding-draft")
    before = pkg.compute_hash()
    prop = propose_update(pkg, R.missing_docs_trace(), archive, [], catalog, R.BreakingAligner(), skill_source().text)
    assert prop.status == "REJECTED" and len(prop.attempts) == 2 and prop.attempts[1]["restrictive"]
    assert prop.gates["new_trace_replay"]["passed"] and not prop.gates["protected_replay"]["passed"]
    fail = prop.gates["protected_replay"]["failures"][0]
    assert fail["divergence"]["actual_state"] and fail["divergence"]["trace_id"] == archive[1].trace_id
    assert pkg.compute_hash() == before and "REQUEST_INPUT" not in pkg.machine.states
    assert env.store.get_active("sandbox", "supplier-onboarding-draft") == active
    assert env.store.archive("supplier-onboarding-draft") == manifest


def test_A15_correct_answer_via_forbidden_action_goes_to_negative_corpus(pkg, catalog, archive):
    t = R.forbidden_write_trace()
    assert t.records[-1].action["terminal"] == "END_VERIFIED_DRAFT"  # the "answer" was right
    prop = propose_update(pkg, t, archive, [], catalog, R.FixtureAligner())
    assert prop.status == "EXCLUDED" and prop.negative_additions == [t.trace_id]
    assert any("ORD-APPROVAL-BEFORE-WRITE" in d for d in prop.diagnostics)


def test_A16_distinct_writes_never_merged(pkg):
    events, _ = normalize(R.duplicate_write_trace())
    writes = [e for e in events if e.tool == "erp.create_draft"]
    assert len(writes) == 2 and writes[0].inputs != writes[1].inputs
    # the same logical operation (transport retry of one action) is merged, keeping both records
    t = R.duplicate_write_trace().model_copy(deep=True)
    t.records[1].meta["logical_action_id"] = t.records[0].meta["logical_action_id"]
    t.records[1].action["input"] = t.records[0].action["input"]
    ev2, _ = normalize(t.seal())
    merged = [e for e in ev2 if e.tool == "erp.create_draft"]
    assert len(merged) == 1 and merged[0].source_steps == [0, 1]


def test_A17_shortcut_and_approval_removal_rejected(pkg, catalog, archive):
    sc = R.shortcut_trace()
    p = propose_update(pkg, sc, archive, [], catalog, R.ShortcutAligner())
    assert p.status == "EXCLUDED"
    cand = apply_ops(pkg, R.ShortcutAligner().propose({}))
    gates = evaluate_candidate(pkg, cand, sc, archive, [sc], catalog)
    assert not gates["passed"] and not gates["static_validation"]["passed"] and not gates["negative_corpus"]["passed"]
    # an update that removes the approval interaction is a policy change, not a trace refinement
    no_approval = cand.model_copy(deep=True)
    no_approval.contracts.interactions.pop("REQUEST_APPROVAL")
    no_approval = no_approval.sealed()
    g2 = evaluate_candidate(pkg, no_approval, sc, archive, [], catalog)
    assert any("REQUEST_APPROVAL" in f for f in g2["policy_non_widening"]["findings"])


def test_mismatched_semantic_match_rejected_by_independent_validation(pkg, catalog, archive):
    prop = propose_update(pkg, R.missing_docs_trace(), archive, [], catalog, R.MismatchAligner())
    assert prop.status == "REJECTED"
    assert any("incompatible regardless of rationale" in e for a in prop.attempts for e in a["op_errors"])


def test_A18_racing_updates_one_wins_other_must_rebase(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    p1 = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)

    class VariantAligner(R.FixtureAligner):
        def propose(self, ctx):
            ops = super().propose(ctx)
            for o in ops:
                if o["op"] == "add_state":
                    o["state"] = {**o["state"], "action": {**o["state"]["action"], "prompt": "Please re-send ids."}}
            return ops
    p2 = propose_update(pkg, dev, archive, [], catalog, VariantAligner(), skill_source().text)
    assert p1.candidate.artifact_hash != p2.candidate.artifact_hash
    kw = dict(approver=env.principal("user:dana"), environment="sandbox",
              archive_manifest=archive_manifest(archive + [dev], []), now=env.clock(), skill_text=skill_source().text)
    r1 = admit(env.store, p1.candidate, catalog, expected_parent_hash=pkg.artifact_hash, **kw)
    r2 = admit(env.store, p2.candidate, catalog, expected_parent_hash=pkg.artifact_hash, **kw)
    assert (r1.status, r2.status) == ("ADMITTED", "CONFLICT")
    assert env.store.get_active("sandbox", "supplier-onboarding-draft")[0] == p1.candidate.artifact_hash
    # rebase: rerun all gates against the new parent; the trace is now already represented
    rebased = propose_update(p1.candidate, dev, archive + [dev], [], catalog, VariantAligner(), skill_source().text)
    assert rebased.status == "NO_CHANGE"


def test_admission_requires_admin_and_valid_package(env, pkg, catalog):
    r = admit(env.store, pkg, catalog, expected_parent_hash=None, approver=env.principal("user:alice"),
              environment="sandbox", archive_manifest={}, now=env.clock())
    assert r.status == "REJECTED" and "artifact_admin" in r.reasons[0]
