"""Scorer correctness: hand-calculated fixture, oracles, denominators, IDs, and category scoring.

All examples here are synthetic test data.
"""

from __future__ import annotations

import json
from fractions import Fraction

import pytest

from agenthorizon.judging.parsing import parse_agentic, validate_object
from agenthorizon.scoring.categories import Category
from agenthorizon.scoring.protocol import (
    GoldItem,
    PredictionSet,
    ScoringError,
    ScoringManifest,
    SelectedPrediction,
    score,
    score_with_selection,
)

DV = "test-dataset@1"


def manifest(items: list[tuple[str, str, Category | None]], mid: str = "m") -> ScoringManifest:
    return ScoringManifest(mid, DV, tuple(GoldItem(i, lab, cat) for i, lab, cat in items), official=False)


def pred(eid: str, obj: dict | str | None) -> SelectedPrediction:
    if isinstance(obj, str):
        return SelectedPrediction(eid, parse_agentic(obj))
    return SelectedPrediction(eid, validate_object(obj, parser="test"))


def pset(records: list[SelectedPrediction], known: set[str]) -> PredictionSet:
    return PredictionSet("p", DV, frozenset(known), records)


def test_hand_fixture_two_positive_two_negative():
    """MP §13: pos1 accepted, pos2 missing; neg1 rejected, neg2 emits a string instead of a Boolean."""
    m = manifest([("pos1", "positive", None), ("pos2", "positive", None),
                  ("neg1", "negative", Category.CRITICAL), ("neg2", "negative", Category.SIDE_EFFECT)])
    ps = pset([
        pred("pos1", {"success": True, "reasoning": "r", "confidence": "high", "mistake_type": None}),
        pred("neg1", {"success": False, "reasoning": "r", "confidence": "high", "mistake_type": "Critical Mistake"}),
        pred("neg2", {"success": "false", "reasoning": "r", "confidence": "low", "mistake_type": "Bad Side Effect"}),
    ], known={"pos1", "pos2", "neg1", "neg2"})
    r = score(m, ps)
    met = r["metrics"]
    assert (met["positive_accuracy"]["numerator"], met["positive_accuracy"]["denominator"]) == (1, 2)
    assert (met["negative_accuracy"]["numerator"], met["negative_accuracy"]["denominator"]) == (1, 2)
    assert Fraction(met["balanced_accuracy"]["numerator"], met["balanced_accuracy"]["denominator"]) == Fraction(1, 2)
    assert met["balanced_accuracy"]["display_pct"] == "50.0"
    c = r["confusion"]
    assert c["missing_positive"] == 1 and c["invalid_positive"] == {}
    assert c["invalid_negative"] == {"success_not_boolean:str": 1} and c["missing_negative"] == 0
    assert c["TP"] == 1 and c["TN"] == 1 and c["FN_valid"] == 0 and c["FP_valid"] == 0
    # the string verdict is never coerced into a valid failure prediction
    assert r["mistake_type_recall"]["bad_side_effect"]["numerator"] == 0
    assert r["mistake_type_recall"]["critical_mistake"]["numerator"] == 1
    assert r["coverage"]["complete"] is False


def _both_classes():
    return manifest([(f"p{i}", "positive", None) for i in range(3)]
                    + [(f"n{i}", "negative", Category.CRITICAL) for i in range(5)])


@pytest.mark.parametrize("policy,expected", [
    ("perfect", Fraction(1)),
    ("always_positive", Fraction(1, 2)),
    ("always_negative", Fraction(1, 2)),
    ("all_invalid", Fraction(0)),
    ("all_missing", Fraction(0)),
])
def test_score_oracles(policy, expected):
    m = _both_classes()
    recs = []
    for it in m.items:
        if policy == "perfect":
            s = it.label == "positive"
        elif policy == "always_positive":
            s = True
        elif policy == "always_negative":
            s = False
        elif policy == "all_invalid":
            recs.append(pred(it.example_id, "I think it failed."))
            continue
        else:
            continue
        recs.append(pred(it.example_id, {"success": s, "reasoning": "r", "confidence": "high",
                                         "mistake_type": None if s else "Critical Mistake"}))
    r = score(m, pset(recs, {i.example_id for i in m.items}))
    b = r["metrics"]["balanced_accuracy"]
    assert Fraction(b["numerator"], b["denominator"]) == expected
    assert r["manifest"]["P"] == 3 and r["manifest"]["N"] == 5  # denominators never shrink


def test_duplicate_unknown_and_version_mismatch_are_rejected():
    m = manifest([("a", "positive", None), ("b", "negative", None)])
    ok = {"success": True, "reasoning": "r", "confidence": "low", "mistake_type": None}
    with pytest.raises(ScoringError, match="duplicate prediction"):
        score(m, pset([pred("a", ok), pred("a", ok)], {"a", "b"}))
    with pytest.raises(ScoringError, match="not in dataset version"):
        score(m, pset([pred("zzz", ok)], {"a", "b"}))
    with pytest.raises(ScoringError, match="dataset version mismatch"):
        score(m, PredictionSet("p", "other@2", frozenset({"a", "b"}), [pred("a", ok)]))
    with pytest.raises(ScoringError, match="duplicate example ids"):
        manifest([("a", "positive", None), ("a", "negative", None)])


