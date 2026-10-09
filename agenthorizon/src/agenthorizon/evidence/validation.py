"""DATA_VALIDATION.json: validation outcomes for every dataset this environment could obtain, and the checks that
are waiting on the official release.

* official AgentHorizon release: not ingested here (dataset host unreachable); the access attempts and the exact
  checks that ``agenthorizon data validate`` will run are listed, with nothing inferred.
* synthetic fixture (TEST DATA): ingested afresh into a temporary directory so the full validator and the release
  reconciliation run end to end on every regeneration.
* supplemental sources: the real imports in this deployment's var directory (AgentRewardBench annotations, OSWorld
  task definitions) with their coverage and missing material.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from agenthorizon.config import Settings
from agenthorizon.util.io import utcnow_iso


def _strip_volatile(report: dict | None) -> dict | None:
    if report is None:
        return None
    return {k: v for k, v in report.items() if k != "generated_at"}


def data_validation_report(settings: Settings) -> dict:
    from agenthorizon.data.dataset import DatasetVersion
    from agenthorizon.data.ingest import IngestOptions, ingest
    from agenthorizon.sources.cache import load_lock
    from agenthorizon.supplemental.pipeline import supplemental_stores
    from agenthorizon.testing.fixture import build_fixture

    lock = load_lock() or {"sources": []}
    ds = next((s for s in lock["sources"] if s["source_id"] == "agenthorizon-dataset"), {})

    with tempfile.TemporaryDirectory(prefix="ah-validation-") as td:
        build_fixture(Path(td) / "fx")
        r = ingest(Settings(var_dir=Path(td) / "var"), IngestOptions(source="local", local_dir=Path(td) / "fx", media="all"))
        dv = DatasetVersion(Path(r.root))
        validation, reconciliation = dv.report("validation"), dv.report("reconciliation")
        fixture = {"warning": "SYNTHETIC test fixture: its records, labels and counts are test data, never AgentHorizon "
                              "content", "dataset_version_id": dv.id, "ingest_status": r.status,
                   "validation": _strip_volatile(validation), "reconciliation": _strip_volatile(reconciliation)}
    checks = [{"check": c["check"], "severity": c["severity"], "detail": c["detail"]} for c in validation["checks"]]

    supplemental = []
    for st in supplemental_stores(settings):
        v = st.version()
        supplemental.append({"store": st.root.name, "source_id": v.get("source_id"), "revision": v.get("revision"),
                             "records": v.get("records"), "records_sha256": v.get("records_sha256"),
                             "license": v.get("license"), "coverage": st.coverage(),
                             "summary": v.get("summary") or v.get("task_definitions"),
                             "trajectories": v.get("trajectories") or v.get("traces"),
                             "compatibility": v.get("compatibility")})

    return {
        "generated_at": utcnow_iso(),
        "official_release": {
            "dataset": "ServiceNow/AgentHorizon (S3)", "status": "not ingested",
            "reason": f"source lock status: {ds.get('status', 'unknown')}",
            "access_attempts": [{k: a.get(k) for k in ("url", "at", "outcome", "detail")} for a in ds.get("access_attempts", [])],
            "checks_to_run": checks,
            "release_reconciliation_targets": "evidence/RELEASE_RECONCILIATION.md (legacy 605/768 composition; revised "
                                              "check table)",
            "commands": ["agenthorizon data ingest --source hf --revision <pinned revision from `agenthorizon sources lock`>",
                         "agenthorizon data validate --dataset-version <dataset version id printed by the ingest>"],
        },
        "synthetic_fixture": fixture,
        "supplemental_sources": supplemental,
    }
