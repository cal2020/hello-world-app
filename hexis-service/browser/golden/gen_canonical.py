"""Golden vectors for HX.canonical (canonical.py) and HX.jsonschema (tools/catalog.validate_against)."""

from __future__ import annotations

import hashlib
import hmac
import json
import random
import struct

from _common import write

from hexis_service.canonical import CanonicalError, canonical_bytes, digest, sha256_hex, strict_loads
from hexis_service.tools.catalog import validate_against

rng = random.Random(20260926)

# --------------------------------------------------------------------------------------------- #
VALUES = [
    None, True, False, 0, 1, -1, 2**53 - 1, -(2**53 - 1), 0.1, -2.25, 1.5, 1e-7, 1.5e-05, 0.0001, 0.00012,
    123456789.123, 3.141592653589793, 2.5e-300, 1234567890123456.7,
    "", "a", "\"quoted\" \\ back", "tab\tnew\nline\rcr\b\f", "\u0000\u0001\u001f\u007f\u0080", "é中😀",
    "  ", "/slash", [], {}, [1, [2, [3, []]]], {"b": 1, "a": 2, "A": 3, "": 0},
    {"é": 1, "e": 2, "z": 3, "😀": 4, "￿": 5, "": 6, "中": 7},
    {"nested": {"list": [1, 0.5, "x", None, True, {"k": []}]}, "num": -0.5},
    {"thresholds": {"min_support": 2, "holdout_ratio": 0.2, "acc_thr": 0.9, "loop_margin": 1.5,
                    "fallback_rate_target": 0.15, "judge_err_max": 0.2}},
]

canonical_cases = [{"value": v, "canonical": canonical_bytes(v).decode("utf-8"), "digest": digest(v)} for v in VALUES]

# Python float repr across magnitudes (non-integral only; the JS port cannot carry integral floats)
floats = []
for e in range(-320, 309, 3):
    for _ in range(3):
        x = rng.uniform(1, 10) * (10.0 ** e) if -308 < e < 308 else rng.uniform(1, 2) * 10.0 ** max(min(e, 307), -307)
        if x != 0 and x == x and abs(x) != float("inf") and not x.is_integer():
            floats.append(x if rng.random() < 0.5 else -x)
for _ in range(600):  # random bit patterns
    bits = rng.getrandbits(64)
    x = struct.unpack("<d", struct.pack("<Q", bits))[0]
    if x == x and abs(x) != float("inf") and not x.is_integer():
        floats.append(x)
for x in (0.1, 0.2, 0.30000000000000004, 1e-5, 1e-4, 9.999999999999999e-05, 1234567890123456.8,
          5e-324, 2.2250738585072014e-308, 0.5, 1 / 3, 2 / 3, 100.25, 1e15 + 0.25, 12345678901234.5):
    if not x.is_integer():
        floats.append(x)
float_cases = [{"value": x, "repr": repr(x)} for x in floats]

# --------------------------------------------------------------------------------------------- #
def loads_case(text: str, note: str = "") -> dict:
    try:
        v = strict_loads(text)
        r = {"text": text, "python": "accept", "value": v}
    except CanonicalError as exc:
        r = {"text": text, "python": "reject", "error": str(exc)}
    r["note"] = note
    return r


def is_integral_float_literal(text):
    try:
        v = json.loads(text)
    except Exception:
        return False
    found = []

    def walk(x):
        if isinstance(x, float) and x.is_integer():
            found.append(x)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
    walk(v)
    return bool(found)


TEXTS = [
    ('{"a": 1, "b": [true, false, null], "c": "x"}', ""), ('  [1, 2.5, -3, "y"]  ', ""), ("{}", ""), ("[]", ""),
    ('"\\ud83d\\ude00"', "escaped surrogate pair"), ('{"a": 1, "a": 2}', "duplicate key"),
    ('{"x": {"y": 1, "y": 1}}', "nested duplicate key"), ("NaN", "non-finite"), ("[Infinity]", "non-finite"),
    ("[-Infinity]", "non-finite"), ("1e400", "overflow to inf"), ('"\\ud800"', "lone surrogate"),
    ('{"\\udc00": 1}', "lone surrogate key"), ("[1,]", "trailing comma"), ("{'a': 1}", "single quotes"),
    ('"a\tb"', "raw control char"), ("﻿{}", "BOM in str"), ("01", "leading zero"), ("1.", "bad number"),
    (".5", "bad number"), ("-", "bad number"), ("[1 2]", "missing comma"), ('{"a" 1}', "missing colon"),
    ("[" * 64 + "]" * 64, "depth 64 ok"), ("[" * 65 + "]" * 65, "depth 65 rejected"),
    ("[" * 66 + "]" * 66, "depth 66 rejected"), ('{"a": ' * 65 + "1" + "}" * 65, "object depth 65"),
    ("1.0", "integral float (JS rejects: deviation)"), ("-0.0", "integral float (JS rejects: deviation)"),
    ("1e2", "integral float (JS rejects: deviation)"), ("9007199254740991", "max safe int"),
    ("9007199254740993", "int beyond 2^53 (JS rejects: deviation)"), ("-0", "negative zero int"),
    ("1.5e-7", ""), ("123.456E+2", "exponent float"), ('"\\u00e9\\n\\"\\\\\\/"', "escapes"), ("true", ""),
    ("nul", "bad literal"), ("[1] x", "extra data"), ("", "empty"), ('{"__proto__": 1}', "proto key"),
]
loads_cases = [loads_case(text, note) for text, note in TEXTS]


