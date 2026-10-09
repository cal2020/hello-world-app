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
from .summaries import by_model, cost_parts

CATEGORY_ORDER = list(kora.CATEGORIES)
TIMELINE_RULE = (
    "Each bar ends at timing.event_time and extends back by timing.duration_ms; AUDR §3.7 and "
    "its multi-emitter example treat event_time as the completion time. Calls without a "
    "duration are drawn as points."
)
SCENARIO_METHOD = (
    "Each flagged call contributes its cost × the highest scenario ratio among the "
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
    known = unknown = estimated = 0
    for spend in spends:
        known += spend.known_calls
        unknown += spend.unknown_calls
        estimated += spend.estimated_calls
        for currency, amount in spend.by_currency.items():
            totals[currency] = totals.get(currency, Decimal(0)) + amount
    return Spend(dict(sorted(totals.items())), known, unknown, estimated)


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


def _rank_key(
    confidence: str, call_count: int, category: str, ordinal: int
) -> tuple[int, int, int, int]:
    # KORA Doctor's text report ranks by confidence, then by call count.
    return (
        {"medium": 0, "low": 1}.get(confidence, 9),
        -call_count,
        CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else 99,
        ordinal,
    )


def rank_findings(findings: Sequence[FindingRow]) -> dict[str, int]:
    """1-based rank of each finding among the given ones."""
    return rank_inputs(
        [(f.id, f.confidence, f.category, f.ordinal, len(f.call_ids)) for f in findings]
    )


def rank_inputs(rows: Sequence[tuple[str, str, str, int, int]]) -> dict[str, int]:
    """Rank (id, confidence, category, ordinal, call count) rows, e.g. from the store."""
    ordered = sorted(rows, key=lambda r: _rank_key(r[1], r[4], r[2], r[3]))
    return {row[0]: index + 1 for index, row in enumerate(ordered)}


def _enrich_evidence(evidence: dict[str, Any], import_id: str) -> dict[str, Any]:
    """Attach stable call IDs to every record the evidence mentions."""
    out = json_safe(evidence)
    for key in ("members", "sequence"):
        for entry in out.get(key) or []:
            entry["call_id"] = ids.call_id(import_id, entry["record_id"])
    if out.get("reference_record_id"):
        out["reference_call_id"] = ids.call_id(import_id, out["reference_record_id"])
    return dict(out)


class FindingContext:
    """Per-request lookups so building many findings stays linear in their size."""

    def __init__(
        self,
        findings: Sequence[FindingRow],
        calls_by_id: dict[str, CallRecord],
        ranks: dict[str, int] | None = None,
    ) -> None:
        self.calls_by_id = calls_by_id
        self.by_id = {f.id: f for f in findings}
        self.ranks = rank_findings(findings) if ranks is None else ranks
        self.by_call: dict[str, list[FindingRow]] = defaultdict(list)
        for finding in findings:
            for cid in finding.call_ids:
                self.by_call[cid].append(finding)

    def shared_calls(self, finding: FindingRow) -> dict[str, int]:
        """Other finding ID → number of this finding's calls it also flags."""
        shared: dict[str, int] = defaultdict(int)
        for cid in finding.call_ids:
            for other in self.by_call.get(cid, ()):
                if other.id != finding.id:
                    shared[other.id] += 1
        return shared


def _affected(finding: FindingRow, ctx: FindingContext) -> list[CallRecord]:
    return [ctx.calls_by_id[cid] for cid in finding.call_ids if cid in ctx.calls_by_id]


def finding_summary_json(finding: FindingRow, ctx: FindingContext) -> dict[str, Any]:
    """Light form for lists and timeline emphasis; details come from finding_json."""
    affected = _affected(finding, ctx)
    shared = ctx.shared_calls(finding)
    reference = finding.evidence.get("reference_record_id")
    return {
        "id": finding.id,
        "import_id": finding.import_id,
        "ordinal": finding.ordinal,
        "rank": ctx.ranks.get(finding.id),
        "category": finding.category,
        "category_label": catalog.label_for(finding.category),
        "title": finding.title,
        "confidence": finding.confidence,
        "evidence_status": finding.evidence_status,
        "call_ids": list(finding.call_ids),
        "reference_call_id": ids.call_id(finding.import_id, reference) if reference else None,
        "run_pks": sorted({c.run_pk for c in affected}),
        "affected_count": len(finding.call_ids),
        "affected_spend": summarize_spend(affected).to_json(),
        "overlap_count": sum(1 for fid in shared if not ctx.by_id[fid].dismissed),
        "dismissed": finding.dismissed,
        "dismissal_note": finding.dismissal_note,
        "dismissed_at": finding.dismissed_at,
    }


def finding_json(finding: FindingRow, ctx: FindingContext) -> dict[str, Any]:
    """Full form: evidence, rule, limitations, affected calls, scenario and overlaps."""
    affected = _affected(finding, ctx)
    estimate: dict[str, Decimal] = {}
    for call in affected:
        if call.cost_total is not None and call.cost_currency is not None:
            estimate[call.cost_currency] = estimate.get(call.cost_currency, Decimal(0)) + scale(
                call.cost_total, finding.saving_ratio
            )
    # One pass over this finding's calls: which other findings also flag them, by category.
    other_ids: dict[str, set[str]] = defaultdict(set)
    shared_calls: dict[str, set[str]] = defaultdict(set)
    for cid in finding.call_ids:
        for other in ctx.by_call.get(cid, ()):
            if other.id != finding.id:
                other_ids[other.category].add(other.id)
                shared_calls[other.category].add(cid)
    overlaps = []
    for category in sorted(
        other_ids, key=lambda c: CATEGORY_ORDER.index(c) if c in CATEGORY_ORDER else 99
    ):
        # Open findings first, so the inspector links to one that still needs a decision.
        others = sorted(
            other_ids[category], key=lambda oid: (ctx.by_id[oid].dismissed, ctx.ranks.get(oid, 0))
        )
        overlaps.append(
            {
                "category": category,
                "category_label": catalog.label_for(category),
                "findings": len(others),
                "open_findings": sum(1 for oid in others if not ctx.by_id[oid].dismissed),
                "shared_calls": len(shared_calls[category]),
                "finding_ids": others[:10],
            }
        )
    summary = finding_summary_json(finding, ctx)
    spend = summarize_spend(affected)
    return {
        **summary,
        "rationale": finding.reason,
        "evidence": _enrich_evidence(finding.evidence, finding.import_id),
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
            for c in affected
        ],
        "run_ids": finding.run_ids,
        "scenario": {
            "ratio": decimal_str(finding.saving_ratio),
            "ratio_percent": decimal_str(finding.saving_ratio * 100),
            "estimate": money_list(estimate),
            "unknown_cost_calls": spend.unknown_calls,
        },
        "overlaps": overlaps,
    }