def test_out_of_manifest_predictions_are_ignored_not_counted():
    m = manifest([("a", "positive", None), ("b", "negative", None)])
    ok = {"success": True, "reasoning": "r", "confidence": "low", "mistake_type": None}
    r = score(m, pset([pred("a", ok), pred("c", ok)], {"a", "b", "c"}))
    assert r["predictions"]["out_of_manifest_ignored"] == 1
    assert r["manifest"]["n_items"] == 2


def test_category_scoring_requires_valid_failure_and_exact_match():
    m = manifest([
        ("n_crit", "negative", Category.CRITICAL),
        ("n_side", "negative", Category.SIDE_EFFECT),
        ("n_mis", "negative", Category.MISUNDERSTANDING),
        ("n_untyped", "negative", None),
        ("p", "positive", None),
    ])
    recs = [
        # success=true with a category: binary FP and never an MT hit
        pred("n_crit", {"success": True, "reasoning": "r", "confidence": "low", "mistake_type": "Critical Mistake"}),
        # valid failure, wrong category: binary TN, MT miss
        pred("n_side", {"success": False, "reasoning": "r", "confidence": "low", "mistake_type": "Critical Mistake"}),
        # plural native spelling is the same category under ah-categories-v1
        pred("n_mis", {"success": False, "reasoning": "r", "confidence": "low",
                       "mistake_type": "Misunderstanding of the Instructions"}),
        pred("n_untyped", {"success": False, "reasoning": "r", "confidence": "low", "mistake_type": "Bad Side Effect"}),
        pred("p", {"success": True, "reasoning": "r", "confidence": "low", "mistake_type": None}),
    ]
    r = score(m, pset(recs, {i.example_id for i in m.items}))
    mt = r["mistake_type_recall"]
    assert mt["critical_mistake"]["numerator"] == 0 and mt["critical_mistake"]["denominator"] == 1
    assert mt["bad_side_effect"]["numerator"] == 0 and mt["bad_side_effect"]["denominator"] == 1
    assert mt["misunderstanding_of_the_instruction"]["numerator"] == 1
    # untyped negatives: in binary denominators, excluded from typed denominators
    assert r["manifest"]["N"] == 4 and r["manifest"]["typed_negatives"] == 3 and r["manifest"]["untyped_negatives"] == 1
    assert (mt["aggregate_typed_micro"]["numerator"], mt["aggregate_typed_micro"]["denominator"]) == (1, 3)
    assert r["confusion"]["TN"] == 3 and r["confusion"]["FP_valid"] == 1


def test_fuzzy_category_strings_are_not_matched():
    m = manifest([("n", "negative", Category.MISUNDERSTANDING)])
    r = score(m, pset([pred("n", {"success": False, "reasoning": "r", "confidence": "low",
                                  "mistake_type": "misunderstanding"})], {"n"}))
    assert r["mistake_type_recall"]["misunderstanding_of_the_instruction"]["numerator"] == 0
    assert r["confusion"]["TN"] == 1  # binary verdict still valid


def test_balanced_accuracy_is_exact_fraction():
    m = manifest([(f"p{i}", "positive", None) for i in range(3)] + [(f"n{i}", "negative", None) for i in range(7)])
    recs = [pred("p0", {"success": True}), pred("n0", {"success": False}), pred("n1", {"success": False})]
    r = score(m, pset(recs, {i.example_id for i in m.items}))
    b = r["metrics"]["balanced_accuracy"]
    assert Fraction(b["numerator"], b["denominator"]) == Fraction(1, 2) * (Fraction(1, 3) + Fraction(2, 7))


def test_absence_of_optional_commentary_does_not_change_binary_score():
    m = manifest([("p", "positive", None), ("n", "negative", None)])
    bare = score(m, pset([pred("p", {"success": True}), pred("n", {"success": False})], {"p", "n"}))
    full = score(m, pset([pred("p", {"success": True, "reasoning": "x", "confidence": "high", "mistake_type": None}),
                          pred("n", {"success": False, "reasoning": "x", "confidence": "high",
                                     "mistake_type": "Critical Mistake"})], {"p", "n"}))
    assert bare["metrics"] == full["metrics"]
    assert bare["validity"]["full_contract_valid"] == 0 and full["validity"]["full_contract_valid"] == 2


def test_selection_subset_is_labelled_and_canonical_counts_missing():
    m = manifest([("p1", "positive", None), ("p2", "positive", None), ("n1", "negative", None), ("n2", "negative", None)])
    recs = [pred("p1", {"success": True}), pred("n1", {"success": False})]
    out = score_with_selection(m, pset(recs, {i.example_id for i in m.items}), {"p1", "n1"})
    assert out["canonical_full_manifest"]["metrics"]["balanced_accuracy"]["display_pct"] == "50.0"
    assert out["selection_subset"]["metrics"]["balanced_accuracy"]["display_pct"] == "100.0"
    assert "not the benchmark result" in out["selection_subset"]["label"]


def test_report_is_deterministic():
    m = _both_classes()
    recs = [pred(i.example_id, {"success": i.label == "positive"}) for i in m.items]
    a = score(m, pset(recs, {i.example_id for i in m.items}))
    b = score(m, pset(list(reversed(recs)), {i.example_id for i in m.items}))
    assert a["report_digest"] == b["report_digest"]
    json.dumps(a)  # serialisable
