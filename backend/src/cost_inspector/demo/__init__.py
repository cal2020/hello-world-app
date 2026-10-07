"""Synthetic demo imports. All records are fictional and documented in README.md here."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from ..config import Settings
from ..importer import import_bytes
from ..store import Store

DEMO_DIR = Path(__file__).parent

#: (demo_key, file name) in import order.
DEMO_FILES = (
    ("support-before", "support-agent-before.jsonl"),
    ("support-after", "support-agent-after.jsonl"),
    ("partial-telemetry", "nightly-digest-partial-telemetry.jsonl"),
)


def seed_demo(store: Store, settings: Settings) -> dict[str, Any]:
    """Import each demo file that is not already present (matched by content hash)."""
    created: list[str] = []
    import_ids: dict[str, str] = {}
    for key, filename in DEMO_FILES:
        data = (DEMO_DIR / filename).read_bytes()
        existing = store.find_import_by_sha(hashlib.sha256(data).hexdigest())
        if existing:
            import_ids[key] = existing
            continue
        summary = import_bytes(
            store, settings, data, filename, source="demo", synthetic=True, demo_key=key
        )
        import_ids[key] = summary.import_id
        created.append(summary.import_id)

    def first_run(key: str) -> str | None:
        runs = store.list_runs(import_ids[key])
        return runs[0].id if runs else None

    return {
        "imports": import_ids,
        "created": created,
        "suggested_comparison": {
            "baseline_run_id": first_run("support-before"),
            "candidate_run_id": first_run("support-after"),
        },
    }


def remove_demo(store: Store) -> int:
    return store.delete_all(demo_only=True)
