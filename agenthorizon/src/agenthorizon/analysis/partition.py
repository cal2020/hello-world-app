"""Partition reconstruction from splitter runs (never relabelled as the official partition).

Legacy (``scripts/aggregate_difficulty.py``): k = 8 verdicts per item from the single splitter; an item is Easy iff
at least 7 agree with gold, using strict JSON-Boolean agreement; any errored item is reported as such, and an item
with fewer than 8 verdicts is incomplete. The reconstruction is compared with the released legacy membership.

Revised (MP §2): 3 splitters x 8 verdicts; <= 18 of 24 correct -> AH. Reconstructions are marked NOT official.
"""

from __future__ import annotations

from collections import Counter

from agenthorizon.data.splits import (
    legacy_difficulty,
    reconstructed_manifests,
    revised_bucket,
    verdict_agrees,
)
from agenthorizon.util.hashing import digest_json


def verdict_matrix(stores, example_ids: list[str]) -> dict[str, list]:
    """``success`` values per item across trial runs (selected attempts; missing responses are recorded as None)."""
    out: dict[str, list] = {e: [] for e in example_ids}
    for st in stores:
        for e in example_ids:
            fin = st.final(e)
            if not fin:
                continue  # unfinished in this trial: the item will be incomplete
            if not fin.get("has_response"):
                out[e].append(None)
                continue
            rec = next(r for r in st.attempts(e) if r.attempt_no == fin["selected_attempt"])
            v = (rec.outcome or {}).get("verdict") or {}
            out[e].append(v.get("success") if v.get("has_success_key") else None)
    return out


def legacy_reconstruction(matrix: dict[str, list], gold: dict[str, dict], released: dict[str, str], k: int = 8) -> dict:
    """``released[eid]`` is "AH" (challenging) or "AH-S" (simple) from the released label files."""
    rows = {}
    for eid, vs in matrix.items():
        g = gold.get(eid)
        if g is None:
            continue
        succ = sum(1 for v in vs if verdict_agrees(v, g["label"]))
        errs = sum(1 for v in vs if not isinstance(v, bool))
        rows[eid] = legacy_difficulty(succ, len(vs), errs, k=k)
    mapped = {e: {"hard": "AH", "easy": "AH-S"}.get(d, d) for e, d in rows.items()}
    both = [e for e in mapped if e in released and mapped[e] in ("AH", "AH-S")]
    agree = sum(1 for e in both if mapped[e] == released[e])
    confusion = Counter((released.get(e, "absent"), mapped[e]) for e in mapped)
    return {"procedure": "legacy k=8, easy iff >= 7/8 agree (strict Boolean)", "items": len(rows),
            "by_bucket": dict(Counter(mapped.values())), "compared": len(both), "agreement": (agree / len(both)) if both else None,
            "confusion_released_vs_reconstructed": {f"{a}->{b}": n for (a, b), n in sorted(confusion.items())},
            "note": "Errors (non-Boolean or missing verdicts) and incomplete items are reported separately, as in the release script."}


def revised_reconstruction(matrices: dict[str, dict[str, list]], gold: dict[str, dict], dataset_version_id: str) -> dict:
    """``matrices[splitter_model][eid]`` = list of success values. Produces NOT-official reconstructed manifests."""
    assignments = []
    for eid, g in sorted(gold.items()):
        verdicts = {m: mat.get(eid, []) for m, mat in matrices.items()}
        assignments.append(revised_bucket(eid, g["label"], verdicts))
    digest = digest_json({m: {e: v for e, v in sorted(mat.items())} for m, mat in sorted(matrices.items())})
    ms = reconstructed_manifests(assignments, dataset_version_id, procedure="three-splitter-24", inputs_digest=digest)
    return {"manifests": [m.to_dict() for m in ms], "incomplete": sum(1 for a in assignments if a.bucket is None),
            "note": "Reconstruction from new splitter runs: NOT the paper's official AH/AH-S membership."}
