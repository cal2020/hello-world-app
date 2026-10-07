"""Validation of records against the official AUDR v1.0.0 JSON Schema.

The schema is applied unmodified with a Draft 2020-12 validator, the way the
AUDR conformance runner applies it. The only adaptation is that numbers decoded
as ``Decimal`` count as JSON numbers, and integral decimals such as ``500.0``
count as integers, as JSON Schema defines. Errors are rewritten into messages
that name the record's line and field and say how to fix the problem.
"""

from __future__ import annotations

import functools
import json
import re
from collections.abc import Iterable, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from jsonschema.protocols import Validator
from jsonschema.validators import extend

from .issues import Issue, IssueList
from .parse import SourceItem, json_type_name

SCHEMA_PATH = Path(__file__).parent / "audr" / "audr.schema.json"
AUDR_SPEC_VERSION = "1.0.0"
#: Largest integer JavaScript can represent exactly; counters above it would be
#: silently rounded in the browser, so they are rejected.
MAX_SAFE_INTEGER = 2**53 - 1
MAX_ERRORS_PER_RECORD = 8

_FIELD_HINTS: dict[str, str] = {
    "spec_version": 'Use an AUDR 1.0.x version string such as "1.0.0".',
    "record_id": "Use a ULID or UUIDv7: 8–64 characters, unique for every emitted record.",
    "corrects": "Name the record_id (8–64 characters) of the record this one restates.",
    "run.run_id": "Use one 8–64 character run identifier on every record in the run.",
    "timing.event_time": "Use RFC 3339 with a timezone, for example 2026-10-07T12:00:00.000Z.",
    "timing.received_time": "Use RFC 3339 with a timezone, for example 2026-10-07T12:00:00.000Z.",
    "resource.provider": "Use a lowercase slug such as anthropic, openai or self-hosted.",
    "resource.modality": (
        "Model operations must state a modality: text, image, audio or multimodal."
    ),
    "resource.type": 'Model operations use type "model"; tool_execution and retrieval use "tool".',
    "cost.currency": "Use an uppercase ISO 4217 code such as USD or EUR.",
    "attribution.environment": "Use production, staging, development, test or evaluation.",
    "attribution.account_id": "Production records must name the paying account (AUDR §3.10).",
    "attribution.labels": "Use at most 20 labels; names may contain letters, digits, '_', '.' "
    "and '-' (up to 64 characters), values up to 256 characters.",
    "run.error_reason": "Keep error_reason to 32 characters; use error_code for detail.",
    "usage": "Model operations report usage.llm; tool_execution and retrieval report usage.tool.",
    "usage.llm": "Report at least one model counter, such as input_tokens or requests.",
    "usage.tool": "Report at least one tool counter, such as call_count.",
    "cost": "When cost is present it needs both total_cost and currency.",
    "cost.llm": "cost.llm needs total_token_cost.",
}

_OPERATION_CLASSES = {
    "generation": "model",
    "embedding": "model",
    "reranking": "model",
    "tool_execution": "tool",
    "retrieval": "tool",
}


def _is_integer(_checker: Any, instance: Any) -> bool:
    if isinstance(instance, bool):
        return False
    if isinstance(instance, int):
        return True
    if isinstance(instance, Decimal):
        return instance.is_finite() and instance == instance.to_integral_value()
    if isinstance(instance, float):
        return instance.is_integer()
    return False


@functools.cache
def load_schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return schema


@functools.cache
def _validator() -> Validator:
    schema = load_schema()
    Draft202012Validator.check_schema(schema)
    cls = extend(  # type: ignore[no-untyped-call]  # jsonschema ships it untyped
        Draft202012Validator,
        type_checker=Draft202012Validator.TYPE_CHECKER.redefine("integer", _is_integer),
    )
    validator: Validator = cls(schema, format_checker=FormatChecker())
    return validator


