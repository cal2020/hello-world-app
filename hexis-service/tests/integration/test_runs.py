"""End-to-end run behavior through the persisted service: A05, A06, A10, A19-A21, A25, A28, A29, A32."""

from __future__ import annotations

import pytest

from hexis_service.artifacts.registry import revoke
from hexis_service.demo import fakes
from hexis_service.demo.env import TASK
from hexis_service.runtime.service import RunError

from ..conftest import approve, run_to_approval, step_until_state


def writes(env):
    return env.erp.count("acme")


def test_happy_path_verified_with_scoped_evidence(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    assert res.status == "WAITING_FOR_APPROVAL"
    assert writes(env) == 0  # nothing written before approval
    approve(env, run_id, res.interaction)
    res = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert res.status == "COMPLETED"
    out = res.checkpoint.outcome
    assert out["terminal"] == "END_VERIFIED_DRAFT" and out["category"] == "verified"
    assert out["evidence_receipts"] == [out["outputs"]["verification_receipt"]]
    assert "Does not establish that extracted commercial facts are true" in res.checkpoint.assurance.verification_scope
    ev = env.store.evidence("acme", run_id)
    claims = {(e["claim"], e["result"], e["invalidated_at"] is None) for e in ev}
    # first validation (repairable) invalidated by the repair; second passed; verifier matched
    assert ("draft_satisfies_onboarding_policy", "repairable", False) in claims
    assert ("draft_satisfies_onboarding_policy", "pass", True) in claims
    assert ("persisted_draft_matches_approved_payload", "match", True) in claims
    assert writes(env) == 1


def test_A05_invalid_task_input_no_dispatch(env, pkg):
    with pytest.raises(RunError) as e:
        env.service.start_run(pkg.artifact_hash, dict(TASK, document_ids="DOC-W9-10042"), env.principal("user:alice"))
    assert e.value.code == "TASK_INPUT_INVALID"
    assert env.store.qa("SELECT COUNT(*) FROM action_receipts")[0][0] == 0


def test_A05_broker_rejects_wrong_input_type_before_connector(env, pkg):
    called = []
    env.broker.connectors["erp.read_draft"] = lambda a, c: called.append(a) or {}
    intent = {"tenant_id": "acme", "run_id": "nope", "logical_action_id": "la_x", "tool": "erp.read_draft",
              "tool_version": "1.0.0", "args": {"draft_id": 7}, "args_digest": "d", "idempotency_key": "k",
              "status": "PENDING", "attempts": 0}
    ok, why = env.broker.authorize(intent=intent, spec=env.catalog.get("erp.read_draft"),
                                   principal=env.principal("user:alice"), package=pkg, business_unit="BU-EMEA",
                                   approval_check=lambda: (True, ""), lease_token=None)
    assert not ok and called == []


def test_A10_repairs_exhausted_end_unverified(env, pkg):
    task = dict(TASK, document_ids=["DOC-W9-10042"])  # no contact email anywhere: repair cannot fix
    p = env.principal("user:alice")
    h = env.service.start_run(pkg.artifact_hash, task, p)
    res = env.service.run_until_blocked(h.run_id, p)
    assert res.checkpoint.outcome["terminal"] == "END_UNVERIFIED"
    path = env.service.inspect_run(h.run_id, p)["path"]
    assert path.count("VALIDATE_DRAFT->REPAIR_DRAFT") == 2  # exactly two repair entries
    assert res.checkpoint.variables["repair_count"] == 2
    assert writes(env) == 0


def test_A19_process_exit_while_waiting_resumes(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    ix = res.interaction
    env2 = env.restart()  # new store connection, broker, service over the same files
    approve(env2, run_id, ix)
    out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    # duplicate resume delivery is rejected/ignored, never double-applied
    with pytest.raises(RunError):
        approve(env2, run_id, ix)


def test_approval_authentication_rules(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    ix = res.interaction
    for who, code in (("user:alice", "NOT_AUTHORIZED"), ("user:carol", "NOT_AUTHORIZED")):
        with pytest.raises(RunError) as e:
            approve(env, run_id, ix, who)
        assert e.value.code == code
    with pytest.raises(RunError) as e:  # other tenant cannot even see the run
        approve(env, run_id, ix, "user:mallory")
    assert e.value.code == "NOT_FOUND"
    with pytest.raises(RunError) as e:  # approver must reference the exact scope shown
        env.service.resume_interaction(run_id, ix["interaction_id"],
                                       {"approval_decision": "approved", "scope_digest": "sha256:0"},
                                       env.principal("user:bob"))
    assert e.value.code == "SCOPE_MISMATCH"
    with pytest.raises(RunError) as e:  # string-to-boolean style coercion refused
        env.service.resume_interaction(run_id, ix["interaction_id"],
                                       {"approval_decision": True, "scope_digest": ix["scope_digest"]},
                                       env.principal("user:bob"))
    assert e.value.code == "RESPONSE_INVALID"


def test_A20_policy_change_after_approval_invalidates_it(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.policy.revoke_capability("user:carol", "documents:read")  # unrelated edit => new policy version
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "FAILED"
    assert "APPROVAL_INVALID" in out.detail and "policy_version" in out.detail
    assert writes(env) == 0


def test_A20_changed_arguments_invalidate_approval(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    cp = env.service._cp("acme", run_id)
    run = env.store.get_run("acme", run_id)
    prep = env.service._prepare_tool(cp, pkg, "PERSIST_DRAFT", cp.revision)
    intent = {"state_id": "PERSIST_DRAFT", "tool": "erp.create_draft", "tool_version": "1.0.0",
              "logical_action_id": prep["lid"], "args": prep["args"], "args_digest": prep["args_digest"]}
    assert env.service._approval_check(run, cp, pkg, intent)() == (True, "")
    tampered = dict(intent, args=dict(prep["args"], supplier_ref="SUP-99999"), args_digest="sha256:changed")
    ok, why = env.service._approval_check(run, cp, pkg, tampered)()
    assert not ok and "args_digest" in why


def test_mutation_altered_stored_approval_digest_denied(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    with env.store.tx() as db:
        db.execute("UPDATE approval_requests SET scope_digest='sha256:forged' WHERE interaction_id=?",
                   (res.interaction["interaction_id"],))
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "FAILED" and "APPROVAL_INVALID" in out.detail
    assert writes(env) == 0


def test_A21_permission_revoked_before_dispatch(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.policy.revoke_capability("user:alice", "erp:draft:create")
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "FAILED"
    assert out.checkpoint.assurance.policy_violations
    assert writes(env) == 0
    denied = [r for r in env.store.receipts("acme", run_id=run_id) if r["dispatch_state"] == "DENIED"]
    assert denied and "POLICY_DENY" in denied[0]["result"]["reason"]


def test_A25_subject_modified_after_verification_blocks_verified_terminal(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    cp = step_until_state(env, run_id, "END_VERIFIED_DRAFT")
    env.erp.modify_out_of_band("acme", cp.variables["erp_draft_id"], {"legal_name": "Changed Later GmbH"})
    out = env.service.advance_run(run_id, env.principal("user:alice"))
    assert out.status == "FAILED"
    assert out.checkpoint.assurance.diagnostics[-1]["code"] == "TERMINAL_ADMISSION_DENIED"
    assert out.checkpoint.outcome is None
    inval = [e for e in env.store.evidence("acme", run_id) if e["claim"] == "persisted_draft_matches_approved_payload"]
    assert inval[0]["invalidated_at"] is not None and "changed" in inval[0]["invalidation_reason"]


def test_A28_post_write_verification_fails_no_duplicate(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    cp = step_until_state(env, run_id, "READ_BACK")
    env.erp.tamper_payload("acme", cp.variables["erp_draft_id"], {"tax_id": "DE000000000"})
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_UNVERIFIED"
    assert writes(env) == 1
    ext = [r["external_ref"] for r in env.store.receipts("acme", run_id=run_id) if r["tool"] == "erp.create_draft"]
    assert ext == [cp.variables["erp_draft_id"]]  # external reference preserved


def test_A29_fallback_in_write_profile_stops_for_review(env, pkg):
    env2 = env.restart(model=fakes.FixtureExtractionModel(invalid_outputs=5))
    p = env2.principal("user:alice")
    h = env2.service.start_run(pkg.artifact_hash, TASK, p)
    out = env2.service.run_until_blocked(h.run_id, p)
    assert out.checkpoint.outcome == {"terminal": "END_REVIEW", "category": "fallback", "outputs": {},
                                      "evidence_receipts": []}
    a = out.checkpoint.assurance
    assert a.entered_fallback and "OUTPUT_INVALID" in a.fallback_reason
    assert out.checkpoint.budget.output_repairs == 1  # exactly one structured-output repair
    tools_after = [r for r in env2.store.receipts("acme", run_id=h.run_id)
                   if r["tool"] not in ("documents.read", "supplier.lookup")]
    assert tools_after == []


def test_model_unavailable_bounded_retries_then_review(env, pkg):
    env2 = env.restart(model=fakes.FixtureExtractionModel(unavailable=True))
    p = env2.principal("user:alice")
    h = env2.service.start_run(pkg.artifact_hash, TASK, p)
    out = env2.service.run_until_blocked(h.run_id, p)
    assert out.checkpoint.outcome["terminal"] == "END_REVIEW"
    assert "MODEL_UNAVAILABLE" in out.checkpoint.assurance.fallback_reason
    assert out.checkpoint.budget.model_calls == 1 + pkg.execution_policy.transport_retries


def test_A32_revoked_artifact(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    revoke(env.store, pkg.artifact_hash, env.principal("user:dana"), "defect found", env.clock())
    with pytest.raises(RunError) as e:
        env.service.start_run(pkg.artifact_hash, TASK, env.principal("user:alice"))
    assert e.value.code == "ARTIFACT_REVOKED"
    approve(env, run_id, res.interaction)
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "CANCELLED"
    assert out.checkpoint.assurance.diagnostics[-1]["code"] == "ARTIFACT_REVOKED"
    assert writes(env) == 0
    with pytest.raises(PermissionError):
        revoke(env.store, pkg.artifact_hash, env.principal("user:alice"), "x", env.clock())


def test_unadmitted_artifact_cannot_run(env, pkg):
    from ..conftest import mutate
    other = mutate(pkg, lambda m, c: m["states"]["EXTRACT_DRAFT"]["action"].update(prompt="changed"))
    env.store.put_version(other.to_json(), "test", env.clock())
    with pytest.raises(RunError) as e:
        env.service.start_run(other.artifact_hash, TASK, env.principal("user:alice"))
    assert e.value.code == "ARTIFACT_NOT_ADMITTED"


def test_request_dedup_returns_same_run(env, pkg):
    p = env.principal("user:alice")
    a = env.service.start_run(pkg.artifact_hash, TASK, p, request_id="req-1")
    b = env.service.start_run(pkg.artifact_hash, TASK, p, request_id="req-1")
    assert a.run_id == b.run_id


def test_approval_expiry_ends_unverified(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    clock.advance(pkg.execution_policy.approval_expiry_s + 1)
    with pytest.raises(RunError) as e:
        approve(env, run_id, res.interaction)
    assert e.value.code == "INTERACTION_EXPIRED"
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_UNVERIFIED"
    assert any(e["type"] == "APPROVAL_EXPIRED" for e in env.store.events("acme", run_id))


def test_immutable_records_cannot_be_rewritten(env, pkg):
    import sqlite3
    run_id, _ = run_to_approval(env, pkg)
    for sql in ("UPDATE run_events SET body='{}'", "DELETE FROM checkpoints", "UPDATE machine_versions SET package='{}'"):
        with pytest.raises(sqlite3.DatabaseError):
            env.store.db.execute(sql)
