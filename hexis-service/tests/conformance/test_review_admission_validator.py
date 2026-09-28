"""Regression tests for review findings on admission and static validation (round 1):
C20-C24, C26-C28, C32, X02, X03; round 2: C21 honest-repair regression, C22 manifest omission, X04, X05."""

from __future__ import annotations

import copy

import pytest

from hexis_service.artifacts.package import MachinePackage
from hexis_service.artifacts.registry import admit
from hexis_service.artifacts.validate import validate_package
from hexis_service.compiler.clauses import index_clauses, is_critical
from hexis_service.compiler.compile import compile_skill
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK, admit_initial, skill_source
from hexis_service.demo.procurement_fixture import contracts_dict, deployment_policy, machine_dict
from hexis_service.traces.model import export_run_trace
from hexis_service.traces.update import apply_ops, propose_update

from ..conftest import approve, mutate, run_to_approval

SKILL = "supplier-onboarding-draft"


@pytest.fixture
def archive(env, pkg):
    """Protected traces from real runs (same construction as tests/replay/test_replay_update.py)."""
    alice = env.principal("user:alice")
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.service.run_until_blocked(run_id, alice)
    h = env.service.start_run(pkg.artifact_hash, dict(TASK, supplier_ref="SUP-55555"), alice)
    env.service.run_until_blocked(h.run_id, alice)
    return [export_run_trace(env.service, run_id, alice, "accepted"),
            export_run_trace(env.service, h.run_id, alice, "accepted")]


def reseal(pkg: MachinePackage, fn) -> MachinePackage:
    d = copy.deepcopy(pkg.to_json())
    fn(d)
    d["artifact_hash"] = ""
    return MachinePackage.from_json(d).sealed()


def rep(pkg, catalog, **kw):
    return validate_package(pkg, catalog, "production", skill_text=skill_source().text, **kw)


def admit_as_dana(env, pkg, parent, **kw):
    return admit(env.store, pkg, env.catalog, expected_parent_hash=parent, approver=env.principal("user:dana"),
                 environment=kw.pop("environment", "sandbox"), deployment_policy=kw.pop("policy", deployment_policy()),
                 now=env.clock(), skill_text=skill_source().text, **kw)


# --- C20: package-declared execution policy may not widen the operator's ------------------------ #
def _widen(d):
    d["execution_policy"]["max_loop_bound"] = 1000
    d["execution_policy"]["budgets"]["max_steps"] = 100000
    d["machine"]["max_steps"] = 100000
    d["machine"]["states"]["VALIDATE_DRAFT"]["transitions"][1]["if"] = \
        "validation_status == 'repairable' and repair_count < 1000"


def test_C20_widened_execution_policy_rejected_at_admission(pkg, catalog, env):
    wide = reseal(pkg, _widen)
    assert rep(wide, catalog).passed  # self-consistent against its own policy ...
    r = rep(wide, catalog, deployment_policy=deployment_policy())
    assert "POLICY_EXCEEDS_DEPLOYMENT" in r.codes()  # ... but wider than the operator's
    res = admit_as_dana(env, wide, None, environment="other")
    assert res.status == "REJECTED" and any("POLICY_EXCEEDS_DEPLOYMENT" in x for x in res.reasons)


def test_C20_capability_and_write_workflow_widening_rejected(pkg, catalog):
    def caps(d):
        d["execution_policy"]["capability_ceiling"].append("payments.send")
    assert "POLICY_EXCEEDS_DEPLOYMENT" in rep(reseal(pkg, caps), catalog, deployment_policy=deployment_policy()).codes()

    def nowrite(d):
        d["execution_policy"]["write_workflow"] = False
    r = rep(reseal(pkg, nowrite), catalog, deployment_policy=deployment_policy())
    assert {"POLICY_EXCEEDS_DEPLOYMENT", "WRITE_WORKFLOW_UNDECLARED"} <= r.codes()


def test_C20_admission_fails_closed_without_deployment_policy(env, pkg):
    res = admit(env.store, pkg, env.catalog, expected_parent_hash=None, approver=env.principal("user:dana"),
                environment="other", now=env.clock(), skill_text=skill_source().text)
    assert res.status == "REJECTED" and "deployment policy" in res.reasons[0]


