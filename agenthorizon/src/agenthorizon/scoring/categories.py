"""Versioned failure-category mapping between native strings and internal enums.

The native strings come from the rubric (S7) and the judge output schema (prompt, S2). The plural
"Misunderstanding of the Instructions" is accepted because the authors' own code treats it as the
labels-file spelling and normalises it (analyze_eval_results.py, results_to_submission.py). Matching is exact
after surrounding-whitespace stripping (mirroring results_to_submission.py); there is no case folding or
fuzzy matching, and the map is fixed before any outcome is seen. Changing it requires a new version id.
"""

from __future__ import annotations

from enum import StrEnum


class Category(StrEnum):
    CRITICAL = "critical_mistake"
    SIDE_EFFECT = "bad_side_effect"
    MISUNDERSTANDING = "misunderstanding_of_the_instruction"


CATEGORY_MAP_VERSION = "ah-categories-v1"

NATIVE_TO_CATEGORY: dict[str, Category] = {
    "Critical Mistake": Category.CRITICAL,
    "Bad Side Effect": Category.SIDE_EFFECT,
    "Misunderstanding of the Instruction": Category.MISUNDERSTANDING,
    "Misunderstanding of the Instructions": Category.MISUNDERSTANDING,
}

CANONICAL_NATIVE: dict[Category, str] = {
    Category.CRITICAL: "Critical Mistake",
    Category.SIDE_EFFECT: "Bad Side Effect",
    Category.MISUNDERSTANDING: "Misunderstanding of the Instruction",
}

DISPLAY: dict[Category, str] = {
    Category.CRITICAL: "Critical Mistake",
    Category.SIDE_EFFECT: "Bad Side Effect",
    Category.MISUNDERSTANDING: "Misunderstanding of the Instruction",
}


def normalize_native(value: object) -> tuple[Category | None, str]:
    """Return (category or None, status) where status is one of:
    ``ok`` | ``absent`` (None/empty) | ``not_string`` | ``unrecognized``."""
    if value is None:
        return None, "absent"
    if not isinstance(value, str):
        return None, "not_string"
    s = value.strip()
    if not s:
        return None, "absent"
    cat = NATIVE_TO_CATEGORY.get(s)
    return (cat, "ok") if cat else (None, "unrecognized")
