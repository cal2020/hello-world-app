"""Strict JSON input and canonical serialization for hashing.

Canonical form (documented contract, used for every hash in this package):
UTF-8 JSON, object keys sorted by code point, no insignificant whitespace,
``ensure_ascii=False``, arrays kept in their given order (transition order is
behaviour-defining), integers as-is, non-finite numbers rejected.

Input is rejected before canonicalization when it contains duplicate object
keys, NaN/Infinity, a byte-order mark or invalid UTF-8, or exceeds size and
nesting limits.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

MAX_INPUT_BYTES = 2_000_000
MAX_DEPTH = 64
MAX_STRING = 200_000


class StrictJSONError(ValueError):
    pass


def _reject_constant(name: str) -> Any:
    raise StrictJSONError(f"non-finite number {name} is not allowed")


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise StrictJSONError(f"duplicate JSON key {key!r}")
        out[key] = value
    return out


def _check_limits(value: Any, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise StrictJSONError("JSON nesting too deep")
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            raise StrictJSONError("JSON string too long")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise StrictJSONError("non-finite number")
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_limits(k, depth + 1)
            _check_limits(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            _check_limits(v, depth + 1)


def loads_strict(data: bytes | str) -> Any:
    if isinstance(data, str):
        data = data.encode("utf-8")
    if len(data) > MAX_INPUT_BYTES:
        raise StrictJSONError("JSON input too large")
    if data.startswith(b"\xef\xbb\xbf"):
        raise StrictJSONError("byte-order mark is not allowed")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise StrictJSONError(f"invalid UTF-8: {exc}") from exc
    try:
        value = json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise StrictJSONError(f"invalid JSON: {exc}") from exc
    _check_limits(value)
    return value


def load_file(path: str) -> Any:
    with open(path, "rb") as fh:
        return loads_strict(fh.read())


def canonical_bytes(value: Any) -> bytes:
    _check_limits(value)
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(value: Any) -> str:
    """``sha256:<hex>`` over the canonical form of ``value``."""
    return "sha256:" + sha256_hex(canonical_bytes(value))


def dumps_pretty(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