# --- C21: repair may not drop requirements --------------------------------------------------------- #
class _Dropper:
    model_id = "test:dropper"
    settings: dict = {}

    def draft(self, ctx, diags, attempt):
        c = copy.deepcopy(contracts_dict())
        if attempt > 1:
            bad = {d["detail"]["requirement"] for d in diags if d.get("code") == "ORDERING_VIOLATION"}
            c["ordering"] = [o for o in c["ordering"] if o["id"] not in bad]
        return {"machine": machine_dict(defect=True), "contracts": c}


def test_C21_repair_dropping_violated_ordering_requirement_is_rejected(catalog):
    res = compile_skill(skill_source(), catalog, deployment_policy(), _Dropper())
    assert res.status == "rejected"
    codes2 = {f["code"] for f in res.attempts[1]["findings"]}
    assert "REQUIREMENT_DROPPED" in codes2


# --- C22: criticality comes from the clause text ---------------------------------------------------- #
def test_C22_critical_clause_cannot_self_declare_noncritical(pkg, catalog):
    crit = [c.id for c in index_clauses(skill_source().text) if is_critical(c)]
    assert crit
    cid = crit[0]

    def downgrade(m, c):
        c["clause_coverage"][cid] = {"classification": "unsupported", "justification": "x", "states": [],
                                     "critical": False}
    r = rep(mutate(pkg, downgrade), catalog)
    assert {"CRITICAL_CLAUSE_UNSUPPORTED", "CRITICAL_FLAG_MISMATCH"} <= r.codes()

    def missing(m, c):
        c["clause_coverage"].pop(cid)
    assert "CRITICAL_CLAUSE_UNSUPPORTED" in rep(mutate(pkg, missing), catalog).codes()


# --- C23: the fallback subgraph is analyzed; fallback is always a review end state ----------------- #
def test_C23_fallback_subgraph_write_loop_rejected(pkg, catalog):
    def g(d):
        d["execution_policy"]["write_workflow"] = False
        d["execution_policy"]["fallback_mode"] = "sandbox_interpret"
        s = d["machine"]["states"]
        w = copy.deepcopy(s["PERSIST_DRAFT"])
        w["id"] = "FB_WRITE"
        w["transitions"] = [{"if": "", "to": "FB_LOOP"}]
        s["FB_WRITE"] = w
        s["FB_LOOP"] = {"id": "FB_LOOP", "action": {"kind": "model", "prompt": "again", "reads": ["approval_decision"],
                                                   "writes": ["draft"]}, "transitions": [{"if": "", "to": "FB_WRITE"}]}
        d["machine"]["fallback"] = "FB_WRITE"
        d["contracts"]["explained_unreachable"]["FB_LOOP"] = "reserved"
    r = rep(reseal(pkg, g), catalog)
    assert not r.passed
    assert {"FALLBACK_NOT_REVIEW", "WRITE_WORKFLOW_UNDECLARED", "LOOP_UNBOUNDED", "READ_BEFORE_WRITE",
            "ORDERING_VIOLATION"} <= r.codes()


# --- C24: loop counters must start at zero -------------------------------------------------------- #
def test_C24_negative_counter_init_rejected(pkg, catalog):
    for bad in (-1000, 1.5, "0"):
        def neg(m, c, bad=bad):
            for v in m["variables"]:
                if v["name"] == "repair_count":
                    v["init"] = bad
        assert "COUNTER_INIT" in rep(mutate(pkg, neg), catalog).codes(), bad
    assert "COUNTER_INIT" not in rep(pkg, catalog).codes()


# --- C26: an unsealed package is never valid or admissible --------------------------------------- #
def test_C26_empty_artifact_hash_rejected(pkg, catalog, env):
    unsealed = pkg.model_copy(update={"artifact_hash": ""})
    assert "HASH_MISSING" in rep(unsealed, catalog).codes()
    res = admit_as_dana(env, unsealed, None, environment="other")
    assert res.status == "REJECTED"
    assert env.store.get_active("other", SKILL) is None


