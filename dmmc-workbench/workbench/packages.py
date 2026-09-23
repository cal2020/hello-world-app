"""Evidence packages: an immutable (checks + draft + manifest) bundle for one snapshot.

Content, evidence freshness and review state are separate fields:
  * content      -> draft_json + package_digest (immutable; edits create a new package)
  * freshness    -> CURRENT / STALE: does the package's dependency manifest equal today's?
  * review state -> DRAFT / NEEDS_REVIEW / REVIEWED_FOR_DEMO / REJECTED (+ STALE overrides)
These are application states for the demo, not RMF dispositions.
"""
from __future__ import annotations

import json

from . import checks, config, db, drafting, opa, reference
from . import model as M
from .identity import Denied, authorize, deny_and_audit, get_user
from .util import digest_obj, now


def dependency_manifest(conn, project: str) -> dict:
    """Everything whose change must invalidate a review. Conservative by design."""
    snap = M.current_snapshot(conn, project)
    cat_d, _ = reference.get(conn, "catalog")
    map_d, _ = reference.get(conn, "mappings")
    _, pol = reference.get(conn, "policy")
    evs = [{"id": e["id"], "digest": e["digest"], "status": e["status"]} for e in M.all_evidence(conn, project)]
    return {
        "snapshot": {"id": snap["id"], "digest": snap["digest"], "revision": snap["revision"]} if snap else None,
        "evidence": evs,
        "catalog_digest": cat_d,
        "mappings_digest": map_d,
        "policy_digest": pol["policy_digest"],
        "policy_tests_digest": pol["tests_digest"],
    }


def build_package(conn, actor: str, project: str, *, mode: str = "fixture", op_id: str | None = None,
                  clock: str | None = None) -> dict:
    try:
        authorize(conn, actor, "build_package", project)
    except Denied as d:
        deny_and_audit(conn, d, "build_package", target=project, op_id=op_id)
        raise
    request = {"project": project, "mode": mode}
    prior = db.find_operation(conn, op_id, "build_package", request)
    if prior:
        return prior
    snap = M.current_snapshot(conn, project)
    if snap is None:
        raise ValueError("no model imported for project")
    cat_d, cat = reference.get(conn, "catalog")
    map_d, maps = reference.get(conn, "mappings")
    dep = dependency_manifest(conn, project)
    with db.tx(conn):
        batch, rows = checks.run_checks(conn, project, snap["id"], clock=clock)
        ctx = drafting.build_context(conn, project, snap, rows, cat_d, cat, map_d, maps)
        # Drafting failure aborts the whole transaction: no package, no substitution.
        draft, drafter_meta = drafting.draft(conn, mode, ctx)
        validation = drafting.validate(conn, draft, ctx)
        manifest = {
            "dependencies": dep,
            "code": {"git": config.git_revision(), "workbench_digest": config.code_digest()},
            "drafter": {"mode": mode, **{k: v for k, v in drafter_meta.items() if k != "usage"},
                        "synthetic_fixture": mode.startswith("fixture")},
            "tools": {"opa": opa.version(), "opa_pinned": config.OPA_VERSION},
            "schemas": {"oscal_component_definition": config.OSCAL_VERSION, "model_contract": "0.1"},
            "reviewer_protocol": config.REVIEW_PROTOCOL,
            "check_batch": batch,
            "clock": clock or now(),
        }
        dep_digest = digest_obj(dep)
        pkg_digest = digest_obj({"draft": draft, "rows": rows, "manifest": manifest})
        seq = db.next_seq(conn, "packages")
        pid = f"pkg-{seq:03d}-{snap['revision']}"
        prev = conn.execute("SELECT id FROM packages WHERE project=? ORDER BY seq DESC LIMIT 1", (project,)).fetchone()
        conn.execute("INSERT INTO packages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (pid, seq, project, snap["id"], prev["id"] if prev else None, now(), actor, mode,
                      json.dumps(draft), json.dumps(validation), json.dumps(rows), json.dumps(manifest),
                      dep_digest, pkg_digest, batch))
        result = {"package_id": pid, "package_digest": pkg_digest, "dependency_digest": dep_digest,
                  "coverage": checks.coverage(rows), "validation": validation}
        db.record_operation(conn, op_id, "build_package", actor, request, result)
        db.audit(conn, actor, "build_package", "ok", op_id=op_id, target=pid, new_ref=pkg_digest,
                 detail={"mode": mode, "snapshot": snap["id"], "coverage": result["coverage"]["statement"]})
    return result


