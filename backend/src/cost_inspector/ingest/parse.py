"""Bounded decoding of AUDR files.

Accepts the three layouts KORA Doctor accepts: one JSON object, a JSON array of
objects, or JSONL (one object per line). Every record keeps the line on which
it starts so validation errors can point at it.

Numbers with a fraction or exponent are decoded as :class:`~decimal.Decimal`
so money is never rounded through binary floating point. ``NaN`` and
``Infinity`` are rejected: they are not JSON.
"""

from __future__ import annotations

import bisect
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any

from .issues import Issue, IssueList

UTF8_HINT = "AUDR files are JSON text. Save the file with UTF-8 encoding."
JSONL_HINT = "Each line of a JSONL file must be one complete AUDR record object."
FORMAT_HINT = (
    "Provide AUDR v1.0 records as JSONL (one object per line), "
    "a JSON array of objects, or a single JSON object."
)

_WS = re.compile(r"[ \t\n\r]*")
_NON_FINITE = re.compile(r"(?<![\w\"])-?(?:NaN|Infinity)(?![\w\"])")


class DocumentFormat(StrEnum):
    JSONL = "jsonl"
    JSON_ARRAY = "json-array"
    JSON_OBJECT = "json-object"


@dataclass(frozen=True)
class SourceItem:
    #: 1-based position of the record in the file.
    item: int
    #: 1-based line on which the record starts.
    line: int
    value: dict[str, Any]


@dataclass
class ParseResult:
    format: DocumentFormat | None
    items: list[SourceItem]
    issues: IssueList
    #: Records found in the file, including ones that failed to parse.
    record_count: int = 0


class NonFiniteNumberError(ValueError):
    pass


def _reject_constant(token: str) -> Any:
    raise NonFiniteNumberError(token)


def make_decoder() -> json.JSONDecoder:
    return json.JSONDecoder(parse_float=Decimal, parse_constant=_reject_constant)


class _LineIndex:
    def __init__(self, text: str) -> None:
        self._starts = [0, *(m.end() for m in re.finditer("\n", text))]

    def line_of(self, offset: int) -> int:
        return bisect.bisect_right(self._starts, offset)


def json_type_name(value: Any) -> str:
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, bool):
        return "boolean"
    if value is None:
        return "null"
    return "number"


def _non_finite_issue(text: str, lines: _LineIndex, base_line: int = 1) -> Issue:
    match = _NON_FINITE.search(text)
    line = lines.line_of(match.start()) + base_line - 1 if match else base_line
    return Issue(
        code="non_finite_number",
        line=line,
        message="NaN and Infinity are not valid JSON numbers.",
        hint="Report a finite number, or omit the field when the value is unknown.",
    )


def parse_document(data: bytes, *, max_records: int, max_issues: int) -> ParseResult:
    issues = IssueList(max_issues)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        issues.add(
            Issue(
                code="encoding",
                line=data.count(b"\n", 0, exc.start) + 1,
                message="This line contains bytes that are not valid UTF-8 text.",
                hint=UTF8_HINT,
            )
        )
        return ParseResult(None, [], issues)

    if text.startswith("﻿"):
        text = text[1:]

    first = _WS.match(text, 0)
    start = first.end() if first else 0
    if start >= len(text):
        issues.add(
            Issue(
                code="empty",
                message="The file is empty: it contains no AUDR records.",
                hint=FORMAT_HINT,
            )
        )
        return ParseResult(None, [], issues)

    lines = _LineIndex(text)
    if text[start] == "[":
        return _parse_array(text, start, lines, max_records, issues)

    decoder = make_decoder()
    try:
        value = decoder.decode(text)
    except json.JSONDecodeError as whole_error:
        if _looks_like_one_document(text):
            issues.add(
                Issue(
                    code="json_syntax",
                    line=whole_error.lineno,
                    column=whole_error.colno,
                    message=f"Invalid JSON: {whole_error.msg}.",
                    hint="This looks like a single pretty-printed JSON object; fix the syntax at "
                    "this position.",
                )
            )
            return ParseResult(None, [], issues)
        return _parse_jsonl(text, max_records, issues)
    except NonFiniteNumberError:
        if _looks_like_one_document(text):
            issues.add(_non_finite_issue(text, lines))
            return ParseResult(None, [], issues)
        return _parse_jsonl(text, max_records, issues)
    except (RecursionError, ValueError) as exc:
        issues.add(_unparseable_issue(exc, lines.line_of(start)))
        return ParseResult(None, [], issues)

    if isinstance(value, dict):
        return ParseResult(
            DocumentFormat.JSON_OBJECT, [SourceItem(1, lines.line_of(start), value)], issues, 1
        )
    issues.add(
        Issue(
            code="not_a_record",
            line=lines.line_of(start),
            message=f"The file contains a JSON {json_type_name(value)}, not an AUDR record object.",
            hint=FORMAT_HINT,
        )
    )
    return ParseResult(None, [], issues)


