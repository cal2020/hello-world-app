"""Strict JSON intake and canonical serialization for hashing.

Canonical form (documented contract, version ``hexis-canon/1``):

* UTF-8 JSON, object keys sorted by Unicode code point, no insignificant whitespace,
  ``ensure_ascii=False``.
* Array order is preserved (transition order is behavior-defining).
* Integers are emitted as integers; floats via ``repr`` (shortest round-trip). ``bool`` is never
  coerced to a number.
* Rejected before canonicalization: duplicate object keys, NaN/Infinity, non-string keys,
  nesting beyond ``MAX_DEPTH``, strings (values and keys) longer than ``MAX_STRING`` or containing
  lone surrogates, integers wider than ``MAX_INT_BITS`` bits, documents larger than
  ``MAX_BYTES``, and byte input that is not valid UTF-8 (a UTF-8 BOM is also rejected).
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

CANON_VERSION = "hexis-canon/1"
MAX_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 64
MAX_STRING = 1024 * 1024
# Integers are bounded well below CPython's default int->str conversion limit (4300 digits).
MAX_INT_BITS = 4096 * 3


class CanonicalError(ValueError):
    """Input cannot be safely canonicalized."""


def _reject_constant(name: str) -> Any:
    raise CanonicalError(f"non-finite number {name} is not allowed")


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict:
    out: dict = {}
    for k, v in pairs:
        if k in out:
            raise CanonicalError(f"duplicate JSON key {k!r}")
        out[k] = v
    return out


def strict_loads(data: str | bytes) -> Any:
    """Parse JSON rejecting duplicate keys, non-finite numbers, bad encodings and oversize input."""
    if isinstance(data, bytes):
        if len(data) > MAX_BYTES:
            raise CanonicalError("document exceeds size limit")
        if data.startswith(b"\xef\xbb\xbf"):
            raise CanonicalError("UTF-8 BOM is not allowed")
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CanonicalError(f"invalid UTF-8: {exc}") from exc
    else:
        text = data
        if len(text.encode("utf-8", errors="surrogatepass")) > MAX_BYTES:
            raise CanonicalError("document exceeds size limit")
    try:
        value = json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except CanonicalError:
        raise
    except json.JSONDecodeError as exc:
        raise CanonicalError(f"invalid JSON: {exc}") from exc
    except RecursionError as exc:
        raise CanonicalError("nesting too deep") from exc
    except ValueError as exc:  # e.g. integer literal beyond the int/str conversion limit
        raise CanonicalError(f"invalid JSON: {exc}") from exc
    check_value(value)
    return value


def _check_string(value: str) -> None:
    if len(value) > MAX_STRING:
        raise CanonicalError("string too long")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise CanonicalError("lone surrogate in string") from exc


def check_value(value: Any, depth: int = 0) -> None:
    """Validate that ``value`` is plain JSON data within limits."""
    if depth > MAX_DEPTH:
        raise CanonicalError("nesting too deep")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if value.bit_length() > MAX_INT_BITS:
            raise CanonicalError("integer too large")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalError("non-finite number")
        return
    if isinstance(value, str):
        _check_string(value)
        return
    if isinstance(value, (list, tuple)):
        for v in value:
            check_value(v, depth + 1)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalError(f"non-string key {k!r}")
            _check_string(k)
            check_value(v, depth + 1)
        return
    raise CanonicalError(f"unsupported type {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    check_value(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def digest(value: Any) -> str:
    """``sha256:<hex>`` of the canonical form."""
    return "sha256:" + sha256_hex(canonical_bytes(value))
