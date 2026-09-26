"""Compatibility with the pinned upstream implementation (Worldbuilder013/HEXIS@96be2719).

Upstream code is NOT vendored (license discrepancy, docs/SOURCES.md). These tests run only when
HEXIS_UPSTREAM_DIR points at a checkout of the pinned commit (and, for semantic comparison, when its
``hexis`` package is importable, e.g. ``PYTHONPATH=$HEXIS_UPSTREAM_DIR/src``). Otherwise they skip.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from hexis_service import guards as G
from hexis_service.artifacts.efsm import load_machine

UP = os.environ.get("HEXIS_UPSTREAM_DIR")
PINNED = "96be2719ee79fc5071dc7eb2aeed816dc03aaa6c"
pytestmark = pytest.mark.skipif(not UP, reason="HEXIS_UPSTREAM_DIR not set (upstream checkout not supplied)")


def test_pinned_commit():
    head = subprocess.run(["git", "-C", UP, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert head == PINNED


@pytest.mark.parametrize("name", ["spreadsheet", "dabench", "livemath", "sealqa"])
def test_upstream_example_machines_round_trip(name):
    data = json.loads((Path(UP) / "examples" / "machines" / name / "machine.json").read_text())
    assert load_machine(data).to_json() == data


GUARDS = [("x == 'a'", {"x": "a"}), ("n < 3 and not ok", {"n": 2, "ok": False}), ("x in ['a', 'b']", {"x": "c"}),
          ("empty(items) or n >= 5", {"items": [], "n": 1}), ("nonempty(s)", {"s": "z"}), ("1 < n < 4", {"n": 3})]


@pytest.mark.parametrize("expr,env", GUARDS)
def test_guard_semantics_match_upstream_on_shared_subset(expr, env):
    cond = pytest.importorskip("hexis.machine.cond")
    assert G.evaluate(expr, env) == cond.evaluate(expr, env)


def test_intentional_difference_undefined_and_coercion():
    cond = pytest.importorskip("hexis.machine.cond")
    with pytest.raises(cond.CondError):
        cond.evaluate("ghost == 1", {})
    with pytest.raises(G.GuardError):
        G.evaluate("ghost == 1", {})
    # Intentional difference: upstream compares True == 1 as true; the production profile rejects it.
    assert cond.evaluate("flag == 1", {"flag": True}) is True
    with pytest.raises(G.GuardError):
        G.evaluate("flag == 1", {"flag": True})
