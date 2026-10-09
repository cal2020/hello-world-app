"""Plain-language rules, labels and limitations for each finding category.

Rule text is written from the analyzer source at the pinned revision; the
keyword and pattern lists are taken from the analyzer's own constants so the
description cannot drift from the code that ran.
"""

from __future__ import annotations

from typing import Any

from . import kora

_KEYWORDS = ", ".join(f"'{kw}'" for kw in kora.DETERMINISTIC_KEYWORDS)
_MARKERS = ", ".join(kora.LOW_COST_MODEL_MARKERS)

CATEGORY_INFO: dict[str, dict[str, Any]] = {
    kora.DUPLICATE: {
        "label": "Repeated call",
        "plural": "Repeated calls",
        "rule": {
            "name": "Repeated usage signature within a run",
            "summary": (
                "Within one run, model calls are grouped by provider, resource type, model "
                "name, operation, modality and the input, output, reasoning, cache-read and "
                "request counters. In each group of two or more calls, every call after the "
                "first is flagged."
            ),
            "confidence": "Always medium.",
        },
        "limitations": [
            "AUDR records contain no prompt or response content, so equal counters cannot show "
            "that two calls did the same work. Different inputs can produce the same token "
            "counts.",
            "Retries after errors, deliberate sampling and polling loops also repeat a "
            "signature and can be legitimate.",
            "Use the flag to decide which calls to check in your agent's own logs.",
        ],
    },
    kora.CACHE: {
        "label": "Cache / reuse candidate",
        "plural": "Cache / reuse candidates",
        "rule": {
            "name": "Usage signature repeated across runs",
            "summary": (
                "Across all runs in the import, model calls are grouped by the same signature "
                "used for repeated calls. When a group spans two or more runs, every call after "
                "the first is flagged."
            ),
            "confidence": "Always low.",
        },
        "limitations": [
            "Reusing a result is only safe when the inputs are the same, and AUDR cannot show "
            "inputs.",
            "Templated steps often produce similar counters for different inputs, such as "
            "different tickets of similar length.",
            "A call flagged here may also be flagged as a repeated call; scenario estimates "
            "count each call once.",
        ],
    },
    kora.DETERMINISTIC: {
        "label": "Deterministic alternative",
        "plural": "Deterministic alternatives",
        "rule": {
            "name": "Task keyword in run metadata",
            "summary": (
                "A model call is flagged when its run name, run type or label values contain "
                f"one of these keyword fragments: {_KEYWORDS}. The first fragment found, in "
                "that order, is reported."
            ),
            "confidence": "Always low.",
        },
        "limitations": [
            "Inferred from names and labels only; the call's actual task is not visible.",
            "A run name applies to every call in the run, so one keyword can flag calls that do "
            "unrelated work.",
            "Some classification, extraction or validation genuinely needs a model.",
        ],
    },
    kora.SMALLER: {
        "label": "Cheaper-model review",
        "plural": "Cheaper-model reviews",
        "rule": {
            "name": "Short call on a high-end model",
            "summary": (
                "A model call is flagged when its model name matches a high-end tier pattern "
                f"and contains none of: {_MARKERS}; it reports at most "
                f"{kora.SMALLER_MODEL_MAX_TOKENS:,} input + output + reasoning tokens; and it "
                "reports no reasoning tokens."
            ),
            "confidence": "Always low.",
        },
        "limitations": [
            "No output quality is measured. A smaller model may fail tasks this model handles.",
            "Model tiers are recognized by name patterns from KORA Doctor v0.1.0 and can be "
            "wrong for new or renamed models.",
            "The scenario ratio is a fixed assumption, not a price comparison between models.",
        ],
    },
    kora.ORCHESTRATION: {
        "label": "Orchestration overhead",
        "plural": "Orchestration overhead",
        "rule": {
            "name": "Many model calls in one run",
            "summary": (
                f"When a run has {kora.ORCHESTRATION_MIN_CALLS} or more model calls, ordered by "
                "step and then time, every call after the "
                f"{kora.ORCHESTRATION_KEPT_CALLS}th is flagged."
            ),
            "confidence": (
                f"Medium at {kora.ORCHESTRATION_MEDIUM_AT} or more model calls, otherwise low."
            ),
        },
        "limitations": [
            "Counts calls only; long-horizon tasks can legitimately need many calls.",
            "Calls are flagged by their position in the run, not by what they did.",
        ],
    },
}

GLOSSARY: dict[str, str] = {
    "observed": "Values reported in the imported telemetry, such as cost.total_cost and token "
    "counters.",
    "candidate": "A call a heuristic flagged as worth reviewing. A candidate is not proof of "
    "waste.",
    "scenario_estimate": "KORA Doctor's fixed assumption of how much of a flagged call's "
    "observed cost might be avoidable. Each call counts once, at its highest ratio, so "
    "overlapping findings never add up.",
    "measured_change": "The cost difference between two recorded runs, labelled measured only "
    "when both runs report complete, comparable costs and you marked them as equivalent work.",
    "unknown_cost": "A call without cost.total_cost. It is excluded from totals and counted "
    "separately; it is never treated as zero.",
    "estimated_cost": "A cost this app computed from reported token counts at Anthropic's "
    "published API list prices, for telemetry that records tokens but no cost, such as Claude "
    "Code transcripts. It is not what was billed.",
}


def rule_for(category: str) -> dict[str, Any]:
    info = CATEGORY_INFO.get(category)
    base: dict[str, Any] = dict(info["rule"]) if info else {"name": category, "summary": ""}
    base["source"] = f"{kora.SOURCE_URL}/blob/{kora.PINNED_REVISION}/{kora.SOURCE_FILE}"
    base["analyzer"] = f"{kora.ANALYZER.name} {kora.ANALYZER.version}"
    return base


def limitations_for(category: str) -> list[str]:
    info = CATEGORY_INFO.get(category)
    return list(info["limitations"]) if info else []


def label_for(category: str) -> str:
    info = CATEGORY_INFO.get(category)
    return str(info["label"]) if info else category