def _flatten(v):
    if isinstance(v, list):
        for x in v:
            yield from _flatten(x)
    elif isinstance(v, dict):
        for x in v.values():
            yield from _flatten(x)
    else:
        yield v


for c in loads_cases:
    js_reject = c["python"] == "accept" and (is_integral_float_literal(c["text"]) or any(
        isinstance(x, int) and not isinstance(x, bool) and abs(x) > 2**53 - 1 for x in _flatten(c.get("value"))))
    c["js"] = "reject" if (c["python"] == "reject" or js_reject) else "accept"
    c["deviation"] = bool(js_reject)
    if js_reject:
        c.pop("value", None)  # not transportable

bytes_cases = []
for raw, note in [(b'{"a": 1}', "ok"), (b"\xef\xbb\xbf{}", "BOM"), (b'"\xff"', "invalid utf-8"),
                  ('{"k": "é"}'.encode(), "utf-8 ok"), (b'"\xed\xa0\x80"', "encoded surrogate (invalid utf-8)")]:
    try:
        v = strict_loads(raw)
        bytes_cases.append({"hex": raw.hex(), "python": "accept", "value": v, "note": note})
    except CanonicalError as exc:
        bytes_cases.append({"hex": raw.hex(), "python": "reject", "error": str(exc), "note": note})

# --------------------------------------------------------------------------------------------- #
sha_cases = []
for s in ["", "abc", "a" * 55, "a" * 56, "a" * 64, "a" * 1000, "é中😀", "The quick brown fox jumps over the lazy dog"]:
    sha_cases.append({"text": s, "sha256": sha256_hex(s)})
hmac_cases = []
for key, msg in [("key", "The quick brown fox jumps over the lazy dog"), ("", ""), ("k" * 100, "msg"),
                 ("hexis-demo-admission-key-not-for-production", '{"a":1}')]:
    hmac_cases.append({"key": key, "message": msg,
                       "hmac": hmac.new(key.encode(), msg.encode(), hashlib.sha256).hexdigest()})

# --------------------------------------------------------------------------------------------- #
SCHEMAS = {
    "obj": {"type": "object", "additionalProperties": False, "required": ["a", "b"],
            "properties": {"a": {"type": "string", "minLength": 1}, "b": {"type": "integer", "minimum": 0},
                           "c": {"type": ["integer", "null"]}, "d": {"enum": ["x", "y"]},
                           "e": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 2},
                           "f": {"type": "string", "pattern": "^SUP-[0-9]{3,10}$"},
                           "g": {"type": "object", "additionalProperties": {"type": "string"}}}},
}
INSTANCES = [
    {"a": "x", "b": 0}, {"a": "", "b": 0}, {"a": "x"}, {"a": "x", "b": -1}, {"a": "x", "b": 1.5}, {"a": "x", "b": True},
    {"a": "x", "b": 1, "z": 1}, {"a": "x", "b": 1, "c": None}, {"a": "x", "b": 1, "c": "no"}, {"a": "x", "b": 1, "d": "z"},
    {"a": "x", "b": 1, "e": []}, {"a": "x", "b": 1, "e": ["p", "q", "r"]}, {"a": "x", "b": 1, "e": [1]},
    {"a": "x", "b": 1, "f": "SUP-123"}, {"a": "x", "b": 1, "f": "SUP-12"}, {"a": "x", "b": 1, "f": "xSUP-123"},
    {"a": "x", "b": 1, "g": {"k": "v"}}, {"a": "x", "b": 1, "g": {"k": 1}}, [], "str", None, {"a": 1, "b": "1"},
]
schema_cases = []
for name, sch in SCHEMAS.items():
    for inst in INSTANCES:
        errs = validate_against(sch, inst)
        schema_cases.append({"schema": name, "instance": inst, "valid": not errs, "n_errors": len(errs),
                             "error_paths": sorted({e.split(":", 1)[0] for e in errs})})

write("canonical", {"canonical": canonical_cases, "floats": float_cases, "loads": loads_cases, "loads_bytes": bytes_cases,
                    "sha256": sha_cases, "hmac": hmac_cases})
write("jsonschema", {"schemas": SCHEMAS, "cases": schema_cases})
print(f"canonical: {len(canonical_cases)} values, {len(float_cases)} floats, {len(loads_cases)} loads; "
      f"jsonschema: {len(schema_cases)} cases")
