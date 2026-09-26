"""Pure-kernel behavior: A06, A07, A09, A10, A30 plus property tests."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from hexis_service import guards as G
from hexis_service.canonical import canonical_bytes, digest, strict_loads
from hexis_service.runtime import kernel as K

from ..conftest import _compiled, mini_package

END = lambda t: {"id": t, "action": {"kind": "end", "terminal": t}, "transitions": []}  # noqa: E731


def judge_pkg():
    states = {
        "J": {"id": "J", "action": {"kind": "judge", "prompt": "ok?", "reads": ["x"], "writes": ["label"],
                                    "labels": ["ok", "bad", "abstain"]},
              "transitions": [{"if": "label == 'ok'", "to": "OK"}, {"if": "", "to": "FALLBACK"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    return mini_package(states, [{"name": "x", "type": "string", "init": "v"}, {"name": "label", "type": "string"}],
                        {"x": {"owner": "task", "schema": {"type": "string"}},
                         "label": {"owner": "model", "schema": {"enum": ["ok", "bad", "abstain"]}}},
                        [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}],
                        {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}, "J")


def falsy_pkg(guard="flag == False and count == 0 and empty(note)"):
    states = {
        "M": {"id": "M", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["flag", "count", "note"]},
              "transitions": [{"if": guard, "to": "A"}, {"if": "", "to": "FALLBACK"}]},
        "A": END("END_A"), "FALLBACK": END("END_REVIEW")}
    return mini_package(states, [{"name": "flag", "type": "boolean"}, {"name": "count", "type": "integer"},
                                 {"name": "note", "type": "string"}, {"name": "ghost", "type": "string"}],
                        {"flag": {"owner": "model", "schema": {"type": "boolean"}},
                         "count": {"owner": "model", "schema": {"type": "integer"}},
                         "note": {"owner": "model", "schema": {"type": "string"}},
                         "ghost": {"owner": "model", "schema": {"type": "string"}}},
                        [{"id": "END_A", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}],
                        {"END_A": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}, "M")


def obs(cp, kind, outputs, **kw):
    return K.Observation(run_id=cp.run_id, state_id=cp.state_id, revision=cp.revision, kind=kind, outputs=outputs,
                         **kw)


def test_A06_invalid_judge_label_and_privileged_fields_rejected():
    p = judge_pkg()
    cp = K.initial_checkpoint(p, "t", "r", {})
    with pytest.raises(K.KernelError) as e:
        K.advance(cp, obs(cp, "judge", {"label": "definitely"}), p)
    assert e.value.code == "INVALID_JUDGE_LABEL"
    with pytest.raises(K.KernelError) as e:
        K.advance(cp, obs(cp, "judge", {"label": "ok", "approved": True}), p)
    assert e.value.code == "UNEXPECTED_OUTPUT_KEYS"
    # abstention is an ordinary explicit branch
    r = K.advance(cp, obs(cp, "judge", {"label": "abstain"}), p)
    assert r.checkpoint.state_id == "FALLBACK" and "approved" not in r.checkpoint.variables


def test_A07_falsy_values_accepted_by_schema_not_truthiness():
    p = falsy_pkg()
    cp = K.initial_checkpoint(p, "t", "r", {})
    r = K.advance(cp, obs(cp, "model", {"flag": False, "count": 0, "note": ""}), p)
    assert r.checkpoint.state_id == "A"
    assert r.checkpoint.variables == {"flag": False, "count": 0, "note": ""}


def test_bool_int_coercion_rejected_at_boundary():
    p = falsy_pkg()
    cp = K.initial_checkpoint(p, "t", "r", {})
    with pytest.raises(K.KernelError) as e:
        K.advance(cp, obs(cp, "model", {"flag": 0, "count": 0, "note": ""}), p)
    assert e.value.code in ("OUTPUT_TYPE", "OUTPUT_SCHEMA")
    with pytest.raises(K.KernelError):
        K.advance(cp, obs(cp, "model", {"flag": "false", "count": 0, "note": ""}), p)


def test_A09_undefined_variable_in_guard_fails_explicitly():
    p = falsy_pkg(guard="ghost == 'x'")
    cp = K.initial_checkpoint(p, "t", "r", {})
    r = K.advance(cp, obs(cp, "model", {"flag": True, "count": 1, "note": "n"}), p)
    assert r.checkpoint.status == "FAILED"
    assert r.checkpoint.assurance.diagnostics[-1]["code"] == "GUARD_EVALUATION_ERROR"
    assert r.checkpoint.state_id == "M"  # did NOT fall through to the default edge


@pytest.mark.parametrize("count,expected_state,expected_count", [(0, "REPAIR_DRAFT", 1), (1, "REPAIR_DRAFT", 2),
                                                                 (2, "END_UNVERIFIED", 2)])
def test_A10_repair_bound_boundaries(pkg, count, expected_state, expected_count):
    cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=pkg.artifact_hash, state_id="VALIDATE_DRAFT",
                         variables={"draft": {}, "required_fields": [], "policy_version": "v", "repair_count": count})
    r = K.advance(cp, obs(cp, "tool", {"status": "repairable", "issues": [], "draft_digest": "d"}), pkg)
    assert r.checkpoint.state_id == expected_state
    assert r.checkpoint.variables["repair_count"] == expected_count


def test_A10_run_budget_exhaustion_is_monotonic(pkg):
    cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=pkg.artifact_hash, state_id="VALIDATE_DRAFT",
                         variables={"draft": {}, "required_fields": [], "policy_version": "v", "repair_count": 0},
                         budget=K.Budget(steps=pkg.execution_policy.budgets.max_steps))
    r = K.advance(cp, obs(cp, "tool", {"status": "pass", "issues": [], "draft_digest": "d"}), pkg)
    assert r.checkpoint.status == "FAILED" and r.checkpoint.assurance.diagnostics[-1]["code"] == "BUDGET_EXHAUSTED"
    assert r.checkpoint.budget.steps == cp.budget.steps + 1


def test_observation_identity_enforced(pkg):
    cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=pkg.artifact_hash, state_id="VALIDATE_DRAFT",
                         variables={})
    stale = K.Observation(run_id="r", state_id="VALIDATE_DRAFT", revision=7, kind="tool", outputs={})
    with pytest.raises(K.KernelError) as e:
        K.advance(cp, stale, pkg)
    assert e.value.code == "OBSERVATION_IDENTITY"


def test_A05_missing_template_binding_is_explicit():
    with pytest.raises(K.KernelError) as e:
        K.fill_template({"draft_id": "${erp_draft_id}"}, {})
    assert e.value.code == "MISSING_INPUT_BINDING"
    with pytest.raises(K.KernelError):
        K.fill_template({"q": "id=${missing}"}, {"other": 1})
    assert K.fill_template({"x": "${v}"}, {"v": False}) == {"x": False}  # typed, not stringified


def test_nested_init_from_resolution(pkg):
    assert K.resolve_path({"a": {"b": {"c": 3}}}, "task.input.a.b.c") == (True, 3)
    assert K.resolve_path({"a/b": {"c": 3}}, "/a~1b/c") == (True, 3)
    assert K.resolve_path({"a": {}}, "task.input.a.b") == (False, None)


# ---- properties ----------------------------------------------------------------------------- #
DRAFT = {"legal_name": "x", "supplier_ref": "S", "business_unit": "B", "source_links": {}}
statuses = st.sampled_from(["pass", "repairable", "fail"])


@settings(max_examples=150, deadline=None)
@given(seq=st.lists(statuses, min_size=1, max_size=6))
def test_A30_property_deterministic_and_monotonic(seq):
    pkg = _compiled().package
    def run():
        cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=pkg.artifact_hash, state_id="VALIDATE_DRAFT",
                             variables={"draft": DRAFT, "required_fields": [], "policy_version": "v",
                                        "repair_count": 0, "validation_issues": [], "documents": []})
        trail = []
        for s in seq:
            if cp.state_id == "REPAIR_DRAFT":
                cp = K.advance(cp, obs(cp, "model", {"draft": dict(DRAFT)}), pkg).checkpoint
            if cp.state_id != "VALIDATE_DRAFT" or cp.status != "RUNNING":
                break
            prev = cp.variables["repair_count"]
            cp = K.advance(cp, obs(cp, "tool", {"status": s, "issues": [], "draft_digest": "d"}), pkg).checkpoint
            assert cp.variables["repair_count"] >= prev
            trail.append((cp.state_id, cp.revision, cp.digest()))
        return trail, cp
    t1, c1 = run()
    t2, c2 = run()
    assert t1 == t2 and c1.digest() == c2.digest()
    assert c1.variables["repair_count"] <= 2


json_values = st.recursive(st.none() | st.booleans() | st.integers() | st.floats(allow_nan=False, allow_infinity=False)
                           | st.text(max_size=8),
                           lambda c: st.lists(c, max_size=4) | st.dictionaries(st.text(max_size=5), c, max_size=4),
                           max_leaves=20)


@settings(max_examples=200, deadline=None)
@given(v=json_values)
def test_canonical_serialization_stable(v):
    b = canonical_bytes(v)
    assert canonical_bytes(strict_loads(b)) == b
    assert digest(v) == digest(strict_loads(b))


@settings(max_examples=200, deadline=None)
@given(status=st.sampled_from(["pass", "repairable", "fail", "other", ""]), n=st.integers(-3, 5))
def test_guard_disjointness_analysis_is_sound(status, n):
    guards = ["validation_status == 'pass'", "validation_status == 'repairable' and repair_count < 2"]
    assert G.analyze_disjoint(guards, {"validation_status": "string", "repair_count": "integer"}).status == "PROVEN"
    env = {"validation_status": status, "repair_count": n}
    assert sum(G.evaluate(g, env) for g in guards) <= 1
