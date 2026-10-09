"""Side-by-side comparison of a run's score with an author-reported row, with every protocol caveat listed.

A comparison is labelled ``comparable`` only when the run is a new paper-compatible run on real data, scored on the
same membership the row reports, with the evidenced model identifier. Otherwise the numbers are shown for orientation
and each reason is listed; a stochastic live run is never asserted to equal a published percentage.
"""

from __future__ import annotations

PAIRS = (("balanced_accuracy", "balanced_accuracy_pct"), ("positive_accuracy", "positive_accuracy_pct"),
         ("negative_accuracy", "negative_accuracy_pct"))
MT_PAIRS = (("critical_mistake", "critical_mistake_recall"), ("bad_side_effect", "bad_side_effect_recall"),
            ("misunderstanding_of_the_instruction", "misunderstanding_recall"))


def compare(report: dict, ref_table: dict, ref_row: dict, definition: dict, manifest_kind: str) -> dict:
    reasons = []
    cls = definition.get("classification", {})
    if cls.get("result_kind") != "new_paper_compatible":
        reasons.append(f"run is {cls.get('result_kind')}: " + "; ".join(cls.get("reasons", [])))
    scope = ref_table.get("scope", {})
    expected = {"S8.T1": "legacy-AH", "S8.T2": "legacy-AH-S", "S8.T3": "full-release"}.get(ref_table["table_id"])
    if expected and expected != manifest_kind:
        reasons.append(f"reference row reports {expected}, report scored on {manifest_kind}")
    if not report.get("coverage", {}).get("complete"):
        reasons.append("run coverage incomplete (missing items count as errors in this score)")
    if definition.get("judge", {}).get("id_source") != "registry":
        reasons.append("model identifier not the evidenced one")
    reasons.append("harness version and serving settings used by the authors are not fully published")
    rows = []
    for ours, theirs in PAIRS:
        v = report["metrics"].get(ours, {}).get("value")
        rows.append({"metric": ours, "run": None if v is None else round(100 * v, 1), "paper_reported": ref_row.get(theirs)})
    mt = report.get("mistake_type_recall", {})
    for ours, theirs in MT_PAIRS:
        if theirs in ref_row:
            v = (mt.get(ours) or {}).get("value")
            rows.append({"metric": f"mt_recall:{ours}", "run": None if v is None else round(100 * v, 1), "paper_reported": ref_row.get(theirs)})
    if "mistake_type_recall_pct" in ref_row:
        v = (mt.get("aggregate_typed_micro") or {}).get("value")
        rows.append({"metric": "mt_recall:aggregate", "run": None if v is None else round(100 * v, 1),
                     "paper_reported": ref_row.get("mistake_type_recall_pct")})
    strict = [r for r in reasons if not r.startswith("harness version")]
    return {"reference": {"table_id": ref_table["table_id"], "line": ref_row.get("line"), "scope": scope,
                          "provenance": ref_table.get("provenance")},
            "comparable": not strict, "caveats": reasons, "rows": rows,
            "note": "Paper-reported values are author aggregates; differences are empirical, not test failures."}
