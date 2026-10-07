"""KORA Doctor adapter: the only module that imports ``kora_doctor``.

The analyzer is used unmodified, pinned to the v0.1.0 release commit. Its
``Finding`` records which calls were flagged, but not *why* in machine-readable
form: duplicate findings, for example, omit the first (reference) call of each
group. This module re-derives the evidence for every finding with the
analyzer's own helper functions and constants, then checks that the
re-derivation reproduces the analyzer's record IDs exactly. When it does not
(for example, after an upstream change), the finding keeps its analyzer
rationale but is marked ``evidence_status="unavailable"`` instead of showing
evidence the analyzer did not use.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import kora_doctor
from kora_doctor import analyzer as kd

from ..ingest.normalize import CallRecord, to_kora_record

PINNED_REVISION = "7c54af8f1ddf891bfd05125fd1c345186c9cd62a"
SOURCE_URL = "https://github.com/Krako-Labs/kora-doctor"
SOURCE_FILE = "kora_doctor/analyzer.py"

DUPLICATE = kd.CATEGORY_DUPLICATE
CACHE = kd.CATEGORY_CACHE
DETERMINISTIC = kd.CATEGORY_DETERMINISTIC
SMALLER = kd.CATEGORY_SMALLER
ORCHESTRATION = kd.CATEGORY_ORCHESTRATION
CATEGORIES = (DUPLICATE, CACHE, DETERMINISTIC, SMALLER, ORCHESTRATION)

DETERMINISTIC_KEYWORDS: tuple[str, ...] = tuple(kd.DETERMINISTIC_KEYWORDS)
FRONTIER_MODEL_PATTERNS: tuple[str, ...] = tuple(kd.FRONTIER_MODEL_PATTERNS)
LOW_COST_MODEL_MARKERS: tuple[str, ...] = tuple(kd.LOW_COST_MODEL_MARKERS)

# Literals inside kora_doctor.analyzer.analyze() at the pinned revision. The
# re-derivation checks below confirm them against every finding emitted.
SMALLER_MODEL_MAX_TOKENS = 2500
ORCHESTRATION_MIN_CALLS = 6
ORCHESTRATION_KEPT_CALLS = 4
ORCHESTRATION_MEDIUM_AT = 8

#: Scenario ratios documented in the upstream README ("Current v0 savings
#: assumptions"). Tests assert every emitted finding uses these values.
SCENARIO_RATIOS: dict[str, Decimal] = {
    DUPLICATE: Decimal("1.0"),
    CACHE: Decimal("0.7"),
    DETERMINISTIC: Decimal("0.8"),
    SMALLER: Decimal("0.5"),
    ORCHESTRATION: Decimal("0.5"),
}

#: Field names of kora_doctor.analyzer._usage_signature, in tuple order.
SIGNATURE_FIELDS = (
    "resource.provider",
    "resource.type",
    "resource.name",
    "resource.operation",
    "resource.modality",
    "usage.llm.input_tokens",
    "usage.llm.output_tokens",
    "usage.llm.reasoning_tokens",
    "usage.llm.cache_read_tokens",
    "usage.llm.requests",
)

NOT_COMPARED = (
    "Prompt and response content: AUDR records do not contain it.",
    "Cost, timing, cache-write tokens and labels: not part of the analyzer's signature.",
)

SIGNATURE_STATEMENT = (
    "Equal usage counters are consistent with repeated work, but they cannot show what each "
    "call processed: AUDR records carry no prompt or response content."
)


@dataclass(frozen=True)
class AnalyzerInfo:
    name: str
    version: str
    revision: str
    source: str

    def to_json(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "revision": self.revision,
            "source": self.source,
        }


ANALYZER = AnalyzerInfo("KORA Doctor", kora_doctor.__version__, PINNED_REVISION, SOURCE_URL)


@dataclass
class AnalyzedFinding:
    ordinal: int
    category: str
    title: str
    reason: str
    confidence: str
    saving_ratio: Decimal
    record_ids: list[str]
    run_ids: list[str]
    evidence: dict[str, Any]
    evidence_status: str  # "derived" | "unavailable"


@dataclass
class AnalysisResult:
    findings: list[AnalyzedFinding]
    category_counts: dict[str, int]
    warnings: list[str]
    #: KORA Doctor's own float totals, kept only for cross-checks; the
    #: inspector's money values are recomputed with Decimal.
    kora_observed_costs: dict[str, float]
    kora_potential_savings: dict[str, float]
    records: int
    model_calls: int
    tool_calls: int
    runs: int
    analyzer: AnalyzerInfo = field(default=ANALYZER)


def _rid(record: dict[str, Any]) -> str:
    return str(record["record_id"])


def _run_id(record: dict[str, Any]) -> str:
    return str(record["run"]["run_id"])


def _signature_probe_ok() -> bool:
    """Confirm the helper still returns the fields in the documented order."""
    probe = {
        "resource": {"provider": "p", "type": "t", "name": "n", "operation": "o", "modality": "m"},
        "usage": {
            "llm": {
                "input_tokens": 1,
                "output_tokens": 2,
                "reasoning_tokens": 3,
                "cache_read_tokens": 4,
                "requests": 5,
            }
        },
    }
    return bool(kd._usage_signature(probe) == ("p", "t", "n", "o", "m", 1, 2, 3, 4, 5))


_SIGNATURE_OK = _signature_probe_ok()


def _signature_evidence(finding: Any, group: list[dict[str, Any]], scope: str) -> dict[str, Any]:
    signature = kd._usage_signature(group[0])
    return {
        "kind": "usage_signature_match",
        "scope": scope,
        "signature": [
            {"field": name, "value": value}
            for name, value in zip(SIGNATURE_FIELDS, signature, strict=True)
        ],
        "reference_record_id": _rid(group[0]),
        "members": [
            {
                "record_id": _rid(record),
                "run_id": _run_id(record),
                "role": "reference" if index == 0 else "candidate",
            }
            for index, record in enumerate(group)
        ],
        "run_ids": sorted({_run_id(r) for r in group}),
        "not_compared": list(NOT_COMPARED),
        "statement": SIGNATURE_STATEMENT,
        "proof": False,
    }


def _derive_duplicate(
    finding: Any, by_id: dict[str, dict[str, Any]], model_records: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not _SIGNATURE_OK or len(finding.run_ids) != 1 or not finding.record_ids:
        return None
    run_id = finding.run_ids[0]
    signature = kd._usage_signature(by_id[finding.record_ids[0]])
    group = [
        r for r in model_records if _run_id(r) == run_id and kd._usage_signature(r) == signature
    ]
    if len(group) < 2 or [_rid(r) for r in group[1:]] != list(finding.record_ids):
        return None
    return _signature_evidence(finding, group, scope="run")


def _derive_cache(
    finding: Any, by_id: dict[str, dict[str, Any]], model_records: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not _SIGNATURE_OK or not finding.record_ids:
        return None
    signature = kd._usage_signature(by_id[finding.record_ids[0]])
    group = [r for r in model_records if kd._usage_signature(r) == signature]
    runs = sorted({_run_id(r) for r in group})
    if (
        len(group) < 2
        or len(runs) < 2
        or [_rid(r) for r in group[1:]] != list(finding.record_ids)
        or runs != sorted(finding.run_ids)
    ):
        return None
    return _signature_evidence(finding, group, scope="import")


def _deterministic_sources(record: dict[str, Any]) -> list[tuple[str, str]]:
    run = record.get("run", {})
    sources = [("run.name", run.get("name")), ("run.run_type", run.get("run_type"))]
    labels = (record.get("attribution") or {}).get("labels") or {}
    if isinstance(labels, dict):
        sources += [(f"attribution.labels.{key}", value) for key, value in labels.items()]
    return [(name, str(value)) for name, value in sources if value]


def _derive_deterministic(
    finding: Any, by_id: dict[str, dict[str, Any]], _model_records: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if len(finding.record_ids) != 1:
        return None
    record = by_id[finding.record_ids[0]]
    text = kd._context_text(record)
    hit = next((kw for kw in kd.DETERMINISTIC_KEYWORDS if kw in text), None)
    if hit is None or f"'{hit}'" not in finding.reason:
        return None
    matches = []
    for name, value in _deterministic_sources(record):
        lowered = value.lower()
        index = lowered.find(hit)
        if index < 0:
            continue
        match: dict[str, Any] = {"field": name, "value": value}
        if len(lowered) == len(value):  # offsets are only safe when lowering keeps length
            match["start"] = index
            match["end"] = index + len(hit)
        matches.append(match)
    return {
        "kind": "metadata_keyword",
        "keyword": hit,
        "matches": matches,
        # Only needed when the keyword spans two fields of the joined text.
        "combined_text": None if matches else text,
        "fields_checked": ["run.name", "run.run_type", "attribution.labels (values)"],
        "keywords_checked": list(kd.DETERMINISTIC_KEYWORDS),
        "also_present": [kw for kw in kd.DETERMINISTIC_KEYWORDS if kw != hit and kw in text],
        "statement": (
            "The keyword appears in run or label metadata. The call's actual task, inputs and "
            "outputs are not visible in AUDR."
        ),
        "proof": False,
    }


def _derive_smaller(
    finding: Any, by_id: dict[str, dict[str, Any]], _model_records: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if len(finding.record_ids) != 1:
        return None
    record = by_id[finding.record_ids[0]]
    model = str(record.get("resource", {}).get("name", ""))
    lowered = model.lower()
    llm = record.get("usage", {}).get("llm", {})
    total = kd._token_total(record)
    reasoning = llm.get("reasoning_tokens")
    pattern = next((p for p in kd.FRONTIER_MODEL_PATTERNS if re.search(p, lowered)), None)
    if not (
        kd._frontier_model(model)
        and pattern is not None
        and total
        and total <= SMALLER_MODEL_MAX_TOKENS
        and reasoning in (None, 0)
        and f"Only {total} reported" in finding.reason
    ):
        return None
    return {
        "kind": "model_tier_and_size",
        "model": model,
        "matched_pattern": pattern,
        "patterns_checked": list(kd.FRONTIER_MODEL_PATTERNS),
        "low_cost_markers": list(kd.LOW_COST_MODEL_MARKERS),
        "token_total": total,
        "token_limit": SMALLER_MODEL_MAX_TOKENS,
        "counted": {
            "input_tokens": llm.get("input_tokens"),
            "output_tokens": llm.get("output_tokens"),
            "reasoning_tokens": reasoning,
        },
        "statement": (
            "Short call on a model whose name matches a high-end tier pattern, with no "
            "reported reasoning tokens. Output-quality needs are not visible in AUDR."
        ),
        "proof": False,
    }


def _orchestration_key(record: dict[str, Any]) -> tuple[bool, int, str]:
    # Same ordering as the lambda in kora_doctor.analyzer.analyze(), including
    # its treatment of step 0 (``step or 10**9`` places it after other steps).
    step = record.get("run", {}).get("step")
    return (step is None, step or 10**9, str(record.get("timing", {}).get("event_time", "")))


def _derive_orchestration(
    finding: Any, _by_id: dict[str, dict[str, Any]], model_records: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if len(finding.run_ids) != 1:
        return None
    run_id = finding.run_ids[0]
    ordered = sorted((r for r in model_records if _run_id(r) == run_id), key=_orchestration_key)
    expected_confidence = "medium" if len(ordered) >= ORCHESTRATION_MEDIUM_AT else "low"
    if (
        len(ordered) < ORCHESTRATION_MIN_CALLS
        or [_rid(r) for r in ordered[ORCHESTRATION_KEPT_CALLS:]] != list(finding.record_ids)
        or finding.confidence != expected_confidence
    ):
        return None
    has_step_zero = any(r.get("run", {}).get("step") == 0 for r in ordered)
    return {
        "kind": "call_count_in_run",
        "run_id": run_id,
        "model_call_count": len(ordered),
        "min_calls": ORCHESTRATION_MIN_CALLS,
        "kept_calls": ORCHESTRATION_KEPT_CALLS,
        "medium_confidence_at": ORCHESTRATION_MEDIUM_AT,
        "ordering": "run.step ascending (records without a step last), then timing.event_time",
        "ordering_note": (
            "KORA Doctor v0.1.0 orders a step of 0 after all other steps."
            if has_step_zero
            else None
        ),
        "sequence": [
            {
                "record_id": _rid(r),
                "position": index + 1,
                "step": r.get("run", {}).get("step"),
                "event_time": r.get("timing", {}).get("event_time"),
                "flagged": index >= ORCHESTRATION_KEPT_CALLS,
            }
            for index, r in enumerate(ordered)
        ],
        "statement": (
            f"{len(ordered)} model calls ran in this run. The analyzer keeps the first "
            f"{ORCHESTRATION_KEPT_CALLS} and flags the rest for review, whatever their purpose."
        ),
        "proof": False,
    }


_DERIVERS: dict[
    str,
    Callable[[Any, dict[str, dict[str, Any]], list[dict[str, Any]]], dict[str, Any] | None],
] = {
    DUPLICATE: _derive_duplicate,
    CACHE: _derive_cache,
    DETERMINISTIC: _derive_deterministic,
    SMALLER: _derive_smaller,
    ORCHESTRATION: _derive_orchestration,
}


def run_analysis(calls: list[CallRecord]) -> AnalysisResult:
    """Run KORA Doctor on stored telemetry (in original record order)."""
    ordered_calls = sorted(calls, key=lambda c: c.ordinal)
    records = [to_kora_record(call) for call in ordered_calls]
    report = kd.analyze(records)
    by_id = {_rid(r): r for r in records}
    model_records = [r for r in records if kd._is_model(r)]

    findings: list[AnalyzedFinding] = []
    for ordinal, finding in enumerate(report.findings):
        derive = _DERIVERS.get(finding.category)
        try:
            evidence = derive(finding, by_id, model_records) if derive else None
        except (KeyError, TypeError, ValueError):
            evidence = None
        findings.append(
            AnalyzedFinding(
                ordinal=ordinal,
                category=str(finding.category),
                title=str(finding.title),
                reason=str(finding.reason),
                confidence=str(finding.confidence),
                saving_ratio=Decimal(repr(float(finding.saving_ratio))),
                record_ids=[str(r) for r in finding.record_ids],
                run_ids=[str(r) for r in finding.run_ids],
                evidence=evidence or {"kind": "unavailable"},
                evidence_status="derived" if evidence else "unavailable",
            )
        )
    return AnalysisResult(
        findings=findings,
        category_counts={k: int(v) for k, v in report.category_counts.items()},
        warnings=[str(w) for w in report.warnings],
        kora_observed_costs=dict(report.observed_costs),
        kora_potential_savings=dict(report.potential_savings),
        records=int(report.records),
        model_calls=int(report.model_calls),
        tool_calls=int(report.tool_calls),
        runs=int(report.runs),
    )
