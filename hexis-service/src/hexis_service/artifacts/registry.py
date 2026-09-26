"""Artifact registry: immutable versions, admission, active pointers, revocation (brief §6.2, §9.5).

Lifecycle: validated → admitted → active; revoked prevents new runs. Admission re-validates the
package itself (it never trusts a report handed to it), requires an admin role, binds the artifact
hash to the validation-report digest and replay-archive digest in a signed record, and publishes
the new active pointer plus the new protected-archive manifest atomically with a compare-and-swap
against the expected parent.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from ..canonical import digest
from ..tools.catalog import ToolCatalog
from ..tools.policy import Principal
from .package import AdmissionRecord, MachinePackage, sign_admission
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


def admit(store, pkg: MachinePackage, catalog: ToolCatalog, *, expected_parent_hash: Optional[str],
          approver: Principal, environment: str, archive_manifest: dict, now: float,
          skill_text: Optional[str] = None, replay_passed: bool = True) -> AdmissionResult:
    h = pkg.artifact_hash
    if ADMIN_ROLE not in approver.roles:
        return AdmissionResult("REJECTED", h, [f"{approver.id} lacks role {ADMIN_ROLE}"])
    report = validate_package(pkg, catalog, "production", skill_text=skill_text)
    if not report.passed:
        return AdmissionResult("REJECTED", h, [f"{f.code}: {f.message}" for f in report.errors])
    if not replay_passed:
        return AdmissionResult("REJECTED", h, ["protected replay gate did not pass"])
    if (pkg.lineage.parent_hash or None) != (expected_parent_hash or None):
        return AdmissionResult("REJECTED", h, ["package lineage parent does not match expected parent"])
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
        version = (row[1] if row else 0) + 1
        from ..storage.sqlite import _j
        db.execute("INSERT OR IGNORE INTO admission_reports VALUES(?,?,?)", (h, _j(rec.model_dump(mode="json")),
                                                                            _j(rj)))
        store.add_lifecycle(db, h, "admitted", approver.id, environment, now)
        store.add_lifecycle(db, h, "active", approver.id, environment, now)
        db.execute("INSERT INTO trace_archive_manifests VALUES(?,?,?,?,?)",
                   (skill_id, version, h, _j({**archive_manifest, "version": version, "artifact_hash": h}), now))
        db.execute("INSERT OR REPLACE INTO active_machine_versions VALUES(?,?,?,?,?)",
                   (environment, skill_id, h, version, now))
    return AdmissionResult("ADMITTED", h, [], rec.model_dump(mode="json"), version)


def revoke(store, artifact_hash: str, actor: Principal, reason: str, now: float) -> None:
    if ADMIN_ROLE not in actor.roles:
        raise PermissionError(f"{actor.id} lacks role {ADMIN_ROLE}")
    with store.tx() as db:
        store.add_lifecycle(db, artifact_hash, "revoked", actor.id, reason, now)
