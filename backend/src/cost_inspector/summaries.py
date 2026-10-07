"""Pure summaries over normalized calls (no I/O)."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from .ingest.normalize import LLM_TOKEN_FIELDS, CallRecord
from .money import summarize_spend


def summarize_tokens(calls: Sequence[CallRecord]) -> dict[str, Any]:
    """Token totals per counter. ``total`` is ``None`` when no call reported the counter."""
    model_calls = [c for c in calls if c.usage_kind == "llm"]
    out: dict[str, Any] = {}
    for name in LLM_TOKEN_FIELDS:
        reported = [v for v in (c.counter(name) for c in model_calls) if v is not None]
        out[name] = {
            "total": int(sum(reported)) if reported else None,
            "reported_calls": len(reported),
            "model_calls": len(model_calls),
        }
    return out


def _first(values: Sequence[Any]) -> Any:
    return next((v for v in values if v is not None), None)


def _last(values: Sequence[Any]) -> Any:
    return next((v for v in reversed(values) if v is not None), None)


def summarize_run(calls: Sequence[CallRecord]) -> dict[str, Any]:
    ordered = sorted(calls, key=lambda c: c.ordinal)
    model = [c for c in ordered if c.is_model]
    tools = [c for c in ordered if not c.is_model]
    starts = [c.start_ms if c.start_ms is not None else c.event_ms for c in ordered]
    name = _first([c.run_name for c in ordered])
    durations = [c.duration_ms for c in ordered if c.duration_ms is not None]
    return {
        "run_id": ordered[0].run_id,
        "name": name,
        "display_name": name or ordered[0].run_id,
        "run_type": _first([c.run_type for c in ordered]),
        "outcome": _last([c.outcome for c in ordered]),
        "error_codes": sorted({c.error_code for c in ordered if c.error_code}),
        "environments": sorted({c.environment for c in ordered if c.environment}),
        "start_ms": min(starts),
        "first_event_ms": min(c.event_ms for c in ordered),
        "last_event_ms": max(c.event_ms for c in ordered),
        "calls": len(ordered),
        "model_calls": len(model),
        "tool_calls": len(tools),
        "spend": summarize_spend(ordered).to_json(),
        "model_spend": summarize_spend(model).to_json(),
        "tool_spend": summarize_spend(tools).to_json(),
        "tokens": summarize_tokens(ordered),
        "models": sorted({c.resource_name for c in model}),
        "tools": sorted({c.resource_name for c in tools}),
        "reported_duration_ms": sum(durations) if durations else None,
        "currencies": sorted({c.cost_currency for c in ordered if c.cost_currency}),
    }


def summarize_runs(calls: Sequence[CallRecord]) -> dict[str, dict[str, Any]]:
    by_run: dict[str, list[CallRecord]] = defaultdict(list)
    for call in calls:
        by_run[call.run_pk].append(call)
    return {pk: summarize_run(group) for pk, group in by_run.items()}


def by_model(calls: Sequence[CallRecord]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], list[CallRecord]] = defaultdict(list)
    for call in calls:
        groups[(call.resource_type, call.provider, call.resource_name)].append(call)
    rows = []
    for (resource_type, provider, name), group in groups.items():
        rows.append(
            {
                "resource_type": resource_type,
                "provider": provider,
                "name": name,
                "calls": len(group),
                "spend": summarize_spend(group).to_json(),
                "tokens": summarize_tokens(group) if resource_type == "model" else None,
            }
        )
    rows.sort(key=lambda r: (r["resource_type"] != "model", r["provider"], r["name"]))
    return rows
