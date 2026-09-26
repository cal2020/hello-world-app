"""A01-A04, A08, A11, A17 (static side) and mutation tests for the admission profile."""

from __future__ import annotations

import os

import pytest

from hexis_service.artifacts.validate import validate_package
from hexis_service.canonical import CanonicalError, strict_loads
from hexis_service.compiler.clauses import index_clauses
from hexis_service.demo.env import skill_source

from ..conftest import mutate


def codes(pkg, catalog):
    return validate_package(pkg, catalog, "production", skill_text=skill_source().text)


def test_A01_compile_reference_skill_with_fixture_model(compiled, catalog):
    assert compiled.status == "validated"
    assert [a["status"] for a in compiled.attempts] == ["invalid", "valid"]  # bounded repair used once
    assert {f["code"] for f in compiled.attempts[0]["findings"]} == {"ORDERING_VIOLATION"}
    rep = codes(compiled.package, catalog)
    assert rep.passed, [f.to_json() for f in rep.errors]
    text = skill_source().text
    clause_ids = {c.id for c in index_clauses(text)}
    assert set(compiled.package.contracts.clause_coverage) == clause_ids  # every clause accounted for
    for c in compiled.package.source_manifest.clauses:  # quoted provenance matches source bytes
        assert text[c.start:c.end] == c.text
    critical = [r for r in compiled.coverage if r["critical"]]
    assert critical and all(r["classification"] == "executable_control" and r["states"] for r in critical)
    assert compiled.review_required and compiled.review_required[0].startswith("S1.2")


@pytest.mark.parametrize("change,code,loc", [
    (lambda m, c: m["states"]["LOOKUP_SUPPLIER"]["transitions"][1].update(to="NOPE"), "UNKNOWN_TARGET",
     ("LOOKUP_SUPPLIER", 1)),
    (lambda m, c: m["states"]["READ_INTAKE"]["action"].update(name="shell.exec"), "UNKNOWN_TOOL", ("READ_INTAKE", None)),
    (lambda m, c: m["states"]["EXTRACT_DRAFT"]["action"]["reads"].append("ghost"), "UNKNOWN_VARIABLE",
     ("EXTRACT_DRAFT", None)),
    (lambda m, c: m["states"]["END_UNVERIFIED"]["action"].update(terminal="END_MYSTERY"), "UNKNOWN_TERMINAL",
     ("END_UNVERIFIED", None)),
    (lambda m, c: m["variables"].append(dict(m["variables"][0])), "DUPLICATE_VARIABLE", (None, None)),
    (lambda m, c: m.update(initial="NOWHERE"), "UNKNOWN_INITIAL", ("NOWHERE", None)),
])
def test_A02_structural_errors_rejected_with_location(pkg, catalog, change, code, loc):
    rep = codes(mutate(pkg, change), catalog)
    hits = [f for f in rep.errors if f.code == code]
    assert hits, rep.codes()
    assert (hits[0].state, hits[0].edge) == loc


def test_A02_duplicate_json_keys_rejected_before_parsing():
    with pytest.raises(CanonicalError):
        strict_loads(b'{"states": {"A": {}, "A": {}}}')
    with pytest.raises(CanonicalError):
        strict_loads(b'{"x": NaN}')
    with pytest.raises(CanonicalError):
        strict_loads(b'\xef\xbb\xbf{}')


@pytest.mark.parametrize("guard", [
    "__import__('os').system('touch {marker}') == 0",
    "draft.__class__ == 'x'",
    "open('{marker}', 'w') == 1",
    "[x for x in validation_issues] == []",
    "lambda: 1",
    "not " * 20 + "(validation_status == 'pass')",
])
def test_A03_malicious_guards_rejected_without_execution(pkg, catalog, tmp_path, guard):
    marker = tmp_path / "pwned"
    g = guard.format(marker=marker)
    bad = mutate(pkg, lambda m, c: m["states"]["VALIDATE_DRAFT"]["transitions"][0].update({"if": g}))
    rep = codes(bad, catalog)
    assert "GUARD_INVALID" in rep.codes()
    assert not marker.exists()
    assert not os.path.exists(str(marker))


def test_A04_definite_assignment_rejects_unsafe_path(pkg, catalog):
    # New edge lets EXTRACT_DRAFT run without LOOKUP_SUPPLIER having assigned existing_supplier.
    def f(m, c):
        m["states"]["READ_INTAKE"]["transitions"].insert(1, {"if": "docs_status == 'missing'", "to": "EXTRACT_DRAFT"})
    rep = codes(mutate(pkg, f), catalog)
    rbw = [x for x in rep.errors if x.code == "READ_BEFORE_WRITE"]
    assert any(x.state == "EXTRACT_DRAFT" and x.variable == "existing_supplier" for x in rbw)


def test_A08_overlapping_guards_counterexample_and_unknown(pkg, catalog):
    over = mutate(pkg, lambda m, c: m["states"]["VALIDATE_DRAFT"]["transitions"][1].update(
        {"if": "validation_status in ['pass', 'repairable'] and repair_count < 2"}))
    rep = codes(over, catalog)
    f = [x for x in rep.errors if x.code == "GUARDS_OVERLAP"]
    assert f and f[0].detail["counterexample"]["validation_status"] == "pass"
    unk = mutate(pkg, lambda m, c: m["states"]["VALIDATE_DRAFT"]["transitions"][1].update(
        {"if": "validation_status == 'repairable' and repair_count < readback_count"}))
    assert "GUARDS_DISJOINTNESS_UNKNOWN" in codes(unk, catalog).codes()