def show(value: Any) -> str:
    """Render a JSON value briefly for an error message."""
    if isinstance(value, str):
        text = json.dumps(value, ensure_ascii=False)
        return text if len(text) <= 60 else text[:57] + '…"'
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "an object"
    if isinstance(value, list):
        return "an array"
    return str(value)


def _dotted(parts: Iterable[Any]) -> str:
    out = ""
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else str(part)
    return out


def _hint_key(path: str) -> str:
    return re.sub(r"\[\d+\]", "", path)


def _operation_context(record: dict[str, Any]) -> str | None:
    resource = record.get("resource")
    if isinstance(resource, dict) and isinstance(resource.get("operation"), str):
        return f'because resource.operation is "{resource["operation"]}"'
    return None


def _describe(err: ValidationError, record: dict[str, Any]) -> tuple[str, str, str | None]:
    """Return ``(path, message, hint)`` for one schema error."""
    base = _dotted(err.absolute_path)
    schema_path = list(err.absolute_schema_path)
    cross_field = "then" in schema_path
    context = ""
    if cross_field:
        if "attribution" in schema_path:
            context = ' because attribution.environment is "production"'
        else:
            op_context = _operation_context(record)
            context = f" {op_context}" if op_context else ""
    keyword = err.validator
    instance = err.instance
    # jsonschema types these as possibly "Unset"; for errors from iter_errors they are set.
    keyword_value: Any = cast(Any, err.validator_value)
    err_schema: Mapping[str, Any] = err.schema if isinstance(err.schema, Mapping) else {}
    in_property_names = "propertyNames" in schema_path

    if keyword == "required":
        missing = next(
            (
                name
                for name in keyword_value
                if isinstance(instance, dict) and name not in instance and repr(name) in err.message
            ),
            None,
        )
        path = f"{base}.{missing}" if base and missing else (missing or base)
        message = f"Missing required field `{path}`{context}."
        return path, message, _FIELD_HINTS.get(_hint_key(path))

    if keyword == "additionalProperties" and isinstance(instance, dict):
        props = err_schema.get("properties", {})
        patterns = err_schema.get("patternProperties", {})
        extras = [
            key
            for key in instance
            if key not in props and not any(re.search(p, key) for p in patterns)
        ]
        names = ", ".join(f"`{_dotted([*err.absolute_path, key])}`" for key in extras)
        where = f"`{base}`" if base else "the record"
        extra_hint = "AUDR objects are closed: remove fields the specification does not define."
        if patterns and any(key.lower().startswith("x") for key in extras):
            extra_hint = (
                "Extension counters must be named x_<provider>_<name> using lowercase letters, "
                "digits and underscores."
            )
        plural = "s" if len(extras) != 1 else ""
        return base, f"Unexpected field{plural} {names} in {where}.", extra_hint

    if keyword == "not" and isinstance(keyword_value, dict):
        forbidden = keyword_value.get("required", [])
        if forbidden:
            path = f"{base}.{forbidden[0]}" if base else str(forbidden[0])
            block_hint = (
                "Model operations carry usage.llm and cost.llm; tool_execution and retrieval "
                "carry usage.tool and cost.tool."
            )
            return path, f"`{path}` must not be present{context}.", block_hint
        return base, f"`{base}` has a shape the specification forbids{context}.", None

    path = base or "record"
    hint = _FIELD_HINTS.get(_hint_key(path))

    if in_property_names:
        return (
            path,
            f"Name {show(instance)} in `{path}` is not allowed.",
            hint or "Use letters, digits, '_', '.' and '-' only.",
        )
    if keyword == "const":
        return (
            path,
            (f"`{path}` must be {show(keyword_value)}{context} (found {show(instance)})."),
            hint,
        )
    if keyword == "enum":
        options = ", ".join(str(v) for v in keyword_value)
        return path, f"`{path}` must be one of: {options} (found {show(instance)}).", hint
    if keyword == "type":
        expected = (
            " or ".join(keyword_value) if isinstance(keyword_value, list) else str(keyword_value)
        )
        article = "an" if str(expected)[0] in "aeiou" else "a"
        return (
            path,
            (
                f"`{path}` must be {article} {expected} "
                f"(found {json_type_name(instance)} {show(instance)})."
            ),
            hint,
        )
    if keyword in ("minimum", "exclusiveMinimum"):
        op = "at least" if keyword == "minimum" else "greater than"
        return path, f"`{path}` must be {op} {keyword_value} (found {show(instance)}).", hint
    if keyword in ("maximum", "exclusiveMaximum"):
        op = "at most" if keyword == "maximum" else "less than"
        return path, f"`{path}` must be {op} {keyword_value} (found {show(instance)}).", hint
    if keyword in ("minLength", "maxLength") and isinstance(instance, str):
        op = "at least" if keyword == "minLength" else "at most"
        return (
            path,
            (f"`{path}` must be {op} {keyword_value} characters (found {len(instance)})."),
            hint,
        )
    if keyword == "pattern":
        if path == "spec_version":
            return (
                path,
                (f"Unsupported AUDR version {show(instance)}: this inspector reads AUDR 1.0.x."),
                "Consumers must reject unsupported major versions (AUDR §3.4).",
            )
        return (
            path,
            (f"`{path}` has an invalid format (found {show(instance)})."),
            hint or f"Expected text matching {keyword_value}.",
        )
    if keyword == "minProperties":
        return path, f"`{path}` must not be empty.", hint
    if keyword == "maxProperties" and isinstance(instance, dict):
        return (
            path,
            (f"`{path}` has {len(instance)} entries; at most {keyword_value} are allowed."),
            hint,
        )
    if keyword == "format":
        return path, f"`{path}` is not a valid {keyword_value} (found {show(instance)}).", hint
    return path, f"`{path}`: {err.message}", hint