# --- C27: ordering selectors must denote something --------------------------------------------- #
def test_C27_unmatched_ordering_selectors_rejected(pkg, catalog):
    def u2(m, c):
        for o in c["ordering"]:
            o["before"] = o["before"].replace("tool:", "tool: ")
    assert "ORDERING_SELECTOR_UNKNOWN" in rep(mutate(pkg, u2), catalog).codes()

    def unknown_kind(m, c):
        c["ordering"][0]["requires"] = ["phase:validate"]
    assert "ORDERING_SELECTOR_UNKNOWN" in rep(mutate(pkg, unknown_kind), catalog).codes()


# --- C28 / C32: admission replays the protected archive and negative corpus itself ---------------- #
def test_C28_C32_candidate_failing_protected_replay_is_rejected(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    cand = apply_ops(pkg, R.BreakingAligner().propose({}))
    active = env.store.get_active("sandbox", SKILL)
    res = admit_as_dana(env, cand, pkg.artifact_hash, protected=archive + [dev])
    assert res.status == "REJECTED" and any(r.startswith("protected replay:") for r in res.reasons), res.reasons
    assert env.store.get_active("sandbox", SKILL) == active


def test_C28_archive_entries_cannot_be_dropped(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    prop = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)
    refined = prop.candidate
    ok = admit_as_dana(env, refined, pkg.artifact_hash, protected=archive + [dev])
    assert ok.status == "ADMITTED", ok.reasons
    stored = env.store.archive(SKILL)
    child = apply_ops(refined, [{"op": "set_coverage", "clause": "S0.1", "coverage": {
        "classification": "external_precondition", "justification": "same, reworded", "states": []}}])
    res = admit_as_dana(env, child, refined.artifact_hash, protected=[])
    assert res.status == "REJECTED" and any("missing or altered" in r for r in res.reasons)
    assert env.store.archive(SKILL) == stored
    # the complete archive (replayed from stored bodies) admits the child
    res2 = admit_as_dana(env, child, refined.artifact_hash, protected=archive + [dev])
    assert res2.status == "ADMITTED", res2.reasons


def test_C28_negative_corpus_checked_at_admission(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    prop = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)
    # a trace the candidate represents cannot sit in the negative corpus
    res = admit_as_dana(env, prop.candidate, pkg.artifact_hash, protected=archive + [dev], negative=[dev])
    assert res.status == "REJECTED" and any("negative corpus" in r for r in res.reasons)


def test_C28_manifest_must_match_traces(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    prop = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)
    res = admit_as_dana(env, prop.candidate, pkg.artifact_hash, protected=archive + [dev],
                        archive_manifest={"protected": [], "negative": []})
    assert res.status == "REJECTED" and "manifest" in res.reasons[0]


# --- X02: weak approval guards / approval bypass --------------------------------------------------- #
def test_X02_disjunctive_approval_guard_rejected(pkg, catalog):
    def weak(m, c):
        m["states"]["REQUEST_APPROVAL"]["transitions"][0]["if"] = \
            "approval_decision == 'approved' or repair_count >= 1"
    assert "APPROVAL_GUARD_WEAK" in rep(mutate(pkg, weak), catalog).codes()


def test_X02_approval_default_through_noop_state_rejected(pkg, catalog):
    def bypass(m, c):
        s = m["states"]
        s["NOOP"] = {"id": "NOOP", "action": {"kind": "model", "prompt": "noop", "reads": [], "writes": []},
                     "transitions": [{"if": "", "to": "PERSIST_DRAFT"}]}
        s["REQUEST_APPROVAL"]["transitions"][-1]["to"] = "NOOP"
    assert "APPROVAL_BYPASS" in rep(mutate(pkg, bypass), catalog).codes()


# --- X03: archive versions are per skill; a second environment admits cleanly --------------------- #
def test_X03_second_environment_admission_does_not_crash(env, pkg):
    res = admit_as_dana(env, pkg, None, environment="production")
    assert res.status == "ADMITTED" and res.archive_version == 2
    assert env.store.get_active("production", SKILL) == (pkg.artifact_hash, 2)


def test_initial_admission_still_works(pkg, clock, tmp_path):
    from hexis_service.demo.env import build_env
    e = build_env(str(tmp_path / "s2"), clock=clock)
    assert admit_initial(e, pkg).status == "ADMITTED"


# ================================ round 2 ========================================================== #
# --- C21 (regression): repairing a requirement the validator flagged as malformed is allowed ------- #
class _TypoFixer:
    model_id = "test:typo-fixer"
    settings: dict = {}

    def draft(self, ctx, diags, attempt):
        c = copy.deepcopy(contracts_dict())
        if attempt == 1:  # malformed selector in the first draft; later drafts correct it
            c["ordering"][0]["before"] = c["ordering"][0]["before"].replace("tool:", "tool: ")
        return {"machine": machine_dict(defect=False), "contracts": c}


def test_C21_honest_repair_of_malformed_requirement_validates(catalog):
    res = compile_skill(skill_source(), catalog, deployment_policy(), _TypoFixer())
    assert {f["code"] for f in res.attempts[0]["findings"]} == {"ORDERING_SELECTOR_UNKNOWN"}
    assert res.status == "validated", res.attempts


class _Weakener:
    model_id = "test:weakener"
    settings: dict = {}

    def draft(self, ctx, diags, attempt):
        c = copy.deepcopy(contracts_dict())
        if attempt > 1:  # a well-formed but violated requirement is weakened instead of the machine fixed
            bad = {d["detail"]["requirement"] for d in diags if d.get("code") == "ORDERING_VIOLATION"}
            for o in c["ordering"]:
                if o["id"] in bad:
                    o["requires"] = [o["before"]]
        return {"machine": machine_dict(defect=True), "contracts": c}


def test_C21_weakening_a_violated_requirement_is_still_rejected(catalog):
    res = compile_skill(skill_source(), catalog, deployment_policy(), _Weakener())
    assert res.status == "rejected"
    assert "REQUIREMENT_DROPPED" in {f["code"] for f in res.attempts[1]["findings"]}


# --- C22 (variant): a critical clause cannot escape by being left out of the source manifest -------- #
def _drop_critical_clause(pkg):
    cid = next(c.id for c in index_clauses(skill_source().text) if is_critical(c))

    def fn(d):
        d["source_manifest"]["clauses"] = [c for c in d["source_manifest"]["clauses"] if c["id"] != cid]
        d["contracts"]["clause_coverage"].pop(cid, None)
        for s in d["machine"]["states"].values():
            if s.get("clause") == cid:
                s["clause"] = ""
        for o in d["contracts"]["ordering"]:
            if o.get("clause") == cid:
                o["clause"] = ""
    return cid, reseal(pkg, fn)


def test_C22_critical_clause_removed_from_manifest_rejected(pkg, catalog, clock, tmp_path):
    from hexis_service.demo.env import build_env
    cid, bad = _drop_critical_clause(pkg)
    r = rep(bad, catalog)
    assert not r.passed
    assert any(f.code == "CRITICAL_CLAUSE_UNSUPPORTED" and f.clause == cid for f in r.errors)
    e = build_env(str(tmp_path / "s3"), clock=clock)
    assert admit_initial(e, bad).status == "REJECTED"
    assert e.store.get_active("sandbox", SKILL) is None


# --- X04 / X05: a run starts only for an artifact admitted, with a verified record, to this env ---- #
def test_X04_admission_to_other_environment_does_not_allow_runs(pkg, clock, tmp_path):
    from hexis_service.demo.env import build_env
    from hexis_service.runtime.service import RunError
    e = build_env(str(tmp_path / "s4"), clock=clock)
    assert e.service.environment == "sandbox"
    assert admit_as_dana(e, pkg, None, environment="staging").status == "ADMITTED"
    with pytest.raises(RunError) as exc:
        e.service.start_run(pkg.artifact_hash, TASK, e.principal("user:alice"))
    assert exc.value.code == "ARTIFACT_NOT_ADMITTED"
    assert admit_as_dana(e, pkg, None, environment="sandbox").status == "ADMITTED"
    assert e.service.start_run(pkg.artifact_hash, TASK, e.principal("user:alice")).run_id


def test_X05_forged_lifecycle_or_unsigned_record_does_not_allow_runs(pkg, clock, tmp_path):
    import json

    from hexis_service.demo.env import build_env
    from hexis_service.runtime.service import RunError
    e = build_env(str(tmp_path / "s5"), clock=clock)
    e.store.put_version(pkg.to_json(), "mallory", 1.0)
    with e.store.tx() as db:
        e.store.add_lifecycle(db, pkg.artifact_hash, "admitted", "mallory", "sandbox", 1.0)
    alice = e.principal("user:alice")
    with pytest.raises(RunError) as exc:
        e.service.start_run(pkg.artifact_hash, TASK, alice)
    assert exc.value.code == "ARTIFACT_NOT_ADMITTED"
    rec = {"artifact_hash": pkg.artifact_hash, "environment": "sandbox", "approver": "mallory",
           "admitted_at": "2026-01-01T00:00:00+00:00", "validation_report_digest": "d", "replay_archive_digest": "a",
           "key_id": "k", "signature": "hmac-sha256:" + "0" * 64}
    with e.store.tx() as db:
        db.execute("INSERT INTO admission_reports VALUES(?,?,?)",
                   (f"{pkg.artifact_hash}@sandbox", json.dumps(rec), json.dumps({"report_digest": "d"})))
    with pytest.raises(RunError) as exc:
        e.service.start_run(pkg.artifact_hash, TASK, alice)
    assert exc.value.code == "ARTIFACT_NOT_ADMITTED"


# --- C28 (residual): the stored archive, not the caller, decides what is protected ----------------- #
def test_C28_enrolled_traces_cannot_be_dropped_by_first_update(env, pkg, catalog, archive):
    from hexis_service.artifacts.registry import enroll_protected
    enr = enroll_protected(env.store, "supplier-onboarding-draft", archive, actor=env.principal("user:dana"),
                           environment="sandbox", now=env.clock())
    assert enr.status == "ADMITTED" and enr.archive_version == 2
    stored = env.store.archive("supplier-onboarding-draft")
    assert {e["trace_id"] for e in stored["protected"]} == {t.trace_id for t in archive}
    dev = R.missing_docs_trace()
    cand = apply_ops(pkg, R.BreakingAligner().propose({}), [dev.trace_id])
    # the caller omits the enrolled run traces the breaking candidate would fail on
    res = admit_as_dana(env, cand, pkg.artifact_hash, protected=[dev])
    assert res.status == "REJECTED" and any("current archive is missing" in r for r in res.reasons)
    # supplying them makes admission replay them, and the breaking candidate fails
    res = admit_as_dana(env, cand, pkg.artifact_hash, protected=archive + [dev])
    assert res.status == "REJECTED" and any("protected replay" in r for r in res.reasons)
    assert env.store.get_active("sandbox", "supplier-onboarding-draft")[0] == pkg.artifact_hash


def test_C28_originating_trace_must_be_protected(env, pkg, catalog, archive):
    dev = R.missing_docs_trace()
    prop = propose_update(pkg, dev, archive, [], catalog, R.FixtureAligner(), skill_source().text)
    assert prop.candidate.lineage.trace_ids == [dev.trace_id]
    res = admit_as_dana(env, prop.candidate, pkg.artifact_hash, protected=archive)
    assert res.status == "REJECTED" and "originating trace" in res.reasons[0]
    assert admit_as_dana(env, prop.candidate, pkg.artifact_hash, protected=archive + [dev]).status == "ADMITTED"


def test_C28_enrollment_gates(env, pkg, archive):
    from hexis_service.artifacts.registry import enroll_protected
    kw = dict(environment="sandbox", now=env.clock())
    assert enroll_protected(env.store, "supplier-onboarding-draft", archive, actor=env.principal("user:alice"),
                            **kw).status == "REJECTED"  # not an artifact admin
    bad = [R.forbidden_write_trace()]  # correct answer via a forbidden action: never protected
    r = enroll_protected(env.store, "supplier-onboarding-draft", bad, actor=env.principal("user:dana"), **kw)
    assert r.status == "REJECTED" and "ineligible" in r.reasons[0]
    unrep = [R.missing_docs_trace()]  # not representable by the active (initial) version
    r = enroll_protected(env.store, "supplier-onboarding-draft", unrep, actor=env.principal("user:dana"), **kw)
    assert r.status == "REJECTED" and "does not replay" in r.reasons[0]
    neg = enroll_protected(env.store, "supplier-onboarding-draft", [R.shortcut_trace()],
                           actor=env.principal("user:dana"), negative=True, **kw)
    assert neg.status == "ADMITTED"
    assert [e["trace_id"] for e in env.store.archive("supplier-onboarding-draft")["negative"]] == \
        ["dev:repair-then-approve-without-revalidation"]