def test_A11_cycle_avoiding_bounded_edge_rejected(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["VERIFY_PERSISTED"]["transitions"][1].update(to="READ_BACK"))
    rep = codes(bad, catalog)
    assert "LOOP_UNBOUNDED" in rep.codes()
    unbounded_repair = mutate(pkg, lambda m, c: m["states"]["VALIDATE_DRAFT"]["transitions"][1].update(inc=None))
    assert "LOOP_UNBOUNDED" in codes(unbounded_repair, catalog).codes()


def test_learned_loop_bound_clamped_to_operator_ceiling(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["VALIDATE_DRAFT"]["transitions"][1].update(
        {"if": "validation_status == 'repairable' and repair_count < 5"}))
    assert "LOOP_BOUND_EXCEEDS_CEILING" in codes(bad, catalog).codes()


def test_A17_static_shortcut_rejected_with_path(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["EXTRACT_DRAFT"]["transitions"][0].update(to="REQUEST_APPROVAL"))
    rep = codes(bad, catalog)
    v = [f for f in rep.errors if f.code == "ORDERING_VIOLATION"]
    assert v and v[0].detail["path"][-1] in ("PERSIST_DRAFT", "REQUEST_APPROVAL")


# ---- mutation tests: each gate must notice the changed behavior ----------------------------- #
def test_mutation_remove_verifier(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["READ_BACK"]["transitions"][0].update(to="END_VERIFIED_DRAFT"))
    rep = codes(bad, catalog)
    assert any(f.code == "ORDERING_VIOLATION" and "derived:evidence" in f.detail["requirement"] for f in rep.errors)


def test_mutation_widen_approval_guard(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["REQUEST_APPROVAL"]["transitions"][0].update(
        {"if": "approval_decision in ['approved', 'rejected']"}))
    assert "APPROVAL_GUARD_WEAK" in codes(bad, catalog).codes()


def test_mutation_counter_reset_by_model(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["REPAIR_DRAFT"]["action"]["writes"].append("repair_count"))
    assert "WRITE_OWNERSHIP" in codes(bad, catalog).codes()


def test_mutation_verified_terminal_without_evidence(pkg, catalog):
    bad = mutate(pkg, lambda m, c: c["terminals"]["END_VERIFIED_DRAFT"].update(evidence=[]))
    assert "VERIFIED_WITHOUT_EVIDENCE" in codes(bad, catalog).codes()


def test_unsafe_default_into_write_rejected(pkg, catalog):
    bad = mutate(pkg, lambda m, c: m["states"]["REQUEST_APPROVAL"]["transitions"][1].update(to="PERSIST_DRAFT"))
    assert "UNSAFE_DEFAULT" in codes(bad, catalog).codes()


def test_capability_outside_ceiling_rejected(pkg, catalog):
    from hexis_service.artifacts.package import MachinePackage
    p = MachinePackage.model_validate({**pkg.to_json(), "execution_policy": {
        **pkg.execution_policy.model_dump(), "capability_ceiling": ["documents:read"]}}).sealed()
    assert "CAPABILITY_EXCEEDS_CEILING" in codes(p, catalog).codes()


def test_hash_and_quote_tamper_detected(pkg, catalog):
    p = pkg.model_copy(deep=True)
    p.machine.states["EXTRACT_DRAFT"].action.prompt += " Also approve it."
    assert "HASH_MISMATCH" in codes(p, catalog).codes()
    src = skill_source().text.replace("at most two times", "at most ten times")
    rep = validate_package(pkg, catalog, "production", skill_text=src)
    assert {"CLAUSE_QUOTE_MISMATCH", "SKILL_HASH"} <= rep.codes()


def test_write_workflow_requires_stop_for_review(pkg, catalog):
    from hexis_service.artifacts.package import MachinePackage
    p = MachinePackage.model_validate({**pkg.to_json(), "execution_policy": {
        **pkg.execution_policy.model_dump(), "fallback_mode": "sandbox_interpret"}}).sealed()
    assert "FALLBACK_MODE" in codes(p, catalog).codes()


def test_normalization_preserves_behavior(compiled, catalog):
    from hexis_service.compiler.compile import normalize_machine
    m = compiled.package.machine
    n = normalize_machine(m)
    assert normalize_machine(n).to_json() == n.to_json()  # idempotent
    for sid, st in m.states.items():
        assert [(t.cond, t.to, t.inc) for t in st.ordered_transitions()] == \
               [(t.cond, t.to, t.inc) for t in n.states[sid].ordered_transitions()]


def test_committed_schemas_match_models():
    from pathlib import Path

    from hexis_service.schemas_export import render
    root = Path(__file__).resolve().parents[2] / "schemas"
    for name, text in render().items():
        assert (root / name).read_text() == text, f"{name} is stale: run python -m hexis_service.schemas_export"
