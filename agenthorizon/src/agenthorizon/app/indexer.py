"""Index a dataset version into PostgreSQL (catalogue for search/pagination; labels into the private schema).

The on-disk dataset version remains the source of truth (judge staging reads it); the index is rebuilt
idempotently from it. Gold labels and grouping go only to ``private.*`` and require the scorer identity.
"""

from __future__ import annotations

from sqlalchemy import Engine, delete, insert, select

from agenthorizon.app.schema import (
    assets,
    dataset_versions,
    examples,
    gold_labels,
    grouping,
    manifest_members,
    manifests,
    steps,
)
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.materialize import current_assets
from agenthorizon.data.normalize import length_bin
from agenthorizon.scoring.categories import normalize_native

CHUNK = 2000
SEARCH_TEXT_MAX = 20000


def _chunks(rows: list[dict]):
    for i in range(0, len(rows), CHUNK):
        yield rows[i:i + CHUNK]


def index_dataset_version(engine: Engine, dv: DatasetVersion, private: PrivateStore | None = None) -> dict:
    asset_rows = current_assets(dv)
    ex_rows, step_rows = [], []
    seen_recordings: set[str] = set()
    for e in dv.examples():
        rec_steps = dv.steps(e["recording_id"])
        keys = [s.get("asset_key") for s in rec_steps if s.get("asset_key")]
        mat = sum(1 for k in keys if (asset_rows.get(k) or {}).get("status") == "materialized")
        meta = e.get("task_meta") or {}
        apps = meta.get("applications") or []
        actions = " | ".join(s.get("action_text_full") or s.get("action_text") or "" for s in rec_steps)
        ex_rows.append({
            "dataset_version_id": dv.id, "example_id": e["example_id"], "recording_id": e["recording_id"],
            "instruction_id": e.get("instruction_id"), "instruction": e["instruction"], "n_steps": e["n_steps"],
            "os": (e.get("environment") or {}).get("os"), "application": ", ".join(apps) if apps else None,
            "domain": meta.get("category"), "length_bin": length_bin(e["n_steps"]),
            "has_markdown": bool((e.get("source_files") or {}).get("markdown")),
            "has_json": bool((e.get("source_files") or {}).get("json")),
            "media_total": len(keys), "media_materialized": mat,
            "search_text": (e["instruction"] + "\n" + actions)[:SEARCH_TEXT_MAX].lower(),
            "meta": {"task_meta": meta, "environment": e.get("environment") or {}, "duration_ms": e.get("duration_ms"),
                     "schema_shape": e.get("schema_shape"), "issues": e.get("issues") or []},
        })
        if e["recording_id"] in seen_recordings:
            continue
        seen_recordings.add(e["recording_id"])
        for s in rec_steps:
            step_rows.append({
                "dataset_version_id": dv.id, "recording_id": e["recording_id"], "idx": s["index"], "step_id": s.get("step_id"),
                "action_type": s.get("action_type"), "action_text": s.get("action_text"),
                "action_text_full": s.get("action_text_full"), "action": s.get("action"), "asset_key": s.get("asset_key"),
                "timestamp_us": s.get("timestamp_us"), "observation_timing": s.get("observation_timing"),
                "thought": s.get("thought"), "action_description": s.get("action_description"),
            })
    a_rows = [{"dataset_version_id": dv.id, "asset_key": k, "sha256": a.get("sha256"), "status": a.get("status", "unknown"),
               "width": a.get("width"), "height": a.get("height"), "bytes": a.get("bytes")} for k, a in asset_rows.items()]
    m_rows, mm_rows = [], []
    for m in dv.manifests():
        d = m.to_dict()
        m_rows.append({"manifest_id": m.manifest_id, "dataset_version_id": dv.id, "name": m.name, "partition": m.partition,
                       "role": m.role, "official": m.official, "n_items": d["n_items"], "digest": m.digest,
                       "lineage": m.lineage, "notes": m.notes})
        mm_rows += [{"manifest_id": m.manifest_id, "example_id": eid} for eid in sorted(set(m.example_ids))]
    with engine.begin() as c:
        for t in (steps, assets, examples):
            c.execute(delete(t).where(t.c.dataset_version_id == dv.id))
        c.execute(delete(manifests).where(manifests.c.dataset_version_id == dv.id))
        c.execute(delete(dataset_versions).where(dataset_versions.c.dataset_version_id == dv.id))
        c.execute(insert(dataset_versions).values(
            dataset_version_id=dv.id, benchmark=dv.info.get("benchmark", ""), synthetic=dv.synthetic, info=dv.info,
            validation=dv.report("validation"), reconciliation=dv.report("reconciliation")))
        for rows, t in ((ex_rows, examples), (step_rows, steps), (a_rows, assets), (m_rows, manifests), (mm_rows, manifest_members)):
            for chunk in _chunks(rows):
                c.execute(insert(t), chunk)
        n_gold = n_group = 0
        if private is not None and private.available():
            c.execute(delete(gold_labels).where(gold_labels.c.dataset_version_id == dv.id))
            c.execute(delete(grouping).where(grouping.c.dataset_version_id == dv.id))
            g_rows = []
            for eid, g in private.gold.items():
                cat, _ = normalize_native(g.get("mistake_type_native")) if g["label"] == "negative" else (None, None)
                g_rows.append({"dataset_version_id": dv.id, "example_id": eid, "label": g["label"],
                               "mistake_type_native": g.get("mistake_type_native"), "category": cat.value if cat else None,
                               "original_id": g.get("original_id"), "paired_id": g.get("paired_id"), "row": g})
            for chunk in _chunks(g_rows):
                c.execute(insert(gold_labels), chunk)
            gr_rows = [{"dataset_version_id": dv.id, "example_id": eid, "component_id": r.get("component_id"),
                        "content_component_id": r.get("content_component_id"), "recording_id": r.get("recording_id"),
                        "instruction_id": r.get("instruction_id"), "row": r} for eid, r in private.grouping.items()]
            for chunk in _chunks(gr_rows):
                c.execute(insert(grouping), chunk)
            n_gold, n_group = len(g_rows), len(gr_rows)
    return {"dataset_version_id": dv.id, "examples": len(ex_rows), "steps": len(step_rows), "assets": len(a_rows),
            "manifests": len(m_rows), "gold_labels": n_gold, "grouping_rows": n_group}


