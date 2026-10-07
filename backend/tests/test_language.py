"""Findings never describe equal token counts as proof of identical prompts, and
comparisons never claim output quality was preserved."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from conftest import AUDR_FIXTURES, DEMO_DIR, KORA_SAMPLES, upload_file

from cost_inspector.analysis import catalog

AFFIRMATIVE_PROMPT_CLAIM = re.compile(
    r"\b(identical|same|duplicated?|matching|equal)\s+(prompts?|inputs?|requests?|content)\b",
    re.IGNORECASE,
)
QUALITY_CLAIM = re.compile(
    r"\b(same|equal|equivalent|preserved|maintained|unchanged|no loss of)\s+(output\s+)?quality\b"
    r"|\bquality\s+(is|was)\s+(preserved|maintained|unchanged|the same)\b",
    re.IGNORECASE,
)
FILES = [
    KORA_SAMPLES / "inefficient_agent.jsonl",
    KORA_SAMPLES / "multi_step.jsonl",
    AUDR_FIXTURES / "multi-emitter-run.jsonl",
    *sorted(DEMO_DIR.glob("*.jsonl")),
]
FRONTEND_SRC = Path(__file__).parents[2] / "frontend" / "src"


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


@pytest.mark.parametrize("path", FILES, ids=[p.name for p in FILES])
def test_no_finding_text_claims_identical_prompts(client, path: Path) -> None:
    detail = upload_file(client, path)
    for finding in detail["findings"]:
        for text in strings(finding):
            assert not AFFIRMATIVE_PROMPT_CLAIM.search(text), text
        if finding["category"] in ("duplicate_repeated", "cache_reuse"):
            evidence = finding["evidence"]
            assert evidence["proof"] is False
            assert "cannot show" in evidence["statement"]
            assert any("Prompt and response content" in n for n in evidence["not_compared"])


def test_catalog_text_makes_no_prompt_or_quality_claims() -> None:
    for text in strings(catalog.CATEGORY_INFO) + strings(catalog.GLOSSARY):
        assert not AFFIRMATIVE_PROMPT_CLAIM.search(text), text
        assert not QUALITY_CLAIM.search(text), text


def test_comparison_makes_no_quality_claim(client) -> None:
    demo = client.post("/api/demo").json()["suggested_comparison"]
    for equivalence in ("equivalent", "not_equivalent", "unsure"):
        result = client.get(
            "/api/compare",
            params={
                "baseline": demo["baseline_run_id"],
                "candidate": demo["candidate_run_id"],
                "equivalence": equivalence,
            },
        ).json()
        assert result["quality"]["measured"] is False
        for text in strings(result):
            assert not QUALITY_CLAIM.search(text), text


@pytest.mark.skipif(not FRONTEND_SRC.is_dir(), reason="frontend not present")
def test_frontend_copy_makes_no_prompt_or_quality_claims() -> None:
    for path in FRONTEND_SRC.rglob("*.ts*"):
        if ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in (AFFIRMATIVE_PROMPT_CLAIM, QUALITY_CLAIM):
            match = pattern.search(text)
            assert match is None, f"{path}: {match.group(0) if match else ''}"
