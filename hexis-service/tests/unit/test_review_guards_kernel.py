"""Regression tests for review findings on guards, canonical intake and kernel field scope."""

from __future__ import annotations

import pytest

from hexis_service import guards as G
from hexis_service.artifacts.package import FieldScope
from hexis_service.canonical import CanonicalError, canonical_bytes, digest, strict_loads
from hexis_service.runtime import kernel as K

from ..conftest import mini_package

END = lambda t: {"id": t, "action": {"kind": "end", "terminal": t}, "transitions": []}  # noqa: E731


# --------------------------------------------------------------------------- #
# Guards: disjointness analysis soundness (C00, C25, C01, C02)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("guards", [['"a" in tags', '"b" in tags'],
                                    ['"DOC-A" in tags', '"DOC-B" not in tags']])
def test_membership_in_array_variable_is_not_proven(guards):
    types = {"tags": "array"}
    assert all(G.typecheck(g, types) == [] for g in guards)
    assert G.analyze_disjoint(guards, types).status != "PROVEN"


def test_empty_nonempty_on_array_still_proven():
    assert G.analyze_disjoint(["empty(tags)", "nonempty(tags)"], {"tags": "array"}).status == "PROVEN"


@pytest.mark.parametrize("guards,types", [
    (["x > 1e20", "x > 5e19"], {"x": "number"}),
    (["n > 9007199254740993", "n > 9007199254740993"], {"n": "integer"}),
    (["n > 9007199254740993", "n < 9007199254740995"], {"n": "integer"}),
    (["x > 9007199254740993", "x < 9007199254740995"], {"x": "number"}),
    (["x > 1e300", "x > 1e299"], {"x": "number"}),
    (["x > 0.1", "x < 0.10000000000000003"], {"x": "number"}),
])
def test_large_or_close_constants_do_not_lose_precision(guards, types):
    an = G.analyze_disjoint(guards, types)
    assert an.status == "COUNTEREXAMPLE", an
    env = an.counterexample
    assert all(G.evaluate(g, env) for g in guards)


@pytest.mark.parametrize("guards,types", [
    (["x > 1e20", "x <= 1e20"], {"x": "number"}),
    (["n > 9007199254740993", "n <= 9007199254740993"], {"n": "integer"}),
    (["n > 2.5", "n < 3"], {"n": "integer"}),
    (["x > 0.1", "x < 0.1"], {"x": "number"}),
])
def test_disjoint_numeric_guards_still_proven(guards, types):
    assert G.analyze_disjoint(guards, types).status == "PROVEN"


def test_integer_between_non_integral_bounds_overlap_found():
    an = G.analyze_disjoint(["n > 2.5", "n < 3.5"], {"n": "integer"})
    assert an.status == "COUNTEREXAMPLE" and an.counterexample == {"n": 3}


@pytest.mark.parametrize("guards,types", [
    (["8.5 < x < 10", "x < 8.9"], {"x": "number"}),
    (["1 < n < 10", "n == 2"], {"n": "integer"}),
    (["0 <= x <= 5 < 100", "x > 4.5"], {"x": "number"}),
])
def test_chained_comparison_overlap_found(guards, types):
    # Regression: constants of all but the last operand pair of a chained comparison were
    # dropped, so overlapping guards were reported PROVEN.
    res = G.analyze_disjoint(guards, types)
    assert res.status == "COUNTEREXAMPLE"


def test_chained_comparison_disjoint_still_proven():
    assert G.analyze_disjoint(["0 <= x < 5", "5 <= x < 10"], {"x": "number"}).status == "PROVEN"


def test_huge_integer_literal_does_not_crash_analysis():
    big = "9" * 400
    an = G.analyze_disjoint([f"n > {big}", "n < 3"], {"n": "integer"})
    assert an.status == "PROVEN"
    an = G.analyze_disjoint([f"x > {big}", f"x > {big}0"], {"x": "number"})
    assert an.status == "COUNTEREXAMPLE"
    assert all(G.evaluate(g, an.counterexample) for g in [f"x > {big}", f"x > {big}0"])


# --------------------------------------------------------------------------- #
# Canonical intake (C05, C06)
# --------------------------------------------------------------------------- #
def test_deep_nesting_raises_canonical_error():
    for doc in ("[" * 100000 + "]" * 100000, ("[" * 100000 + "]" * 100000).encode()):
        with pytest.raises(CanonicalError):
            strict_loads(doc)


