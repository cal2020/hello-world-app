"""Comparison of two recorded runs.

A change is *measured* only when (1) both runs report a cost for every call in
the scope, (2) the user marked the runs as equivalent work, and (3) the amounts
are compared within one currency. Percentages are undefined for a zero
baseline. No output quality is measured, so no quality claim is made.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from .ingest.normalize import LLM_TOKEN_FIELDS, CallRecord, decimal_str
from .money import Spend, money_list, percent_change, summarize_spend
from .summaries import summarize_tokens

EQUIVALENCE_CHOICES = ("equivalent", "not_equivalent", "unsure")

QUALITY_NOTE = (
    "AUDR telemetry carries no output-quality measure. This comparison covers cost and usage "
    "only; it does not show that the candidate's results were as good as the baseline's."
)


class ComparisonError(ValueError):
    pass


def _scope(
    key: str, label: str, base: Sequence[CallRecord], cand: Sequence[CallRecord]
) -> dict[str, Any]:
    b = summarize_spend(base)
    c = summarize_spend(cand)
    reasons: list[str] = []
    if b.total_calls == 0 and c.total_calls == 0:
        reasons.append("Neither run has calls in this scope.")
    if b.unknown_calls:
        reasons.append(
            f"The baseline has {b.unknown_calls} call(s) without a reported cost, so its total "
            "is incomplete."
        )
    if c.unknown_calls:
        reasons.append(
            f"The candidate has {c.unknown_calls} call(s) without a reported cost, so its total "
            "is incomplete."
        )
    priced = {b.basis, c.basis} - {"none"}
    if "mixed" in priced or priced == {"reported", "estimated"}:
        reasons.append(
            "One side's costs are list-price estimates and the other's are reported amounts "
            "(or a mix), so the difference would mix pricing with billing."
        )
    comparable = not reasons
    currencies = sorted(set(b.by_currency) | set(c.by_currency))
    rows = []
    for currency in currencies:
        bv = b.by_currency.get(currency, Decimal(0))
        cv = c.by_currency.get(currency, Decimal(0))
        row: dict[str, Any] = {
            "currency": currency,
            "baseline": decimal_str(bv),
            "candidate": decimal_str(cv),
            "delta": None,
            "percent": None,
            "percent_note": None,
        }
        if comparable:
            pct = percent_change(bv, cv)
            row["delta"] = decimal_str(cv - bv)
            if pct is None:
                row["percent_note"] = (
                    "The baseline is 0 in this currency, so a percentage change is undefined."
                )
            else:
                row["percent"] = decimal_str(pct)
        rows.append(row)
    notes = []
    if len(currencies) > 1:
        notes.append(
            "Spend is reported in more than one currency. Each currency is compared on its own; "
            "amounts are never converted or combined."
        )
    if set(b.by_currency) != set(c.by_currency) and b.by_currency and c.by_currency:
        notes.append(
            "The runs report spend in different currencies, so there is no single overall change."
        )
    if comparable and priced == {"estimated"}:
        notes.append(
            "Both runs' costs are list-price estimates from their token counts, so the change "
            "reflects measured usage priced at the same list prices, not billed amounts."
        )
    return {
        "scope": key,
        "label": label,
        "comparable": comparable,
        "reasons": reasons,
        "notes": notes,
        "rows": rows,
        "baseline_spend": b.to_json(),
        "candidate_spend": c.to_json(),
    }


def _delta(base: int | None, cand: int | None) -> dict[str, int | None]:
    return {
        "baseline": base,
        "candidate": cand,
        "delta": cand - base if base is not None and cand is not None else None,
    }


def _token_delta(base: dict[str, Any], cand: dict[str, Any]) -> dict[str, Any]:
    complete_b = base["reported_calls"] == base["model_calls"] and base["model_calls"] > 0
    complete_c = cand["reported_calls"] == cand["model_calls"] and cand["model_calls"] > 0
    out: dict[str, Any] = {
        "baseline": base["total"],
        "candidate": cand["total"],
        "baseline_reported": f"{base['reported_calls']}/{base['model_calls']}",
        "candidate_reported": f"{cand['reported_calls']}/{cand['model_calls']}",
        "delta": None,
    }
    if complete_b and complete_c:
        out["delta"] = cand["total"] - base["total"]
    return out


def _by_model(base: Sequence[CallRecord], cand: Sequence[CallRecord]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], dict[str, list[CallRecord]]] = defaultdict(
        lambda: {"baseline": [], "candidate": []}
    )
    for side, calls in (("baseline", base), ("candidate", cand)):
        for call in calls:
            groups[(call.resource_type, call.provider, call.resource_name)][side].append(call)
    rows = []
    for (resource_type, provider, name), sides in groups.items():
        b = summarize_spend(sides["baseline"])
        c = summarize_spend(sides["candidate"])
        delta = None
        if b.unknown_calls == 0 and c.unknown_calls == 0:
            currencies = set(b.by_currency) | set(c.by_currency)
            delta = money_list(
                {
                    cur: c.by_currency.get(cur, Decimal(0)) - b.by_currency.get(cur, Decimal(0))
                    for cur in currencies
                }
            )
        rows.append(
            {
                "resource_type": resource_type,
                "provider": provider,
                "name": name,
                "baseline": {"calls": len(sides["baseline"]), "spend": b.to_json()},
                "candidate": {"calls": len(sides["candidate"]), "spend": c.to_json()},
                "delta": delta,
            }
        )
    rows.sort(key=lambda r: (r["resource_type"] != "model", r["provider"], r["name"]))
    return rows


def compare_runs(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    baseline_calls: Sequence[CallRecord],
    candidate_calls: Sequence[CallRecord],
    equivalence: str,
) -> dict[str, Any]:
    """``baseline``/``candidate`` are run summaries from :mod:`views`."""
    if equivalence not in EQUIVALENCE_CHOICES:
        raise ComparisonError(
            "Choose whether the runs did equivalent work: equivalent, not_equivalent or unsure."
        )
    if baseline["id"] == candidate["id"]:
        raise ComparisonError("Choose two different runs to compare.")

    scopes = [
        _scope("all_calls", "All calls", baseline_calls, candidate_calls),
        _scope(
            "model_calls",
            "Model calls",
            [c for c in baseline_calls if c.is_model],
            [c for c in candidate_calls if c.is_model],
        ),
    ]
    headline = next((s for s in scopes if s["comparable"]), None)
    if headline is None:
        kind = "not_comparable"
    elif equivalence == "equivalent":
        kind = "measured_change"
    else:
        kind = "observed_difference"

    btok = summarize_tokens(baseline_calls)
    ctok = summarize_tokens(candidate_calls)
    notes = []
    if baseline.get("synthetic") or candidate.get("synthetic"):
        notes.append(
            "Synthetic demo data: the result describes these runs only and is not a production "
            "savings rate."
        )
    if kind == "observed_difference":
        notes.append(
            "These runs are not marked as equivalent work, so the difference cannot be "
            "attributed to a change you made."
        )
    return {
        "baseline": _ref(baseline),
        "candidate": _ref(candidate),
        "equivalence": equivalence,
        "kind": kind,
        "headline_scope": headline["scope"] if headline else None,
        "scopes": scopes,
        "usage": {
            "calls": _delta(len(baseline_calls), len(candidate_calls)),
            "model_calls": _delta(
                sum(c.is_model for c in baseline_calls), sum(c.is_model for c in candidate_calls)
            ),
            "tool_calls": _delta(
                sum(not c.is_model for c in baseline_calls),
                sum(not c.is_model for c in candidate_calls),
            ),
            "tokens": {name: _token_delta(btok[name], ctok[name]) for name in LLM_TOKEN_FIELDS},
        },
        "by_model": _by_model(baseline_calls, candidate_calls),
        "findings": {
            "baseline_open": baseline.get("open_findings", 0),
            "candidate_open": candidate.get("open_findings", 0),
            "baseline_flagged_calls": baseline.get("flagged_calls", 0),
            "candidate_flagged_calls": candidate.get("flagged_calls", 0),
        },
        "outcomes": {"baseline": baseline.get("outcome"), "candidate": candidate.get("outcome")},
        "quality": {"measured": False, "note": QUALITY_NOTE},
        "notes": notes,
    }


def _ref(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": run["id"],
        "run_id": run["run_id"],
        "display_name": run["display_name"],
        "import_id": run["import_id"],
        "import_filename": run.get("import_filename"),
        "synthetic": run.get("synthetic", False),
        "calls": run.get("calls"),
        "spend": run.get("spend"),
    }


def spend_from(run_summary: dict[str, Any]) -> Spend:
    return Spend.from_json(run_summary["spend"])
