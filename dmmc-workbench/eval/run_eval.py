"""Evaluation suite: 22 synthetic cases + a template-baseline comparison.

This is an engineering check of software behaviour on synthetic fixtures. Fixture
drafting exercises the pipeline; it does not measure language-model quality. No
human reviewers took part, so reviewer correction time and seeded-error catch rate
by people are UNMEASURED. Expected values are in expected.json (same author as code).

Run: python -m workbench eval   (writes reports/evaluation_report.{md,json})
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("DMMC_NOW", "2026-09-23T15:00:00Z")

from workbench import (checks, config, db, demo, drafting, export, identity, importer, impact, opa,  # noqa: E402
                       packages, reference, review)
from workbench import model as M  # noqa: E402

EXP = json.loads((ROOT / "eval" / "expected.json").read_text())
EV = config.FIXTURES / "evidence"
P = demo.PROJECT
CASES = []
HELD_OUT = {"E06", "E11", "E13", "E17", "E19", "E21"}


def case(cid, title):
    def deco(fn):
        CASES.append((cid, title, fn))
        return fn
    return deco


class Fresh:
    """Each case gets its own data directory and database."""

    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="dmmc-eval-")
        os.environ["DMMC_DATA_DIR"] = self.dir
        self.conn, _ = demo.reset()
        return self.conn

    def __exit__(self, *a):
        self.conn.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def load(conn, model="A", evidence=("A",)):
    importer.import_model(conn, "bob", (demo.MODEL_A if model == "A" else demo.MODEL_B).read_bytes())
    for s in evidence:
        importer.import_evidence_dir(conn, "bob", EV / f"set-{s}")


def rows_of(conn, pid):
    return {r["row_id"]: r for r in json.loads(packages.get(conn, pid)["rows_json"])}


def expect(cond, msg, fails):
    if not cond:
        fails.append(msg)


def count(conn, table):
    return conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]


def scenario(conn, name):
    """Set up one of the expected.json scenarios and build a fixture package."""
    if name == "A_complete":
        load(conn, "A")
    elif name == "A_transport_withdrawn":
        load(conn, "A")
        importer.set_evidence_status(conn, "bob", "ev-tls-portal-api-a1", "withdrawn", "eval")
    elif name == "B_with_A_evidence_only":
        load(conn, "A")
        importer.import_model(conn, "bob", demo.MODEL_B.read_bytes())
    elif name == "B_with_B_evidence":
        load(conn, "A")
        importer.import_model(conn, "bob", demo.MODEL_B.read_bytes())
        importer.import_evidence_dir(conn, "bob", EV / "set-B")
    return packages.build_package(conn, "bob", P, mode="fixture")


# --- cases -------------------------------------------------------------------------

@case("E01", "Complete evidence: claims resolve to exact sources; checks report bounded scope")
def e01(f):
    with Fresh() as c:
        r = scenario(c, "A_complete")
        rows = rows_of(c, r["package_id"])
        for rid, exp in EXP["scenarios"]["A_complete"]["rows"].items():
            expect(rows[rid]["result"] == exp, f"{rid}: {rows[rid]['result']} != {exp}", f)
        v = r["validation"]["counts"]
        expect(set(v) <= {"CITATIONS_RESOLVE", "NO_CITATION_REQUIRED"}, f"unexpected validation statuses {v}", f)
        return {"validation": v}


@case("E02", "Missing transport observation: keep design assertion, expose gap, no effectiveness claim")
def e02(f):
    with Fresh() as c:
        r = scenario(c, "A_transport_withdrawn")
        row = rows_of(c, r["package_id"])["OBL-SC8-FLOW::flow:portal-api"]
        expect(row["result"] == "UNKNOWN", f"result {row['result']}", f)
        expect(row["detail"]["design"]["state"] == "PRESENT", "design assertion lost", f)
        expect(any("No current applicable observation" in g for g in row["gaps"]), "gap not exposed", f)
        expect(r["validation"]["flagged"] == 0, "drafter overclaimed", f)
        return {"gaps": row["gaps"][:1]}


@case("E03", "Wrong environment: reject evidence applicability even when report says PASS")
def e03(f):
    with Fresh() as c:
        load(c, "A")
        importer.set_evidence_status(c, "bob", "ev-tls-portal-api-a1", "withdrawn", "eval")
        importer.import_evidence(c, "bob", EV / "eval" / "tls-wrong-environment.meta.json")
        r = packages.build_package(c, "bob", P)
        row = rows_of(c, r["package_id"])["OBL-SC8-FLOW::flow:portal-api"]
        e = next(x for x in row["detail"]["evidence"] if x["evidence_id"] == "ev-tls-wrong-env")
        expect(row["result"] == "UNKNOWN" and not e["applicable"], "wrong-environment PASS was reused", f)
        expect(any("environment" in x for x in e["reasons"]), "reason missing", f)
        return {"reasons": e["reasons"]}


@case("E04", "Wrong asset version: A-revision report is inapplicable after model B")
def e04(f):
    with Fresh() as c:
        r = scenario(c, "B_with_A_evidence_only")
        rows = rows_of(c, r["package_id"])
        for rid, exp in EXP["scenarios"]["B_with_A_evidence_only"]["rows"].items():
            expect(rows[rid]["result"] == exp, f"{rid}: {rows[rid]['result']} != {exp}", f)
        e = rows["OBL-SC8-FLOW::flow:portal-api"]["detail"]["evidence"][0]
        expect(not e["applicable"] and "revision a1" in e["reasons"][0], "old report reused", f)
        return {"reason": e["reasons"][0]}


@case("E05", "Expired evidence is not applicable")
def e05(f):
    with Fresh() as c:
        load(c, "A")
        importer.set_evidence_status(c, "bob", "ev-tls-portal-api-a1", "withdrawn", "eval")
        importer.import_evidence(c, "bob", EV / "eval" / "tls-expired.meta.json")
        r = packages.build_package(c, "bob", P)
        row = rows_of(c, r["package_id"])["OBL-SC8-FLOW::flow:portal-api"]
        e = next(x for x in row["detail"]["evidence"] if x["evidence_id"] == "ev-tls-expired")
        expect(row["result"] == "UNKNOWN" and any("expired" in x for x in e["reasons"]), "expired evidence reused", f)
        return {"reasons": e["reasons"]}


@case("E06", "Contradictory sources: both presented, resolution requested")
def e06(f):
    with Fresh() as c:
        load(c, "A")
        importer.import_evidence(c, "bob", EV / "eval" / "tls-conflicting-fail.meta.json")
        r = packages.build_package(c, "bob", P)
        row = rows_of(c, r["package_id"])["OBL-SC8-FLOW::flow:portal-api"]
        app = [x for x in row["detail"]["evidence"] if x["applicable"]]
        expect(row["result"] == "UNKNOWN" and len(app) == 2, f"result {row['result']} with {len(app)} applicable", f)
        expect(any("Conflicting" in g for g in row["gaps"]), "no resolution request", f)
        expect(row["evidence_state"] == "CONFLICT", f"evidence_state {row['evidence_state']}", f)
        return {"applicable_results": [x["result"] for x in app]}


@case("E07", "Unknown control ID rejected; unset parameters preserved as unresolved")
def e07(f):
    with Fresh() as c:
        bad = json.loads(config.MAPPINGS_PATH.read_text())
        bad["obligations"][0]["control_id"] = "ac-99"
        tmp = Path(tempfile.mkdtemp()) / "bad.json"
        tmp.write_text(json.dumps(bad))
        try:
            reference.install(c, mappings_path=tmp)
            f.append("unknown control id accepted")
        except reference.ReferenceError_ as e:
            msg = str(e)
        r = scenario(c, "A_complete")
        rows = rows_of(c, r["package_id"])
        unresolved = [k for rr in rows.values() for k, v in rr["params"].items() if v["state"] == "UNRESOLVED"]
        expect("au-12_odp.01" in unresolved and "sc-08_odp" in unresolved, "parameters silently filled", f)
        d = json.loads(packages.get(c, r["package_id"])["draft_json"])
        expect(any("unresolved" in q["text"] for q in d["questions"]), "no reviewer question for parameters", f)
        return {"rejection": msg[:120], "unresolved_params": sorted(set(unresolved))}


@case("E08", "Claimed inherited control without evidence stays unresolved")
def e08(f):
    with Fresh() as c:
        r = scenario(c, "A_complete")
        row = rows_of(c, r["package_id"])["OBL-SC8-INHERIT::cmp:telemetry-db"]
        expect(row["result"] == "UNKNOWN", f"inheritance became {row['result']}", f)
        return {"gaps": row["gaps"]}


@case("E09", "Added flow / changed role: scope expands, AC-3 mismatch found, prior review STALE")
def e09(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        a = M.current_snapshot(c, P)["id"]
        importer.import_model(c, "bob", demo.MODEL_B.read_bytes())
        b = M.current_snapshot(c, P)["id"]
        st = packages.status(c, p["package_id"])
        expect(st["effective_state"] == "STALE", "prior review not STALE", f)
        rep = impact.impact_report(c, P, a, b, p["package_id"])
        exp = EXP["impact_A_to_B"]
        got_aff = {x["row_id"] for x in rep["affected_rows"]}
        fn = set(exp["affected_rows"]) - got_aff
        fp = got_aff - set(exp["affected_rows"])
        expect(not fn, f"impact false negatives {fn}", f)
        expect(rep["new_scope_rows"] == exp["new_scope_rows"], "new scope row missing", f)
        expect(sorted(x["evidence_id"] for x in rep["evidence_applicability_changes"]) ==
               exp["evidence_no_longer_applicable"], "evidence applicability changes wrong", f)
        importer.import_evidence_dir(c, "bob", EV / "set-B")
        p2 = packages.build_package(c, "bob", P)
        ac3 = rows_of(c, p2["package_id"])["OBL-AC3-API::cmp:api-service"]
        expect(ac3["result"] == "FAIL" and len(ac3["detail"]["mismatches"]) == 2, "AC-3 mismatch not detected", f)
        return {"impact_false_negatives": len(fn), "impact_false_positives": len(fp),
                "affected_rows": sorted(got_aff)}


@case("E10", "Edited draft creates a new version and requires a new decision")
def e10(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        e = packages.edit_section(c, "bob", p["package_id"], "sec:scope", "Operators are trained annually.", [])
        st = packages.status(c, e["package_id"])
        expect(e["package_id"] != p["package_id"], "edit mutated package", f)
        expect(st["review_state"] == "NEEDS_REVIEW", f"edited package state {st['review_state']}", f)
        expect(e["validation"]["counts"].get("UNSUPPORTED", 0) == 1, "uncited human edit not flagged", f)
        try:
            export.export_package(c, "alice", e["package_id"], mode="current")
            f.append("edited package exported as reviewed")
        except export.ExportRefused:
            pass
        try:
            review.decide(c, "alice", e["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                          seen_head_decision_id=None)
            f.append("decision on old digest moved onto new text")
        except review.ReviewConflict:
            pass
        return {"new_package": e["package_id"]}


@case("E11", "Changed policy bundle or catalog invalidates review")
def e11(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        td = Path(tempfile.mkdtemp())
        pol = td / "policy"
        shutil.copytree(config.POLICY_DIR, pol)
        (pol / "authz.rego").write_text((pol / "authz.rego").read_text().replace('"operator": {"read"}', '"operator": {"read", "write"}'))
        reference.install(c, policy_dir=pol)
        st = packages.status(c, p["package_id"])
        expect(st["effective_state"] == "STALE", "policy change did not invalidate", f)
        p2 = packages.build_package(c, "bob", P)
        ac3 = rows_of(c, p2["package_id"])["OBL-AC3-API::cmp:api-service"]
        expect(ac3["result"] == "FAIL" and "test_operator_write_denied" in ac3["detail"]["tests"]["failed_names"],
               "changed policy not caught by independent tests", f)
        reference.install(c)  # restore pinned policy
        cat = json.loads(config.CATALOG_PATH.read_text())
        cat["controls"][0]["title"] += " (edited)"
        cp = td / "cat.json"
        cp.write_text(json.dumps(cat))
        reference.install(c, catalog_path=cp)
        expect(packages.status(c, p2["package_id"])["effective_state"] == "STALE", "catalog change did not invalidate", f)
        return {"ac3_failed_tests": ac3["detail"]["tests"]["failed_names"]}


@case("E12", "Revoked reviewer: stale review/export attempts rejected")
def e12(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "carol", p["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        identity.revoke_user(c, "sam", "carol", "eval: authority withdrawn")
        st = packages.status(c, p["package_id"])
        expect(st["review_state"] == "NEEDS_REVIEW", "revoked reviewer's decision still current", f)
        for fn in (lambda: export.export_package(c, "alice", p["package_id"], mode="current"),
                   lambda: review.decide(c, "carol", p["package_id"], "ACCEPT", "again",
                                         seen_package_digest=pk["package_digest"], seen_head_decision_id=st["head_decision"])):
            try:
                fn()
                f.append("action succeeded after revocation")
            except (export.ExportRefused, identity.Denied):
                pass
        return {"reasons": st["reasons"]}


@case("E13", "Concurrent update: second reviewer with stale head gets explicit conflict")
def e13(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "alice", p["package_id"], "ACCEPT", "first", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        try:
            review.decide(c, "carol", p["package_id"], "REJECT", "second", seen_package_digest=pk["package_digest"],
                          seen_head_decision_id=None)
            f.append("concurrent decision accepted silently")
        except review.ReviewConflict as e:
            msg = str(e)
        expect(count(c, "review_decisions") == 1, "extra decision row written", f)
        # Second connection = second process; BEGIN IMMEDIATE serialises writers.
        c2 = db.connect()
        c2.execute("BEGIN IMMEDIATE")
        try:
            c.execute("PRAGMA busy_timeout=200")
            review.decide(c, "carol", p["package_id"], "REJECT", "x", seen_package_digest=pk["package_digest"],
                          seen_head_decision_id="dec-001")
            f.append("write proceeded while another writer held the lock")
        except sqlite3.OperationalError:
            pass
        finally:
            c2.execute("ROLLBACK")
            c2.close()
        return {"conflict": msg}


@case("E14", "Wrong project / unauthorized actor: denied server-side with no effect")
def e14(f):
    with Fresh() as c:
        load(c, "A")
        before = {t: count(c, t) for t in ("snapshots", "packages", "review_decisions", "evidence")}
        attempts = [
            lambda: importer.import_model(c, "mallory", demo.MODEL_B.read_bytes()),
            lambda: packages.build_package(c, "mallory", P),
            lambda: packages.build_package(c, "alice", P),
            lambda: importer.set_evidence_status(c, "alice", "ev-tls-portal-api-a1", "withdrawn", "x"),
            lambda: identity.revoke_user(c, "bob", "alice", "x"),
            lambda: importer.import_model(c, "nobody", demo.MODEL_B.read_bytes()),
        ]
        denied = 0
        for a in attempts:
            try:
                a()
            except identity.Denied:
                denied += 1
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        try:
            review.decide(c, "bob", p["package_id"], "ACCEPT", "self", seen_package_digest=pk["package_digest"],
                          seen_head_decision_id=None)
        except identity.Denied:
            denied += 1
        after = {t: count(c, t) for t in ("snapshots", "packages", "review_decisions", "evidence")}
        after["packages"] -= 1
        expect(denied == 7, f"only {denied}/7 denied", f)
        expect(before == after, f"unauthorized effect: {before} -> {after}", f)
        n_denied = c.execute("SELECT COUNT(*) AS n FROM audit_events WHERE outcome='denied'").fetchone()["n"]
        expect(n_denied == 7, f"denied audit events {n_denied}", f)
        return {"denied": denied, "unauthorized_effects": 0 if before == after else 1}


@case("E15", "Source contains an instruction to approve itself: no authority follows")
def e15(f):
    with Fresh() as c:
        scenario(c, "B_with_B_evidence")
        r = packages.build_package(c, "bob", P, mode="fixture-seeded")
        st = packages.status(c, r["package_id"])
        d = json.loads(packages.get(c, r["package_id"])["draft_json"])
        inj = next(cl for s in d["sections"] for cl in s["claims"] if cl.get("seeded") == "obeyed injected instruction")
        expect(inj["validation"]["status"] == "PROHIBITED_ASSERTION", "injected approval claim not flagged", f)
        expect(st["review_state"] == "NEEDS_REVIEW" and count(c, "review_decisions") == 0, "state changed", f)
        return {"flag": inj["validation"]["problems"]}


@case("E16", "Incorrect generated policy: independent tests detect it; enforcement policy unchanged")
def e16(f):
    r1 = opa.evaluate_candidate((config.FIXTURES / "candidates" / "candidate_missing_project_check.rego").read_text())
    r2 = opa.evaluate_candidate((config.FIXTURES / "candidates" / "candidate_uses_http_send.rego").read_text())
    expect(r1["verdict"] == "FAILS_INDEPENDENT_TESTS", f"candidate verdict {r1['verdict']}", f)
    expect(r2["verdict"] == "REJECTED_AT_COMPILE", f"http.send verdict {r2['verdict']}", f)
    expect(r1["enforcement_policy_unchanged"] and r2["enforcement_policy_unchanged"], "enforcement policy changed", f)
    return {"missing_project_check": {"failed": r1["tests"]["failed_names"]}, "http_send": r2["verdict"]}


@case("E17", "Empty tests, evaluator error, unavailable model: distinct failures, no silent success")
def e17(f):
    with Fresh() as c:
        td = Path(tempfile.mkdtemp())
        shutil.copy(config.POLICY_DIR / "authz.rego", td / "authz.rego")
        reference.install(c, policy_dir=td)
        load(c, "A")
        importer.import_evidence(c, "bob", EV / "eval" / "tls-malformed.meta.json")
        r = packages.build_package(c, "bob", P)
        rows = rows_of(c, r["package_id"])
        expect(rows["OBL-AC3-API::cmp:api-service"]["result"] == "ERROR", "empty policy test suite did not ERROR", f)
        sc8 = rows["OBL-SC8-FLOW::flow:portal-api"]
        expect(sc8["result"] == "ERROR" and "unparseable" in (sc8["error"] or ""), f"malformed evidence gave {sc8['result']}", f)
        n = count(c, "packages")
        try:
            packages.build_package(c, "bob", P, mode="live")
            live = "succeeded (credentials present?)"
        except drafting.DraftingError as e:
            live = f"DraftingError: {e}"
            expect(count(c, "packages") == n, "package written after drafting failure", f)
        return {"ac3": "ERROR", "sc8_error": sc8["error"], "live_mode": live}


@case("E18", "Retry after commit returns the committed result; one operation, one history")
def e18(f):
    with Fresh() as c:
        a1 = importer.import_model(c, "bob", demo.MODEL_A.read_bytes(), op_id="op-imp-1")
        a2 = importer.import_model(c, "bob", demo.MODEL_A.read_bytes(), op_id="op-imp-1")
        expect(a1 == a2 and count(c, "snapshots") == 1, "import retry duplicated", f)
        importer.import_evidence_dir(c, "bob", EV / "set-A")
        p = packages.build_package(c, "bob", P, op_id="op-build-1")
        p_retry = packages.build_package(c, "bob", P, op_id="op-build-1")
        expect(p == p_retry and count(c, "packages") == 1, "build retry duplicated", f)
        pk = packages.get(c, p["package_id"])
        kw = dict(seen_package_digest=pk["package_digest"], seen_head_decision_id=None, op_id="op-rev-1")
        d1 = review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", **kw)
        # acknowledgement "lost": client retries the same operation
        d2 = review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", **kw)
        expect(d1 == d2 and count(c, "review_decisions") == 1, "review retry duplicated", f)
        try:
            review.decide(c, "alice", p["package_id"], "REJECT", "different", **kw)
            f.append("op id reuse with different request accepted")
        except db.OperationConflict:
            pass
        return {"decision": d1["decision_id"], "decision_rows": count(c, "review_decisions")}


@case("E19", "Invalid OSCAL / broken reference: validation failure reported, nothing invented")
def e19(f):
    with Fresh() as c:
        scenario(c, "A_complete")
        pid = packages.list_packages(c, P)[0]["id"]
        pk = packages.get(c, pid)
        review.decide(c, "alice", pid, "ACCEPT", "ok", seen_package_digest=pk["package_digest"], seen_head_decision_id=None)
        out = export.export_package(c, "alice", pid)
        good = json.loads((Path(out["path"]) / "oscal-validation-report.json").read_text())
        if good["schema_valid"] is None:
            # Validator libraries absent: the export must NOT be labelled OSCAL.
            expect("component-definition.UNVALIDATED.json" in out["files"] and not good["valid_oscal_claim"],
                   "unvalidated document labelled as OSCAL", f)
            return {"validation": "NOT RUN (jsonschema/regex not installed); file labelled UNVALIDATED"}
        expect(good["valid_oscal_claim"] is True, f"clean export not valid: {good['schema_errors'][:2]}", f)
        doc = json.loads((Path(out["path"]) / "oscal-component-definition.json").read_text())
        cd = doc["component-definition"]
        ir = cd["components"][0]["control-implementations"][0]["implemented-requirements"][0]
        ir["control-id"] = "ac-99"
        ir["links"][0]["href"] = "#00000000-0000-4000-8000-000000000000"
        cd["components"][0]["uuid"] = "not-a-uuid"
        del cd["metadata"]["title"]
        _, cat = reference.get(c, "catalog")
        rep = export.validate_oscal(doc, cat)
        expect(rep["schema_valid"] is False and len(rep["reference_errors"]) >= 2 and not rep["valid_oscal_claim"],
               "invalid document not rejected", f)
        return {"clean_export_valid": good["valid_oscal_claim"], "schema_errors": rep["schema_errors"][:3],
                "reference_errors": rep["reference_errors"]}


@case("E20", "Persisted history survives restart; audit chain intact; tampering detected")
def e20(f):
    with Fresh() as c:
        load(c, "A")
        p = packages.build_package(c, "bob", P)
        pk = packages.get(c, p["package_id"])
        review.decide(c, "alice", p["package_id"], "ACCEPT", "ok", seen_package_digest=pk["package_digest"],
                      seen_head_decision_id=None)
        before = packages.status(c, p["package_id"])
        c.close()
        c2 = db.connect()
        after = packages.status(c2, p["package_id"])
        expect(before == after, "status changed across restart", f)
        chain = db.verify_audit_chain(c2)
        expect(chain["ok"], "audit chain broken", f)
        try:
            c2.execute("UPDATE review_decisions SET decision='REJECT'")
            f.append("append-only trigger did not fire")
        except sqlite3.IntegrityError:
            pass
        # Simulate an administrator bypassing triggers: the hash chain detects the edit.
        c2.execute("DROP TRIGGER audit_events_no_update")
        c2.execute("UPDATE audit_events SET actor='someone-else' WHERE seq=3")
        tampered = db.verify_audit_chain(c2)
        expect(not tampered["ok"], "tampering not detected", f)
        c2.close()
        return {"events": chain["events"], "tamper_detected_at_seq": tampered.get("broken_at_seq")}


@case("E21", "Audit records missing a required field: FAIL with the specific problem")
def e21(f):
    with Fresh() as c:
        load(c, "A")
        importer.set_evidence_status(c, "bob", "ev-audit-api-a1", "withdrawn", "eval")
        importer.import_evidence(c, "bob", EV / "eval" / "audit-missing-outcome.meta.json")
        r = packages.build_package(c, "bob", P)
        row = rows_of(c, r["package_id"])["OBL-AU12-API::cmp:api-service"]
        expect(row["result"] == "FAIL" and any("outcome" in g for g in row["gaps"]), f"got {row['result']}", f)
        return {"gaps": [g for g in row["gaps"] if "outcome" in g]}


@case("E22", "Seeded drafter failure modes are all flagged by the validator")
def e22(f):
    with Fresh() as c:
        scenario(c, "B_with_B_evidence")
        r = packages.build_package(c, "bob", P, mode="fixture-seeded")
        d = json.loads(packages.get(c, r["package_id"])["draft_json"])
        seeded = [cl for s in d["sections"] for cl in s["claims"] if cl.get("seeded")]
        flagged = [cl for cl in seeded if cl["validation"]["status"] not in ("CITATIONS_RESOLVE", "NO_CITATION_REQUIRED")]
        expect(len(seeded) == EXP["seeded_drafter_errors"], f"{len(seeded)} seeded", f)
        expect(len(flagged) == len(seeded), f"{len(flagged)}/{len(seeded)} flagged", f)
        clean = sum(1 for s in d["sections"] for cl in s["claims"] if not cl.get("seeded")
                    and cl["validation"]["status"] not in ("CITATIONS_RESOLVE", "NO_CITATION_REQUIRED"))
        expect(clean == 0, f"{clean} false flags on non-seeded claims", f)
        return {"seeded": len(seeded), "flagged": len(flagged), "false_flags_on_clean_claims": clean,
                "by_type": {cl["seeded"]: cl["validation"]["status"] for cl in seeded}}


# --- baseline comparison -----------------------------------------------------------

def baseline_comparison():
    """Same scenarios, two drafters: template baseline vs workbench (checks + fixture drafter)."""
    out = []
    for name, exp in EXP["scenarios"].items():
        with Fresh() as c:
            t0 = time.perf_counter()
            r = scenario(c, name)
            build_ms = (time.perf_counter() - t0) * 1000
            p = packages.get(c, r["package_id"])
            rows = json.loads(p["rows_json"])
            snap = M.snapshot(c, p["snapshot_id"])
            cat_d, cat = reference.get(c, "catalog")
            map_d, maps = reference.get(c, "mappings")
            ctx = drafting.build_context(c, P, snap, rows, cat_d, cat, map_d, maps)
            base, _ = drafting.draft(c, "baseline", ctx)
            bval = drafting.validate(c, base, ctx)
            wb = json.loads(p["draft_json"])
            wval = json.loads(p["validation_json"])
            gap_rows = set(exp["gap_rows"])
            wb_gap_rows = {cl["row_id"] for s in wb["sections"] for cl in s["claims"] if cl["kind"] == "gap"} & gap_rows
            base_gap_rows = {cl["row_id"] for s in base["sections"] for cl in s["claims"] if cl["kind"] == "gap"} & gap_rows
            cites = [x for s in wb["sections"] for cl in s["claims"] for x in cl.get("cites", [])]
            resolved = 0
            for x in cites:
                try:
                    drafting.resolve_citation(c, x)
                    resolved += 1
                except Exception:
                    pass
            results_ok = sum(1 for r in rows if exp["rows"].get(r["row_id"]) == r["result"])
            out.append({
                "scenario": name, "rows": len(rows), "row_results_matching_expected": results_ok,
                "expected_gap_rows": len(gap_rows),
                "workbench_gap_rows_found": len(wb_gap_rows), "baseline_gap_rows_found": len(base_gap_rows),
                "workbench_overclaims": wval["counts"].get("OVERCLAIM", 0),
                "baseline_overclaims": bval["counts"].get("OVERCLAIM", 0),
                "workbench_citations": len(cites), "workbench_citations_resolved": resolved,
                "build_ms": round(build_ms),
            })
    return out


def main():
    results = []
    for cid, title, fn in CASES:
        fails: list[str] = []
        t0 = time.perf_counter()
        try:
            detail = fn(fails)
        except Exception as e:
            detail = {"exception": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-800:]}
            fails.append("exception")
        results.append({"id": cid, "title": title, "held_out": cid in HELD_OUT, "passed": not fails,
                        "failures": fails, "ms": round((time.perf_counter() - t0) * 1000), "detail": detail})
        print(f"{cid} {'PASS' if not fails else 'FAIL'} {title}" + (f"  -> {fails}" if fails else ""))
    comp = baseline_comparison()
    env = {"opa": opa.version(), "python": os.sys.version.split()[0], "clock": os.environ["DMMC_NOW"],
           "code_digest": config.code_digest(), "git": config.git_revision()}
    rep = {"environment": env, "cases": results, "baseline_comparison": comp,
           "summary": {"cases": len(results), "passed": sum(r["passed"] for r in results),
                       "held_out_cases": sorted(HELD_OUT)}}
    (ROOT / "reports").mkdir(exist_ok=True)
    (ROOT / "reports" / "evaluation_report.json").write_text(json.dumps(rep, indent=2, default=str))
    (ROOT / "reports" / "evaluation_report.md").write_text(render_md(rep))
    print(f"\n{rep['summary']['passed']}/{rep['summary']['cases']} cases passed; report in reports/")
    return 0 if rep["summary"]["passed"] == rep["summary"]["cases"] else 1


def render_md(rep):
    s, env = rep["summary"], rep["environment"]
    L = ["# Evaluation report (synthetic engineering check)", "",
         "Generated by `python -m workbench eval`. This checks software behaviour on synthetic fixtures. It does not",
         "measure language-model quality (fixture drafter), mission validity, or production reliability.", "",
         f"- Environment: OPA {env['opa']}, Python {env['python']}, pinned clock {env['clock']}, "
         f"code digest `{env['code_digest'][:12]}`, git `{env['git']}`",
         f"- Result: **{s['passed']} of {s['cases']} cases passed**. Each case is an independent scenario on a fresh database;",
         "  repeated runs are not additional samples.",
         f"- Held-out designation ({', '.join(s['held_out_cases'])}) is procedural only: the same author wrote the cases,",
         "  the expected values and the code in one session. They are not independent labels.",
         "- Not measured: reviewer correction time, human seeded-error catch rate, live-model quality, latency/cost of",
         "  a live model (no live run was performed).", "",
         "| Case | Held out | Result | ms | Scenario |", "|---|---|---|---|---|"]
    for r in rep["cases"]:
        L.append(f"| {r['id']} | {'yes' if r['held_out'] else ''} | {'PASS' if r['passed'] else 'FAIL: ' + '; '.join(r['failures'])} "
                 f"| {r['ms']} | {r['title']} |")
    L += ["", "## Template baseline vs. workbench on the same scenarios", "",
          "Baseline = a narrative template filled from model design attributes (no evidence, no checks).",
          "Workbench = deterministic checks + fixture drafter + validator. Counts are per scenario (rows are obligation×object).", "",
          "| Scenario | Rows | Row results = expected | Gap rows expected | Gap rows found (workbench / baseline) | "
          "Overclaims (workbench / baseline) | Citations resolved | Build ms |", "|---|---|---|---|---|---|---|---|"]
    for c in rep["baseline_comparison"]:
        L.append(f"| {c['scenario']} | {c['rows']} | {c['row_results_matching_expected']}/{c['rows']} | {c['expected_gap_rows']} | "
                 f"{c['workbench_gap_rows_found']} / {c['baseline_gap_rows_found']} | {c['workbench_overclaims']} / "
                 f"{c['baseline_overclaims']} | {c['workbench_citations_resolved']}/{c['workbench_citations']} | {c['build_ms']} |")
    L += ["", "Reading this honestly: the workbench's advantage over the template comes from deterministic checks and",
          "applicability rules, not from AI. The validator's 'overclaim' rule is a regex over implementation verbs; it is a",
          "guard, not a semantic judge. Build time includes spawning OPA subprocesses on this container.", "",
          "## Case details", ""]
    for r in rep["cases"]:
        L.append(f"- **{r['id']}** `{json.dumps(r['detail'], default=str)[:600]}`")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
