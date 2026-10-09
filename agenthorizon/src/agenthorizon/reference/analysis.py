"""Consistency analyses over author-reported aggregates.

The released reference scorer (scripts/analyze_eval_results.py) does not compute exact mistake-type recall,
so the definition of the aggregate ``MT`` column in S8 must be inferred. If MT is a micro-average over a
subset's typed negatives, then for every model

    full_correct = MT_challenging * n_c + MT_simple * (T - n_c)

where ``full_correct`` is the exact count from the full-benchmark table (S8.T3), ``T`` is the number of
negatives in the hypothesised denominator, and ``n_c`` is the (unknown, model-independent) number of such
negatives in the legacy challenging subset. Solving for ``n_c`` per model and checking that the implied value
is the same across models — within the bounds implied by 0.1-point rounding — discriminates hypotheses.
"""

from __future__ import annotations

import statistics


def implied_challenging_count(full_correct: int, mt_c: float, mt_s: float, total: int) -> dict | None:
    """Solve for n_c with interval bounds from rounding of mt_c and mt_s to one decimal (in percent)."""
    def solve(c: float, s: float) -> float | None:
        if abs(s - c) < 1e-9:
            return None
        return (s / 100.0 * total - full_correct) / (s / 100.0 - c / 100.0)

    point = solve(mt_c, mt_s)
    if point is None:
        return None
    corners = [v for v in (solve(mt_c + dc, mt_s + ds) for dc in (-0.05, 0.05) for ds in (-0.05, 0.05)) if v is not None]
    return {"point": point, "low": min(corners), "high": max(corners)}


def mt_definition_analysis(tables: list[dict]) -> dict:
    by_id = {t["table_id"]: t for t in tables}
    t1, t2, t3 = by_id["S8.T1"], by_id["S8.T2"], by_id["S8.T3"]

    def key(r: dict) -> tuple[str, str]:
        return (r["model"], r["interface"])

    mt_c = {key(r): r["mistake_type_recall_pct"] for r in t1["rows"]}
    mt_s = {key(r): r["mistake_type_recall_pct"] for r in t2["rows"]}
    qualifiers = {key(r): r.get("model_qualifier") for r in t1["rows"]}
    hypotheses = {
        "micro_over_typed_negatives (T=844)": 844,
        "micro_over_all_negatives_incl_untyped (T=850)": 850,
    }
    rows = []
    for r in t3["rows"]:
        k = key(r)
        if k not in mt_c or k not in mt_s:
            continue
        cells = [r["critical_mistake_recall"], r["bad_side_effect_recall"], r["misunderstanding_recall"]]
        correct = sum(c["numerator"] for c in cells)
        rec = {"model": k[0], "interface": k[1], "qualifier": qualifiers.get(k), "full_exact_correct": correct,
               "mt_challenging": mt_c[k], "mt_simple": mt_s[k]}
        for name, total in hypotheses.items():
            rec[name] = implied_challenging_count(correct, mt_c[k], mt_s[k], total)
        rows.append(rec)

    def summarize(name: str, subset: list[dict]) -> dict:
        pts = [r[name]["point"] for r in subset if r[name]]
        lows = [r[name]["low"] for r in subset if r[name]]
        highs = [r[name]["high"] for r in subset if r[name]]
        # A model-independent n_c must lie in the intersection of every row's rounding interval.
        lo, hi = max(lows), min(highs)
        ints = [n for n in range(int(lo) - 1, int(hi) + 2) if lo <= n <= hi] if lo <= hi else []
        binding = sorted(subset, key=lambda r: r[name]["low"], reverse=True)[0]
        return {
            "n_rows": len(pts),
            "mean_implied_n_c": round(statistics.mean(pts), 2),
            "stdev_implied_n_c": round(statistics.pstdev(pts), 2),
            "intersection_of_rounding_intervals": [round(lo, 2), round(hi, 2)],
            "consistent_integers": ints,
            "binding_lower_row": f"{binding['model']} / {binding['interface']}",
        }

    non_splitter = [r for r in rows if r["qualifier"] != "splitter"]
    summary = {name: {"all_rows": summarize(name, rows), "excluding_splitter_row": summarize(name, non_splitter)}
               for name in hypotheses}
    typed = summary["micro_over_typed_negatives (T=844)"]
    untyped = summary["micro_over_all_negatives_incl_untyped (T=850)"]
    typed_ok = bool(typed["excluding_splitter_row"]["consistent_integers"])
    untyped_ok = bool(untyped["excluding_splitter_row"]["consistent_integers"])
    if typed_ok and not untyped_ok:
        n = typed["excluding_splitter_row"]["consistent_integers"]
        conclusion = (
            f"Micro-averaging over typed negatives fits every non-splitter row with one model-independent count "
            f"(n_c in {n}; stdev of per-row implied values {typed['all_rows']['stdev_implied_n_c']}), while the "
            f"T=850 hypothesis does not (stdev {untyped['all_rows']['stdev_implied_n_c']}). The splitter row misses "
            "the rounding interval by ~0.1 point, consistent with S8's note that it is affected by its splitter role. "
            "Aggregate MT is implemented as exact-type matches over typed negatives; untyped negatives stay in binary "
            "denominators only. Inference, not a released definition."
        )
        supported = ["micro_over_typed_negatives (T=844)"]
    else:
        conclusion = "Inconclusive: see summary; the scorer exposes both definitions."
        supported = [n for n, s in summary.items() if s["excluding_splitter_row"]["consistent_integers"]]
    return {
        "question": "Which denominator makes S8's legacy MT columns consistent with S8.T3's exact full-benchmark counts?",
        "rows": rows,
        "summary": summary,
        "supported_hypotheses": supported,
        "conclusion": conclusion,
    }


