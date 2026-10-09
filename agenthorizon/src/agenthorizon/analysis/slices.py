"""Slice reports: length / application / OS / domain, each scored with fixed denominators within the slice.

Every manifest item in a slice is in that slice's denominator; items without a prediction count as missing errors,
exactly as in the canonical score. An item involving several applications belongs to each of their slices (so
application slices overlap); single-valued dimensions partition the manifest.
"""

from __future__ import annotations

from collections import defaultdict

from agenthorizon.scoring.protocol import PredictionSet, ScoringManifest, score

DIMENSIONS = ("length_bin", "os", "application", "domain")


def example_meta(dv) -> dict[str, dict]:
    """Judge-visible metadata per example from a dataset version."""
    from agenthorizon.data.normalize import length_bin

    out = {}
    for e in dv.examples():
        meta = e.get("task_meta") or {}
        out[e["example_id"]] = {"length_bin": length_bin(e["n_steps"]), "os": (e.get("environment") or {}).get("os"),
                                "application": list(meta.get("applications") or []), "domain": meta.get("category"),
                                "n_steps": e["n_steps"]}
    return out


def _values(meta: dict, dim: str) -> list[str]:
    v = meta.get(dim)
    if isinstance(v, list):
        return [str(x) for x in v] or ["(none)"]
    return [str(v) if v not in (None, "") else "(unknown)"]


def slice_scores(manifest: ScoringManifest, predictions: PredictionSet, meta: dict[str, dict],
                 dims: tuple[str, ...] = DIMENSIONS, min_items: int = 1) -> dict:
    out: dict[str, list[dict]] = {}
    for dim in dims:
        groups: dict[str, set[str]] = defaultdict(set)
        for item in manifest.items:
            for v in _values(meta.get(item.example_id, {}), dim):
                groups[v].add(item.example_id)
        rows = []
        for value, ids in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if len(ids) < min_items:
                continue
            sub = manifest.subset(ids, f"{manifest.manifest_id}#{dim}={value}")
            preds = PredictionSet(predictions.prediction_set_id, predictions.dataset_version_id, predictions.known_example_ids,
                                  [r for r in predictions.records if r.example_id in ids])
            rep = score(sub, preds)
            m, c = rep["metrics"], rep["confusion"]
            rows.append({"value": value, "n": len(ids), "P": rep["manifest"]["P"], "N": rep["manifest"]["N"],
                         "balanced_accuracy": m["balanced_accuracy"], "positive_accuracy": m["positive_accuracy"],
                         "negative_accuracy": m["negative_accuracy"],
                         "mt_aggregate": rep["mistake_type_recall"]["aggregate_typed_micro"],
                         "missing": c["missing_positive"] + c["missing_negative"],
                         "invalid": sum(c["invalid_positive"].values()) + sum(c["invalid_negative"].values())})
        out[dim] = rows
    return {"manifest_id": manifest.manifest_id, "prediction_set_id": predictions.prediction_set_id, "dimensions": out,
            "overlapping_dimensions": ["application"],
            "note": "Denominators are fixed per slice (all manifest items in the slice); missing items count as errors. "
                    "A slice with an empty gold class has undefined balanced accuracy."}
