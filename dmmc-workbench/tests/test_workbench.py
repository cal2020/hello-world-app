"""Unit tests. The scenario-level acceptance cases live in eval/run_eval.py and are run here too."""
import json
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("DMMC_NOW", "2026-09-23T15:00:00Z")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # also runnable as `python tests/test_workbench.py`

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
        doc = json.loads(run_eval.demo.MODEL_A.read_text())
        doc["flows"][0]["target"] = "cmp:nope"
        del doc["synthetic"]
        errs = importer.validate_model(doc)
        self.assertTrue(any("cmp:nope" in e for e in errs))
        self.assertTrue(any("synthetic" in e for e in errs))

    def test_fixture_models_are_valid(self):
        for m in (run_eval.demo.MODEL_A, run_eval.demo.MODEL_B):
            self.assertEqual(importer.validate_model(json.loads(Path(m).read_text())), [])


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



class WebAppTests(unittest.TestCase):
    """The transport-independent UI layer used by both the HTTP server and the browser build."""

    def setUp(self):
        import tempfile
        from workbench import demo
        from workbench.webapp import WebApp
        self._prev = os.environ.get("DMMC_DATA_DIR")
        self.dir = tempfile.mkdtemp(prefix="dmmc-webapp-")
        os.environ["DMMC_DATA_DIR"] = self.dir
        conn, _ = demo.reset()
        self.app = WebApp(conn)

    def tearDown(self):
        import shutil
        self.app.conn.close()
        shutil.rmtree(self.dir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("DMMC_DATA_DIR", None)
        else:
            os.environ["DMMC_DATA_DIR"] = self._prev

    def post(self, form, actor="bob", path="/act", referer="/"):
        return self.app.post(path, {"csrf": self.app.csrf, **form}, actor, referer)

    def test_csrf_required(self):
        r = self.app.post("/act", {"action": "reset"}, "bob", "/")
        self.assertEqual(r.status, 403)

    def test_whoami_sets_only_known_identities(self):
        self.assertEqual(self.post({"actor": "alice"}, path="/whoami").set_actor, "alice")
        self.assertEqual(self.post({"actor": "<script>"}, path="/whoami").set_actor, "bob")

    def test_demo_flow_and_pages(self):
        self.assertIn("Imported snap-001-A", self.post({"action": "import_model", "which": "A"}).location.replace("%20", " "))
        self.post({"action": "import_evidence", "which": "A"})
        r = self.post({"action": "build", "mode": "fixture"})
        self.assertTrue(r.location.startswith("/package/pkg-001-A"))
        for path in ("/", "/package/pkg-001-A", "/model", "/evidence", "/evidence/ev-tls-portal-api-a1", "/impact",
                     "/audit", "/eval", "/about"):
            self.assertEqual(self.app.get(path, "bob").status, 200, path)
        self.assertEqual(self.app.get("/package/nope", "bob").status, 404)
        self.assertEqual(self.app.get("/nowhere", "bob").status, 404)

    def test_denials_are_reported_not_raised(self):
        r = self.post({"action": "import_model", "which": "A"}, actor="mallory")
        self.assertIn("err=1", r.location)
        self.assertIn("wrong%20project", r.location)

    def test_file_route_cannot_escape_exports(self):
        for bad in ("/files/../workbench.db", "/files/%2e%2e/workbench.db", "/files/../../fixtures/models/maint-telemetry.vA.json"):
            self.assertEqual(self.app.get(bad, "bob").status, 404, bad)

    def test_redirects_stay_inside_the_app(self):
        r = self.post({"action": "nonsense"}, referer="https://evil.example/x")
        self.assertTrue(r.location.startswith("/"))
        r = self.post({"action": "build"}, actor="mallory", referer="//evil.example/x")
        self.assertTrue(r.location.startswith("/?") or r.location.startswith("/"))
        self.assertFalse(r.location.startswith("//"))

    def test_paste_import_validates_contract(self):
        r = self.post({"action": "import_model_json", "model_json": "{not json"})
        self.assertIn("ImportError_", r.location)
        from workbench import demo
        r = self.post({"action": "import_model_json", "model_json": demo.MODEL_A.read_text()})
        self.assertIn("Imported", r.location.replace("%20", " "))

    def test_html_is_escaped(self):
        import json as _json
        from workbench import demo
        doc = _json.loads(demo.MODEL_A.read_text())
        doc["elements"][0]["description"] = "<img src=x onerror=alert(1)>"
        doc["elements"][0]["attributes"]["note"] = "<script>alert(1)</script>"
        self.post({"action": "import_model_json", "model_json": _json.dumps(doc)})
        body = self.app.get("/model", "bob").body
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertNotIn("<img src=x", body)


class ReviewFindingRegressionTests(unittest.TestCase):
    """Regression tests for defects found by the multi-agent review of the browser build."""

    def setUp(self):
        import tempfile
        from workbench import demo
        from workbench.webapp import WebApp
        self._prev = os.environ.get("DMMC_DATA_DIR")
        self.dir = tempfile.mkdtemp(prefix="dmmc-reg-")
        os.environ["DMMC_DATA_DIR"] = self.dir
        conn, _ = demo.reset()
        self.app = WebApp(conn)

    def tearDown(self):
        import shutil
        self.app.conn.close()
        shutil.rmtree(self.dir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("DMMC_DATA_DIR", None)
        else:
            os.environ["DMMC_DATA_DIR"] = self._prev

    def post(self, form, actor="bob", path="/act", referer="/"):
        return self.app.post(path, {"csrf": self.app.csrf, **form}, actor, referer)

    def _model(self, **changes):
        from workbench import demo
        doc = json.loads(demo.MODEL_A.read_text())
        doc.update(changes)
        return json.dumps(doc)

    def test_revision_cannot_escape_or_inject(self):
        for rev in ("../../../../tmp/x", "a\r\nSet-Cookie: y", "v2 draft", "a/b", "x" * 65):
            r = self.post({"action": "import_model_json", "model_json": self._model(revision=rev)})
            self.assertIn("ImportError_", r.location, rev)
            self.assertNotIn("\n", r.location)

    def test_nesting_and_size_limits(self):
        from workbench import importer
        with self.assertRaises(importer.ImportError_):
            importer.parse_model(b"[" * 10000 + b"]" * 10000)
        with self.assertRaises(importer.ImportError_):
            importer.parse_model(b" " * (importer.MAX_MODEL_BYTES + 1))
        r = self.post({"action": "import_model_json", "model_json": "[" * 5000 + "]" * 5000})
        self.assertIn("nests", r.location)

    def test_whoami_redirect_stays_local(self):
        for ref in ("//evil.example/x", "/\\evil.example", "https://evil.example/", "/ok?c=1"):
            loc = self.post({"actor": "alice"}, path="/whoami", referer=ref).location
            self.assertTrue(loc.startswith("/") and not loc.startswith("//") and "\\" not in loc, (ref, loc))
        self.assertEqual(self.post({"actor": "alice"}, path="/whoami", referer="/ok?c=1").location, "/ok?c=1")

    def test_missing_form_field_message(self):
        r = self.post({"action": "review"})
        self.assertIn("Missing%20form%20field", r.location)

    def test_percent_encoded_paths_route(self):
        self.post({"action": "import_model", "which": "A"})
        self.post({"action": "import_evidence", "which": "A"})
        self.assertEqual(self.app.get("/evidence/ev%2Dtls%2Dportal%2Dapi%2Da1", "bob").status, 200)

    def test_undefined_decision_is_an_error_not_a_shifted_pass(self):
        import tempfile
        from workbench import opa
        d = Path(tempfile.mkdtemp())
        (d / "authz.rego").write_text(
            'package mtel.authz\n'
            'decision := {"allow": true, "reasons": ["r"]} if input.action == "read"\n')
        cases = [{"action": "read"}, {"action": "write"}, {"action": "read"}]
        if opa.backend() == "cli":
            with self.assertRaisesRegex(RuntimeError, "decision undefined"):
                opa.eval_decisions([str(d / "authz.rego")], "data.mtel.authz", cases)


if __name__ == "__main__":
    unittest.main()
