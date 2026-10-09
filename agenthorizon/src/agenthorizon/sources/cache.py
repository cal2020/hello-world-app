"""Read files from pinned source checkouts, verifying digests against SOURCE_LOCK.json when present."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from agenthorizon.config import PROJECT_ROOT, get_settings
from agenthorizon.sources.gitsource import GitCheckout, ensure_checkout
from agenthorizon.sources.lock import KNOWN_PINS, SHALLOW_SOURCES
from agenthorizon.sources.registry import get_source
from agenthorizon.util.hashing import sha256_file

LOCK_PATH = PROJECT_ROOT / "evidence" / "SOURCE_LOCK.json"


class PinnedFileError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def load_lock(path: str | None = None) -> dict | None:
    p = Path(path) if path else LOCK_PATH
    if not p.is_file():
        return None
    return json.loads(p.read_text())


def locked_revision(source_id: str) -> str | None:
    lock = load_lock()
    if lock:
        for s in lock["sources"]:
            if s["source_id"] == source_id and s.get("resolved_revision"):
                return s["resolved_revision"]
    return KNOWN_PINS.get(source_id)


def locked_file_digest(source_id: str, rel: str) -> str | None:
    lock = load_lock()
    if not lock:
        return None
    for s in lock["sources"]:
        if s["source_id"] == source_id:
            for f in s.get("files", []):
                if f["path"] == rel:
                    return f["sha256"]
    return None


def checkout(source_id: str) -> GitCheckout:
    spec = get_source(source_id)
    rev = locked_revision(source_id)
    if not rev:
        raise PinnedFileError(f"no pinned revision for {source_id}; run `agenthorizon sources lock`")
    return ensure_checkout(spec.urls[0], rev, get_settings().sources_dir, shallow=source_id in SHALLOW_SOURCES)


def pinned_file(source_id: str, rel: str) -> Path:
    """Path to ``rel`` in the pinned checkout of ``source_id``; raises if its digest disagrees with the lock."""
    co = checkout(source_id)
    p = co.file(rel)
    want = locked_file_digest(source_id, rel)
    if want is not None:
        got = sha256_file(p)
        if got != want:
            raise PinnedFileError(f"{source_id}:{rel} digest {got} != locked {want}")
    return p


def provenance(source_id: str, rel: str, lines: tuple[int, int] | None = None) -> dict:
    p = pinned_file(source_id, rel)
    out = {"source_id": source_id, "revision": locked_revision(source_id), "path": rel, "sha256": sha256_file(p)}
    if lines:
        out["lines"] = list(lines)
    return out
