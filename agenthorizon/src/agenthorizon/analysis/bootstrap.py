"""EXTENSION (not a paper analysis): grouped bootstrap intervals for class accuracies and balanced accuracy.

Examples that share a recording or a label-pair component are not independent observations, so the bootstrap
resamples whole groups (with replacement) rather than rows. Group ids come from the private grouping (label
components, falling back to shared recordings); when no grouping is available the report says so instead of
silently treating rows as independent. Missing and invalid predictions count as errors, as in the canonical score.
"""

from __future__ import annotations

import random

from agenthorizon.scoring.protocol import PredictionSet, ScoringManifest, score

EXTENSION_ID = "ext-grouped-bootstrap/1"


def grouped_bootstrap(manifest: ScoringManifest, predictions: PredictionSet, groups: dict[str, str] | None, *,
                      B: int = 2000, seed: int = 20261009, alpha: float = 0.05) -> dict:
    rep = score(manifest, predictions)
    outcome = rep["_per_item_outcome"]
    items = [(i.example_id, i.label, (outcome[i.example_id] == "valid:true") if i.label == "positive"
              else (outcome[i.example_id] == "valid:false")) for i in manifest.items]
    if groups:
        by_group: dict[str, list] = {}
        for eid, lab, ok in items:
            by_group.setdefault(groups.get(eid) or f"solo:{eid}", []).append((lab, ok))
        basis = "groups (label components / shared recordings)"
    else:
        by_group = {eid: [(lab, ok)] for eid, lab, ok in items}
        basis = "rows (NO grouping available: intervals ignore pairing and are likely too narrow)"
    keys = sorted(by_group)
    rng = random.Random(seed)
    stats = {"positive_accuracy": [], "negative_accuracy": [], "balanced_accuracy": []}
    for _ in range(B):
        tp = p = tn = n = 0
        for _k in range(len(keys)):
            for lab, ok in by_group[keys[rng.randrange(len(keys))]]:
                if lab == "positive":
                    p += 1
                    tp += ok
                else:
                    n += 1
                    tn += ok
        if p and n:
            pa, na = tp / p, tn / n
            stats["positive_accuracy"].append(pa)
            stats["negative_accuracy"].append(na)
            stats["balanced_accuracy"].append((pa + na) / 2)

    def ci(xs: list[float]) -> dict:
        if not xs:
            return {"low": None, "high": None, "valid_resamples": 0}
        xs = sorted(xs)
        lo = xs[int((alpha / 2) * (len(xs) - 1))]
        hi = xs[int((1 - alpha / 2) * (len(xs) - 1))]
        return {"low": lo, "high": hi, "valid_resamples": len(xs)}

    return {"extension": EXTENSION_ID, "basis": basis, "groups": len(keys), "items": len(items), "B": B, "seed": seed,
            "alpha": alpha, "point": {k: rep["metrics"][k]["value"] for k in ("positive_accuracy", "negative_accuracy", "balanced_accuracy")},
            "intervals": {k: ci(v) for k, v in stats.items()},
            "note": "Percentile intervals from a grouped bootstrap; an extension analysis, not part of the paper protocol."}


def groups_from_private(private, example_ids: set[str]) -> dict[str, str] | None:
    g = getattr(private, "grouping", {}) or {}
    if not g:
        return None
    out = {}
    for eid in example_ids:
        r = g.get(eid) or {}
        out[eid] = r.get("component_id") or (f"rec:{r['recording_id']}" if r.get("recording_id") else None) or f"solo:{eid}"
    return out
