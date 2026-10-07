"""Stable identifiers derived from the import and AUDR identifiers."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Iterable

_SEP = "\x1f"


def _digest(*parts: str) -> str:
    return hashlib.sha256(_SEP.join(parts).encode("utf-8")).hexdigest()[:16]


def new_import_id() -> str:
    return f"imp_{secrets.token_hex(6)}"


def new_comparison_id() -> str:
    return f"cmp_{secrets.token_hex(6)}"


def run_pk(import_id: str, run_id: str) -> str:
    return f"run_{_digest(import_id, run_id)}"


def call_id(import_id: str, record_id: str) -> str:
    return f"call_{_digest(import_id, record_id)}"


def finding_id(
    import_id: str, category: str, record_ids: Iterable[str], run_ids: Iterable[str]
) -> str:
    """Same import, category and affected records give the same ID after re-analysis."""
    return "fnd_" + _digest(
        import_id, category, "\x1e".join(sorted(record_ids)), "\x1e".join(sorted(run_ids))
    )
