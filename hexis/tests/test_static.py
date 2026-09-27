"""Static admission checks: A01-A04, A08, A11, A17 and mutation tests."""
import copy
import os
import tempfile
import unittest

from helpers import compiled_package, loaded, repackage

from hexis_service import app, canonical
from hexis_service import guards as G
from hexis_service.compiler import index_clauses
from hexis_service.validator import validate_package


def codes(pkg: dict, profile="production") -> set[str]:
    return validate_package(loaded(pkg), profile).codes()


def find(pkg: dict, code: str):
    return [f for f in validate_package(loaded(pkg)).findings if f.code == code]


class TestCompile(unittest.TestCase):
    def test_A01_reference_skill_compiles_and_every_clause_is_accounted_for(self):
        res = app.compile_example()
        self.assertTrue(res.ok)
        self.assertEqual(res.report["attempts"], 2, "first draft is rejected, repaired within budget")
        self.assertIn("GUARD_OVERLAP", {f["code"] for f in res.rejected_drafts[0]["findings"]})
        with open(app.example_path("SKILL.md"), "rb") as fh:
            skill = fh.read()
        clause_ids = {c["id"] for c in index_clauses(skill)}
        covered = {c["clause"] for c in res.report["coverage"]}
        self.assertEqual(clause_ids, covered)
        for c in res.package["source_manifest"]["clauses"]:
            s, e = c["span"]
            self.assertEqual(skill[s:e].decode(), c["text"], "quoted clause must match source bytes")
            if c["critical"] and c["coverage"]["classification"] == "executable_control":
                states = [x for x in res.report["coverage"] if x["clause"] == c["id"]][0]["states"]
                rules = [r for r in res.package["contracts"]["ordering"] if r["clause"] == c["id"]]
                self.assertTrue(states or rules, c["id"])
        self.assertEqual(res.report["validation"]["ok"], True)
        self.assertEqual(res.package["compiler_manifest"]["mode"], "fixture")

    def test_A01_repair_may_not_drop_a_protected_clause(self):
        fx = canonical.load_file(app.example_path("compiler_fixture.json"))
        fx["responses"][1]["patch"] = [{"op": "replace", "path": "/states/REPAIR_DRAFT/clause", "value": "drafting.1"}]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "fx.json")
            base = canonical.load_file(app.example_path("machine.efsm.json"))
            for name, doc in (("machine.efsm.json", base), ("fx.json", fx)):
                with open(os.path.join(d, name), "w") as fh:
                    fh.write(canonical.dumps_pretty(doc))
            from hexis_service.compiler import FixtureCompilerModel, compile_skill
            inp = app.load_example_inputs()
            res = compile_skill(app.example_path("SKILL.md"), inp["tool_catalog"], inp["contracts"],
                                inp["execution_policy"], FixtureCompilerModel(path), max_attempts=3)
        self.assertFalse(res.ok)
        self.assertIn("REPAIR_DROPPED_REQUIREMENT", {f["code"] for d in res.rejected_drafts for f in d["findings"]})

    def test_strict_json_rejects_duplicates_and_nan(self):
        with self.assertRaises(canonical.StrictJSONError):
            canonical.loads_strict('{"a": 1, "a": 2}')
        with self.assertRaises(canonical.StrictJSONError):
            canonical.loads_strict('{"a": NaN}')
        with self.assertRaises(canonical.StrictJSONError):
            canonical.loads_strict(b"\xef\xbb\xbf{}")


