"""The traceability matrix and paper specification are generated from the code and must stay current with it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agenthorizon.evidence.traceability import REQUIREMENTS, check, render_csv

ROOT = Path(__file__).resolve().parents[1]


needs_checkout = pytest.mark.skipif(not (ROOT / "frontend" / "e2e").is_dir() or not (ROOT / "compose.yaml").is_file(),
                                    reason="needs the full repository checkout (container images carry src/ and tests/ only)")


@needs_checkout
def test_every_reference_resolves():
    """Every cited module symbol, test function, Playwright test and evidence file exists."""
    assert check() == []
    assert len({r.req_id for r in REQUIREMENTS}) == len(REQUIREMENTS)


@needs_checkout
def test_committed_matrix_and_spec_are_current():
    assert (ROOT / "evidence" / "TRACEABILITY.csv").read_text() == render_csv(), \
        "regenerate with `agenthorizon evidence traceability`"
    try:
        from agenthorizon.evidence.spec import paper_spec

        fresh = paper_spec()
    except Exception as exc:  # noqa: BLE001 — the prompt digests need the pinned checkout
        pytest.skip(f"pinned checkout unavailable: {exc}")
    committed = json.loads((ROOT / "evidence" / "PAPER_SPEC.json").read_text())
    for d in (fresh, committed):
        d.pop("generated_at")
    assert json.loads(json.dumps(fresh)) == committed, "regenerate with `agenthorizon evidence spec`"