def finding_detail(store: Store, finding_id: str) -> dict[str, Any] | None:
    """One finding with full evidence. Loads only its calls and the findings sharing them;
    its rank is import-wide, matching the import overview and the exported report."""
    nearby = store.load_findings_near_finding(finding_id)
    finding = next((f for f in nearby if f.id == finding_id), None)
    if finding is None:
        return None
    calls = {c.id: c for c in store.load_finding_calls(finding_id)}
    ranks = rank_inputs(store.finding_rank_inputs(finding.import_id))
    return finding_json(finding, FindingContext(nearby, calls, ranks))


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
    per_import = store.import_finding_counts()
    return [
        import_summary_json(imp, runs_by_import[imp.id], counts, per_import.get(imp.id, {}))
        for imp in store.list_imports()
    ]


def import_notes(imp: ImportRow) -> list[dict[str, Any]]:
    notes = [n.to_json() for n in imp.notes]
    for warning in imp.analysis.get("warnings", []):
        notes.append({"code": "analyzer_warning", "severity": "info", "message": warning})
    return notes


class ImportData:
    """Everything stored for one import, loaded once and shared by the views built on it."""

    def __init__(self, store: Store, imp: ImportRow) -> None:
        self.imp = imp
        self.runs = store.list_runs(imp.id)
        self.calls = store.load_calls(imp.id)
        self.findings = store.load_findings(imp.id)
        self.ctx = FindingContext(self.findings, {c.id: c for c in self.calls})

    def overview(self, store: Store) -> dict[str, Any]:
        """Import summary, notes, scenario and per-model spend; no finding list."""
        summary = import_summary_json(
            self.imp, self.runs, store.finding_counts(), _import_counts(self.findings)
        )
        return {
            **summary,
            "notes": import_notes(self.imp),
            "category_counts": self.imp.analysis.get("category_counts", {}),
            "scenario": scenario_json(self.findings, self.ctx.calls_by_id),
            "by_model": by_model(self.calls),
            "cost_parts": cost_parts(self.calls),
        }


def import_detail(store: Store, import_id: str) -> dict[str, Any] | None:
    imp = store.get_import(import_id)
    if imp is None:
        return None
    data = ImportData(store, imp)
    return {
        **data.overview(store),
        "findings": sorted(
            (finding_summary_json(f, data.ctx) for f in data.findings), key=lambda f: f["rank"]
        ),
    }


def run_detail(store: Store, run_pk: str) -> dict[str, Any] | None:
    run = store.get_run(run_pk)
    if run is None:
        return None
    imp = store.get_import(run.import_id)
    assert imp is not None
    # Only this run's calls, plus calls elsewhere that share a finding with them.
    run_calls = store.load_calls(run.import_id, run_pk)
    calls_by_id = {c.id: c for c in run_calls}
    calls_by_id.update((c.id, c) for c in store.load_calls_flagged_with_run(run_pk))
    run_call_ids = {c.id for c in run_calls}
    nearby = store.load_findings_near_run(run_pk)
    touching = [f for f in nearby if run_call_ids.intersection(f.call_ids)]
    # Ranks are relative to the run's own findings, the order its list shows.
    ctx = FindingContext(nearby, calls_by_id, rank_findings(touching))
    by_call = _finding_index(touching)
    counts = store.finding_counts()
    summary = run_summary_json(run, imp, counts)
    starts = [c.start_ms if c.start_ms is not None else c.event_ms for c in run_calls]
    return {
        "run": summary,
        "import": import_summary_json(
            imp,
            store.list_runs(run.import_id),
            counts,
            store.import_finding_counts().get(imp.id, {}),
        ),
        "calls": [call_json(c, by_call.get(c.id, ())) for c in run_calls],
        "findings": sorted(
            (finding_summary_json(f, ctx) for f in touching), key=lambda f: f["rank"]
        ),
        "scenario": scenario_json(touching, calls_by_id, run_pk=run_pk),
        "by_model": by_model(run_calls),
        "cost_parts": cost_parts(run_calls),
        "timeline": {
            "start_ms": min(starts),
            "end_ms": max(c.event_ms for c in run_calls),
            "rule": TIMELINE_RULE,
        },
    }