class TestStructure(unittest.TestCase):
    def setUp(self):
        self.pkg = compiled_package()

    def mutate(self, fn):
        m = copy.deepcopy(self.pkg["machine"])
        fn(m)
        return repackage(self.pkg, machine=m)

    def test_reference_package_is_clean(self):
        vr = validate_package(loaded(self.pkg))
        self.assertTrue(vr.ok, [f.__dict__ for f in vr.findings])
        self.assertTrue(all(a["result"] == G.PROVEN for a in vr.guard_analysis))

    def test_A02_unknown_state_tool_variable_terminal_duplicate(self):
        def unknown_state(m):
            m["states"]["LOOKUP_SUPPLIER"]["transitions"][0]["to"] = "NOWHERE"
        f = find(self.mutate(unknown_state), "UNKNOWN_STATE")
        self.assertEqual(f[0].location, "edge:LOOKUP_SUPPLIER[0]")

        def unknown_tool(m):
            m["states"]["READ_BACK"]["action"]["name"] = "erp.delete_everything"
        self.assertEqual(find(self.mutate(unknown_tool), "UNKNOWN_TOOL")[0].location, "state:READ_BACK")

        def unknown_var(m):
            m["states"]["EXTRACT_DRAFT"]["action"]["reads"].append("secret_bank_details")
        self.assertEqual(find(self.mutate(unknown_var), "UNKNOWN_VARIABLE")[0].location, "state:EXTRACT_DRAFT")

        def unknown_terminal(m):
            m["states"]["END_UNVERIFIED"]["action"]["terminal"] = "END_SOMETHING"
        self.assertEqual(find(self.mutate(unknown_terminal), "UNKNOWN_TERMINAL")[0].location, "state:END_UNVERIFIED")

        def dup_var(m):
            m["variables"].append({"name": "draft", "type": "object"})
        self.assertEqual(find(self.mutate(dup_var), "DUPLICATE_VARIABLE")[0].location, "variable:draft")
        with self.assertRaises(canonical.StrictJSONError):
            canonical.loads_strict('{"states": {"A": {}, "A": {}}}')

    def test_A03_guard_with_code_is_rejected_without_execution(self):
        with tempfile.TemporaryDirectory() as d:
            marker = os.path.join(d, "pwned")
            evil = [f'__import__("os").system("touch {marker}")', "draft.keys()", "len(draft) > 0",
                     "[x for x in documents]", "lambda: 1", "documents[0] == 1",
                     "not " * 20 + "flag", "exec('1')"]
            for g in evil:
                with self.assertRaises(G.GuardError, msg=g):
                    G.parse(g)
            m = copy.deepcopy(self.pkg["machine"])
            m["states"]["VALIDATE_DRAFT"]["transitions"][0]["if"] = evil[0]
            self.assertIn("GUARD_INVALID", codes(repackage(self.pkg, machine=m)))
            self.assertFalse(os.path.exists(marker))

    def test_guard_typing_rejects_bool_int_coercion(self):
        types = {"flag": "boolean", "n": "integer", "s": "string"}
        for g in ("flag == 1", "n == True", "n", "s < 3", "flag and n", 'n in ["1"]'):
            with self.assertRaises(G.GuardError, msg=g):
                G.typecheck(g, types)
        G.typecheck("flag == False and n >= 0", types)

    def test_A04_read_assigned_on_one_predecessor_only(self):
        def shortcut(m):
            m["states"]["LOOKUP_SUPPLIER"]["transitions"].insert(
                1, {"if": 'lookup_status == "existing_in_scope"', "to": "VALIDATE_DRAFT"})
        f = find(self.mutate(shortcut), "READ_NOT_ASSIGNED")
        self.assertTrue(any(x.location == "state:VALIDATE_DRAFT" and x.detail["variable"] == "draft" for x in f))

    def test_A08_overlapping_guards_rejected_with_counterexample(self):
        def overlap(m):
            m["states"]["VALIDATE_DRAFT"]["transitions"][1]["if"] = \
                'validation_status in ["repairable", "pass"] and repair_count < 2'
        f = find(self.mutate(overlap), "GUARD_OVERLAP")[0]
        self.assertEqual(f.detail["witness"]["validation_status"], "pass")

    def test_A08_undecidable_overlap_is_unknown_not_proof(self):
        r = G.disjoint("a < b", "a > b", {"a": "integer", "b": "integer"})
        self.assertEqual(r.result, G.UNKNOWN)

        def var_compare(m):
            m["states"]["READ_INTAKE"]["transitions"][1]["if"] = \
                'documents_status == "missing" and input_requests < repair_count'
        self.assertIn("GUARD_ANALYSIS_UNKNOWN", codes(self.mutate(var_compare)))

    def test_default_rules(self):
        def two_defaults(m):
            m["states"]["EXTRACT_DRAFT"]["transitions"].append({"if": "", "to": "FALLBACK"})
        self.assertIn("MULTIPLE_DEFAULTS", codes(self.mutate(two_defaults)))

        def no_default(m):
            m["states"]["LOOKUP_SUPPLIER"]["transitions"].pop()
        self.assertIn("DEFAULT_MISSING", codes(self.mutate(no_default)))

    def test_A11_cycle_that_avoids_the_bounded_backedge(self):
        def unbounded(m):
            m["states"]["VALIDATE_DRAFT"]["transitions"].insert(
                2, {"if": 'validation_status == "fail"', "to": "REPAIR_DRAFT"})
        f = find(self.mutate(unbounded), "UNBOUNDED_CYCLE")
        self.assertTrue(f and set(f[0].detail["states"]) == {"VALIDATE_DRAFT", "REPAIR_DRAFT"})

    def test_A17_shortcut_bypassing_validation_or_approval(self):
        def skip_validation(m):
            m["states"]["EXTRACT_DRAFT"]["transitions"][0]["to"] = "REQUEST_APPROVAL"
        bypass = find(self.mutate(skip_validation), "ORDERING_BYPASS")
        self.assertTrue(any("VALIDATE_DRAFT" in f.message for f in bypass))

        def skip_approval(m):
            m["states"]["VALIDATE_DRAFT"]["transitions"][0]["to"] = "PERSIST_DRAFT"
        cs = codes(self.mutate(skip_approval))
        self.assertIn("ORDERING_BYPASS", cs)
        self.assertIn("WRITE_WITHOUT_APPROVAL", cs)

    def test_ownership_model_cannot_write_engine_or_user_values(self):
        def model_writes_approval(m):
            m["states"]["EXTRACT_DRAFT"]["action"]["writes"].append("approval_decision")
        self.assertIn("WRITE_OWNERSHIP", codes(self.mutate(model_writes_approval)))

    def test_capability_ceiling(self):
        pol = copy.deepcopy(self.pkg["execution_policy"])
        pol["capability_ceiling"].remove("erp:draft:write")
        self.assertIn("CAPABILITY_EXCEEDS_CEILING", codes(repackage(self.pkg, policy=pol)))

    def test_A29_production_requires_stop_for_review_fallback(self):
        pol = copy.deepcopy(self.pkg["execution_policy"])
        pol["fallback_mode"] = "interpreted"
        self.assertIn("FALLBACK_MODE", codes(repackage(self.pkg, policy=pol)))


