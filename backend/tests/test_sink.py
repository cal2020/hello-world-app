"""AUDR sink rules: deduplication, corrections, voids and merge-key warnings."""

from __future__ import annotations

import copy
import json

from conftest import record, tool_record

from cost_inspector.ingest.issues import IssueList
from cost_inspector.ingest.parse import SourceItem, make_decoder
from cost_inspector.ingest.sink import apply_sink_rules


def items(*records: dict) -> list[SourceItem]:
    decoder = make_decoder()
    return [
        SourceItem(item=n, line=n * 10, value=decoder.decode(json.dumps(r)))
        for n, r in enumerate(records, 1)
    ]


def run(*records: dict):
    errors = IssueList(50)
    result = apply_sink_rules(items(*records), errors)
    return result, errors


def codes(result) -> set[str]:
    return {n.code for n in result.notes}


def test_exact_duplicates_are_dropped_with_a_note() -> None:
    a = record(1)
    result, errors = run(a, copy.deepcopy(a), record(2))
    assert not errors
    assert [i.value["record_id"] for i in result.accepted] == [
        a["record_id"],
        record(2)["record_id"],
    ]
    note = next(n for n in result.notes if n.code == "duplicate_records_dropped")
    assert note.lines == (20,)


def test_reused_record_id_with_different_content_is_an_error() -> None:
    a = record(1)
    b = record(1, usage__llm={"input_tokens": 999})
    _, errors = run(a, b)
    (issue,) = errors.items
    assert issue.code == "conflicting_record_id" and issue.line == 20
    assert "line 10" in issue.message


def test_correction_replaces_the_record_it_restates() -> None:
    original = record(1)
    fixed = record(2, run=original["run"], usage__llm={"input_tokens": 90, "output_tokens": 20})
    fixed["corrects"] = original["record_id"]
    result, errors = run(original, fixed)
    assert not errors
    assert [i.value["record_id"] for i in result.accepted] == [fixed["record_id"]]
    assert "corrections_applied" in codes(result)


def test_correction_chain_keeps_only_the_last_version() -> None:
    a = record(1)
    b = record(2, corrects=a["record_id"])
    c = record(3, corrects=b["record_id"])
    result, errors = run(a, b, c)
    assert not errors
    assert [i.value["record_id"] for i in result.accepted] == [c["record_id"]]


def test_void_correction_removes_both_records() -> None:
    a = record(1)
    void = record(
        2,
        corrects=a["record_id"],
        usage__llm={"input_tokens": 0, "output_tokens": 0, "requests": 0},
    )
    result, errors = run(a, void, record(3))
    assert not errors
    assert [i.value["record_id"] for i in result.accepted] == [record(3)["record_id"]]
    assert result.voided == 1 and "records_voided" in codes(result)


def test_correction_from_another_component_is_rejected() -> None:
    a = record(1)
    b = record(
        2, corrects=a["record_id"], emitter={"component": "harness", "name": "x", "version": "1"}
    )
    _, errors = run(a, b)
    assert errors.items[0].code == "correction_component_mismatch"


def test_two_corrections_of_one_record_are_ambiguous() -> None:
    a = record(1)
    _, errors = run(a, record(2, corrects=a["record_id"]), record(3, corrects=a["record_id"]))
    assert errors.items[0].code == "ambiguous_correction"


def test_correction_cycle_is_reported_once() -> None:
    a = record(1, corrects=record(2)["record_id"])
    b = record(2, corrects=record(1)["record_id"])
    _, errors = run(a, b)
    assert [i.code for i in errors.items] == ["correction_cycle"]


def test_correction_of_missing_record_is_kept_with_a_warning() -> None:
    result, errors = run(record(2, corrects="01KNOTINFILE00000000000000"))
    assert not errors and len(result.accepted) == 1
    assert "correction_target_missing" in codes(result)


def test_missing_environment_is_a_warning_not_an_error() -> None:
    result, errors = run(record(1, attribution={}))
    assert not errors and len(result.accepted) == 1
    note = next(n for n in result.notes if n.code == "environment_missing")
    assert note.severity == "warning" and note.lines == (10,)


def test_shared_merge_keys_warn_about_double_counting() -> None:
    model = record(1)
    model["cost"] = {"total_cost": 0.01, "currency": "USD"}
    provider = record(
        2, run=model["run"], emitter={"component": "provider", "name": "p", "version": "1"}
    )
    provider["cost"] = {"total_cost": 0.01, "currency": "USD"}
    result, errors = run(model, provider)
    assert not errors
    assert {"shared_merge_keys", "possible_double_count"} <= codes(result)


def test_same_component_on_one_merge_key_is_flagged() -> None:
    a = tool_record(1)
    b = tool_record(2, run=a["run"])
    result, _ = run(a, b)
    assert "merge_key_same_component" in codes(result)