def _unparseable_issue(exc: BaseException, line: int) -> Issue:
    if isinstance(exc, RecursionError):
        return Issue(
            code="too_deep",
            line=line,
            message="The JSON is nested too deeply to read.",
            hint="AUDR records are shallow objects; check that the file is AUDR data.",
        )
    return Issue(code="json_syntax", line=line, message=f"Invalid JSON: {exc}.")


def _looks_like_one_document(text: str) -> bool:
    """A first line holding only ``{`` means a pretty-printed object, not JSONL."""
    for raw in text.split("\n"):
        stripped = raw.strip()
        if stripped:
            return stripped == "{"
    return False


def _parse_jsonl(text: str, max_records: int, issues: IssueList) -> ParseResult:
    raw_lines = text.split("\n")
    record_lines = sum(1 for raw in raw_lines if raw.strip())
    if record_lines > max_records:
        issues.add(_too_many_records(record_lines, max_records))
        return ParseResult(DocumentFormat.JSONL, [], issues, record_lines)

    decoder = make_decoder()
    items: list[SourceItem] = []
    position = 0
    for line_no, raw in enumerate(raw_lines, 1):
        line = raw.rstrip("\r")
        if not line.strip():
            continue
        position += 1
        try:
            value = decoder.decode(line)
        except json.JSONDecodeError as exc:
            issues.add(
                Issue(
                    code="json_syntax",
                    line=line_no,
                    column=exc.colno,
                    item=position,
                    message=f"Invalid JSON: {exc.msg}.",
                    hint=JSONL_HINT,
                )
            )
            continue
        except NonFiniteNumberError:
            issues.add(_non_finite_issue(line, _LineIndex(line), base_line=line_no))
            continue
        except (RecursionError, ValueError) as exc:
            issues.add(_unparseable_issue(exc, line_no))
            continue
        if not isinstance(value, dict):
            issues.add(
                Issue(
                    code="not_a_record",
                    line=line_no,
                    item=position,
                    message="Expected one AUDR record object on this line; found a JSON "
                    f"{json_type_name(value)}.",
                    hint=JSONL_HINT,
                )
            )
            continue
        items.append(SourceItem(position, line_no, value))
    return ParseResult(DocumentFormat.JSONL, items, issues, record_lines)


def _parse_array(
    text: str, start: int, lines: _LineIndex, max_records: int, issues: IssueList
) -> ParseResult:
    decoder = make_decoder()
    try:
        value = decoder.decode(text)
    except json.JSONDecodeError as exc:
        issues.add(
            Issue(
                code="json_syntax",
                line=exc.lineno,
                column=exc.colno,
                message=f"Invalid JSON: {exc.msg}.",
                hint="The file starts with '[' and is read as one JSON array of AUDR records.",
            )
        )
        return ParseResult(None, [], issues)
    except NonFiniteNumberError:
        issues.add(_non_finite_issue(text, lines))
        return ParseResult(None, [], issues)
    except (RecursionError, ValueError) as exc:
        issues.add(_unparseable_issue(exc, lines.line_of(start)))
        return ParseResult(None, [], issues)

    assert isinstance(value, list)
    if not value:
        issues.add(
            Issue(
                code="empty",
                line=lines.line_of(start),
                message="The JSON array is empty: it contains no AUDR records.",
                hint=FORMAT_HINT,
            )
        )
        return ParseResult(DocumentFormat.JSON_ARRAY, [], issues)
    if len(value) > max_records:
        issues.add(_too_many_records(len(value), max_records))
        return ParseResult(DocumentFormat.JSON_ARRAY, [], issues, len(value))

    items: list[SourceItem] = []
    for position, (offset, element) in enumerate(_iter_array(text, start, decoder), 1):
        line = lines.line_of(offset)
        if not isinstance(element, dict):
            issues.add(
                Issue(
                    code="not_a_record",
                    line=line,
                    item=position,
                    message=f"Array item {position} is a JSON {json_type_name(element)}, "
                    "not an AUDR record object.",
                    hint=FORMAT_HINT,
                )
            )
            continue
        items.append(SourceItem(position, line, element))
    return ParseResult(DocumentFormat.JSON_ARRAY, items, issues, len(value))


def _iter_array(text: str, start: int, decoder: json.JSONDecoder) -> Iterator[tuple[int, Any]]:
    """Yield ``(offset, element)`` for each element of an already-validated JSON array."""
    idx = _ws_end(text, start + 1)
    if text[idx] == "]":
        return
    while True:
        element, end = decoder.raw_decode(text, idx)
        yield idx, element
        idx = _ws_end(text, end)
        if text[idx] == ",":
            idx = _ws_end(text, idx + 1)
            continue
        return


def _ws_end(text: str, idx: int) -> int:
    match = _WS.match(text, idx)
    return match.end() if match else idx


def _too_many_records(count: int, limit: int) -> Issue:
    return Issue(
        code="too_many_records",
        message=f"The file has {count:,} records; one import is limited to {limit:,}.",
        hint="Split the file by run, or raise ACI_MAX_RECORDS for this local service.",
    )
