"""Read models: JSON-ready views of stored data, shared by the API and reports.

Every money amount leaves this module as an exact decimal string. Nothing
returned here contains a ``Decimal`` or ``float`` money value.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Any

from . import ids
from .analysis import catalog, kora
from .ingest.normalize import CallRecord, decimal_str
from .money import Spend, money_list, scale, summarize_spend
from .store import FindingRow, ImportRow, RunRow, Store
from .summaries import by_model

CATEGORY_ORDER = list(kora.CATEGORIES)
TIMELINE_RULE = (
    "Each bar ends at timing.event_time and extends back by timing.duration_ms; AUDR §3.7 and "
    "its multi-emitter example treat event_time as the completion time. Calls without a "
    "duration are drawn as points."
)
SCENARIO_METHOD = (
    "Each flagged call contributes its observed cost × the highest scenario ratio among the "
    "findings that flag it, so overlapping findings never add up. Calls without a reported cost "
    "contribute nothing. These ratios are KORA Doctor v0 assumptions, not measurements."
)


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, Decimal):
        return decimal_str(value)
    if isinstance(value, float):
        return repr(value)
    return value


def combine_spends(spends: Iterable[Spend]) -> Spend:
    totals: dict[str, Decimal] = {}
    known = unknown = 0
    for spend in spends:
        known += spend.known_calls
        unknown += spend.unknown_calls
        for currency, amount in spend.by_currency.items():
            totals[currency] = totals.get(currency, Decimal(0)) + amount
    return Spend(dict(sorted(totals.items())), known, unknown)


def cost_json(call: CallRecord) -> dict[str, Any]:
    return {
        "amount": decimal_str(call.cost_total) if call.cost_total is not None else None,
        "currency": call.cost_currency,
    }


def call_json(call: CallRecord, findings: Sequence[FindingRow] = ()) -> dict[str, Any]:
    return {
        "id": call.id,
        "import_id": call.import_id,
        "record_id": call.record_id,
        "run_pk": call.run_pk,
        "run_id": call.run_id,
        "ordinal": call.ordinal,
        "line": call.line,
        "item": call.item,
        "step": call.step,
        "span_id": call.span_id,
        "parent_span_id": call.parent_span_id,
        "event_time": call.event_time,
        "event_ms": call.event_ms,
        "start_ms": call.start_ms,
        "duration_ms": call.duration_ms,
        "received_time": call.received_time,
        "emitter": {
            "component": call.emitter_component,
            "name": call.emitter_name,
            "version": call.emitter_version,
        },
        "resource": {
            "provider": call.provider,
            "type": call.resource_type,
            "name": call.resource_name,
            "operation": call.operation,
            "modality": call.modality,
            "region": call.region,
            "deployment": call.deployment,
        },
        "is_model": call.is_model,
        "usage_kind": call.usage_kind,
        "usage": json_safe(call.usage),
        "cost": {**cost_json(call), "detail": json_safe(call.cost_detail)},
        "labels": dict(call.labels),
        "environment": call.environment,
        "run_name": call.run_name,
        "run_type": call.run_type,
        "outcome": call.outcome,
        "error_code": call.error_code,
        "error_reason": call.error_reason,
        "corrects": call.corrects,
        "spec_version": call.spec_version,
        "content_sha256": call.content_sha256,
        "findings": [
            {"id": f.id, "category": f.category, "dismissed": f.dismissed} for f in findings
        ],
    }


def _rank_key(finding: FindingRow) -> tuple[int, int, int, int]:
    # KORA Doctor's text report ranks by confidence, then by call count.
    confidence = {"medium": 0, "low": 1}.get(finding.confidence, 9)
    category = CATEGORY_ORDER.index(finding.category) if finding.category in CATEGORY_ORDER else 99
    return (confidence, -len(finding.call_ids), category, finding.ordinal)


def rank_findings(findings: Sequence[FindingRow]) -> dict[str, int]:
    return {f.id: index + 1 for index, f in enumerate(sorted(findings, key=_rank_key))}


def _enrich_evidence(evidence: dict[str, Any], import_id: str) -> dict[str, Any]:
    """Attach stable call IDs to every record the evidence mentions."""
    out = json_safe(evidence)
    for key in ("members", "sequence"):
        for entry in out.get(key) or []:
            entry["call_id"] = ids.call_id(import_id, entry["record_id"])
    if out.get("reference_record_id"):
        out["reference_call_id"] = ids.call_id(import_id, out["reference_record_id"])
    return dict(out)


def finding_json(
    finding: FindingRow,
    calls_by_id: dict[str, CallRecord],
    all_findings: Sequence[FindingRow],
    ranks: dict[str, int],
) -> dict[str, Any]:
    affected_calls = [calls_by_id[cid] for cid in finding.call_ids if cid in calls_by_id]
    estimate: dict[str, Decimal] = {}
    for call in affected_calls:
        if call.cost_total is not None and call.cost_currency is not None:
            estimate[call.cost_currency] = estimate.get(call.cost_currency, Decimal(0)) + scale(
                call.cost_total, finding.saving_ratio
            )
    mine = set(finding.call_ids)
    overlaps = []
    for other in all_findings:
        if other.id == finding.id:
            continue
        shared = mine.intersection(other.call_ids)
        if shared:
            overlaps.append(
                {
                    "finding_id": other.id,
                    "category": other.category,
                    "category_label": catalog.label_for(other.category),
                    "shared_calls": len(shared),
                    "dismissed": other.dismissed,
                }
            )
    spend = summarize_spend(affected_calls)
    run_pks = sorted({c.run_pk for c in affected_calls})
    return {
        "id": finding.id,
        "import_id": finding.import_id,
        "ordinal": finding.ordinal,
        "rank": ranks.get(finding.id),
        "category": finding.category,
        "category_label": catalog.label_for(finding.category),
        "title": finding.title,
        "rationale": finding.reason,
        "confidence": finding.confidence,
        "evidence": _enrich_evidence(finding.evidence, finding.import_id),
        "evidence_status": finding.evidence_status,
        "rule": catalog.rule_for(finding.category),
        "limitations": catalog.limitations_for(finding.category),
        "affected": [
            {
                "call_id": c.id,
                "record_id": c.record_id,
                "run_pk": c.run_pk,
                "run_id": c.run_id,
                "step": c.step,
                "resource_name": c.resource_name,
                "event_time": c.event_time,
                "cost": cost_json(c),
            }
            for c in affected_calls
        ],
        "run_ids": finding.run_ids,
        "run_pks": run_pks,
        "affected_spend": spend.to_json(),
        "scenario": {
            "ratio": decimal_str(finding.saving_ratio),
            "ratio_percent": decimal_str(finding.saving_ratio * 100),
            "estimate": money_list(estimate),
            "unknown_cost_calls": spend.unknown_calls,
        },
        "overlaps": overlaps,
        "dismissed": finding.dismissed,
        "dismissal_note": finding.dismissal_note,
        "dismissed_at": finding.dismissed_at,
    }


def scenario_json(
    findings: Sequence[FindingRow],
    calls_by_id: dict[str, CallRecord],
    run_pk: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ratios": {cat: decimal_str(r) for cat, r in kora.SCENARIO_RATIOS.items()},
        "method": SCENARIO_METHOD,
    }
    for mode in ("open", "all"):
        max_ratio: dict[str, Decimal] = {}
        for finding in findings:
            if mode == "open" and finding.dismissed:
                continue
            for cid in finding.call_ids:
                call = calls_by_id.get(cid)
                if call is None or (run_pk is not None and call.run_pk != run_pk):
                    continue
                max_ratio[cid] = max(max_ratio.get(cid, Decimal(0)), finding.saving_ratio)
        estimate: dict[str, Decimal] = {}
        for cid, ratio in max_ratio.items():
            call = calls_by_id[cid]
            if call.cost_total is not None and call.cost_currency is not None:
                estimate[call.cost_currency] = estimate.get(call.cost_currency, Decimal(0)) + scale(
                    call.cost_total, ratio
                )
        flagged = summarize_spend(calls_by_id[cid] for cid in max_ratio)
        out[mode] = {
            "flagged_calls": len(max_ratio),
            "flagged_spend": flagged.to_json(),
            "estimate": money_list(estimate),
            "unknown_cost_calls": flagged.unknown_calls,
        }
    return out


def _finding_index(findings: Sequence[FindingRow]) -> dict[str, list[FindingRow]]:
    by_call: dict[str, list[FindingRow]] = defaultdict(list)
    for finding in findings:
        for cid in finding.call_ids:
            by_call[cid].append(finding)
    return by_call


def run_summary_json(
    run: RunRow, imp: ImportRow, counts: dict[str, dict[str, int]]
) -> dict[str, Any]:
    c = counts.get(run.id, {})
    return {
        **run.summary,
        "id": run.id,
        "import_id": run.import_id,
        "run_id": run.run_id,
        "ordinal": run.ordinal,
        "synthetic": imp.synthetic,
        "import_filename": imp.filename,
        "open_findings": c.get("open_findings", 0),
        "dismissed_findings": c.get("dismissed_findings", 0),
        "flagged_calls": c.get("flagged_calls", 0),
    }


def import_summary_json(
    imp: ImportRow,
    runs: Sequence[RunRow],
    counts: dict[str, dict[str, int]],
    import_counts: dict[str, int],
) -> dict[str, Any]:
    spend = combine_spends(Spend.from_json(r.summary["spend"]) for r in runs)
    return {
        "id": imp.id,
        "filename": imp.filename,
        "source": imp.source,
        "synthetic": imp.synthetic,
        "demo_key": imp.demo_key,
        "format": imp.format,
        "file_sha256": imp.file_sha256,
        "byte_size": imp.byte_size,
        "record_count": imp.record_count,
        "accepted_count": imp.accepted_count,
        "imported_at": imp.imported_at,
        "analyzed_at": imp.analyzed_at,
        "analyzer": imp.analyzer,
        "spend": spend.to_json(),
        "runs": [run_summary_json(r, imp, counts) for r in runs],
        "open_findings": import_counts.get("open", 0),
        "dismissed_findings": import_counts.get("dismissed", 0),
        "notes_count": len(imp.notes),
        "warnings_count": sum(1 for n in imp.notes if n.severity == "warning"),
    }


def _import_counts(findings: Sequence[FindingRow]) -> dict[str, int]:
    return {
        "open": sum(1 for f in findings if not f.dismissed),
        "dismissed": sum(1 for f in findings if f.dismissed),
    }


def list_imports(store: Store) -> list[dict[str, Any]]:
    counts = store.finding_counts()
    runs_by_import: dict[str, list[RunRow]] = defaultdict(list)
    for run in store.list_runs():
        runs_by_import[run.import_id].append(run)
    out = []
    for imp in store.list_imports():
        findings = store.load_findings(imp.id)
        out.append(
            import_summary_json(imp, runs_by_import[imp.id], counts, _import_counts(findings))
        )
    return out


def import_notes(imp: ImportRow) -> list[dict[str, Any]]:
    notes = [n.to_json() for n in imp.notes]
    for warning in imp.analysis.get("warnings", []):
        notes.append({"code": "analyzer_warning", "severity": "info", "message": warning})
    return notes


def import_detail(store: Store, import_id: str) -> dict[str, Any] | None:
    imp = store.get_import(import_id)
    if imp is None:
        return None
    runs = store.list_runs(import_id)
    calls = store.load_calls(import_id)
    findings = store.load_findings(import_id)
    calls_by_id = {c.id: c for c in calls}
    ranks = rank_findings(findings)
    summary = import_summary_json(imp, runs, store.finding_counts(), _import_counts(findings))
    return {
        **summary,
        "notes": import_notes(imp),
        "category_counts": imp.analysis.get("category_counts", {}),
        "findings": sorted(
            (finding_json(f, calls_by_id, findings, ranks) for f in findings),
            key=lambda f: f["rank"],
        ),
        "scenario": scenario_json(findings, calls_by_id),
        "by_model": by_model(calls),
    }


def run_detail(store: Store, run_pk: str) -> dict[str, Any] | None:
    run = store.get_run(run_pk)
    if run is None:
        return None
    imp = store.get_import(run.import_id)
    assert imp is not None
    all_calls = store.load_calls(run.import_id)
    findings = store.load_findings(run.import_id)
    calls_by_id = {c.id: c for c in all_calls}
    run_calls = [c for c in all_calls if c.run_pk == run_pk]
    run_call_ids = {c.id for c in run_calls}
    touching = [f for f in findings if run_call_ids.intersection(f.call_ids)]
    ranks = rank_findings(touching)
    by_call = _finding_index(findings)
    counts = store.finding_counts()
    summary = run_summary_json(run, imp, counts)
    starts = [c.start_ms if c.start_ms is not None else c.event_ms for c in run_calls]
    return {
        "run": summary,
        "import": import_summary_json(
            imp, store.list_runs(run.import_id), counts, _import_counts(findings)
        ),
        "calls": [call_json(c, by_call.get(c.id, ())) for c in run_calls],
        "findings": sorted(
            (finding_json(f, calls_by_id, touching, ranks) for f in touching),
            key=lambda f: f["rank"],
        ),
        "scenario": scenario_json(findings, calls_by_id, run_pk=run_pk),
        "by_model": by_model(run_calls),
        "timeline": {
            "start_ms": min(starts),
            "end_ms": max(c.event_ms for c in run_calls),
            "rule": TIMELINE_RULE,
        },
    }
