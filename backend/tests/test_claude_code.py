"""Claude Code transcripts: converted to AUDR, priced at list prices, labeled as estimates."""

from __future__ import annotations

import json
import uuid
from decimal import Decimal
from typing import Any

import pytest
from conftest import FIXTURES, jsonl, record, upload, upload_file, with_cost

from cost_inspector.ingest import claude_code
from cost_inspector.ingest.issues import IssueList

TRANSCRIPT = FIXTURES / "claude-code" / "session.jsonl"
SESSION = "5b0c2a6e-3f1d-4e8a-9c7b-1a2b3c4d5e6f"
OTHER_SESSION = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"
USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
    "output_tokens_details",
    "server_tool_use",
    "service_tier",
    "speed",
    "inference_geo",
)


def convert(
    data: bytes, max_records: int = 10_000
) -> tuple[claude_code.Conversion | None, IssueList]:
    errors = IssueList(50)
    return claude_code.convert(data, max_records=max_records, errors=errors), errors


def records(data: bytes) -> list[dict[str, Any]]:
    converted, errors = convert(data)
    assert converted is not None, [e.message for e in errors.items]
    return [json.loads(line, parse_float=Decimal) for line in converted.data.decode().splitlines()]


def usage_only(data: bytes) -> bytes:
    """What the web app uploads: the entries the converter reads, without message content."""
    out = []
    for line in data.decode().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        kind = entry.get("type")
        if kind == "assistant":
            message = entry["message"]
            entry = {
                k: entry[k]
                for k in (
                    "type",
                    "sessionId",
                    "requestId",
                    "timestamp",
                    "isSidechain",
                    "agentId",
                    "version",
                    "effort",
                )
                if k in entry
            }
            entry["message"] = {
                "id": message.get("id"),
                "model": message.get("model"),
                "usage": {k: v for k, v in message["usage"].items() if k in USAGE_KEYS},
            }
        elif kind not in ("ai-title", "custom-title", "cost-state"):
            continue
        elif kind == "cost-state":
            entry = {
                "type": kind,
                "sessionId": entry["sessionId"],
                "totalCostUSD": entry["totalCostUSD"],
            }
        out.append(json.dumps(entry))
    return ("\n".join(out) + "\n").encode()


def test_transcripts_are_told_apart_from_audr() -> None:
    assert claude_code.looks_like_transcript(TRANSCRIPT.read_bytes())
    assert claude_code.looks_like_transcript(usage_only(TRANSCRIPT.read_bytes()))
    assert not claude_code.looks_like_transcript((FIXTURES / "known_costs.jsonl").read_bytes())
    pretty = json.dumps(record(1), indent=2).encode()
    assert not claude_code.looks_like_transcript(pretty)
    assert not claude_code.looks_like_transcript(b"[" + json.dumps(record(1)).encode() + b"]")
    assert not claude_code.looks_like_transcript(b"not json at all")


def test_one_record_per_api_request_in_time_order() -> None:
    out = records(TRANSCRIPT.read_bytes())
    spans = [(r["run"]["run_id"], r["run"]["step"], r["run"]["span_id"]) for r in out]
    assert spans == [
        (SESSION, 1, "req_test_A"),  # logged twice (one entry per content block)
        (SESSION, 2, "req_test_B"),
        (SESSION, 2, "req_test_B:web_search"),
        (SESSION, 3, "req_test_C"),  # the <synthetic> error message before it is not a call
        (SESSION, 4, "req_test_D"),
        (SESSION, 5, "req_test_E"),
        (SESSION, 6, "req_test_F"),
        (OTHER_SESSION, 1, "req_test_G"),
    ]
    assert {r["run"]["name"] for r in out if r["run"]["run_id"] == SESSION} == {"Billing refactor"}
    assert out[-1]["run"]["name"] == "Claude Code session 7 Oct 2026 12:05 UTC"
    for r in out:
        rid = uuid.UUID(r["record_id"])
        assert rid.version == 7 and str(rid) == r["record_id"]
    assert records(TRANSCRIPT.read_bytes()) == out  # deterministic


