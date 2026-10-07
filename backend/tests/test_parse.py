"""Bounded decoding and line-specific parse errors."""

from __future__ import annotations

import json
from decimal import Decimal

from conftest import KORA_SAMPLES, record

from cost_inspector.ingest.parse import DocumentFormat, parse_document


def parse(data: bytes | str, max_records: int = 1000):
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return parse_document(raw, max_records=max_records, max_issues=50)


def test_jsonl_keeps_line_numbers_and_skips_blank_lines() -> None:
    text = json.dumps(record(1)) + "\n\n" + json.dumps(record(2)) + "\n"
    result = parse(text)
    assert result.format is DocumentFormat.JSONL
    assert [(i.item, i.line) for i in result.items] == [(1, 1), (2, 3)]
    assert result.record_count == 2
    assert not result.issues


def test_crlf_and_bom_are_accepted() -> None:
    text = "﻿" + json.dumps(record(1)) + "\r\n" + json.dumps(record(2)) + "\r\n"
    result = parse(text)
    assert len(result.items) == 2 and not result.issues


def test_pretty_printed_array_reports_each_item_start_line() -> None:
    text = json.dumps([record(1), record(2)], indent=2)
    result = parse(text)
    assert result.format is DocumentFormat.JSON_ARRAY
    starts = [n for n, line in enumerate(text.splitlines(), 1) if line == "  {"]
    assert len(starts) == 2 and starts[1] > 2
    assert [i.line for i in result.items] == starts


def test_single_pretty_object() -> None:
    result = parse(json.dumps(record(1), indent=2))
    assert result.format is DocumentFormat.JSON_OBJECT
    assert result.items[0].line == 1


def test_floats_parse_as_decimal() -> None:
    text = json.dumps(record(1)).replace('"requests": 1', '"requests": 1') + "\n"
    rec = json.loads(text)
    rec["cost"] = {"total_cost": 0.1, "currency": "USD"}
    result = parse(json.dumps(rec))
    assert result.items[0].value["cost"]["total_cost"] == Decimal("0.1")


def test_invalid_jsonl_line_is_reported_with_line_and_column() -> None:
    text = json.dumps(record(1)) + "\n" + '{"spec_version": "1.0.0",\n' + json.dumps(record(3))
    result = parse(text)
    assert [i.line for i in result.items] == [1, 3]
    (issue,) = result.issues.items
    assert issue.code == "json_syntax" and issue.line == 2 and issue.column is not None
    assert "Invalid JSON" in issue.message and issue.hint


def test_upstream_malformed_fixture() -> None:
    result = parse((KORA_SAMPLES / "malformed.jsonl").read_bytes())
    (issue,) = result.issues.items
    assert (issue.line, issue.code) == (1, "json_syntax")


def test_non_object_lines_and_values_are_rejected() -> None:
    result = parse('[1, {"a": 1}]')
    assert result.issues.items[0].code == "not_a_record" and result.issues.items[0].item == 1
    result = parse('{"a": 1}\n42\n')
    assert result.issues.items[0].line == 2
    result = parse("42")
    assert result.issues.items[0].code == "not_a_record"


def test_empty_inputs() -> None:
    for data in ("", "   \n\n", "[]"):
        result = parse(data)
        assert result.issues.items[0].code == "empty", data
        assert not result.items


def test_invalid_utf8_names_the_line() -> None:
    data = json.dumps(record(1)).encode() + b"\n" + b'{"bad": "\xff"}\n'
    result = parse(data)
    (issue,) = result.issues.items
    assert issue.code == "encoding" and issue.line == 2


def test_nan_and_infinity_are_rejected_with_line() -> None:
    good = json.dumps(record(1))
    result = parse(good + "\n" + good.replace('"duration_ms": 500', '"duration_ms": NaN'))
    (issue,) = result.issues.items
    assert issue.code == "non_finite_number" and issue.line == 2
    result = parse("[" + good.replace('"duration_ms": 500', '"duration_ms": -Infinity') + "]")
    assert result.issues.items[0].code == "non_finite_number"


def test_record_limit_is_enforced_before_parsing() -> None:
    text = "\n".join(json.dumps(record(i)) for i in range(1, 6))
    result = parse(text, max_records=4)
    assert result.issues.items[0].code == "too_many_records" and not result.items
    assert result.record_count == 5
    result = parse(json.dumps([record(i) for i in range(1, 6)]), max_records=4)
    assert result.issues.items[0].code == "too_many_records"


def test_broken_pretty_object_reports_one_error_at_the_real_position() -> None:
    text = json.dumps(record(1), indent=2).replace('"step": 1', '"step": 1,,')
    result = parse(text)
    (issue,) = result.issues.items
    assert issue.code == "json_syntax"
    assert issue.line == next(i for i, ln in enumerate(text.splitlines(), 1) if ",," in ln)


def test_line_separator_inside_a_string_does_not_split_a_jsonl_line() -> None:
    rec = record(1, attribution__labels={"note": "a b"})
    text = json.dumps(rec, ensure_ascii=False) + "\n" + json.dumps(record(2))
    result = parse(text)
    assert len(result.items) == 2 and not result.issues


def test_deep_nesting_is_reported_not_raised() -> None:
    result = parse("[" * 100_000 + "]" * 100_000)
    assert result.issues and not result.items
