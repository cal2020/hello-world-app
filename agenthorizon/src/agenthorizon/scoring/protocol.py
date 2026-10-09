"""Canonical AgentHorizon scorer (protocol S5; denominators fixed by the manifest).

For a manifest with P gold positives and N gold negatives:

    TP = gold-positive items with a valid Boolean success=true
    TN = gold-negative items with a valid Boolean success=false
    positive accuracy = TP / P,  negative accuracy = TN / N
    balanced accuracy = (TP/P + TN/N) / 2

Missing, malformed and non-Boolean verdicts are incorrect for their gold class and never shrink P or N. They
are reported separately (invalid-positive / invalid-negative / missing-*), so the valid-only confusion matrix
plus these adjacent counts reconcile exactly to the manifest.

Exact failure-type recall requires a *valid* ``success=false`` and the matching category. Typed denominators
exclude untyped negatives; binary denominators never do. Aggregate MT = exact matches / typed negatives
(micro-average; see REFERENCE_DATA.json → analysis_aggregate_mt_definition for why).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Literal

from agenthorizon.judging.parsing import Verdict
from agenthorizon.scoring.categories import CATEGORY_MAP_VERSION, Category
from agenthorizon.util.hashing import digest_json
from agenthorizon.util.io import utcnow_iso

SCORER_ID = "ah-protocol-scorer/1"


class ScoringError(ValueError):
    pass


@dataclass(frozen=True)
class GoldItem:
    example_id: str
    label: Literal["positive", "negative"]
    category: Category | None = None
    category_native: str | None = None


@dataclass(frozen=True)
class ScoringManifest:
    manifest_id: str
    dataset_version_id: str
    items: tuple[GoldItem, ...]
    role: str = "evaluation"  # evaluation | development | subset | engineering-smoke
    partition: str = "unspecified"
    official: bool = False

    def __post_init__(self) -> None:
        ids = [i.example_id for i in self.items]
        if len(ids) != len(set(ids)):
            dup = [k for k, c in Counter(ids).items() if c > 1][:5]
            raise ScoringError(f"manifest {self.manifest_id} has duplicate example ids: {dup}")

    @property
    def digest(self) -> str:
        return digest_json(sorted((i.example_id, i.label, i.category.value if i.category else None) for i in self.items))

    def subset(self, example_ids: set[str], manifest_id: str) -> ScoringManifest:
        return ScoringManifest(manifest_id, self.dataset_version_id,
                               tuple(i for i in self.items if i.example_id in example_ids),
                               role="subset", partition=self.partition, official=False)


@dataclass(frozen=True)
class SelectedPrediction:
    example_id: str
    verdict: Verdict | None  # None means the record exists but no response text could be obtained
    attempt: int | None = None
    record_ref: str | None = None


@dataclass
class PredictionSet:
    prediction_set_id: str
    dataset_version_id: str
    known_example_ids: frozenset[str]
    records: list[SelectedPrediction] = field(default_factory=list)

    def by_id(self) -> dict[str, SelectedPrediction]:
        out: dict[str, SelectedPrediction] = {}
        for r in self.records:
            if r.example_id in out:
                raise ScoringError(f"duplicate prediction for {r.example_id} in {self.prediction_set_id}; "
                                   "select exactly one attempt per example before scoring")
            out[r.example_id] = r
        return out


def frac(num: int, den: int) -> dict:
    if den == 0:
        return {"numerator": num, "denominator": den, "value": None, "display_pct": None}
    v = Fraction(num, den)
    return {"numerator": num, "denominator": den, "value": float(v), "display_pct": f"{100 * float(v):.1f}"}


def classify(pred: SelectedPrediction | None) -> str:
    if pred is None:
        return "missing"
    v = pred.verdict
    if v is None or not v.extracted:
        return "invalid:no_json_object"
    if not v.has_success_key:
        return "invalid:success_missing"
    if not v.binary_valid:
        return f"invalid:success_not_boolean:{v.success_raw_type}"
    return "valid:true" if v.success else "valid:false"


def score(manifest: ScoringManifest, predictions: PredictionSet, *, strict_unknown: bool = True) -> dict:
    if predictions.dataset_version_id != manifest.dataset_version_id:
        raise ScoringError(f"dataset version mismatch: predictions on {predictions.dataset_version_id}, "
                           f"manifest on {manifest.dataset_version_id}")
    by_id = predictions.by_id()
    unknown = sorted(set(by_id) - predictions.known_example_ids)
    if unknown and strict_unknown:
        raise ScoringError(f"{len(unknown)} prediction ids are not in dataset version "
                           f"{predictions.dataset_version_id}: {unknown[:5]}")
    manifest_ids = {i.example_id for i in manifest.items}
    out_of_manifest = sorted(set(by_id) - manifest_ids - set(unknown))

    P = sum(1 for i in manifest.items if i.label == "positive")
    N = len(manifest.items) - P
    outcome: dict[str, str] = {}
    pos = Counter()
    neg = Counter()
    typed_den: Counter = Counter()
    typed_hit: Counter = Counter()
    typed_pred: dict[str, Counter] = {c.value: Counter() for c in Category}
    untyped = 0
    present = 0
    full_valid = 0
    for item in manifest.items:
        p = by_id.get(item.example_id)
        o = classify(p)
        outcome[item.example_id] = o
        if p is not None:
            present += 1
            if p.verdict is not None and p.verdict.full_contract_valid:
                full_valid += 1
        (pos if item.label == "positive" else neg)[o] += 1
        if item.label == "negative":
            if item.category is None:
                untyped += 1
                continue
            typed_den[item.category.value] += 1
            if o == "valid:false":
                pc = p.verdict.mistake_type_category if p and p.verdict else None
                typed_pred[item.category.value][pc or f"({p.verdict.mistake_type_status})"] += 1
                if pc == item.category.value:
                    typed_hit[item.category.value] += 1
            else:
                typed_pred[item.category.value][o] += 1

    TP, FNv = pos["valid:true"], pos["valid:false"]
    TN, FPv = neg["valid:false"], neg["valid:true"]
    inv_pos = {k.split(":", 1)[1]: v for k, v in pos.items() if k.startswith("invalid:")}
    inv_neg = {k.split(":", 1)[1]: v for k, v in neg.items() if k.startswith("invalid:")}
    miss_pos, miss_neg = pos["missing"], neg["missing"]
    recon_pos = TP + FNv + sum(inv_pos.values()) + miss_pos
    recon_neg = TN + FPv + sum(inv_neg.values()) + miss_neg
    if recon_pos != P or recon_neg != N:  # pragma: no cover - internal invariant
        raise AssertionError("confusion counts do not reconcile to the manifest")

    pa = frac(TP, P)
    na = frac(TN, N)
    if P and N:
        bal = Fraction(TP, P) / 2 + Fraction(TN, N) / 2
        bal_rec = {"numerator": bal.numerator, "denominator": bal.denominator, "value": float(bal),
                   "display_pct": f"{100 * float(bal):.1f}", "formula": "0.5 * (TP/P + TN/N)"}
    else:
        bal_rec = {"value": None, "reason": "balanced accuracy undefined: a gold class is empty"}

    typed_total = sum(typed_den.values())
    mt = {c.value: frac(typed_hit[c.value], typed_den[c.value]) for c in Category}
    mt["aggregate_typed_micro"] = frac(sum(typed_hit.values()), typed_total)
    report = {
        "score_report_version": 1,
        "generated_at": utcnow_iso(),
        "scorer": {"id": SCORER_ID, "category_map": CATEGORY_MAP_VERSION,
                   "validity_rule": "success must be a JSON Boolean; missing/malformed/non-Boolean are incorrect"},
        "manifest": {"id": manifest.manifest_id, "digest": manifest.digest, "dataset_version_id": manifest.dataset_version_id,
                     "role": manifest.role, "partition": manifest.partition, "official": manifest.official,
                     "n_items": len(manifest.items), "P": P, "N": N, "typed_negatives": typed_total,
                     "untyped_negatives": untyped},
        "predictions": {"id": predictions.prediction_set_id, "records": len(by_id), "in_manifest_present": present,
                        "out_of_manifest_ignored": len(out_of_manifest), "unknown_ids": len(unknown)},
        "confusion": {
            "TP": TP, "FN_valid": FNv, "TN": TN, "FP_valid": FPv,
            "invalid_positive": inv_pos, "invalid_negative": inv_neg,
            "missing_positive": miss_pos, "missing_negative": miss_neg,
            "reconciliation": {"positive": f"{TP}+{FNv}+{sum(inv_pos.values())}+{miss_pos}={P}",
                               "negative": f"{TN}+{FPv}+{sum(inv_neg.values())}+{miss_neg}={N}"},
        },
        "metrics": {
            "positive_accuracy": pa,
            "negative_accuracy": na,
            "balanced_accuracy": bal_rec,
            "raw_accuracy_secondary": frac(TP + TN, P + N),
        },
        "mistake_type_recall": mt,
        "mistake_type_prediction_breakdown": {k: dict(v) for k, v in typed_pred.items()},
        "validity": {
            "present": present,
            "binary_valid": sum(1 for o in outcome.values() if o.startswith("valid:")),
            "full_contract_valid": full_valid,
            "parse_or_type_invalid": sum(1 for o in outcome.values() if o.startswith("invalid:")),
            "missing": miss_pos + miss_neg,
        },
        "coverage": {"evaluated_with_valid_verdict": sum(1 for o in outcome.values() if o.startswith("valid:")),
                     "of": len(manifest.items), "complete": (miss_pos + miss_neg) == 0},
    }
    report["report_digest"] = digest_json({k: v for k, v in report.items() if k != "generated_at"})
    report["_per_item_outcome"] = outcome
    return report


def score_with_selection(manifest: ScoringManifest, predictions: PredictionSet, selection: set[str]) -> dict:
    """Canonical full-manifest score (unfinished = missing) plus an explicitly labelled selection subset score."""
    full = score(manifest, predictions)
    sub_manifest = manifest.subset(selection, f"{manifest.manifest_id}#selection")
    sub_preds = PredictionSet(predictions.prediction_set_id, predictions.dataset_version_id, predictions.known_example_ids,
                              [r for r in predictions.records if r.example_id in selection])
    sub = score(sub_manifest, sub_preds)
    sub["label"] = "SUBSET SCORE — not the benchmark result; the canonical score is the full-manifest report"
    return {"canonical_full_manifest": full, "selection_subset": sub}
