"""Exact re-implementation of the released reference scorer, for cross-checking only.

Ports ``load_results``, ``load_labels``, ``compute_metrics`` and ``build_json_report`` from
``scripts/analyze_eval_results.py`` at 8584a347 (UUID remapping is not ported; it is a migration aid for
regenerated JSONL files). Known divergences from the protocol scorer, all intentional here:

* ``bool(data["success"])`` coerces non-Boolean values (the string "false" becomes a positive prediction);
* items without a result file are absent from every denominator;
* parse errors are counted separately and excluded from accuracy;
* ``negative_by_mistake_type`` is the binary rejection rate per gold type, not exact-type recall.

Never use this module to produce reported scores.
"""

from __future__ import annotations

import json
import os
import uuid as _uuid
from collections import defaultdict
from pathlib import Path

REFERENCE_ID = "ah-reference-analyze_eval_results@8584a347"


def load_results(results_dir: Path) -> tuple[dict[str, bool], int, list[str]]:
    predictions: dict[str, bool] = {}
    parse_errors = 0
    parse_error_ids: list[str] = []
    for fname in sorted(os.listdir(results_dir)):
        if not fname.endswith(".json") or fname.startswith("_"):
            continue
        trajectory_id = fname[: -len(".json")]
        try:
            _uuid.UUID(trajectory_id)
        except ValueError:
            continue
        try:
            with open(results_dir / fname) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            parse_errors += 1
            parse_error_ids.append(trajectory_id)
            continue
        if "success" not in data:
            parse_errors += 1
            parse_error_ids.append(trajectory_id)
            continue
        predictions[trajectory_id] = bool(data["success"])
    return predictions, parse_errors, parse_error_ids


def load_labels(labels_path: Path) -> dict[str, dict]:
    labels: dict[str, dict] = {}
    with open(labels_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            tid = record.get("trajectory_id")
            if tid:
                labels[tid] = record
    return labels


def compute_metrics(predictions: dict[str, bool], labels: dict[str, dict], parse_error_ids: list[str] | None = None) -> dict:
    tp = fp = tn = fn = 0
    unmatched = []
    positive_correct = positive_total = negative_correct = negative_total = 0
    by_mistake_type: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    by_negative_source: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for tid, predicted_positive in predictions.items():
        label_record = labels.get(tid)
        if label_record is None:
            unmatched.append(tid)
            continue
        actual_positive = label_record["label"] == "positive"
        if actual_positive:
            positive_total += 1
            if predicted_positive:
                tp += 1
                positive_correct += 1
            else:
                fn += 1
        else:
            negative_total += 1
            if predicted_positive:
                fp += 1
            else:
                tn += 1
                negative_correct += 1
            raw_mt = label_record.get("mistake_type") or "Unknown"
            if raw_mt == "Misunderstanding of the Instructions":
                raw_mt = "Misunderstanding of the Instruction"
            neg_source = label_record.get("negative_source", "Unknown")
            by_mistake_type[raw_mt][1] += 1
            by_negative_source[neg_source][1] += 1
            if not predicted_positive:
                by_mistake_type[raw_mt][0] += 1
                by_negative_source[neg_source][0] += 1
    parse_error_count = 0
    for tid in parse_error_ids or []:
        if labels.get(tid) is not None:
            parse_error_count += 1
    total = tp + fp + tn + fn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "tp": tp, "fp": fp, "tn": tn, "fn": fn, "total": total, "accuracy": accuracy, "precision": precision,
        "recall": recall, "f1": f1, "positive_correct": positive_correct, "positive_total": positive_total,
        "negative_correct": negative_correct, "negative_total": negative_total,
        "parse_errors_penalized": parse_error_count, "by_mistake_type": dict(by_mistake_type),
        "by_negative_source": dict(by_negative_source), "unmatched": unmatched,
    }


def build_json_report(metrics: dict, total_results: int, parse_errors: int) -> dict:
    m = metrics
    return {
        "summary": {"total_results": total_results, "matched": m["total"], "parse_errors": parse_errors,
                    "unmatched": len(m["unmatched"])},
        "metrics": {"accuracy": round(m["accuracy"], 4), "precision": round(m["precision"], 4),
                    "recall": round(m["recall"], 4), "f1": round(m["f1"], 4)},
        "confusion_matrix": {"tp": m["tp"], "fp": m["fp"], "tn": m["tn"], "fn": m["fn"]},
        "accuracy_by_label": {
            "positive": {"correct": m["positive_correct"], "total": m["positive_total"],
                         "accuracy": round(m["positive_correct"] / m["positive_total"], 4) if m["positive_total"] else None},
            "negative": {"correct": m["negative_correct"], "total": m["negative_total"],
                         "accuracy": round(m["negative_correct"] / m["negative_total"], 4) if m["negative_total"] else None},
        },
        "negative_by_mistake_type": {
            mtype: {"correct": c[0], "total": c[1], "accuracy": round(c[0] / c[1], 4) if c[1] else None}
            for mtype, c in sorted(m["by_mistake_type"].items())
        },
        "negative_by_source": {
            src: {"correct": c[0], "total": c[1], "accuracy": round(c[0] / c[1], 4) if c[1] else None}
            for src, c in sorted(m["by_negative_source"].items())
        },
    }


def reference_report(results_dir: Path, labels_path: Path) -> dict:
    predictions, parse_errors, parse_error_ids = load_results(results_dir)
    total_results = len(predictions) + parse_errors
    labels = load_labels(labels_path)
    metrics = compute_metrics(predictions, labels, parse_error_ids=parse_error_ids)
    return build_json_report(metrics, total_results, parse_errors)
