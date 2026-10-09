"""Cross-check against the authors' scorer on identical inputs (synthetic test data).

1. ``reference_compat`` must reproduce ``scripts/analyze_eval_results.py --output`` exactly.
2. The protocol scorer must agree with it on complete, valid prediction sets and diverge — in the documented
   direction — on missing and non-Boolean outputs.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from conftest import run_reference_script

from agenthorizon.judging.parsing import parse_agentic
from agenthorizon.scoring.categories import normalize_native
from agenthorizon.scoring.protocol import GoldItem, PredictionSet, ScoringManifest, SelectedPrediction, score
from agenthorizon.scoring.reference_compat import reference_report


def _uid(n: int) -> str:
    return str(uuid.UUID(int=n + 1))


def _labels(n_pos: int, n_neg: int) -> list[dict]:
    mts = ["Critical Mistake", "Bad Side Effect", "Misunderstanding of the Instructions", None]
    out = []
    for i in range(n_pos):
        out.append({"trajectory_id": _uid(i), "label": "positive", "original_id": f"d{i}"})
    for j in range(n_neg):
        k = n_pos + j
        out.append({"trajectory_id": _uid(k), "label": "negative", "original_id": f"d{j}", "paired_id": f"e{j}",
                    "negative_source": ["parent_instruction_child_trajectory", "child_instruction_parent_trajectory"][j % 2],
                    "mistake_type": mts[j % 4]})
    return out


def _write(tmp: Path, labels: list[dict], results: dict[str, object]) -> tuple[Path, Path]:
    lp = tmp / "labels.jsonl"
    lp.write_text("".join(json.dumps(r) + "\n" for r in labels))
    rd = tmp / "results"
    rd.mkdir()
    for tid, content in results.items():
        (rd / f"{tid}.json").write_text(content if isinstance(content, str) else json.dumps(content))
    (rd / "_summary.json").write_text("{}")
    (rd / "analysis.json").write_text("{}")  # non-UUID name: skipped by the reference
    return lp, rd


def _protocol(labels: list[dict], results: dict[str, object]) -> dict:
    items = []
    for r in labels:
        cat, _ = normalize_native(r.get("mistake_type")) if r["label"] == "negative" else (None, "absent")
        items.append(GoldItem(r["trajectory_id"], r["label"], cat))
    m = ScoringManifest("m", "dv", tuple(items))
    recs = []
    for tid, content in results.items():
        text = content if isinstance(content, str) else json.dumps(content)
        recs.append(SelectedPrediction(tid, parse_agentic(text)))
    known = frozenset(r["trajectory_id"] for r in labels) | frozenset(results)
    return score(m, PredictionSet("p", "dv", known, recs), strict_unknown=False)


@pytest.mark.reference
def test_reference_compat_reproduces_authors_script(tmp_path, reference_checkout):
    labels = _labels(6, 10)
    results: dict[str, object] = {}
    for i, r in enumerate(labels):
        tid = r["trajectory_id"]
        if i == 0:
            continue  # missing result file
        if i == 1:
            results[tid] = {"success": "false"}  # non-Boolean string
        elif i == 2:
            results[tid] = "{not valid json"
        elif i == 3:
            results[tid] = {"reasoning": "no success key"}
        elif i == 7:
            results[tid] = {"success": 0}
        else:
            results[tid] = {"success": (r["label"] == "positive") ^ (i % 5 == 0), "reasoning": "x"}
    results[_uid(999)] = {"success": True}  # unmatched id
    lp, rd = _write(tmp_path, labels, results)
    out = tmp_path / "ref.json"
    proc = run_reference_script(reference_checkout / "scripts" / "analyze_eval_results.py",
                                ["--results-dir", str(rd), "--labels", str(lp), "--output", str(out)], cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text()) == reference_report(rd, lp)


@pytest.mark.reference
def test_protocol_and_reference_agree_on_complete_valid_sets(tmp_path, reference_checkout):
    labels = _labels(5, 7)
    results = {r["trajectory_id"]: {"success": (r["label"] == "positive") ^ (i % 3 == 0)} for i, r in enumerate(labels)}
    lp, rd = _write(tmp_path, labels, results)
    ref = reference_report(rd, lp)
    pro = _protocol(labels, results)
    assert ref["accuracy_by_label"]["positive"]["correct"] == pro["metrics"]["positive_accuracy"]["numerator"]
    assert ref["accuracy_by_label"]["positive"]["total"] == pro["metrics"]["positive_accuracy"]["denominator"]
    assert ref["accuracy_by_label"]["negative"]["correct"] == pro["metrics"]["negative_accuracy"]["numerator"]
    assert ref["accuracy_by_label"]["negative"]["total"] == pro["metrics"]["negative_accuracy"]["denominator"]


def test_hand_fixture_divergence_is_documented(tmp_path):
    """Same 2+2 fixture: protocol = 1/2 and 1/2; released scorer = 1/1 and 1/2 (missing dropped, "false" -> True)."""
    labels = [
        {"trajectory_id": _uid(0), "label": "positive"},
        {"trajectory_id": _uid(1), "label": "positive"},
        {"trajectory_id": _uid(2), "label": "negative", "mistake_type": "Critical Mistake"},
        {"trajectory_id": _uid(3), "label": "negative", "mistake_type": "Bad Side Effect"},
    ]
    results = {_uid(0): {"success": True}, _uid(2): {"success": False}, _uid(3): {"success": "false"}}
    lp, rd = _write(tmp_path, labels, results)
    ref = reference_report(rd, lp)
    assert (ref["accuracy_by_label"]["positive"]["correct"], ref["accuracy_by_label"]["positive"]["total"]) == (1, 1)
    assert (ref["accuracy_by_label"]["negative"]["correct"], ref["accuracy_by_label"]["negative"]["total"]) == (1, 2)
    assert ref["confusion_matrix"]["fp"] == 1  # the string "false" counted as a positive prediction
    pro = _protocol(labels, results)
    assert pro["metrics"]["positive_accuracy"]["denominator"] == 2
    assert pro["metrics"]["balanced_accuracy"]["display_pct"] == "50.0"
    assert pro["confusion"]["FP_valid"] == 0 and pro["confusion"]["invalid_negative"] == {"success_not_boolean:str": 1}
