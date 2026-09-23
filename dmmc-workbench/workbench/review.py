"""Review service: identified decisions bound to exact content and dependencies.

No client- or model-supplied flag can authorize a transition. At commit the service
verifies, inside one IMMEDIATE transaction: actor permission and project, actor not
revoked, the digest the reviewer saw equals the stored package digest, the package's
dependency manifest is still current, and the decision head the reviewer saw is
still the head (optimistic concurrency). Any mismatch is an explicit conflict.
"""
from __future__ import annotations

import json

from . import db, packages
from .identity import Denied, authorize, deny_and_audit
from .util import digest_obj, now

DECISIONS = ("ACCEPT", "REQUEST_CHANGES", "REJECT")


class ReviewConflict(Exception):
    pass


def decide(conn, actor: str, package_id: str, decision: str, reason: str, *, seen_package_digest: str,
           seen_head_decision_id: str | None, op_id: str | None = None) -> dict:
    if decision not in DECISIONS:
        raise ValueError(f"decision must be one of {DECISIONS}")
    if not reason or not reason.strip():
        raise ValueError("a reason is required")
    p = packages.get(conn, package_id)
    request = {"package_id": package_id, "decision": decision, "reason": reason,
               "seen_package_digest": seen_package_digest, "seen_head": seen_head_decision_id}
    try:
        u = authorize(conn, actor, "review", p["project"])
        if p["created_by"] == actor:
            raise Denied(actor, "review", p["project"], "reviewer may not review a package they built")
    except Denied as d:
        deny_and_audit(conn, d, "review", target=package_id, op_id=op_id)
        raise
    try:
        with db.tx(conn):
            prior = db.find_operation(conn, op_id, "review", request)
            if prior:
                return prior
            # Re-read everything inside the lock.
            u = conn.execute("SELECT * FROM users WHERE id=?", (actor,)).fetchone()
            if u["revoked_at"]:
                raise ReviewConflict("reviewer authority was revoked")
            p = packages.get(conn, package_id)
            if seen_package_digest != p["package_digest"]:
                raise ReviewConflict("the content you reviewed is not this package's content")
            st = packages.status(conn, package_id)
            if st["freshness"] != "CURRENT":
                raise ReviewConflict("package is STALE: " + "; ".join(st["reasons"]))
            if st["head_decision"] != seen_head_decision_id:
                raise ReviewConflict(f"concurrent update: decision head is {st['head_decision']}, "
                                     f"you saw {seen_head_decision_id}")
            rows = json.loads(p["rows_json"])
            limitations = [{"row_id": r["row_id"], "result": r["result"], "gaps": r["gaps"]}
                           for r in rows if r["gaps"]]
            seq = db.next_seq(conn, "review_decisions")
            did = f"dec-{seq:03d}"
            conn.execute("INSERT INTO review_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (did, seq, package_id, p["package_digest"], p["dependency_digest"], actor, u["role"],
                          decision, reason, json.dumps(limitations), seen_head_decision_id, now()))
            result = {"decision_id": did, "package_id": package_id, "decision": decision,
                      "package_digest": p["package_digest"], "acknowledged_gaps": sum(len(l["gaps"]) for l in limitations)}
            db.record_operation(conn, op_id, "review", actor, request, result)
            db.audit(conn, actor, "review", "ok", op_id=op_id, target=package_id,
                     prior_ref=seen_head_decision_id, new_ref=did,
                     detail={"decision": decision, "package_digest": p["package_digest"],
                             "note": "document review only; not a control-effectiveness or authorization decision"})
        return result
    except ReviewConflict as e:
        db.audit(conn, actor, "review", "conflict", op_id=op_id, target=package_id, detail={"why": str(e)})
        raise


def revoke(conn, actor: str, decision_id: str, reason: str) -> dict:
    d = conn.execute("SELECT * FROM review_decisions WHERE id=?", (decision_id,)).fetchone()
    if d is None:
        raise LookupError(decision_id)
    p = packages.get(conn, d["package_id"])
    try:
        authorize(conn, actor, "revoke_decision", p["project"])
    except Denied as e:
        deny_and_audit(conn, e, "revoke_decision", target=decision_id)
        raise
    with db.tx(conn):
        if conn.execute("SELECT 1 FROM decision_revocations WHERE decision_id=?", (decision_id,)).fetchone():
            raise ReviewConflict("already revoked")
        conn.execute("INSERT INTO decision_revocations VALUES (?,?,?,?)", (decision_id, actor, reason, now()))
        db.audit(conn, actor, "revoke_decision", "ok", target=decision_id, detail={"reason": reason})
    return {"revoked": decision_id}


def request_digest(obj) -> str:
    return digest_obj(obj)
