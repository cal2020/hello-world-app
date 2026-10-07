"""AUDR schema validation: conformance suite and actionable messages."""

from __future__ import annotations

import json
from decimal import Decimal

import pytest
from conftest import AUDR_FIXTURES, DELETE, KORA_SAMPLES, record

from cost_inspector.ingest.parse import SourceItem, make_decoder, parse_document
from cost_inspector.ingest.validate import MAX_SAFE_INTEGER, validate_record

CASES = json.loads((AUDR_FIXTURES / "cases.json").read_text())["cases"]


def issues_for(rec: dict, line: int = 7) -> list:
    value = make_decoder().decode(json.dumps(rec))
    return validate_record(SourceItem(item=1, line=line, value=value))


@pytest.mark.parametrize("case", CASES, ids=[c["file"] for c in CASES])
def test_official_conformance_case(case: dict) -> None:
    raw = (AUDR_FIXTURES / "conformance" / case["file"]).read_text()
    value = make_decoder().decode(raw)
    issues = validate_record(SourceItem(item=1, line=1, value=value))
    assert ("invalid" if issues else "valid") == case["expect"], [i.message for i in issues]


def test_conformance_suite_size_matches_upstream_runner() -> None:
    assert len(CASES) == 38


@pytest.mark.parametrize("name", ["simple", "multi_step", "inefficient_agent"])
def test_kora_samples_are_valid_audr(name: str) -> None:
    result = parse_document(
        (KORA_SAMPLES / f"{name}.jsonl").read_bytes(), max_records=100, max_issues=10
    )
    assert all(not validate_record(item) for item in result.items)


def test_messages_name_line_field_and_fix() -> None:
    rec = record(1, resource__modality=DELETE)
    (issue,) = issues_for(rec, line=12)
    assert issue.line == 12 and issue.path == "resource.modality"
    assert 'because resource.operation is "generation"' in issue.message
    assert issue.hint and "modality" in issue.hint


def test_bad_currency_hint() -> None:
    rec = record(1)
    rec["cost"] = {"total_cost": 0.1, "currency": "usd"}
    (issue,) = issues_for(rec)
    assert issue.path == "cost.currency" and "ISO 4217" in (issue.hint or "")


def test_negative_counter() -> None:
    rec = record(1, usage__llm={"input_tokens": -5})
    (issue,) = issues_for(rec)
    assert issue.message == "`usage.llm.input_tokens` must be at least 0 (found -5)."


def test_unexpected_fields_are_listed() -> None:
    rec = record(1)
    rec["prompt"] = "secret text"
    (issue,) = issues_for(rec)
    assert "`prompt`" in issue.message and "closed" in (issue.hint or "")


def test_cross_field_cost_block() -> None:
    rec = record(1)
    rec["cost"] = {"total_cost": 0.1, "currency": "USD", "tool": {"call_cost": 0.1}}
    (issue,) = issues_for(rec)
    assert issue.path == "cost.tool" and "must not be present" in issue.message


def test_unsupported_major_version() -> None:
    (issue,) = issues_for(record(1, spec_version="2.0.0"))
    assert "Unsupported AUDR version" in issue.message


def test_production_requires_account() -> None:
    (issue,) = issues_for(record(1, attribution={"environment": "production"}))
    assert issue.path == "attribution.account_id"
    assert 'because attribution.environment is "production"' in issue.message


def test_all_errors_in_a_record_are_reported() -> None:
    rec = record(1, run={"span_id": "s"}, timing={"event_time": "yesterday"})
    paths = {i.path for i in issues_for(rec)}
    assert {"run.run_id", "timing.event_time"} <= paths


def test_integral_decimal_counts_as_integer() -> None:
    rec = record(1)
    value = make_decoder().decode(
        json.dumps(rec).replace('"input_tokens": 100', '"input_tokens": 100.0')
    )
    assert value["usage"]["llm"]["input_tokens"] == Decimal("100.0")
    assert not validate_record(SourceItem(1, 1, value))


def test_values_beyond_safe_integer_range_are_rejected() -> None:
    rec = record(1, usage__llm={"input_tokens": MAX_SAFE_INTEGER + 1})
    (issue,) = issues_for(rec)
    assert issue.code == "value_too_large" and issue.path == "usage.llm.input_tokens"
