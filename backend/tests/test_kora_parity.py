"""Imported files reproduce the KORA Doctor CLI's findings exactly."""

from __future__ import annotations

import json
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from conftest import AUDR_FIXTURES, DEMO_DIR, KORA_SAMPLES, upload_file

from cost_inspector.analysis import kora
from cost_inspector.ingest.issues import IssueList
from cost_inspector.ingest.normalize import normalize_items
from cost_inspector.ingest.parse import parse_document

PARITY_FILES = [
    KORA_SAMPLES / "simple.jsonl",
    KORA_SAMPLES / "multi_step.jsonl",
    KORA_SAMPLES / "inefficient_agent.jsonl",
    AUDR_FIXTURES / "multi-emitter-run.jsonl",
    *sorted(DEMO_DIR.glob("*.jsonl")),
]


def cli_json(path: Path) -> dict:
    result = subprocess.run(
        [sys.executable, "-m", "kora_doctor", "audit", str(path), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    data: dict = json.loads(result.stdout)
    return data


def money_map(spend_list: list[dict]) -> dict[str, Decimal]:
    return {m["currency"]: Decimal(m["amount"]) for m in spend_list}


@pytest.mark.parametrize("path", PARITY_FILES, ids=[p.name for p in PARITY_FILES])
def test_findings_match_cli(client, path: Path) -> None:
    expected = cli_json(path)
    detail = upload_file(client, path)
    stored = sorted(detail["findings"], key=lambda f: f["ordinal"])

    assert [
        (
            f["category"],
            f["title"],
            f["rationale"],
            f["confidence"],
            [a["record_id"] for a in f["affected"]],
            f["run_ids"],
            float(f["scenario"]["ratio"]),
        )
        for f in stored
    ] == [
        (
            f["category"],
            f["title"],
            f["reason"],
            f["confidence"],
            f["record_ids"],
            f["run_ids"],
            f["saving_ratio"],
        )
        for f in expected["findings"]
    ]
    assert detail["category_counts"] == expected["category_counts"]

    # Exact Decimal totals agree with the analyzer's float totals to float precision.
    ours = money_map(detail["spend"]["by_currency"])
    assert set(ours) == set(expected["observed_costs"])
    for currency, value in expected["observed_costs"].items():
        assert abs(float(ours[currency]) - value) < 1e-12
    estimate = money_map(detail["scenario"]["all"]["estimate"])
    for currency, value in expected["potential_savings"].items():
        assert abs(float(estimate.get(currency, Decimal(0))) - value) < 1e-12


@pytest.mark.parametrize("path", PARITY_FILES, ids=[p.name for p in PARITY_FILES])
def test_every_finding_has_derived_evidence_and_documented_ratio(client, path: Path) -> None:
    detail = upload_file(client, path)
    for finding in detail["findings"]:
        assert finding["evidence_status"] == "derived", finding["title"]
        assert finding["evidence"]["proof"] is False
        assert Decimal(finding["scenario"]["ratio"]) == kora.SCENARIO_RATIOS[finding["category"]]


@pytest.mark.parametrize("path", PARITY_FILES, ids=[p.name for p in PARITY_FILES])
def test_rebuilt_records_analyze_like_the_original_file(path: Path) -> None:
    """Stored telemetry alone reproduces the analysis (needed for run deletion)."""
    original = cli_json(path)
    parsed = parse_document(path.read_bytes(), max_records=1000, max_issues=10)
    calls = normalize_items(parsed.items, IssueList(10), "imp_parity")
    rebuilt = kora.run_analysis(calls)
    assert [
        (f.category, f.title, f.reason, f.confidence, f.record_ids, f.run_ids)
        for f in rebuilt.findings
    ] == [
        (f["category"], f["title"], f["reason"], f["confidence"], f["record_ids"], f["run_ids"])
        for f in original["findings"]
    ]
    assert rebuilt.kora_observed_costs == original["observed_costs"]


def test_analyzer_is_the_pinned_upstream_release() -> None:
    import kora_doctor

    assert kora_doctor.__version__ == "0.1.0"
    assert kora.PINNED_REVISION == "7c54af8f1ddf891bfd05125fd1c345186c9cd62a"
    assert kora._SIGNATURE_OK