def test_tokens_follow_audr_and_costs_are_list_price_estimates() -> None:
    by_span = {r["run"]["span_id"]: r for r in records(TRANSCRIPT.read_bytes())}
    a = by_span["req_test_A"]
    assert a["usage"]["llm"] == {
        "input_tokens": 3,
        "output_tokens": 380,  # 500 reported, of which 120 were thinking
        "reasoning_tokens": 120,
        "cache_read_tokens": 40000,
        "cache_write_tokens": 2000,
        "requests": 1,
    }
    assert a["cost"] == {
        "total_cost": Decimal("0.034012"),
        "currency": "USD",
        "llm": {
            "total_token_cost": Decimal("0.034012"),
            "input_token_cost": Decimal("0.000012"),
            "output_token_cost": Decimal("0.0076"),
            "cache_read_cost": Decimal("0.008"),
            "cache_write_cost": Decimal("0.016"),
            "reasoning_cost": Decimal("0.0024"),
        },
    }
    assert a["attribution"] == {
        "environment": "development",
        "labels": {
            "source": "claude-code",
            "thread": "main",
            "cost_basis": "list_price_estimate",
            "price_list": "anthropic-2026-10-09",
            "claude_code_version": "2.1.296",
            "effort": "high",
        },
    }
    totals = {span: r.get("cost", {}).get("total_cost") for span, r in by_span.items()}
    assert totals == {
        "req_test_A": Decimal("0.034012"),
        "req_test_B": Decimal("0.0025"),  # Haiku 4.5; cache writes without a duration: 5 minutes
        "req_test_B:web_search": Decimal("0.02"),
        "req_test_C": Decimal("0.026488"),  # fast mode, US-only inference
        "req_test_D": Decimal("0.0066"),  # Sonnet 5.5 subagent
        "req_test_E": None,  # a Bedrock model ID: no first-party list price
        "req_test_F": Decimal("0.011"),  # Haiku 5.5, prompt over 100k tokens
        "req_test_G": Decimal("0.00175"),
    }
    assert by_span["req_test_C"]["resource"]["region"] == "us"
    assert by_span["req_test_C"]["attribution"]["labels"]["speed"] == "fast"
    assert by_span["req_test_D"]["attribution"]["labels"]["thread"] == "subagent"
    assert by_span["req_test_D"]["attribution"]["labels"]["agent_id"] == "a1b2c3d4"
    assert "cost_basis" not in by_span["req_test_E"]["attribution"]["labels"]
    search = by_span["req_test_B:web_search"]
    assert search["run"]["parent_span_id"] == "req_test_B"
    assert search["usage"] == {"tool": {"type": "web_search", "call_count": 2}}


def test_notes_explain_the_estimate_and_cross_check_claude_codes_own_figure() -> None:
    converted, _ = convert(TRANSCRIPT.read_bytes())
    assert converted is not None
    notes = {n.code: n for n in converted.notes}
    assert list(notes) == [
        "claude_code_transcript",
        "estimated_cost",
        "claude_code_cost",
        "analyzer_fit",
        "unpriced_models",
        "assumed_cache_duration",
        "fast_mode",
        "web_searches",
        "unreadable_lines",
    ]
    assert "7 API calls in 2 sessions" in notes["claude_code_transcript"].message
    # A, B (with its searches) and C were logged before Claude Code saved its figure.
    assert notes["claude_code_cost"].message.startswith(
        "Claude Code's own cost figure for the one session that records it, saved after 3 of "
        "its 6 calls, is $0.07; this estimate for the same calls is $0.08."
    )
    assert "us.anthropic.claude-sonnet-4-5-20250929-v1:0" in notes["unpriced_models"].message
    assert notes["unreadable_lines"].lines == (15,)


def test_message_content_never_reaches_the_records() -> None:
    converted, _ = convert(TRANSCRIPT.read_bytes())
    assert converted is not None
    text = converted.data.decode()
    for secret in ("SECRET-PROMPT-TEXT", "SECRET-REPLY-TEXT", "SECRET-COMMAND", "/home/dev"):
        assert secret not in text


