"""Unit tests. The scenario-level acceptance cases live in eval/run_eval.py and are run here too."""
import json
import os
import unittest

os.environ.setdefault("DMMC_NOW", "2026-09-23T15:00:00Z")

from workbench import importer, util  # noqa: E402
from workbench.drafting import PROHIBITED, _sentences_with  # noqa: E402
from eval import run_eval  # noqa: E402


class PointerTests(unittest.TestCase):
    def test_resolves_and_escapes(self):
        doc = {"a/b": [{"~k": 1}]}
        self.assertEqual(util.resolve_pointer(doc, "/a~1b/0/~0k"), 1)
        self.assertEqual(util.pointer("a/b", 0, "~k"), "/a~1b/0/~0k")

    def test_out_of_range_raises(self):
        with self.assertRaises(util.PointerError):
            util.resolve_pointer({"x": [1]}, "/x/5")


class ImportContractTests(unittest.TestCase):
    def test_rejects_dangling_flow_and_missing_synthetic_flag(self):
        doc = json.loads(open(run_eval.demo.MODEL_A).read())
        doc["flows"][0]["target"] = "cmp:nope"
        del doc["synthetic"]
        errs = importer.validate_model(doc)
        self.assertTrue(any("cmp:nope" in e for e in errs))
        self.assertTrue(any("synthetic" in e for e in errs))

    def test_fixture_models_are_valid(self):
        for m in (run_eval.demo.MODEL_A, run_eval.demo.MODEL_B):
            self.assertEqual(importer.validate_model(json.loads(open(m).read())), [])


class ValidatorRuleTests(unittest.TestCase):
    def flagged(self, text):
        return [why for rx, why in PROHIBITED if rx.search(text)]

    def test_prohibited(self):
        self.assertTrue(self.flagged("See CVE-2024-3094."))
        self.assertTrue(self.flagged("The system is compliant."))
        self.assertTrue(self.flagged("SC-8 is satisfied."))
        self.assertTrue(self.flagged("The package has been approved."))
        self.assertTrue(self.flagged("67% of controls"))

    def test_allowed(self):
        self.assertFalse(self.flagged("It is not a statement about control effectiveness."))
        self.assertFalse(self.flagged("The model asserts transport protection 'TLS'."))

    def test_sentence_offsets_keep_version_numbers(self):
        t = "Intro.\n\nUse TLS 1.2 or later. Other."
        self.assertEqual([t[a:b] for a, b in _sentences_with(t, "TLS")], ["Use TLS 1.2 or later."])


class AcceptanceCases(unittest.TestCase):
    pass


def _make(cid, fn):
    def t(self):
        fails = []
        fn(fails)
        self.assertEqual(fails, [], cid)
    return t


for _cid, _title, _fn in run_eval.CASES:
    setattr(AcceptanceCases, f"test_{_cid}", _make(_cid, _fn))

if __name__ == "__main__":
    unittest.main()