class TestMutations(unittest.TestCase):
    """Mutations that remove a verifier, widen a guard or drop a counter must be detected."""

    def setUp(self):
        self.pkg = compiled_package()

    def test_remove_verifier(self):
        m = copy.deepcopy(self.pkg["machine"])
        m["states"]["READ_BACK"]["transitions"][0]["to"] = "END_VERIFIED_DRAFT"
        self.assertIn("EVIDENCE_BYPASS", codes(repackage(self.pkg, machine=m)))

    def test_widen_guard(self):
        m = copy.deepcopy(self.pkg["machine"])
        m["states"]["READ_INTAKE"]["transitions"][0]["if"] = 'documents_status in ["available", "missing"]'
        self.assertIn("GUARD_OVERLAP", codes(repackage(self.pkg, machine=m)))

    def test_drop_counter_increment(self):
        m = copy.deepcopy(self.pkg["machine"])
        del m["states"]["VALIDATE_DRAFT"]["transitions"][1]["inc"]
        self.assertIn("UNBOUNDED_CYCLE", codes(repackage(self.pkg, machine=m)))

    def test_write_after_verification_invalidates_evidence_path(self):
        m = copy.deepcopy(self.pkg["machine"])
        rewrite = copy.deepcopy(m["states"]["PERSIST_DRAFT"])
        rewrite["id"] = "REWRITE"
        rewrite["transitions"] = [{"if": "", "to": "END_VERIFIED_DRAFT"}]
        m["states"]["REWRITE"] = rewrite
        m["states"]["VERIFY_PERSISTED"]["transitions"][0]["to"] = "REWRITE"
        found = find(repackage(self.pkg, machine=m), "EVIDENCE_STALE_PATH")
        self.assertTrue(any(f.detail["path"][0] == "REWRITE" for f in found))

    def test_tampered_package_hash(self):
        pkg = compiled_package()
        pkg["machine"]["states"]["VALIDATE_DRAFT"]["transitions"][1]["if"] = \
            'validation_status == "repairable" and repair_count < 3'
        from hexis_service.package import PackageError, load_package
        with self.assertRaises(PackageError):
            load_package(pkg)


if __name__ == "__main__":
    unittest.main()
