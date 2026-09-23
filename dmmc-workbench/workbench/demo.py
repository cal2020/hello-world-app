"""Deterministic reset and the scripted five-step demonstration (also the recorded fallback)."""
from __future__ import annotations

import json
import shutil

from . import config, db, export, identity, importer, impact, packages, reference, review
from . import model as M

PROJECT = "proj-mtel"
MODEL_A = config.FIXTURES / "models" / "maint-telemetry.vA.json"
MODEL_B = config.FIXTURES / "models" / "maint-telemetry.vB.json"
EVIDENCE_A = config.FIXTURES / "evidence" / "set-A"
EVIDENCE_B = config.FIXTURES / "evidence" / "set-B"


def reset(*, keep_exports: bool = False):
    """Delete local state and seed users + pinned reference data. No model is imported."""
    d = config.data_dir()
    if d.exists():
        for p in d.iterdir():
            if p.name == "exports" and keep_exports:
                continue
            shutil.rmtree(p) if p.is_dir() else p.unlink()
    conn = db.connect()
    with db.tx(conn):
        identity.seed_users(conn)
        db.audit(conn, "system", "reset", "ok", detail={"data_dir": str(d)})
    digests = reference.install(conn)
    return conn, digests


def _say(log, msg):
    log.append(msg)
    print(msg)


def run_demo(conn=None, *, mode: str = "fixture") -> dict:
    """Runs the brief's five steps end to end, printing observable results."""
    if conn is None:
        conn, _ = reset()
    log: list[str] = []
    out = {}
    _say(log, "== Step 1: import Version A and its evidence; build package ==")
    a = importer.import_model(conn, "bob", MODEL_A.read_bytes(), op_id="demo-import-A")
    importer.import_evidence_dir(conn, "bob", EVIDENCE_A)
    p1 = packages.build_package(conn, "bob", PROJECT, mode=mode)
    _say(log, f"snapshot {a['snapshot_id']}; package {p1['package_id']}: {p1['coverage']['statement']}; "
              f"results {p1['coverage']['results']}")

    _say(log, "== Step 2: withdraw the portal->API transport test; rebuild ==")
    importer.set_evidence_status(conn, "bob", "ev-tls-portal-api-a1", "withdrawn", "demo: show the gap")
    p2 = packages.build_package(conn, "bob", PROJECT, mode=mode)
    row = next(r for r in json.loads(packages.get(conn, p2["package_id"])["rows_json"])
               if r["row_id"] == "OBL-SC8-FLOW::flow:portal-api")
    _say(log, f"{p2['package_id']}: SC-8 portal-api -> {row['result']} ({row['evidence_state']}); "
              f"design assertion state {row['detail']['design']['state']}; gaps: {row['gaps'][0]}")
    _say(log, f"{p1['package_id']} is now {packages.status(conn, p1['package_id'])['effective_state']}")

    _say(log, "== Step 3: restore evidence, rebuild, reviewer accepts with gaps retained ==")
    importer.set_evidence_status(conn, "bob", "ev-tls-portal-api-a1", "active", "demo: restore")
    p3 = packages.build_package(conn, "bob", PROJECT, mode=mode)
    pk3 = packages.get(conn, p3["package_id"])
    dec = review.decide(conn, "alice", p3["package_id"], "ACCEPT",
                        "Wording accepted for demo; inheritance and parameters remain open.",
                        seen_package_digest=pk3["package_digest"], seen_head_decision_id=None, op_id="demo-review-A")
    _say(log, f"{dec['decision_id']} ACCEPT on {p3['package_id']} (acknowledged gaps: {dec['acknowledged_gaps']}); "
              f"state {packages.status(conn, p3['package_id'])['effective_state']}")
    e3 = export.export_package(conn, "alice", p3["package_id"], mode="current")
    _say(log, f"export {e3['export_id']} -> {sorted(e3['files'])}")
    out["reviewed_A"] = {"package": p3["package_id"], "export": e3}

    _say(log, "== Step 4: import Version B; prior review becomes STALE; current export refused ==")
    b = importer.import_model(conn, "bob", MODEL_B.read_bytes(), op_id="demo-import-B")
    st = packages.status(conn, p3["package_id"])
    _say(log, f"snapshot {b['snapshot_id']}; {p3['package_id']} is {st['effective_state']}: {st['reasons'][0]}")
    try:
        export.export_package(conn, "alice", p3["package_id"], mode="current")
        _say(log, "UNEXPECTED: stale export allowed")
        out["stale_export_bypass"] = True
    except export.ExportRefused as e:
        _say(log, f"refused as expected: {e}")
        out["stale_export_bypass"] = False
    rep = impact.impact_report(conn, PROJECT, a["snapshot_id"], b["snapshot_id"], p3["package_id"])
    _say(log, "changes: " + "; ".join(f"{c['change']} {c['id']}" for c in rep["changes"]))
    _say(log, f"affected rows: {[x['row_id'] for x in rep['affected_rows']]}; new scope: {rep['new_scope_rows']}")
    _say(log, f"evidence no longer applicable: {[x['evidence_id'] for x in rep['evidence_applicability_changes']]}")
    out["impact"] = rep

    _say(log, "== Step 5: add Version B evidence, rebuild, review, export with gaps ==")
    importer.import_evidence_dir(conn, "bob", EVIDENCE_B)
    p5 = packages.build_package(conn, "bob", PROJECT, mode=mode)
    pk5 = packages.get(conn, p5["package_id"])
    for r in json.loads(pk5["rows_json"]):
        _say(log, f"  {r['row_id']:<40} {r['result']:<8} evidence={r['evidence_state']:<17} gaps={len(r['gaps'])}")
    dec5 = review.decide(conn, "alice", p5["package_id"], "ACCEPT",
                         "Accepted for demo with open gaps: provider transport test missing; "
                         "provider write role not in reviewed policy.",
                         seen_package_digest=pk5["package_digest"], seen_head_decision_id=None)
    e5 = export.export_package(conn, "alice", p5["package_id"], mode="current")
    _say(log, f"{dec5['decision_id']} ACCEPT; export {e5['export_id']} files {sorted(e5['files'])}")
    ocheck = json.loads((config.Path(e5["path"]) / "oscal-validation-report.json").read_text())
    _say(log, f"OSCAL schema_valid={ocheck['schema_valid']} reference_errors={ocheck['reference_errors']}")
    out.update(reviewed_B={"package": p5["package_id"], "export": e5}, log=log,
               audit_chain=db.verify_audit_chain(conn))
    _say(log, f"audit chain: {out['audit_chain']}")
    return out
