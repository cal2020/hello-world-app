"""Workbench's OWN authorization (separate from the target application's Rego policy).

Identities are SIMULATED: the demo has no authentication. The point being
demonstrated is that every state-changing service call is checked server-side
against role, project and revocation, whatever the UI or a model says.
Errors or unknowns deny.
"""
from __future__ import annotations

from . import db
from .util import now

SEED_USERS = [
    ("bob", "Bob (engineer)", "engineer", "proj-mtel"),
    ("alice", "Alice (reviewer)", "reviewer", "proj-mtel"),
    ("carol", "Carol (reviewer)", "reviewer", "proj-mtel"),
    ("sam", "Sam (security admin)", "admin", "proj-mtel"),
    ("mallory", "Mallory (engineer, other project)", "engineer", "proj-other"),
]

PERMISSIONS = {
    "engineer": {"read", "import_model", "import_evidence", "withdraw_evidence", "build_package",
                 "edit_draft", "export_current", "export_historical"},
    "reviewer": {"read", "review", "revoke_decision", "export_current", "export_historical"},
    "admin": {"read", "revoke_user"},
}


class Denied(Exception):
    def __init__(self, actor, action, project, why):
        super().__init__(f"denied: {actor} may not {action} in {project}: {why}")
        self.actor, self.action, self.project, self.why = actor, action, project, why


def seed_users(conn):
    for uid, display, role, project in SEED_USERS:
        conn.execute("INSERT OR IGNORE INTO users (id, display, role, project) VALUES (?,?,?,?)",
                     (uid, display, role, project))


def get_user(conn, actor):
    return conn.execute("SELECT * FROM users WHERE id=?", (actor,)).fetchone()


def authorize(conn, actor: str, action: str, project: str):
    """Raise Denied unless actor holds action in project. Any failure path denies."""
    try:
        u = get_user(conn, actor)
        if u is None:
            raise Denied(actor, action, project, "unknown identity")
        if u["revoked_at"]:
            raise Denied(actor, action, project, "authority revoked")
        if u["project"] != project:
            raise Denied(actor, action, project, "wrong project")
        if action not in PERMISSIONS.get(u["role"], set()):
            raise Denied(actor, action, project, f"role {u['role']} lacks {action}")
        return u
    except Denied:
        raise
    except Exception as e:  # evaluator error is kept distinct but still denies
        raise Denied(actor, action, project, f"authorization error: {e!r}")


def deny_and_audit(conn, exc: Denied, operation: str, target=None, op_id=None):
    """Denied attempts are themselves audit events (written outside the failed transaction)."""
    db.audit(conn, exc.actor or "?", operation, "denied", op_id=op_id, target=target,
             detail={"why": exc.why, "action": exc.action, "project": exc.project})


def revoke_user(conn, actor: str, user_id: str, reason: str):
    target = get_user(conn, user_id)
    if target is None:
        raise ValueError(f"unknown user {user_id}")
    try:
        # Authorize outside the transaction so a denial is audited rather than rolled back.
        authorize(conn, actor, "revoke_user", target["project"])
    except Denied as d:
        deny_and_audit(conn, d, "revoke_user", target=user_id)
        raise
    with db.tx(conn):
        authorize(conn, actor, "revoke_user", target["project"])  # re-check under the write lock
        conn.execute("UPDATE users SET revoked_at=?, revoked_reason=? WHERE id=?", (now(), reason, user_id))
        db.audit(conn, actor, "revoke_user", "ok", target=user_id, detail={"reason": reason})
