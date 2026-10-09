"""Content digests used for locks, manifests, media addressing, and run identity."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

_CHUNK = 1 << 20


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(_CHUNK):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(obj: Any) -> str:
    """Deterministic JSON text: sorted keys, no insignificant whitespace, UTF-8 preserved."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_json(obj: Any) -> str:
    return sha256_text(canonical_json(obj))


def tree_digest(entries: Iterable[tuple[str, str]]) -> str:
    """Digest of a file tree given (relative_path, sha256) pairs; order-independent."""
    h = hashlib.sha256()
    for rel, digest in sorted(entries):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(digest.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


def short(digest: str, n: int = 12) -> str:
    return digest[:n]
