"""Judge-response parsing and verdict validation.

Two reference parsers are ported verbatim from the pinned release, because the authors used different ones:

* ``ah-agentic-extractor@8584a347`` = ``scripts/evaluate_trajectories.py:_extract_verdict_from_response``
  (pure JSON, fenced JSON, fences inside prose, balanced-brace substrings; the *last* object carrying a
  ``success`` key wins).
* ``ah-direct-parser@8584a347`` = ``llm_judges/utils.py:parse_judge_response`` (strip one fence, then the whole
  text must be JSON; otherwise ``{"raw_response": text}``).

Validation is separate from extraction and is strict: binary validity requires ``success`` to be a JSON
Boolean (Python ``bool``, not ``int``). Strings like ``"false"``, numbers, ``null`` and absent keys are invalid
and are never coerced. Full-contract validity additionally checks reasoning, confidence and mistake_type.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field

from agenthorizon.scoring.categories import CATEGORY_MAP_VERSION, normalize_native

AGENTIC_PARSER_ID = "ah-agentic-extractor@8584a347"
DIRECT_PARSER_ID = "ah-direct-parser@8584a347"
CONFIDENCE_VALUES = ("low", "medium", "high")


def _extract_balanced_objects(text: str):
    i = 0
    while i < len(text):
        if text[i] == "{":
            depth = 0
            start = i
            for j in range(i, len(text)):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        yield text[start : j + 1]
                        i = j + 1
                        break
            else:
                return
        else:
            i += 1


def extract_agentic_reference(text: str) -> dict | None:
    """Verbatim behaviour of ``_extract_verdict_from_response`` at 8584a347."""
    if not text:
        return None
    s = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*\n?", "", s)
    stripped = re.sub(r"\n?```\s*$", "", stripped).strip()
    try:
        d = json.loads(stripped)
        if isinstance(d, dict):
            return d
    except json.JSONDecodeError:
        pass
    for block in reversed(re.findall(r"```(?:json)?\s*\n(.*?)\n```", s, flags=re.DOTALL)):
        try:
            d = json.loads(block.strip())
            if isinstance(d, dict) and "success" in d:
                return d
        except json.JSONDecodeError:
            continue
    candidates = list(_extract_balanced_objects(s))
    for block in reversed(candidates):
        try:
            d = json.loads(block)
            if isinstance(d, dict) and "success" in d:
                return d
        except json.JSONDecodeError:
            continue
    for block in candidates:
        try:
            d = json.loads(block)
            if isinstance(d, dict):
                return d
        except json.JSONDecodeError:
            continue
    return None


def parse_direct_reference(response_text: str) -> dict:
    """Verbatim behaviour of ``llm_judges/utils.py:parse_judge_response`` at 8584a347."""
    text = response_text.strip()
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_response": text}


def candidate_diagnostics(text: str) -> dict:
    """Non-normative diagnostics: how many JSON objects carry ``success`` and whether they disagree."""
    objs = []
    for block in _extract_balanced_objects((text or "").strip()):
        try:
            d = json.loads(block)
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and "success" in d:
            objs.append(d)
    values = [json.dumps(o.get("success")) for o in objs]
    return {"objects_with_success": len(objs), "distinct_success_values": sorted(set(values)),
            "conflicting": len(set(values)) > 1}


@dataclass
class Verdict:
    parser: str
    category_map: str
    extracted: bool  # parser produced a dict
    has_success_key: bool
    success_raw_type: str  # bool | str | int | float | null | list | dict | absent
    binary_valid: bool
    success: bool | None  # only when binary_valid
    full_contract_valid: bool
    reasoning: str | None
    confidence: str | None
    mistake_type_native: str | None
    mistake_type_category: str | None
    mistake_type_status: str
    problems: list[str] = field(default_factory=list)
    diagnostics: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _type_name(v: object) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    return {int: "int", float: "float", str: "str", list: "list", dict: "dict"}.get(type(v), type(v).__name__)


def validate_object(obj: dict | None, *, parser: str) -> Verdict:
    problems: list[str] = []
    if not isinstance(obj, dict):
        return Verdict(parser, CATEGORY_MAP_VERSION, False, False, "absent", False, None, False, None, None, None, None,
                       "absent", ["no_json_object"])
    has = "success" in obj
    sv = obj.get("success") if has else None
    stype = _type_name(sv) if has else "absent"
    binary_valid = has and isinstance(sv, bool)
    if not has:
        problems.append("success_missing")
    elif not binary_valid:
        problems.append(f"success_not_boolean:{stype}")
    reasoning = obj.get("reasoning")
    if not isinstance(reasoning, str) or not reasoning.strip():
        problems.append("reasoning_missing_or_empty")
        reasoning_s = reasoning if isinstance(reasoning, str) else None
    else:
        reasoning_s = reasoning
    conf = obj.get("confidence")
    if conf not in CONFIDENCE_VALUES:
        problems.append(f"confidence_invalid:{conf!r}"[:80])
    mt_raw = obj.get("mistake_type")
    cat, mt_status = normalize_native(mt_raw)
    if binary_valid:
        if sv is True and mt_raw is not None:
            problems.append("mistake_type_on_success")
        if sv is False and cat is None:
            problems.append(f"mistake_type_{mt_status}_on_failure")
    full = binary_valid and not problems
    return Verdict(
        parser=parser,
        category_map=CATEGORY_MAP_VERSION,
        extracted=True,
        has_success_key=has,
        success_raw_type=stype,
        binary_valid=binary_valid,
        success=sv if binary_valid else None,
        full_contract_valid=full,
        reasoning=reasoning_s,
        confidence=conf if isinstance(conf, str) else None,
        mistake_type_native=mt_raw if isinstance(mt_raw, str) else None,
        mistake_type_category=cat.value if cat else None,
        mistake_type_status=mt_status,
        problems=problems,
    )


def parse_agentic(text: str) -> Verdict:
    v = validate_object(extract_agentic_reference(text), parser=AGENTIC_PARSER_ID)
    v.diagnostics = candidate_diagnostics(text)
    return v


def parse_direct(text: str) -> Verdict:
    obj = parse_direct_reference(text)
    if isinstance(obj, dict) and set(obj) == {"raw_response"}:
        obj = None
    v = validate_object(obj if isinstance(obj, dict) else None, parser=DIRECT_PARSER_ID)
    v.diagnostics = candidate_diagnostics(text)
    return v


def reference_attempt_succeeded(parsed: dict | None) -> bool:
    """The authors' retry stop rule: an attempt is final once its parsed dict carries a ``success`` key
    (any value). Used to decide whether a fresh judgment attempt is allowed — never on verdict content."""
    return isinstance(parsed, dict) and "success" in parsed
