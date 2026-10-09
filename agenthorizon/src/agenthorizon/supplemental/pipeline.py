"""Import supplemental sources into their own stores, audit separation, and export judge-ready datasets."""

from __future__ import annotations

import json
from pathlib import Path

from agenthorizon.config import Settings
from agenthorizon.supplemental import arb, osworld
from agenthorizon.supplemental.dedup import audit, items_from_dataset, items_from_supplemental
from agenthorizon.supplemental.records import SupplementalStore, SupRecord
from agenthorizon.util.io import atomic_write_json, utcnow_iso


def _lock_entry(source_id: str) -> dict:
    from agenthorizon.sources.cache import load_lock

    lock = load_lock()
    return next((s for s in lock["sources"] if s["source_id"] == source_id), {})


def import_arb(settings: Settings, trajectories_root: Path | None = None, checkout: Path | None = None) -> dict:
    from agenthorizon.sources.cache import checkout as co_fn

    entry = _lock_entry("agentrewardbench-repo")
    co = checkout or co_fn("agentrewardbench-repo").path
    rev = entry.get("resolved_revision") or co.name.split("@")[-1]
    lic = (entry.get("license") or {}).get("status") if isinstance(entry.get("license"), dict) else None
    records, summary = arb.load_repo(co, rev, lic)
    traj = arb.attach_trajectories(records, trajectories_root) if trajectories_root else {
        "files_matched": 0, "note": f"trajectories not imported: the dataset ({arb.DATASET_URL}) was not supplied"}
    store = SupplementalStore.for_source(settings.var_dir, arb.SOURCE_ID, rev)
    agreement = arb.annotation_agreement(records)
    v = store.write(records, {"source_id": arb.SOURCE_ID, "upstream": arb.REPO_URL, "dataset": arb.DATASET_URL,
                              "revision": rev, "license": lic or "unknown (no licence file in the repository)",
                              "summary": summary, "trajectories": traj, "annotation_agreement": agreement,
                              "compatibility": {"binary_success": "expert trajectory_success (primary, Unsure excluded)",
                                                "failure_categories": "unavailable: ARB annotates side effects, optimality "
                                                                      "and looping under its own rubric"},
                              "imported_at": utcnow_iso()})
    return {"store": str(store.root), **v}


def import_osworld(settings: Settings, traces_root: Path | None = None, run_label: str = "operator-run",
                   checkout: Path | None = None) -> dict:
    from agenthorizon.sources.cache import checkout as co_fn

    entry = _lock_entry("osworld-repo")
    co = checkout or co_fn("osworld-repo").path
    rev = entry.get("resolved_revision") or co.name.split("@")[-1]
    tasks, summary = osworld.load_task_definitions(co, rev)
    traces, tsum = [], {"traces": 0, "note": "no trace export supplied (none is linked from the pinned repository)"}
    if traces_root:
        by_id = {r.native_ids["id"]: r for r in tasks if r.native_ids["platform"] == "ubuntu"}
        traces, tsum = osworld.import_trace_exports(traces_root, by_id, run_label=run_label)
    store = SupplementalStore.for_source(settings.var_dir, osworld.SOURCE_ID, rev)
    v = store.write(tasks + traces, {"source_id": osworld.SOURCE_ID, "upstream": osworld.REPO_URL, "revision": rev,
                                     "license": "Apache-2.0", "task_definitions": summary, "traces": tsum,
                                     "compatibility": {"binary_success": "machine evaluator score only (flagged; never official)",
                                                       "failure_categories": "unavailable"},
                                     "imported_at": utcnow_iso()})
    return {"store": str(store.root), **v}


def supplemental_stores(settings: Settings) -> list[SupplementalStore]:
    root = settings.var_dir / "supplemental"
    return [SupplementalStore(p) for p in sorted(root.glob("*@*")) if (p / "version.json").is_file()] if root.is_dir() else []


def run_audit(settings: Settings, output: Path | None = None) -> dict:
    from agenthorizon.data.dataset import DatasetVersion

    items = []
    sources = []
    if settings.datasets_dir.is_dir():
        for p in sorted(settings.datasets_dir.glob("*/version.json")):
            dv = DatasetVersion(p.parent)
            items += items_from_dataset(dv)
            sources.append(dv.id)
    for st in supplemental_stores(settings):
        items += items_from_supplemental(st.records())
        sources.append(st.root.name)
    rep = audit(items)
    rep["datasets_and_sources"] = sources
    if output:
        atomic_write_json(output, rep)
    return rep


def export_for_judging(settings: Settings, store_root: Path, out: Path, *, media_root: Path | None,
                       include_machine_labels: bool = False) -> dict:
    from agenthorizon.supplemental.records import SupLabel, SupStep
    from agenthorizon.supplemental.standard_export import export_standard

    st = SupplementalStore(store_root)
    v = st.version()
    recs = []
    for d in st.records():
        steps = [SupStep(**s) for s in d["steps"]] if d.get("steps") else None
        labels = [SupLabel(**lab) for lab in d["labels"]]
        recs.append(SupRecord(d["record_id"], d["source_id"], d["kind"], d["native_ids"], d["native_schema"], d.get("instruction"),
                              steps, labels, d.get("split"), d["groups"], d["coverage"], d["missing"], d["provenance"],
                              d.get("flags", []), d.get("dedup", {})))
    res = export_standard(recs, media_root, out, benchmark=v["source_id"], include_machine_labels=include_machine_labels)
    (out / "EXPORT_PROVENANCE.json").write_text(json.dumps({"store": str(store_root), "version": v, "result": res}, indent=1,
                                                          default=str))
    return res