def _achievable(value_pct: float, denominator: int, tol: float = 0.05 + 1e-9) -> bool:
    return any(abs(100.0 * k / denominator - value_pct) <= tol for k in range(denominator + 1))


def legacy_composition_inference(tables: list[dict], mt: dict | None = None) -> dict:
    """Which (positives, negatives) splits of each legacy subset make *every* reported class accuracy exactly
    achievable as k/denominator at one-decimal rounding? Under fixed denominators the true composition must."""
    by_id = {t["table_id"]: t for t in tables}
    out: dict = {"method": "Exhaustive search over P in [1, total-1]; a candidate survives only if every model's "
                           "positive and negative accuracy equals round(100*k/denominator, 1) for some integer k.",
                 "subsets": {}}
    for tid, total, name in (("S8.T1", 605, "AH-legacy"), ("S8.T2", 768, "AH-S-legacy")):
        rows = by_id[tid]["rows"]
        pos = [r["positive_accuracy_pct"] for r in rows]
        neg = [r["negative_accuracy_pct"] for r in rows]
        cands = [(p, total - p) for p in range(1, total) if all(_achievable(v, p) for v in pos)
                 and all(_achievable(v, total - p) for v in neg)]
        out["subsets"][name] = {"table_id": tid, "total": total, "feasible_positive_negative": cands}
    a = out["subsets"]["AH-legacy"]["feasible_positive_negative"]
    b = out["subsets"]["AH-S-legacy"]["feasible_positive_negative"]
    if len(a) == 1 and len(b) == 1:
        (pa, na), (pb, nb) = a[0], b[0]
        out["consistency_with_release"] = {"positives_sum": pa + pb, "negatives_sum": na + nb,
                                           "matches_523_850": (pa + pb, na + nb) == (523, 850)}
        if mt and mt.get("supported_hypotheses") == ["micro_over_typed_negatives (T=844)"]:
            n_c = mt["summary"]["micro_over_typed_negatives (T=844)"]["excluding_splitter_row"]["consistent_integers"]
            if len(n_c) == 1:
                typed_a = n_c[0]
                out["implied_failure_typing"] = {
                    "AH-legacy": {"typed_negatives": typed_a, "untyped_negatives": na - typed_a},
                    "AH-S-legacy": {"typed_negatives": 844 - typed_a, "untyped_negatives": nb - (844 - typed_a)},
                    "untyped_total": (na - typed_a) + (nb - (844 - typed_a)),
                    "matches_6_untyped": (na - typed_a) + (nb - (844 - typed_a)) == 6,
                }
    out["status"] = "inferred reconciliation target; verify against released legacy label files when obtainable"
    return out


# Revised-partition reconciliation targets as stated in the implementation brief (attributed there to S1).
# Recorded as reference data with explicit provenance; never used to modify labels.
REVISED_CHECK_TABLE = {
    "provenance": {"source_id": "master-prompt", "citation": "MP §2 (attributes the table to S1)", "status": "described_only"},
    "columns": ["total", "positive", "negative", "critical", "side_effect", "misunderstanding", "untyped"],
    "rows": {
        "AH-D": [162, 62, 100, 32, 26, 41, 1],
        "AH": [528, 227, 301, 48, 107, 142, 4],
        "AH-S": [683, 234, 449, 193, 99, 156, 1],
        "TOTAL": [1373, 523, 850, 273, 232, 339, 6],
    },
}


def check_table_identities(table: dict = REVISED_CHECK_TABLE) -> list[dict]:
    cols = table["columns"]
    rows = {k: dict(zip(cols, v, strict=True)) for k, v in table["rows"].items()}
    out = []
    for name, r in rows.items():
        out.append({"row": name, "check": "positive + negative = total", "ok": r["positive"] + r["negative"] == r["total"]})
        typed = r["critical"] + r["side_effect"] + r["misunderstanding"] + r["untyped"]
        out.append({"row": name, "check": "typed + untyped = negative", "ok": typed == r["negative"]})
    for c in cols:
        s = sum(rows[k][c] for k in ("AH-D", "AH", "AH-S"))
        out.append({"row": "TOTAL", "check": f"column {c} sums", "ok": s == rows["TOTAL"][c]})
    return out
