"""Resource use and latency summaries with telemetry coverage (unknown values are excluded, never treated as 0)."""

from __future__ import annotations

import statistics

FIELDS = ("input_tokens", "output_tokens", "tool_calls", "images_viewed", "turns", "wall_time_s", "cost_billed_usd")


def _summ(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0, "mean": None, "median": None, "max": None}
    return {"n": len(xs), "mean": statistics.fmean(xs), "median": statistics.median(xs), "max": max(xs)}


def resource_summary(store, *, selected_only: bool = True) -> dict:
    """Per-field summaries over the selected (scored) attempts, or all judgment attempts."""
    d = store.definition()
    vals: dict[str, list[float]] = {f: [] for f in FIELDS}
    n = 0
    for eid in d.example_ids:
        recs = store.attempts(eid)
        if selected_only:
            fin = store.final(eid)
            if not fin or fin.get("selected_attempt") is None:
                continue
            recs = [r for r in recs if r.attempt_no == fin["selected_attempt"]]
        else:
            recs = [r for r in recs if r.counts_toward_limit]
        for r in recs:
            n += 1
            t = (r.outcome or {}).get("telemetry") or {}
            for f in FIELDS:
                v = t.get(f)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    vals[f].append(float(v))
    return {"run_id": store.run_id, "scope": "selected attempts" if selected_only else "all judgment attempts",
            "attempts": n, "fields": {f: {**_summ(v), "coverage": (len(v) / n) if n else None} for f, v in vals.items()},
            "note": "Means use only attempts whose harness reported the field; coverage is the reporting fraction."}


def compare_with_reference(summary: dict, ref_row: dict | None) -> dict | None:
    if not ref_row:
        return None
    pairs = {"input_tokens": "mean_input_tokens", "output_tokens": "mean_output_tokens", "tool_calls": "mean_tool_calls",
             "images_viewed": "mean_images_viewed"}
    return {k: {"run_mean": summary["fields"][k]["mean"], "run_coverage": summary["fields"][k]["coverage"],
                "paper_reported_mean": ref_row.get(v)} for k, v in pairs.items()}
