"""Read side of the canonical model: snapshots, elements, flows, evidence applicability."""
from __future__ import annotations

import json

from . import config
from .util import now, parse_time, resolve_pointer


def current_snapshot(conn, project: str):
    r = conn.execute("SELECT current_snapshot_id FROM project_state WHERE project=?", (project,)).fetchone()
    if not r or not r["current_snapshot_id"]:
        return None
    return snapshot(conn, r["current_snapshot_id"])


def snapshot(conn, sid: str):
    return conn.execute("SELECT * FROM snapshots WHERE id=?", (sid,)).fetchone()


def snapshot_doc(conn, sid: str) -> dict:
    return json.loads(snapshot(conn, sid)["raw"])


def elements(conn, sid: str) -> dict:
    return {r["id"]: dict(r, data=json.loads(r["data_json"]))
            for r in conn.execute("SELECT * FROM elements WHERE snapshot_id=? ORDER BY pointer", (sid,))}


def flows(conn, sid: str) -> dict:
    return {r["id"]: dict(r, data=json.loads(r["data_json"]))
            for r in conn.execute("SELECT * FROM flows WHERE snapshot_id=? ORDER BY pointer", (sid,))}


def boundaries(conn, sid: str) -> dict:
    return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM boundaries WHERE snapshot_id=? ORDER BY pointer", (sid,))}


def value_state(container: dict, key: str):
    """Distinguish absent, unknown (explicit null) and present values."""
    if not isinstance(container, dict) or key not in container:
        return "ABSENT", None
    if container[key] is None:
        return "UNKNOWN", None
    return "PRESENT", container[key]


def all_evidence(conn, project: str) -> list[dict]:
    from .importer import evidence_status
    out = []
    for r in conn.execute("SELECT * FROM evidence WHERE project=? ORDER BY id", (project,)):
        d = dict(r)
        d["meta"] = json.loads(r["meta_json"])
        d["status"] = evidence_status(conn, r["id"])
        out.append(d)
    return out


def applicability(ev: dict, els: dict, fls: dict, *, clock: str | None = None) -> tuple[bool, list[str]]:
    """Is this evidence about the CURRENT model identities? Reasons are shown to reviewers.

    A PASS inside an inapplicable report is never reused.
    """
    reasons = []
    meta = ev["meta"]
    if ev["status"] != "active":
        reasons.append(f"status is {ev['status']}")
    if meta.get("environment") != config.DEMO_ENVIRONMENT:
        reasons.append(f"environment {meta.get('environment')!r} is not {config.DEMO_ENVIRONMENT!r}")
    exp = meta.get("expires_at")
    if exp and parse_time(exp) <= parse_time(clock or now()):
        reasons.append(f"expired at {exp}")
    tgt = meta.get("target") or {}
    for eid, rev in (tgt.get("element_revisions") or {}).items():
        cur = els.get(eid)
        if cur is None:
            reasons.append(f"target element {eid} not in current model")
        elif cur["revision"] != rev:
            reasons.append(f"collected against {eid} revision {rev}; current revision is {cur['revision']}")
    fid = tgt.get("flow_id")
    if fid and fid not in fls:
        reasons.append(f"target flow {fid} not in current model")
    return (not reasons), reasons


def resolve_model_pointer(conn, digest: str, ptr: str):
    r = conn.execute("SELECT raw FROM snapshots WHERE digest=?", (digest,)).fetchone()
    if r is None:
        raise LookupError(f"no snapshot with digest {digest[:12]}")
    return resolve_pointer(json.loads(r["raw"]), ptr)
