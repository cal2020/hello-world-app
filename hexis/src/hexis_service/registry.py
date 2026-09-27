"""Artifact registry: immutable versions, admission records, active pointers, revocation.

Lifecycle ``draft -> validated -> admitted``; ``active`` is per tenant (the
tenant's active pointer names an admitted version); ``revoked`` is terminal and
blocks new runs and further promotion. Admitted packages are never edited in place. The active pointer moves
only through ``promote`` with a compare-and-swap on the expected current
hash, and the archive manifest pointer moves in the same transaction.
Runs pin an artifact hash and are never migrated automatically.
"""
from __future__ import annotations

import json

from . import canonical
from .package import LoadedPackage, load_package, sign_admission, verify_admission
from .store import ConflictError, Store
from .validator import validate_package


class AdmissionRejected(ValueError):
    def __init__(self, message: str, report: dict | None = None):
        super().__init__(message)
        self.report = report


class Registry:
    def __init__(self, store: Store):
        self.store = store

    def register_draft(self, pkg: dict) -> str:
        load_package(pkg)  # hash and schema check
        self.store.put_machine_version(pkg, "draft")
        return pkg["artifact_hash"]

    def admit(self, pkg: dict, approver: str, environment: str, replay_report: dict | None = None,
              profile: str = "production") -> dict:
        loaded = load_package(pkg)
        vr = validate_package(loaded, profile)
        if not vr.ok:
            raise AdmissionRejected("static validation failed", vr.to_dict())
        if replay_report is not None and not replay_report.get("ok", False):
            raise AdmissionRejected("protected replay failed", replay_report)
        self.store.put_machine_version(pkg, "validated")
        record = sign_admission({
            "artifact_hash": pkg["artifact_hash"], "environment": environment, "approved_by": approver,
            "validation_digest": canonical.digest(vr.to_dict()),
            "replay_digest": canonical.digest(replay_report) if replay_report else None,
            "profile": profile, "revocation_ref": f"revocation:{pkg['artifact_hash']}",
        })
        with self.store.tx() as c:
            c.execute("INSERT OR REPLACE INTO admission_reports VALUES(?,?,?)",
                      ("adm-" + pkg["artifact_hash"][7:23], pkg["artifact_hash"], json.dumps(record, sort_keys=True)))
            if self.lifecycle(pkg["artifact_hash"]) in ("draft", "validated"):
                self.store.set_lifecycle(c, pkg["artifact_hash"], "admitted")
        return record

    def admission(self, artifact_hash: str) -> dict | None:
        rows = self.store.q("SELECT record_json FROM admission_reports WHERE artifact_hash=?", (artifact_hash,))
        return json.loads(rows[0][0]) if rows else None

    def promote(self, tenant: str, artifact_hash: str, expected_current: str | None,
                archive_manifest: dict | None = None) -> int:
        """Atomically make an admitted version active if the pointer still equals ``expected_current``."""
        got = self.store.get_machine_version(artifact_hash)
        if not got or got[1] != "admitted":
            raise AdmissionRejected(f"{artifact_hash} is {got[1] if got else 'unknown'}, not admitted")
        if not verify_admission(self.admission(artifact_hash)):
            raise AdmissionRejected("admission record signature is invalid")
        skill_id = got[0]["machine"]["skill_id"]
        with self.store.tx() as c:
            row = c.execute("SELECT artifact_hash, generation FROM active_machine_versions WHERE tenant_id=? AND "
                            "skill_id=?", (tenant, skill_id)).fetchone()
            current = row[0] if row else None
            if current != expected_current:
                raise ConflictError(f"active version is {current}, expected {expected_current}")
            gen = (row[1] if row else 0) + 1
            manifest_id = None
            if archive_manifest is not None:
                manifest_id = "am-" + canonical.digest(archive_manifest)[7:23]
                c.execute("INSERT OR IGNORE INTO trace_archive_manifests VALUES(?,?,?)",
                          (manifest_id, skill_id, json.dumps(archive_manifest, sort_keys=True)))
            c.execute("INSERT INTO active_machine_versions VALUES(?,?,?,?,?) ON CONFLICT(tenant_id, skill_id) DO "
                      "UPDATE SET artifact_hash=excluded.artifact_hash, generation=excluded.generation, "
                      "archive_manifest_id=excluded.archive_manifest_id",
                      (tenant, skill_id, artifact_hash, gen, manifest_id))
        return gen

    def revoke(self, artifact_hash: str) -> None:
        with self.store.tx() as c:
            self.store.set_lifecycle(c, artifact_hash, "revoked")

    def lifecycle(self, artifact_hash: str, tenant: str | None = None) -> str | None:
        """Stored lifecycle (draft/validated/admitted/revoked). With ``tenant``, an admitted version
        that is that tenant's active pointer is reported as ``active``; activeness is per tenant."""
        got = self.store.get_machine_version(artifact_hash)
        if not got:
            return None
        if tenant is not None and got[1] == "admitted":
            row = self.store.get_active(tenant, got[0]["machine"]["skill_id"])
            if row and row[0] == artifact_hash:
                return "active"
        return got[1]

    def load(self, artifact_hash: str) -> LoadedPackage:
        got = self.store.get_machine_version(artifact_hash)
        if not got:
            raise KeyError(artifact_hash)
        return load_package(got[0])

    def active(self, tenant: str, skill_id: str) -> tuple[str, int, dict | None] | None:
        row = self.store.get_active(tenant, skill_id)
        if not row:
            return None
        manifest = None
        if row[2]:
            rows = self.store.q("SELECT manifest_json FROM trace_archive_manifests WHERE manifest_id=?", (row[2],))
            manifest = json.loads(rows[0][0]) if rows else None
        return row[0], row[1], manifest
