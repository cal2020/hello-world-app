"""Normalized telemetry: the only form in which imported records are stored.

A :class:`CallRecord` keeps the fields needed to inspect cost and reproduce
the analysis. It deliberately drops identity and credential metadata
(``attribution.user_id``, ``account_id``, ``subscription_id``,
``resource.key_name``, ``run.trace_id``). AUDR records carry no prompt or
response content, and the schema rejects unknown fields, so no prompt text
can reach storage.

Usage counters keep the absent-versus-zero distinction AUDR requires: a
counter that is not reported is absent, never ``0``.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

from .. import ids
from ..pricing import COST_BASIS_ESTIMATE, COST_BASIS_LABEL
from .issues import Issue, IssueList
from .parse import SourceItem
from .sink import canonical_json

DROPPED_FIELDS = (
    "attribution.user_id",
    "attribution.account_id",
    "attribution.subscription_id",
    "resource.key_name",
    "run.trace_id",
)

LLM_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "requests",
)

_RFC3339 = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$"
)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

Number = int | Decimal


def decimal_str(value: Decimal) -> str:
    """Plain (non-exponent) canonical spelling of a decimal, e.g. ``0.0084``."""
    text = format(value.normalize(), "f")
    return "0" if text in ("-0", "") else text


def _number(value: Any) -> Number:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    raise TypeError(f"expected a number, got {type(value).__name__}")


def parse_event_time(value: str) -> int:
    """RFC 3339 timestamp to UTC epoch milliseconds. Raises ``ValueError``."""
    match = _RFC3339.match(value)
    if not match:
        raise ValueError("not an RFC 3339 timestamp")
    year, month, day, hour, minute, second, fraction, tz = match.groups()
    sec = int(second)
    extra_ms = 0
    if sec == 60:  # leap second: keep it inside the same minute
        sec, extra_ms = 59, 999
    micros = int((fraction or "0")[:6].ljust(6, "0"))
    if tz == "Z":
        tzinfo: timezone = UTC
    else:
        sign = 1 if tz[0] == "+" else -1
        hours, minutes = int(tz[1:3]), int(tz[4:6])
        if hours > 23 or minutes > 59:
            raise ValueError("invalid UTC offset")
        tzinfo = timezone(sign * timedelta(hours=hours, minutes=minutes))
    moment = datetime(
        int(year), int(month), int(day), int(hour), int(minute), sec, micros, tzinfo=tzinfo
    )
    millis = (moment - _EPOCH) // timedelta(milliseconds=1)
    return millis + (extra_ms if not fraction else 0)


@dataclass(frozen=True)
class CallRecord:
    import_id: str
    #: Stable call ID, derived from the import and ``record_id``.
    id: str
    #: Stable run key, derived from the import and ``run.run_id``.
    run_pk: str
    record_id: str
    #: 0-based position among analyzed records; analysis input keeps this order.
    ordinal: int
    line: int
    item: int
    spec_version: str
    emitter_component: str
    emitter_name: str
    emitter_version: str
    event_time: str
    event_ms: int
    received_time: str | None
    duration_ms: int | None
    provider: str
    resource_type: str
    resource_name: str
    operation: str
    modality: str | None
    region: str | None
    deployment: str | None
    run_id: str
    span_id: str
    parent_span_id: str | None
    step: int | None
    run_name: str | None
    run_type: str | None
    outcome: str | None
    error_code: str | None
    error_reason: str | None
    environment: str | None
    labels: dict[str, str]
    usage_kind: Literal["llm", "tool"]
    #: The record's usage block as reported (integers stay integers).
    usage: dict[str, Any]
    cost_total: Decimal | None
    cost_currency: str | None
    #: Remaining cost fields; amounts as canonical decimal strings.
    cost_detail: dict[str, Any] | None
    corrects: str | None
    content_sha256: str
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def is_model(self) -> bool:
        # Same rule as kora_doctor.analyzer._is_model.
        return self.resource_type == "model" or self.usage_kind == "llm"

    @property
    def cost_is_estimate(self) -> bool:
        """The cost was estimated at list prices by the importer, not reported."""
        return (
            self.cost_total is not None and self.labels.get(COST_BASIS_LABEL) == COST_BASIS_ESTIMATE
        )

    @property
    def start_ms(self) -> int | None:
        return self.event_ms - self.duration_ms if self.duration_ms is not None else None

    def counter(self, name: str) -> Number | None:
        value = self.usage.get(name)
        if value is None or isinstance(value, str):
            return None
        return _number(value) if isinstance(value, (int, Decimal)) else None


def _money_tree(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _money_tree(v) for k, v in value.items()}
    if isinstance(value, (Decimal, int)) and not isinstance(value, bool):
        return decimal_str(Decimal(value))
    return value


def _usage_tree(block: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in block.items():
        if isinstance(value, (int, Decimal)) and not isinstance(value, bool):
            out[key] = _number(value)
        else:
            out[key] = value
    return out


def normalize_record(item: SourceItem, ordinal: int, import_id: str) -> CallRecord:
    record = item.value
    emitter = record["emitter"]
    timing = record["timing"]
    resource = record["resource"]
    run = record["run"]
    attribution = record.get("attribution") or {}
    usage = record["usage"]
    usage_kind: Literal["llm", "tool"] = "llm" if "llm" in usage else "tool"
    cost = record.get("cost")

    cost_total: Decimal | None = None
    cost_currency: str | None = None
    cost_detail: dict[str, Any] | None = None
    if isinstance(cost, dict):
        cost_total = Decimal(cost["total_cost"])
        cost_currency = str(cost["currency"])
        rest = {k: v for k, v in cost.items() if k not in ("total_cost", "currency")}
        cost_detail = _money_tree(rest) if rest else None

    labels = attribution.get("labels") or {}
    duration = timing.get("duration_ms")
    step = run.get("step")
    return CallRecord(
        import_id=import_id,
        id=ids.call_id(import_id, str(record["record_id"])),
        run_pk=ids.run_pk(import_id, str(run["run_id"])),
        record_id=str(record["record_id"]),
        ordinal=ordinal,
        line=item.line,
        item=item.item,
        spec_version=str(record["spec_version"]),
        emitter_component=str(emitter["component"]),
        emitter_name=str(emitter["name"]),
        emitter_version=str(emitter["version"]),
        event_time=str(timing["event_time"]),
        event_ms=parse_event_time(str(timing["event_time"])),
        received_time=timing.get("received_time"),
        duration_ms=int(duration) if duration is not None else None,
        provider=str(resource["provider"]),
        resource_type=str(resource["type"]),
        resource_name=str(resource["name"]),
        operation=str(resource["operation"]),
        modality=resource.get("modality"),
        region=resource.get("region"),
        deployment=resource.get("deployment"),
        run_id=str(run["run_id"]),
        span_id=str(run["span_id"]),
        parent_span_id=run.get("parent_span_id"),
        step=int(step) if step is not None else None,
        run_name=run.get("name"),
        run_type=run.get("run_type"),
        outcome=run.get("outcome"),
        error_code=run.get("error_code"),
        error_reason=run.get("error_reason"),
        environment=attribution.get("environment"),
        labels={str(k): str(v) for k, v in labels.items()},
        usage_kind=usage_kind,
        usage=_usage_tree(usage[usage_kind]),
        cost_total=cost_total,
        cost_currency=cost_currency,
        cost_detail=cost_detail,
        corrects=record.get("corrects"),
        content_sha256=hashlib.sha256(canonical_json(record).encode("utf-8")).hexdigest(),
    )


def normalize_items(items: list[SourceItem], errors: IssueList, import_id: str) -> list[CallRecord]:
    calls: list[CallRecord] = []
    for item in items:
        try:
            calls.append(normalize_record(item, ordinal=len(calls), import_id=import_id))
        except ValueError as exc:
            errors.add(
                Issue(
                    code="invalid_timestamp",
                    line=item.line,
                    item=item.item,
                    path="timing.event_time",
                    message=f"`timing.event_time` is not a real date and time ({exc}).",
                    hint="Use RFC 3339 with a valid calendar date, e.g. 2026-10-07T12:00:00.000Z.",
                )
            )
    return calls


def _kora_number(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def to_kora_record(call: CallRecord) -> dict[str, Any]:
    """Rebuild the AUDR fields KORA Doctor reads, from stored telemetry only.

    Absent fields stay absent so the analyzer sees exactly what the original
    record reported. Costs become ``float`` because the analyzer only accepts
    ``int``/``float``; ``float(Decimal(text))`` equals ``json.loads(text)``.
    """
    resource: dict[str, Any] = {
        "provider": call.provider,
        "type": call.resource_type,
        "name": call.resource_name,
        "operation": call.operation,
    }
    if call.modality is not None:
        resource["modality"] = call.modality
    run: dict[str, Any] = {"run_id": call.run_id, "span_id": call.span_id}
    if call.step is not None:
        run["step"] = call.step
    if call.run_name is not None:
        run["name"] = call.run_name
    if call.run_type is not None:
        run["run_type"] = call.run_type
    attribution: dict[str, Any] = {}
    if call.environment is not None:
        attribution["environment"] = call.environment
    if call.labels:
        attribution["labels"] = dict(call.labels)
    record: dict[str, Any] = {
        "spec_version": call.spec_version,
        "record_id": call.record_id,
        "emitter": {
            "component": call.emitter_component,
            "name": call.emitter_name,
            "version": call.emitter_version,
        },
        "timing": {"event_time": call.event_time},
        "resource": resource,
        "run": run,
        "attribution": attribution,
        "usage": {call.usage_kind: {k: _kora_number(v) for k, v in call.usage.items()}},
    }
    if call.cost_total is not None:
        record["cost"] = {"total_cost": float(call.cost_total), "currency": call.cost_currency}
    return record