def test_usage_only_copy_converts_to_the_same_records() -> None:
    full, _ = convert(TRANSCRIPT.read_bytes())
    lean, _ = convert(usage_only(TRANSCRIPT.read_bytes()))
    assert full is not None and lean is not None
    assert lean.data == full.data


def test_transcript_without_api_calls_is_rejected() -> None:
    data = b'{"type":"user","sessionId":"' + SESSION.encode() + b'","message":{"content":"hi"}}\n'
    converted, errors = convert(data)
    assert converted is None and [e.code for e in errors.items] == ["no_api_calls"]


def test_too_many_calls_are_rejected_before_analysis() -> None:
    converted, errors = convert(TRANSCRIPT.read_bytes(), max_records=3)
    assert converted is None
    assert errors.items[0].code == "too_many_records"
    assert "7 API calls" in errors.items[0].message


def test_api_imports_a_transcript_with_estimated_costs(client) -> None:
    detail = upload_file(client, TRANSCRIPT)
    assert detail["format"] == "claude-code"
    spend = detail["spend"]
    assert spend["by_currency"] == [{"currency": "USD", "amount": "0.10235"}]
    assert (spend["known_calls"], spend["estimated_calls"], spend["unknown_calls"]) == (7, 7, 1)
    assert spend["basis"] == "estimated"
    assert [n["code"] for n in detail["notes"]][:3] == [
        "claude_code_transcript",
        "estimated_cost",
        "claude_code_cost",
    ]
    names = sorted(run["display_name"] for run in detail["runs"])
    assert names == ["Billing refactor", "Claude Code session 7 Oct 2026 12:05 UTC"]


def test_same_session_imports_once_whatever_copy_is_uploaded(client) -> None:
    detail = upload_file(client, TRANSCRIPT)
    response = upload(client, usage_only(TRANSCRIPT.read_bytes()), "usage.jsonl")
    assert response.status_code == 409
    assert response.json()["error"]["import_id"] == detail["id"]


def test_rejected_transcript_explains_why(client) -> None:
    response = upload(client, b'{"type":"user","sessionId":"' + SESSION.encode() + b'"}\n')
    assert response.status_code == 422
    body = response.json()
    assert [i["code"] for i in body["error"]["issues"]] == ["no_api_calls"]


def test_reports_label_costs_as_estimates(client) -> None:
    detail = upload_file(client, TRANSCRIPT)
    html = client.get(f"/api/imports/{detail['id']}/report?format=html").text
    assert "Estimated spending" in html and "Observed spending" not in html
    assert "Estimated cost</th>" in html
    report = client.get(f"/api/imports/{detail['id']}/report?format=json").json()
    assert any("list prices" in line for line in report["how_to_read"])


def compare(client, baseline: str, candidate: str) -> dict[str, Any]:
    response = client.get(
        "/api/compare",
        params={"baseline": baseline, "candidate": candidate, "equivalence": "equivalent"},
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def test_estimates_compare_only_with_estimates(client) -> None:
    transcript = upload_file(client, TRANSCRIPT)
    by_name = {run["display_name"]: run["id"] for run in transcript["runs"]}
    reported = upload(client, jsonl([with_cost(record(1), "0.5")]))
    assert reported.status_code == 201
    reported_run = reported.json()["runs"][0]["id"]

    mixed = compare(client, reported_run, by_name["Claude Code session 7 Oct 2026 12:05 UTC"])
    assert mixed["kind"] == "not_comparable"
    assert any("list-price estimates" in r for r in mixed["scopes"][0]["reasons"])

    session = by_name["Billing refactor"]
    other = by_name["Claude Code session 7 Oct 2026 12:05 UTC"]
    both = compare(client, other, session)
    # The busy session has a call with unknown cost, so only priced scopes could compare.
    assert all("list-price estimates" not in r for s in both["scopes"] for r in s["reasons"])


@pytest.mark.parametrize("line", [b"", b"\n", b"   \n"])
def test_blank_input_is_not_a_transcript(line: bytes) -> None:
    assert not claude_code.looks_like_transcript(line)