def edit_section(conn, actor: str, package_id: str, section_id: str, new_text: str, cites: list[str]) -> dict:
    """A human edit creates a NEW package version; the old review never moves onto it."""
    base = get(conn, package_id)
    try:
        authorize(conn, actor, "edit_draft", base["project"])
    except Denied as d:
        deny_and_audit(conn, d, "edit_draft", target=package_id)
        raise
    draft = json.loads(base["draft_json"])
    sec = next((s for s in draft["sections"] if s["id"] == section_id), None)
    if sec is None:
        raise ValueError(f"no section {section_id}")
    sec["claims"].append({"kind": "fact", "row_id": sec.get("row_id"), "cites": cites, "text": new_text,
                          "edited_by": actor})
    snap = M.snapshot(conn, base["snapshot_id"])
    rows = json.loads(base["rows_json"])
    cat_d, cat = reference.get(conn, "catalog")
    map_d, maps = reference.get(conn, "mappings")
    ctx = drafting.build_context(conn, base["project"], snap, rows, cat_d, cat, map_d, maps)
    for s in draft["sections"]:
        for c in s["claims"]:
            c.pop("validation", None)
    validation = drafting.validate(conn, draft, ctx)
    manifest = json.loads(base["manifest_json"])
    manifest["edited_from"] = package_id
    with db.tx(conn):
        pkg_digest = digest_obj({"draft": draft, "rows": rows, "manifest": manifest})
        seq = db.next_seq(conn, "packages")
        pid = f"pkg-{seq:03d}-{snap['revision']}-edit"
        conn.execute("INSERT INTO packages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (pid, seq, base["project"], base["snapshot_id"], package_id, now(), actor, base["drafter_mode"],
                      json.dumps(draft), json.dumps(validation), base["rows_json"], json.dumps(manifest),
                      base["dependency_digest"], pkg_digest, base["batch_id"]))
        db.audit(conn, actor, "edit_draft", "ok", target=pid, prior_ref=package_id, new_ref=pkg_digest)
    return {"package_id": pid, "package_digest": pkg_digest, "validation": validation}


def get(conn, package_id: str):
    r = conn.execute("SELECT * FROM packages WHERE id=?", (package_id,)).fetchone()
    if r is None:
        raise LookupError(f"unknown package {package_id}")
    return r


def list_packages(conn, project: str):
    return conn.execute("SELECT * FROM packages WHERE project=? ORDER BY seq DESC", (project,)).fetchall()


def decisions(conn, package_id: str):
    out = []
    for r in conn.execute("SELECT * FROM review_decisions WHERE package_id=? ORDER BY seq", (package_id,)):
        d = dict(r)
        rv = conn.execute("SELECT * FROM decision_revocations WHERE decision_id=?", (r["id"],)).fetchone()
        d["revoked"] = dict(rv) if rv else None
        d["limitations"] = json.loads(r["limitations_json"])
        out.append(d)
    return out


def status(conn, package_id: str) -> dict:
    """Derived, never stored: freshness + review state + reasons."""
    p = get(conn, package_id)
    current_dep = digest_obj(dependency_manifest(conn, p["project"]))
    fresh = current_dep == p["dependency_digest"]
    live = [d for d in decisions(conn, package_id) if not d["revoked"]]
    head = live[-1] if live else None
    reasons = []
    if head is None:
        review = "NEEDS_REVIEW"
    elif head["decision"] == "ACCEPT":
        review = "REVIEWED_FOR_DEMO"
        u = get_user(conn, head["actor"])
        if u is None or u["revoked_at"]:
            review = "NEEDS_REVIEW"
            reasons.append(f"reviewer {head['actor']}'s authority was revoked after the decision")
        if head["package_digest"] != p["package_digest"]:
            review = "NEEDS_REVIEW"
            reasons.append("decision bound to different content")
    elif head["decision"] == "REJECT":
        review = "REJECTED"
    else:
        review = "NEEDS_REVIEW"
    if not fresh:
        reasons.append("dependency manifest changed since this package was built (model, evidence, catalog, mappings or policy)")
    effective = "STALE" if not fresh else review
    return {"package_id": package_id, "freshness": "CURRENT" if fresh else "STALE", "review_state": review,
            "effective_state": effective, "head_decision": head["id"] if head else None, "reasons": reasons,
            "current_dependency_digest": current_dep, "package_dependency_digest": p["dependency_digest"]}
