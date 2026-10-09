"""Verdict parsing: strict Boolean validity, reference extraction behaviour, and parity with the release."""

from __future__ import annotations

import json

import pytest

from agenthorizon.judging.parsing import (
    extract_agentic_reference,
    parse_agentic,
    parse_direct,
    parse_direct_reference,
    reference_attempt_succeeded,
)

FULL_FALSE = {"success": False, "reasoning": "Wrong file exported.", "confidence": "high",
              "mistake_type": "Misunderstanding of the Instruction"}


@pytest.mark.parametrize("text,binary_valid,success", [
    ('{"success": true, "reasoning": "ok", "confidence": "high", "mistake_type": null}', True, True),
    (json.dumps(FULL_FALSE), True, False),
    ('{"reasoning": "no verdict"}', False, None),
    ('{"success": null}', False, None),
    ('{"success": "false"}', False, None),
    ('{"success": "true"}', False, None),
    ('{"success": 0}', False, None),
    ('{"success": 1}', False, None),
    ('{"success": [false]}', False, None),
    ("not json at all", False, None),
    ('{"success": false, "reasoning": "trunc', False, None),  # incomplete stream
])
def test_binary_validity_is_strict(text, binary_valid, success):
    v = parse_agentic(text)
    assert v.binary_valid is binary_valid
    assert v.success is success


def test_string_false_is_never_coerced():
    v = parse_agentic('{"success": "false", "reasoning": "x", "confidence": "high", "mistake_type": "Critical Mistake"}')
    assert v.has_success_key and not v.binary_valid and v.success is None
    assert "success_not_boolean:str" in v.problems


def test_fenced_and_prose_outputs():
    fenced = "```json\n" + json.dumps(FULL_FALSE) + "\n```"
    prose = "After reviewing the screenshots:\n```json\n" + json.dumps(FULL_FALSE) + "\n```\nDone."
    assert parse_agentic(fenced).success is False
    assert parse_direct(fenced).success is False
    assert parse_agentic(prose).success is False
    # the released direct parser only accepts whole-text JSON (one fence stripped)
    assert parse_direct(prose).binary_valid is False


def test_multiple_objects_follow_reference_and_flag_conflict():
    text = '{"success": true, "reasoning": "first"} then on reflection {"success": false, "reasoning": "second"}'
    v = parse_agentic(text)
    assert v.success is False  # reference: last object carrying "success" wins
    assert v.diagnostics["conflicting"] is True and v.diagnostics["objects_with_success"] == 2


def test_full_contract_validity_is_separate_from_binary():
    v = parse_agentic('{"success": true, "reasoning": "fine", "confidence": "certain", "mistake_type": null}')
    assert v.binary_valid and not v.full_contract_valid
    v = parse_agentic('{"success": true, "reasoning": "fine", "confidence": "high", "mistake_type": "Critical Mistake"}')
    assert v.binary_valid and not v.full_contract_valid and "mistake_type_on_success" in v.problems
    v = parse_agentic('{"success": false, "reasoning": "bad", "confidence": "low", "mistake_type": null}')
    assert v.binary_valid and not v.full_contract_valid
    v = parse_agentic('{"success": false, "reasoning": "bad", "confidence": "low", "mistake_type": "Misunderstanding of the Instructions"}')
    assert v.full_contract_valid and v.mistake_type_category == "misunderstanding_of_the_instruction"
    assert v.mistake_type_native == "Misunderstanding of the Instructions"  # native spelling preserved


def test_low_confidence_does_not_determine_verdict():
    v = parse_agentic('{"success": true, "reasoning": "unsure", "confidence": "low", "mistake_type": null}')
    assert v.success is True


def test_retry_stop_rule_matches_reference():
    assert reference_attempt_succeeded({"success": "maybe"})  # any success key stops retries
    assert not reference_attempt_succeeded({"raw_response": "..."})
    assert not reference_attempt_succeeded(None)


CORPUS = [
    "", "   ", "{}", "[]", "true", '{"success": true}', '{"success": false}', "```\n{\"success\": true}\n```",
    "```json\n{\"success\": true}```", 'text {"a": 1} more {"success": false} end', '{"a": {"b": {"success": true}}}',
    '{"success": true} {"success": false}', '{"success": tru', "```json\n{bad json}\n```\n{\"success\": false}",
    'prefix ```json\n{"success": true}\n``` and ```json\n{"success": false}\n```', '{"x": "}"} {"success": true}',
    '{"success": "false"}', "\n\n{\"success\": false, \"reasoning\": \"a\\nb\"}\n\n", "{{{", "}}}{", '{"success": null}',
]


@pytest.mark.reference
def test_agentic_extractor_matches_released_function(reference_checkout):
    from conftest import load_reference_functions

    ref = load_reference_functions(reference_checkout / "scripts" / "evaluate_trajectories.py",
                                   ["_extract_balanced_objects", "_extract_verdict_from_response"])
    for text in CORPUS:
        assert extract_agentic_reference(text) == ref._extract_verdict_from_response(text), text


@pytest.mark.reference
def test_direct_parser_matches_released_function(reference_checkout):
    from conftest import load_reference_functions

    ref = load_reference_functions(reference_checkout / "llm_judges" / "utils.py", ["parse_judge_response"])
    for text in CORPUS:
        assert parse_direct_reference(text) == ref.parse_judge_response(text), text