def test_huge_integers_raise_canonical_error():
    with pytest.raises(CanonicalError):
        strict_loads("1" * 5000)
    with pytest.raises(CanonicalError):
        digest(10 ** 5000)
    with pytest.raises(CanonicalError):
        strict_loads("1" * 4000)  # parses, but exceeds MAX_INT_BITS
    assert strict_loads("1" * 300) == int("1" * 300)


def test_lone_surrogate_key_rejected_at_intake():
    with pytest.raises(CanonicalError):
        strict_loads('{"\\ud800": 1}')
    with pytest.raises(CanonicalError):
        canonical_bytes({"\ud800": 1})


def test_key_length_bounded(monkeypatch):
    from hexis_service import canonical as C
    monkeypatch.setattr(C, "MAX_STRING", 4)
    with pytest.raises(CanonicalError):
        strict_loads('{"abcdef": 1}')


# --------------------------------------------------------------------------- #
# Kernel field scope (C03, C04)
# --------------------------------------------------------------------------- #
def _scoped_pkg(schema, issues=None):
    states = {"R": {"id": "R", "action": {"kind": "model", "prompt": "p", "reads": ["doc", "issues"],
                                          "writes": ["doc"]},
                    "transitions": [{"if": "", "to": "A"}]}, "A": END("E")}
    p = mini_package(states, [{"name": "doc", "type": "object", "init": {"a": "x", "locked": 1, "gone": None}},
                              {"name": "issues", "type": "array",
                               "init": issues if issues is not None else [{"field": "a"}]}],
                     {"doc": {"owner": "model", "schema": schema},
                      "issues": {"owner": "tool", "schema": {"type": "array"}}},
                     [{"id": "E", "kind": "unverified"}], {"E": {"category": "unverified"}}, "R")
    c = p.contracts.model_copy(update={"field_scoped_writes": {"R": FieldScope(variable="doc",
                                                                              allowed_fields_from="issues")}})
    return p.model_copy(update={"contracts": c})


def _advance(p, new):
    cp = K.initial_checkpoint(p, "t", "r", {})
    o = K.Observation(run_id="r", state_id="R", revision=0, kind="model", outputs={"doc": new})
    return K.advance(cp, o, p)


@pytest.mark.parametrize("new", [
    {"a": "y", "locked": 2, "gone": None},
    {"a": "y", "locked": True, "gone": None},
    {"a": "y", "locked": 1.0, "gone": None},
    {"a": "y", "locked": 1},
    {"a": "y", "locked": 1, "gone": None, "injected": None},
])
def test_field_scope_detects_type_changes_and_null_presence(new):
    with pytest.raises(K.KernelError) as ei:
        _advance(_scoped_pkg({"type": "object"}), new)
    assert ei.value.code == "FIELD_SCOPE_VIOLATION"


def test_field_scope_allows_in_scope_change():
    r = _advance(_scoped_pkg({"type": "object"}), {"a": "y", "locked": 1, "gone": None})
    assert r.checkpoint.variables["doc"] == {"a": "y", "locked": 1, "gone": None}


def test_field_scope_null_output_is_kernel_error():
    with pytest.raises(K.KernelError) as ei:
        _advance(_scoped_pkg({"type": ["object", "null"]}), None)
    assert ei.value.code == "FIELD_SCOPE_VIOLATION"


@pytest.mark.parametrize("issues,new", [
    ([{"field": "a"}, {"code": "global"}], {"a": "y", "locked": 2, "gone": None}),
    ([{"field": "a"}, {"field": ["x"]}], {"a": "y", "locked": 2, "gone": None}),
])
def test_field_scope_malformed_issues_is_kernel_error(issues, new):
    with pytest.raises(K.KernelError) as ei:
        _advance(_scoped_pkg({"type": "object"}, issues), new)
    assert ei.value.code == "FIELD_SCOPE_VIOLATION"
    assert ei.value.detail["fields"] == ["locked"]


def test_field_scope_malformed_issue_ignored_for_allowed_change():
    r = _advance(_scoped_pkg({"type": "object"}, [{"field": "a"}, {"field": ["x"]}]),
                 {"a": "y", "locked": 1, "gone": None})
    assert r.checkpoint.variables["doc"]["a"] == "y"