def refresh_media_counts(engine: Engine, dv: DatasetVersion) -> int:
    """Update asset statuses and per-example materialized counts after media materialization."""
    from sqlalchemy import text, update

    asset_rows = current_assets(dv)
    with engine.begin() as c:
        for k, a in asset_rows.items():
            c.execute(update(assets).where((assets.c.dataset_version_id == dv.id) & (assets.c.asset_key == k)).values(
                status=a.get("status", "unknown"), sha256=a.get("sha256"), width=a.get("width"), height=a.get("height"),
                bytes=a.get("bytes")))
        c.execute(text(
            "UPDATE examples e SET media_materialized = sub.n FROM ("
            " SELECT e2.example_id, count(a.asset_key) FILTER (WHERE a.status = 'materialized') AS n"
            " FROM examples e2 JOIN steps s ON s.dataset_version_id = e2.dataset_version_id AND s.recording_id = e2.recording_id"
            " LEFT JOIN assets a ON a.dataset_version_id = s.dataset_version_id AND a.asset_key = s.asset_key"
            " WHERE e2.dataset_version_id = :dv GROUP BY e2.example_id) sub"
            " WHERE e.dataset_version_id = :dv AND e.example_id = sub.example_id"), {"dv": dv.id})
        return c.execute(select(examples.c.example_id).where(examples.c.dataset_version_id == dv.id)).rowcount or 0
