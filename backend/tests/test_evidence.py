"""Each finding exposes the right records and the heuristic evidence that produced it."""

from __future__ import annotations

from types import SimpleNamespace

from conftest import KORA_SAMPLES, full_findings, upload_file

from cost_inspector.analysis import kora
from cost_inspector.ingest.normalize import to_kora_record

INEFFICIENT = KORA_SAMPLES / "inefficient_agent.jsonl"
R = "01KD20000000000000000000"  # record_id prefix in the upstream sample


def findings_by(detail: dict, category: str) -> list[dict]:
    return [f for f in detail["full"] if f["category"] == category]


def test_repeated_call_evidence_includes_the_unflagged_reference_call(client) -> None:
    detail = upload_file(client, INEFFICIENT)
    detail["full"] = full_findings(client, detail)
    finding = next(
        f
        for f in findings_by(detail, kora.DUPLICATE)
        if [a["record_id"] for a in f["affected"]] == [f"{R}02", f"{R}03"]
    )
    evidence = finding["evidence"]
    assert evidence["reference_record_id"] == f"{R}01"
    assert [(m["record_id"], m["role"]) for m in evidence["members"]] == [
        (f"{R}01", "reference"),
        (f"{R}02", "candidate"),
        (f"{R}03", "candidate"),
    ]
    assert {s["field"]: s["value"] for s in evidence["signature"]} == {
        "resource.provider": "anthropic",
        "resource.type": "model",
        "resource.name": "claude-sonnet-4-20250514",
        "resource.operation": "generation",
        "resource.modality": "text",
        "usage.llm.input_tokens": 800,
        "usage.llm.output_tokens": 80,
        "usage.llm.reasoning_tokens": None,
        "usage.llm.cache_read_tokens": None,
        "usage.llm.requests": 1,
    }
    # Evidence links to the stored calls the UI can open.
    run = client.get(f"/api/runs/{finding['run_pks'][0]}").json()
    call_ids = {c["record_id"]: c["id"] for c in run["calls"]}
    assert evidence["reference_call_id"] == call_ids[f"{R}01"]
    assert [a["call_id"] for a in finding["affected"]] == [call_ids[f"{R}02"], call_ids[f"{R}03"]]


def test_cross_run_reuse_evidence_spans_runs(client) -> None:
    detail = upload_file(client, INEFFICIENT)
    detail["full"] = full_findings(client, detail)
    finding = next(f for f in findings_by(detail, kora.CACHE) if len(f["affected"]) == 3)
    assert finding["evidence"]["scope"] == "import"
    assert finding["evidence"]["run_ids"] == ["run-inefficient-001", "run-inefficient-002"]
    assert finding["evidence"]["reference_record_id"] == f"{R}01"


def test_deterministic_evidence_points_at_the_matching_text(client) -> None:
    detail = upload_file(client, INEFFICIENT)
    detail["full"] = full_findings(client, detail)
    finding = next(
        f
        for f in findings_by(detail, kora.DETERMINISTIC)
        if f["affected"][0]["record_id"] == f"{R}01"
    )
    evidence = finding["evidence"]
    assert evidence["keyword"] == "classif"
    match = next(m for m in evidence["matches"] if m["field"] == "run.name")
    assert match["value"][match["start"] : match["end"]].lower() == "classif"
    assert "'classif'" in finding["rationale"]


def test_smaller_model_evidence_shows_pattern_and_token_count(client) -> None:
    detail = upload_file(client, INEFFICIENT)
    detail["full"] = full_findings(client, detail)
    finding = next(
        f for f in findings_by(detail, kora.SMALLER) if f["affected"][0]["record_id"] == f"{R}01"
    )
    evidence = finding["evidence"]
    assert evidence["matched_pattern"] == r"claude[-_ ].*(?:opus|sonnet)"
    assert evidence["token_total"] == 880 and evidence["token_limit"] == 2500
    assert evidence["counted"] == {
        "input_tokens": 800,
        "output_tokens": 80,
        "reasoning_tokens": None,
    }


def test_orchestration_evidence_lists_the_ordered_sequence(client) -> None:
    detail = upload_file(client, INEFFICIENT)
    detail["full"] = full_findings(client, detail)
    (finding,) = findings_by(detail, kora.ORCHESTRATION)
    sequence = finding["evidence"]["sequence"]
    assert len(sequence) == 9
    assert [s["flagged"] for s in sequence] == [False] * 4 + [True] * 5
    assert [a["record_id"] for a in finding["affected"]] == [
        s["record_id"] for s in sequence if s["flagged"]
    ]


def test_evidence_is_withheld_when_rederivation_disagrees() -> None:
    record = to_kora_record_stub()
    finding = SimpleNamespace(
        category=kora.DUPLICATE,
        record_ids=["01KWRONG00000001"],
        run_ids=["run-x-0001"],
        reason="",
        confidence="medium",
    )
    assert kora._derive_duplicate(finding, kora._Index.build([record])) is None


def to_kora_record_stub() -> dict:
    from conftest import record

    from cost_inspector.ingest.issues import IssueList
    from cost_inspector.ingest.normalize import normalize_items
    from cost_inspector.ingest.parse import SourceItem

    rec = record(1)
    rec["record_id"] = "01KWRONG00000001"
    rec["run"]["run_id"] = "run-x-0001"
    (call,) = normalize_items([SourceItem(1, 1, rec)], IssueList(5), "imp_x")
    return to_kora_record(call)
