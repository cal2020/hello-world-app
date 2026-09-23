"""Small shared helpers: canonical JSON, digests, JSON Pointer, clock, ids."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone


def canonical(obj) -> bytes:
    """Deterministic JSON encoding used for every digest in the workbench."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def digest_obj(obj) -> str:
    return sha256(canonical(obj))


def short(d: str | None, n: int = 12) -> str:
    return (d or "")[:n]


def now() -> str:
    """UTC timestamp. DMMC_NOW pins the clock for deterministic tests and demos."""
    fixed = os.environ.get("DMMC_NOW")
    if fixed:
        return fixed
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# --- JSON Pointer (RFC 6901) -------------------------------------------------

def _unescape(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def _escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def pointer(*tokens) -> str:
    return "".join("/" + _escape(str(t)) for t in tokens)


class PointerError(LookupError):
    pass


def resolve_pointer(doc, ptr: str):
    if ptr == "":
        return doc
    if not ptr.startswith("/"):
        raise PointerError(f"invalid JSON Pointer: {ptr!r}")
    cur = doc
    for raw in ptr[1:].split("/"):
        tok = _unescape(raw)
        if isinstance(cur, list):
            if not tok.isdigit() or int(tok) >= len(cur):
                raise PointerError(f"pointer {ptr!r}: index {tok!r} out of range")
            cur = cur[int(tok)]
        elif isinstance(cur, dict):
            if tok not in cur:
                raise PointerError(f"pointer {ptr!r}: key {tok!r} not present")
            cur = cur[tok]
        else:
            raise PointerError(f"pointer {ptr!r}: cannot descend into scalar")
    return cur
