"""AUDR sink rules applied before analysis (AUDR v1.0.0 §3.3).

* Exact duplicates of a ``record_id`` are dropped, as sinks deduplicate by
  ``record_id``; a reused ``record_id`` with different content is an error.
* A correction (``corrects``) replaces the record it fully restates. It must
  come from the same ``emitter.component``. A correction whose usage counters
  are all zero is a *void*: both records leave the analysis.
* Records sharing a merge key ``(run_id, span_id)`` describe one operation.
  This inspector does not merge them; it warns, and says so explicitly when
  more than one of them asserts a cost.
* Records without ``attribution.environment`` are kept for inspection, with a
  warning that a conforming sink would ignore them for rating.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .issues import Issue, IssueList
from .parse import SourceItem
from .validate import show

MAX_LINES_IN_NOTE = 50


def _canon(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _canon(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_canon(v) for v in value]
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return ["__decimal__", format(value.normalize(), "f")]
    if isinstance(value, float):
        return ["__decimal__", format(Decimal(repr(value)).normalize(), "f")]
    return value


def canonical_json(value: Any) -> str:
    """Key-order and number-spelling independent JSON, used for equality and hashing."""
    return json.dumps(_canon(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _lines(items: list[SourceItem]) -> tuple[int, ...]:
    return tuple(item.line for item in items[:MAX_LINES_IN_NOTE])


def _usage_block(record: dict[str, Any]) -> dict[str, Any]:
    usage = record.get("usage", {})
    block = usage.get("llm") or usage.get("tool") or {}
    return block if isinstance(block, dict) else {}


def is_void(record: dict[str, Any]) -> bool:
    """A correction whose numeric usage counters are all zero voids its target."""
    if record.get("corrects") is None:
        return False
    numbers = [
        v
        for v in _usage_block(record).values()
        if isinstance(v, (int, Decimal)) and not isinstance(v, bool)
    ]
    return bool(numbers) and all(v == 0 for v in numbers)


@dataclass
class SinkResult:
    accepted: list[SourceItem]
    notes: list[Issue] = field(default_factory=list)
    duplicates_dropped: int = 0
    corrections_applied: int = 0
    voided: int = 0


def apply_sink_rules(items: list[SourceItem], errors: IssueList) -> SinkResult:
    notes: list[Issue] = []

    # 1. record_id deduplication
    first_by_id: dict[str, SourceItem] = {}
    canon_by_id: dict[str, str] = {}
    unique: list[SourceItem] = []
    duplicates: list[SourceItem] = []
    for item in items:
        record_id = item.value["record_id"]
        canon = canonical_json(item.value)
        first = first_by_id.get(record_id)
        if first is not None:
            if canon_by_id[record_id] == canon:
                duplicates.append(item)
            else:
                errors.add(
                    Issue(
                        code="conflicting_record_id",
                        line=item.line,
                        item=item.item,
                        path="record_id",
                        message=f"record_id {show(record_id)} is already used on line {first.line} "
                        "by a record with different content.",
                        hint="Every emitted AUDR record needs its own record_id. To restate a "
                        "record, emit a correction with a new record_id and `corrects`.",
                    )
                )
            continue
        first_by_id[record_id] = item
        canon_by_id[record_id] = canon
        unique.append(item)
    if duplicates:
        notes.append(
            Issue(
                code="duplicate_records_dropped",
                severity="info",
                message=f"{len(duplicates)} exact duplicate record(s) were dropped; AUDR sinks "
                "deduplicate by record_id.",
                lines=_lines(duplicates),
            )
        )

    # 2. corrections
    by_id = {item.value["record_id"]: item for item in unique}
    corrected_by: dict[str, SourceItem] = {}
    orphans: list[SourceItem] = []
    for item in unique:
        target_id = item.value.get("corrects")
        if target_id is None:
            continue
        if target_id == item.value["record_id"]:
            errors.add(
                Issue(
                    code="self_correction",
                    line=item.line,
                    item=item.item,
                    path="corrects",
                    message="A record cannot correct itself.",
                    hint="`corrects` names the earlier record_id being restated.",
                )
            )
            continue
        target = by_id.get(target_id)
        if target is None:
            orphans.append(item)
            continue
        target_component = target.value["emitter"]["component"]
        component = item.value["emitter"]["component"]
        if component != target_component:
            errors.add(
                Issue(
                    code="correction_component_mismatch",
                    line=item.line,
                    item=item.item,
                    path="emitter.component",
                    message=f"This correction comes from emitter.component {show(component)}, "
                    f"but the record it corrects (line {target.line}) comes from "
                    f"{show(target_component)}.",
                    hint="A correction must use the same emitter.component as the corrected "
                    "record (AUDR §3.3).",
                )
            )
            continue
        previous = corrected_by.get(target_id)
        if previous is not None:
            errors.add(
                Issue(
                    code="ambiguous_correction",
                    line=item.line,
                    item=item.item,
                    path="corrects",
                    message=f"Record {show(target_id)} is corrected by more than one record "
                    f"(lines {previous.line} and {item.line}).",
                    hint="Chain corrections: a later correction should correct the previous "
                    "correction, not the original record.",
                )
            )
            continue
        corrected_by[target_id] = item

    in_reported_cycle: set[str] = set()
    for start_id in corrected_by:
        if start_id in in_reported_cycle:
            continue
        seen = {start_id}
        current = corrected_by[start_id].value["record_id"]
        while current in corrected_by:
            if current in seen:
                item = corrected_by[start_id]
                in_reported_cycle.update(seen)
                errors.add(
                    Issue(
                        code="correction_cycle",
                        line=item.line,
                        item=item.item,
                        path="corrects",
                        message="These corrections form a cycle, so no record is final.",
                        hint="Each correction must restate an earlier record.",
                    )
                )
                break
            seen.add(current)
            current = corrected_by[current].value["record_id"]

    if orphans:
        notes.append(
            Issue(
                code="correction_target_missing",
                severity="warning",
                message=f"{len(orphans)} correction(s) restate records that are not in this file; "
                "they are analyzed as ordinary records.",
                lines=_lines(orphans),
            )
        )

    superseded = set(corrected_by)
    effective = [item for item in unique if item.value["record_id"] not in superseded]
    voids = [item for item in effective if is_void(item.value)]
    void_ids = {item.value["record_id"] for item in voids}
    accepted = [item for item in effective if item.value["record_id"] not in void_ids]
    applied = [item for item in corrected_by.values() if item.value["record_id"] not in void_ids]
    if applied:
        notes.append(
            Issue(
                code="corrections_applied",
                severity="info",
                message=f"{len(applied)} correction(s) replaced the records they restate "
                "(AUDR §3.3); only the corrected versions are analyzed.",
                lines=_lines(applied),
            )
        )
    if voids:
        notes.append(
            Issue(
                code="records_voided",
                severity="info",
                message=f"{len(voids)} record(s) were voided by all-zero corrections and are "
                "excluded from analysis.",
                lines=_lines(voids),
            )
        )

    # 3. records that a conforming sink would not rate
    missing_env = [
        item for item in accepted if "environment" not in (item.value.get("attribution") or {})
    ]
    if missing_env:
        notes.append(
            Issue(
                code="environment_missing",
                severity="warning",
                message=f"{len(missing_env)} record(s) have no attribution.environment. AUDR sinks "
                "must ignore such records for rating; they are still shown here.",
                lines=_lines(missing_env),
            )
        )

    # 4. multi-emitter merge keys
    groups: dict[tuple[str, str], list[SourceItem]] = defaultdict(list)
    for item in accepted:
        run = item.value["run"]
        groups[(run["run_id"], run["span_id"])].append(item)
    shared = [group for group in groups.values() if len(group) > 1]
    if shared:
        notes.append(
            Issue(
                code="shared_merge_keys",
                severity="info",
                message=f"{len(shared)} operation(s) are described by more than one record "
                "(same run_id and span_id). Each record is analyzed separately; AUDR sinks "
                "would merge them.",
                lines=_lines([item for group in shared for item in group]),
            )
        )
        same_writer = [
            group
            for group in shared
            if len({item.value["emitter"]["component"] for item in group}) < len(group)
        ]
        if same_writer:
            notes.append(
                Issue(
                    code="merge_key_same_component",
                    severity="warning",
                    message=f"{len(same_writer)} operation(s) have several records from the same "
                    "emitter.component. AUDR allows one writer per block, so these may be "
                    "duplicate emissions.",
                    lines=_lines([item for group in same_writer for item in group]),
                )
            )
        multi_cost = [group for group in shared if sum("cost" in item.value for item in group) > 1]
        if multi_cost:
            notes.append(
                Issue(
                    code="possible_double_count",
                    severity="warning",
                    message=f"Possible double counting: {len(multi_cost)} operation(s) have a cost "
                    "asserted by more than one record. Observed totals include every record's "
                    "cost.",
                    lines=_lines([item for group in multi_cost for item in group]),
                )
            )

    return SinkResult(
        accepted=accepted,
        notes=notes,
        duplicates_dropped=len(duplicates),
        corrections_applied=len(applied),
        voided=len(voids),
    )