def _unsafe_integers(value: Any, path: list[Any]) -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _unsafe_integers(child, [*path, key])
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _unsafe_integers(child, [*path, index])
    elif (
        isinstance(value, (int, Decimal))
        and not isinstance(value, bool)
        and abs(Decimal(value)) > MAX_SAFE_INTEGER
    ):
        yield _dotted(path), value


def validate_record(item: SourceItem) -> list[Issue]:
    record = item.value
    errors = sorted(
        _validator().iter_errors(record),
        key=lambda e: (_dotted(e.absolute_path), str(e.validator)),
    )
    issues: list[Issue] = []
    seen: set[tuple[str, str]] = set()
    for err in errors:
        path, message, hint = _describe(err, record)
        if (path, message) in seen:
            continue
        seen.add((path, message))
        issues.append(
            Issue(
                code="schema", line=item.line, item=item.item, path=path, message=message, hint=hint
            )
        )
    for path, value in _unsafe_integers(record, []):
        issues.append(
            Issue(
                code="value_too_large",
                line=item.line,
                item=item.item,
                path=path,
                message=f"`{path}` is {value}, larger than this inspector can represent exactly "
                f"({MAX_SAFE_INTEGER:,}).",
                hint="Check the emitter for an overflow or unit mistake.",
            )
        )
    if len(issues) > MAX_ERRORS_PER_RECORD:
        hidden = len(issues) - MAX_ERRORS_PER_RECORD
        issues = issues[:MAX_ERRORS_PER_RECORD]
        issues.append(
            Issue(
                code="schema",
                line=item.line,
                item=item.item,
                message=f"…and {hidden} more problem{'s' if hidden != 1 else ''} in this record.",
            )
        )
    return issues


def validate_items(items: list[SourceItem], issues: IssueList) -> list[SourceItem]:
    """Validate every record; return the records that passed."""
    valid: list[SourceItem] = []
    for item in items:
        record_issues = validate_record(item)
        if record_issues:
            for issue in record_issues:
                issues.add(issue)
        else:
            valid.append(item)
    return valid
