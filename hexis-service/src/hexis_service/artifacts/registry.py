"""Artifact registry: immutable versions, admission, active pointers, revocation (brief §6.2, §9.5).

Lifecycle: validated → admitted → active; revoked prevents new runs. Admission re-validates the
package itself (it never trusts a report handed to it) against the operator's deployment policy,
replays every protected trace and the negative corpus itself (refusing archives that drop entries of
the current archive version), requires an admin role, binds the artifact
hash to the validation-report digest and replay-archive digest in a signed record, and publishes
the new active pointer plus the new protected-archive manifest atomically with a compare-and-swap
against the expected parent.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from ..canonical import digest, sha256_hex
from ..tools.catalog import ToolCatalog
from ..tools.policy import Principal
from .package import AdmissionRecord, MachinePackage, sign_admission, verify_admission
from .validate import validate_package

ADMIN_ROLE = "artifact_admin"


def signing_key() -> tuple[str, bytes]:
    """Development HMAC key from the environment; a fixed demo key is used only when unset and is
    labeled as such in every admission record."""
    k = os.environ.get("HEXIS_ADMISSION_KEY")
    if k:
        return os.environ.get("HEXIS_ADMISSION_KEY_ID", "env-key"), k.encode()
    return "insecure-demo-key", b"hexis-demo-admission-key-not-for-production"


@dataclass
class AdmissionResult:
    status: str  # ADMITTED | CONFLICT | REJECTED
    artifact_hash: str
    reasons: list[str] = field(default_factory=list)
    record: Optional[dict] = None
    archive_version: Optional[int] = None


def register(store, pkg: MachinePackage, actor: str, now: float) -> None:
    store.put_version(pkg.to_json(), actor, now)


def _check_archive(store, pkg: MachinePackage, protected: list, negative: list, current: dict) -> list[str]:
    """Admission-time replay gates, computed here rather than trusted from the caller.

    * the new archive must keep every protected / negative entry of the current archive version
      (same trace id and records digest); stored bodies of those entries are replayed, not the
      caller's copies;
    * every supplied trace must be intact (sealed record digests);
    * every protected trace must structurally replay (PASS) against the candidate;
    * no negative-corpus trace may become representable (structural PASS)."""
    from ..replay.replay import replay_structural
    from ..traces.model import Trace
    reasons: list[str] = []
    by_id = {"protected": {t.trace_id: t for t in protected}, "negative": {t.trace_id: t for t in negative}}
    to_replay = {"protected": dict(by_id["protected"]), "negative": dict(by_id["negative"])}
    for kind in ("protected", "negative"):
        for ent in current.get(kind, []) or []:
            tid, rd = ent.get("trace_id"), ent.get("records_digest")
            sup = by_id[kind].get(tid)
            if sup is None or sup.records_digest() != rd:
                reasons.append(f"archive: {kind} entry {tid} of the current archive is missing or altered")
                continue
            row = store.q1("SELECT body FROM trace_blobs WHERE trace_id=?", (tid,))
            if row:
                stored, errs = Trace.from_jsonl(row[0])
                if errs or stored.records_digest() != rd:
                    reasons.append(f"archive: stored body of {kind} trace {tid} does not match the manifest")
                    continue
                to_replay[kind][tid] = stored
    for kind in ("protected", "negative"):
        for tid, t in to_replay[kind].items():
            integ = t.integrity_errors()
            if integ:
                reasons.append(f"archive: {kind} trace {tid} integrity: {integ[0]}")
    if reasons:
        return reasons
    for tid, t in sorted(to_replay["protected"].items()):
        r = replay_structural(pkg, t)
        if r.status != "PASS":
            reasons.append(f"protected replay: {tid} {r.status} {r.detail}")
    for tid, t in sorted(to_replay["negative"].items()):
        r = replay_structural(pkg, t)
        if r.status == "PASS":
            reasons.append(f"negative corpus: {tid} is representable by the candidate")
    return reasons


def admit(store, pkg: MachinePackage, catalog: ToolCatalog, *, expected_parent_hash: Optional[str],
          approver: Principal, environment: str, now: float, deployment_policy: object = None,
          protected: Optional[list] = None, negative: Optional[list] = None,
          archive_manifest: Optional[dict] = None, skill_text: Optional[str] = None) -> AdmissionResult:
    """Admit ``pkg`` as the new active version of its skill in ``environment``.

    ``deployment_policy`` is the operator's trusted policy (a ``DeploymentPolicy`` or an
    ``ExecutionPolicy``); admission fails closed without it. ``protected`` / ``negative`` are the
    archive traces (``traces.model.Trace``); admission replays them itself. ``archive_manifest``, if
    given, must equal the manifest of those traces (it is otherwise derived from them)."""
    from ..traces.update import archive_manifest as manifest_of
    h = pkg.artifact_hash
    protected, negative = list(protected or []), list(negative or [])
    if ADMIN_ROLE not in approver.roles:
        return AdmissionResult("REJECTED", h, [f"{approver.id} lacks role {ADMIN_ROLE}"])
    if deployment_policy is None:
        return AdmissionResult("REJECTED", h, ["no operator deployment policy supplied; admission fails closed"])
    if not pkg.verify_hash():
        return AdmissionResult("REJECTED", h, ["HASH_MISSING/HASH_MISMATCH: package is not sealed with its content "
                                               "hash"])
    if skill_text is None:
        return AdmissionResult("REJECTED", h, ["skill source text is required to verify clause provenance"])
    report = validate_package(pkg, catalog, "production", skill_text=skill_text, deployment_policy=deployment_policy)
    if not report.passed:
        return AdmissionResult("REJECTED", h, [f"{f.code}: {f.message}" for f in report.errors])
    if (pkg.lineage.parent_hash or None) != (expected_parent_hash or None):
        return AdmissionResult("REJECTED", h, ["package lineage parent does not match expected parent"])
    computed_manifest = manifest_of(protected, negative)
    if archive_manifest is not None and digest(archive_manifest) != digest(computed_manifest):
        return AdmissionResult("REJECTED", h, ["archive manifest does not match the supplied archive traces"])
    archive_manifest = computed_manifest
    missing_origin = sorted(set(pkg.lineage.trace_ids) - {t.trace_id for t in protected})
    if missing_origin:
        return AdmissionResult("REJECTED", h, [f"originating trace {tid} of this update must be in the protected "
                                               "archive it is admitted with" for tid in missing_origin])
    current_archive = store.archive(pkg.machine.skill_id) or {}
    gated_version = current_archive.get("version")
    gate = _check_archive(store, pkg, protected, negative, current_archive)
    if gate:
        return AdmissionResult("REJECTED", h, gate)
    rj = report.to_json()
    key_id, key = signing_key()
    rec = sign_admission(AdmissionRecord(
        artifact_hash=h, environment=environment, approver=approver.id,
        admitted_at=datetime.fromtimestamp(now, timezone.utc).isoformat(), validation_report_digest=rj["report_digest"],
        replay_archive_digest=digest(archive_manifest), key_id=key_id), key)
    skill_id = pkg.machine.skill_id
    register(store, pkg, approver.id, now)
    with store.tx() as db:
        row = db.execute("SELECT artifact_hash, archive_version FROM active_machine_versions WHERE environment=? AND "
                         "skill_id=?", (environment, skill_id)).fetchone()
        current = row[0] if row else None
        if current != expected_parent_hash:
            return AdmissionResult("CONFLICT", h, [f"active version is {current}, expected {expected_parent_hash}; "
                                                   "rebase onto the new parent and rerun all gates"])
        latest = db.execute("SELECT MAX(version) FROM trace_archive_manifests WHERE skill_id=?",
                            (skill_id,)).fetchone()[0]
        if latest != gated_version:
            return AdmissionResult("CONFLICT", h, ["protected archive changed during admission; rerun all gates"])
        # archive versions are per skill (shared across environments), so allocate from the global max
        version = (latest or 0) + 1
        from ..storage.sqlite import _j
        for t in protected + negative:
            body = t.to_jsonl()
            db.execute("INSERT OR IGNORE INTO trace_blobs VALUES(?,?,?,?)", (t.trace_id, sha256_hex(body), body, now))
        db.execute("INSERT OR IGNORE INTO admission_reports VALUES(?,?,?)", (h, _j(rec.model_dump(mode="json")),
                                                                            _j(rj)))
        # per-environment signed record: what ``is_admitted_in`` verifies before a run may start
        db.execute("INSERT OR IGNORE INTO admission_reports VALUES(?,?,?)",
                   (_env_key(h, environment), _j(rec.model_dump(mode="json")), _j(rj)))
        store.add_lifecycle(db, h, "admitted", approver.id, environment, now)
        store.add_lifecycle(db, h, "active", approver.id, environment, now)
        db.execute("INSERT INTO trace_archive_manifests VALUES(?,?,?,?,?)",
                   (skill_id, version, h, _j({**archive_manifest, "version": version, "artifact_hash": h}), now))
        db.execute("INSERT OR REPLACE INTO active_machine_versions VALUES(?,?,?,?,?)",
                   (environment, skill_id, h, version, now))
    return AdmissionResult("ADMITTED", h, [], rec.model_dump(mode="json"), version)


def enroll_protected(store, skill_id: str, traces: list, *, actor: Principal, environment: str, now: float,
                     negative: bool = False) -> AdmissionResult:
    """Append traces to the stored protected archive (or the negative corpus) without a new machine.

    The stored archive is the only authority on what later admissions must replay: traces that
    were never enrolled are not protected, and an admission cannot drop an enrolled one. Each
    protected trace must be intact, eligible (no ordering / evidence violations) and structurally
    replay against the active version in ``environment``; a negative trace must NOT replay. The new
    archive version is published with a compare-and-swap on the current version."""
    from ..replay.replay import replay_structural
    from ..storage.sqlite import _j
    from ..traces.normalize import eligibility
    kind = "negative" if negative else "protected"
    if ADMIN_ROLE not in actor.roles:
        return AdmissionResult("REJECTED", "", [f"{actor.id} lacks role {ADMIN_ROLE}"])
    active = store.get_active(environment, skill_id)
    if active is None:
        return AdmissionResult("REJECTED", "", [f"no active version of {skill_id} in {environment}"])
    active_hash = active[0]
    pkg = MachinePackage.from_json(store.get_version(active_hash))
    current = store.archive(skill_id) or {}
    reasons = []
    for t in traces:
        integ = t.integrity_errors()
        if integ:
            reasons.append(f"{t.trace_id}: integrity: {integ[0]}")
            continue
        rep = replay_structural(pkg, t)
        if negative:
            if rep.status == "PASS":
                reasons.append(f"{t.trace_id}: negative trace is representable by the active version")
            continue
        viol = eligibility(t, pkg)
        if viol:
            reasons.append(f"{t.trace_id}: ineligible for the protected archive: {viol[0]['code']}")
        if rep.status != "PASS":
            reasons.append(f"{t.trace_id}: does not replay against the active version: {rep.status} {rep.detail}")
    if reasons:
        return AdmissionResult("REJECTED", active_hash, reasons)
    existing = {e["trace_id"]: e for e in current.get(kind, []) or []}
    for t in traces:
        prev = existing.get(t.trace_id)
        if prev is not None and prev.get("records_digest") != t.records_digest():
            return AdmissionResult("REJECTED", active_hash, [f"{t.trace_id}: already enrolled with different records"])
        existing[t.trace_id] = {"trace_id": t.trace_id, "records_digest": t.records_digest()}
    manifest = {"protected": list(current.get("protected", []) or []),
                "negative": list(current.get("negative", []) or []),
                "held_out": current.get("held_out", "never stored here")}
    manifest[kind] = [existing[k] for k in sorted(existing)]
    with store.tx() as db:
        latest = db.execute("SELECT MAX(version) FROM trace_archive_manifests WHERE skill_id=?",
                            (skill_id,)).fetchone()[0]
        if latest != current.get("version"):
            return AdmissionResult("CONFLICT", active_hash, ["protected archive changed concurrently; retry"])
        version = (latest or 0) + 1
        for t in traces:
            body = t.to_jsonl()
            db.execute("INSERT OR IGNORE INTO trace_blobs VALUES(?,?,?,?)", (t.trace_id, sha256_hex(body), body, now))
        db.execute("INSERT INTO trace_archive_manifests VALUES(?,?,?,?,?)",
                   (skill_id, version, active_hash, _j({**manifest, "version": version, "artifact_hash": active_hash}),
                    now))
        db.execute("UPDATE active_machine_versions SET archive_version=? WHERE skill_id=? AND artifact_hash=?",
                   (version, skill_id, active_hash))
        store.add_lifecycle(db, active_hash, f"archive_enrolled:{kind}", actor.id,
                            ",".join(t.trace_id for t in traces), now)
    return AdmissionResult("ADMITTED", active_hash, [], None, version)


def _env_key(artifact_hash: str, environment: str) -> str:
    return f"{artifact_hash}@{environment}"


def is_admitted_in(store, artifact_hash: str, environment: str) -> bool:
    """True only if ``artifact_hash`` was admitted to ``environment`` by :func:`admit`: an
    ``admitted`` lifecycle entry for that environment *and* a stored admission record for that
    environment whose HMAC signature verifies and which binds this hash, this environment and the
    stored validation report. A bare lifecycle row (or an admission to another environment) is not
    enough."""
    import json
    if not any(e["state"] == "admitted" and e["reason"] == environment for e in store.lifecycle(artifact_hash)):
        return False
    row = store.q1("SELECT record, report FROM admission_reports WHERE artifact_hash=?",
                   (_env_key(artifact_hash, environment),))
    if not row:
        return False
    try:
        rec = AdmissionRecord.model_validate(json.loads(row[0]))
        report = json.loads(row[1])
    except Exception:  # noqa: BLE001 - an unparsable record is simply not an admission
        return False
    _, key = signing_key()
    return (rec.artifact_hash == artifact_hash and rec.environment == environment
            and rec.validation_report_digest == report.get("report_digest") and verify_admission(rec, key))


def revoke(store, artifact_hash: str, actor: Principal, reason: str, now: float) -> None:
    if ADMIN_ROLE not in actor.roles:
        raise PermissionError(f"{actor.id} lacks role {ADMIN_ROLE}")
    with store.tx() as db:
        store.add_lifecycle(db, artifact_hash, "revoked", actor.id, reason, now)
