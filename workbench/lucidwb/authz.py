"""Simulated local identities and project-scoped permissions.

This is NOT production authentication. Bearer tokens are fixed demo strings seeded
into the local database; the UI's identity switcher is labeled as simulated. The
server never trusts an actor name supplied in a request body.
"""
from .util import ApiError, now

DEMO_USERS = [
    # user_id, display, token, kind, [(project, permission), ...]
    ("alice", "Alice (engineer, reviewer/approver)", "demo-alice", "human",
     [("ehm", "read"), ("ehm", "link:review"), ("ehm", "link:approve")]),
    ("bob", "Bob (viewer)", "demo-bob", "human", [("ehm", "read")]),
    ("carol", "Carol (release manager)", "demo-carol", "human",
     [("ehm", "read"), ("ehm", "import"), ("ehm", "release:manage"), ("ehm", "projection:review"),
      ("ehm", "link:review")]),
    ("dana", "Dana (radar project only)", "demo-dana", "human",
     [("radar", "read"), ("radar", "import"), ("radar", "release:manage")]),
    ("svc-consumer", "Dashboard consumer (service identity)", "demo-svc-consumer", "service", [("ehm", "read")]),
    ("svc-release-check", "Release checker (service identity)", "demo-svc-release-check", "service",
     [("ehm", "read"), ("radar", "read")]),
    ("admin", "Local admin (grant management)", "demo-admin", "human",
     [("ehm", "grants:manage"), ("radar", "grants:manage")]),
]


def seed(c):
    for user_id, display, token, kind, grants in DEMO_USERS:
        c.execute("INSERT OR IGNORE INTO users (user_id, display, token, kind) VALUES (?,?,?,?)",
                  (user_id, display, token, kind))
        for project, perm in grants:
            exists = c.execute("SELECT 1 FROM grants WHERE user_id=? AND project=? AND permission=?",
                               (user_id, project, perm)).fetchone()
            if not exists:
                c.execute("INSERT INTO grants (user_id, project, permission, granted_at) VALUES (?,?,?,?)",
                          (user_id, project, perm, now()))


def authenticate(c, auth_header):
    if not auth_header or not auth_header.startswith("Bearer "):
        raise ApiError(401, "unauthenticated", "A simulated bearer token is required (e.g. 'Bearer demo-alice').")
    row = c.execute("SELECT user_id FROM users WHERE token=?", (auth_header[7:].strip(),)).fetchone()
    if not row:
        raise ApiError(401, "unauthenticated", "Unknown token.")
    return row["user_id"]


def has(c, user, project, perm) -> bool:
    return c.execute("SELECT 1 FROM grants WHERE user_id=? AND project=? AND permission=? AND revoked_at IS NULL",
                     (user, project, perm)).fetchone() is not None


def readable_projects(c, user):
    return sorted(r["project"] for r in c.execute(
        "SELECT DISTINCT project FROM grants WHERE user_id=? AND permission='read' AND revoked_at IS NULL", (user,)))


def require(c, user, project, perm):
    """Current-authority check. Projects the caller cannot read look nonexistent (404), so
    error messages do not disclose other projects' existence or contents."""
    if not has(c, user, project, "read") and not has(c, user, project, perm):
        raise ApiError(404, "not_found", "Resource not found.")
    if not has(c, user, project, perm):
        raise ApiError(403, "forbidden", f"Missing permission '{perm}' on this project.",
                       {"permission": perm})


def grants_for(c, user):
    return [dict(r) for r in c.execute(
        "SELECT project, permission, granted_at, revoked_at FROM grants WHERE user_id=? ORDER BY project, permission",
        (user,))]
