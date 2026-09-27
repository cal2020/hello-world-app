"""Pure kernel semantics: A06 (judge labels, privileged fields), A07, A09, A10 bounds, A30, properties."""
import copy
import random
import unittest

from helpers import loaded, tiny_package

from hexis_service import canonical, kernel


def judge_machine():
    states = {
        "J": {"id": "J", "action": {"kind": "judge", "prompt": "Is it relevant?", "reads": [], "writes": ["label"],
                                    "labels": ["yes", "no", "abstain"], "abstain": "abstain"},
              "transitions": [{"if": 'label == "yes"', "to": "M"}, {"if": 'label == "no"', "to": "OK_END"},
                              {"if": "", "to": "FALLBACK"}]},
        "M": {"id": "M", "action": {"kind": "model", "prompt": "facts", "reads": [], "writes": ["flag", "count", "note"],
                                    "observable": True},
              "transitions": [{"if": "flag == False and count == 0", "to": "OK_END"}, {"if": "", "to": "LOOP"}]},
        "LOOP": {"id": "LOOP", "action": {"kind": "model", "prompt": "retry", "reads": [], "writes": ["flag"],
                                          "observable": True},
                 "transitions": [{"if": "flag == True and tries < 2", "to": "LOOP", "inc": "tries"},
                                 {"if": "", "to": "OK_END"}]},
        "OK_END": {"id": "OK_END", "action": {"kind": "end", "terminal": "OK"}, "transitions": []},
    }
    variables = [{"name": "label", "type": "string"}, {"name": "flag", "type": "boolean"},
                 {"name": "count", "type": "integer"}, {"name": "note", "type": "string"},
                 {"name": "tries", "type": "integer", "init": 0}]
    contracts = {"label": {"owner": "model", "enum": ["yes", "no", "abstain"],
                           "schema": {"type": "string", "enum": ["yes", "no", "abstain"]}},
                 "flag": {"owner": "model", "schema": {"type": "boolean"}},
                 "count": {"owner": "model", "schema": {"type": "integer", "minimum": 0}},
                 "note": {"owner": "model", "schema": {"type": "string", "maxLength": 20}},
                 "tries": {"owner": "engine", "schema": {"type": "integer"}}}
    return loaded(tiny_package(states, variables, contracts, loop_bounds={"tries": 2}))


def obs(cp, kind, outputs, **extra):
    return {"kind": kind, "run_id": cp["run_id"], "state_id": cp["state_id"], "revision": cp["revision"],
            "outputs": outputs, "observed_at": 0, **extra}


class TestKernel(unittest.TestCase):
    def setUp(self):
        self.pkg = judge_machine()
        self.cp = kernel.initial_checkpoint(self.pkg, "T", "run", {})

    def test_reference_path(self):
        r = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "yes"}), self.pkg)
        self.assertEqual(r.checkpoint["state_id"], "M")
        self.assertEqual(r.event["edge_index"], 0)

    def test_A06_invalid_judge_label_goes_to_fallback_without_mutation(self):
        r = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "definitely"}), self.pkg)
        self.assertEqual(r.checkpoint["state_id"], "FALLBACK")
        self.assertTrue(r.checkpoint["assurance"]["entered_fallback"])
        self.assertNotIn("label", r.checkpoint["variables"])

    def test_A06_extra_privileged_fields_rejected(self):
        for bad in ({"label": "yes", "tries": 0}, {"label": "yes", "approved": True}):
            r = kernel.apply(self.cp, obs(self.cp, "judge", bad), self.pkg)
            self.assertEqual(r.checkpoint["state_id"], "FALLBACK")
            self.assertIn("unexpected output", r.checkpoint["diagnostic"]["message"])
            self.assertEqual(r.checkpoint["variables"], self.cp["variables"])

    def test_abstention_is_an_explicit_branch(self):
        r = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "abstain"}), self.pkg)
        self.assertEqual(r.checkpoint["state_id"], "FALLBACK")
        self.assertEqual(r.event["type"], "transition")

    def test_A07_false_zero_and_empty_are_valid_values(self):
        cp = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "yes"}), self.pkg).checkpoint
        r = kernel.apply(cp, obs(cp, "model", {"flag": False, "count": 0, "note": ""}), self.pkg)
        self.assertEqual(r.checkpoint["state_id"], "OK_END")
        self.assertIs(r.checkpoint["variables"]["flag"], False)
        self.assertEqual(r.checkpoint["variables"]["note"], "")

    def test_no_coercion_of_strings_or_ints(self):
        cp = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "yes"}), self.pkg).checkpoint
        for bad in ({"flag": "false", "count": 0, "note": ""}, {"flag": 0, "count": 0, "note": ""},
                    {"flag": False, "count": False, "note": ""}, {"flag": False, "count": 0}):
            r = kernel.apply(cp, obs(cp, "model", bad), self.pkg)
            self.assertEqual(r.checkpoint["state_id"], "FALLBACK", bad)

    def test_A09_undefined_variable_in_guard_stops_without_default(self):
        states = {"S": {"id": "S", "action": {"kind": "model", "prompt": "", "reads": [], "writes": ["a"]},
                        "transitions": [{"if": "b == 1", "to": "OK_END"}, {"if": "", "to": "FALLBACK"}]},
                  "OK_END": {"id": "OK_END", "action": {"kind": "end", "terminal": "OK"}, "transitions": []}}
        pkg = loaded(tiny_package(states, [{"name": "a", "type": "integer"}, {"name": "b", "type": "integer"}],
                                  {"a": {"owner": "model"}, "b": {"owner": "model"}}))
        cp = kernel.initial_checkpoint(pkg, "T", "run", {})
        r = kernel.apply(cp, obs(cp, "model", {"a": 1}), pkg)
        self.assertEqual(r.checkpoint["status"], "FAILED")
        self.assertEqual(r.checkpoint["diagnostic"]["code"], "GUARD_ERROR")
        self.assertEqual(r.checkpoint["state_id"], "S")

    def test_A10_loop_bound_boundaries_0_1_2(self):
        cp = kernel.apply(self.cp, obs(self.cp, "judge", {"label": "yes"}), self.pkg).checkpoint
        cp = kernel.apply(cp, obs(cp, "model", {"flag": True, "count": 1, "note": "x"}), self.pkg).checkpoint
        self.assertEqual((cp["state_id"], cp["variables"]["tries"]), ("LOOP", 0))
        seen = []
        for _ in range(3):
            cp = kernel.apply(cp, obs(cp, "model", {"flag": True}), self.pkg).checkpoint
            seen.append((cp["state_id"], cp["variables"]["tries"]))
        # guard sees the old counter; increment follows selection; bound 2 = two re-entries
        self.assertEqual(seen, [("LOOP", 1), ("LOOP", 2), ("OK_END", 2)])

    def test_engine_enforces_bound_even_if_guard_is_wrong(self):
        states = {"S": {"id": "S", "action": {"kind": "model", "prompt": "", "reads": [], "writes": ["a"]},
                        "transitions": [{"if": "a == 1", "to": "S", "inc": "c"}, {"if": "", "to": "OK_END"}]},
                  "OK_END": {"id": "OK_END", "action": {"kind": "end", "terminal": "OK"}, "transitions": []}}
        pkg = loaded(tiny_package(states, [{"name": "a", "type": "integer"}, {"name": "c", "type": "integer", "init": 0}],
                                  {"a": {"owner": "model"}, "c": {"owner": "engine"}}, loop_bounds={"c": 1}))
        cp = kernel.initial_checkpoint(pkg, "T", "run", {})
        cp = kernel.apply(cp, obs(cp, "model", {"a": 1}), pkg).checkpoint
        cp = kernel.apply(cp, obs(cp, "model", {"a": 1}), pkg).checkpoint
        self.assertEqual(cp["diagnostic"]["code"], "LOOP_BOUND_EXCEEDED")

    def test_observation_identity_is_checked(self):
        bad = obs(self.cp, "judge", {"label": "yes"})
        bad["revision"] = 7
        with self.assertRaises(kernel.KernelError):
            kernel.apply(self.cp, bad, self.pkg)

    def test_A30_same_checkpoint_and_observation_give_identical_results(self):
        o = obs(self.cp, "judge", {"label": "yes"})
        a = kernel.apply(copy.deepcopy(self.cp), copy.deepcopy(o), self.pkg)
        b = kernel.apply(copy.deepcopy(self.cp), copy.deepcopy(o), self.pkg)
        self.assertEqual(canonical.digest(a.checkpoint), canonical.digest(b.checkpoint))
        self.assertEqual(a.event, b.event)

    def test_property_random_walks_are_deterministic_and_monotonic(self):
        rnd = random.Random(20260926)
        labels = ["yes", "no", "abstain", "bogus"]
        for _ in range(300):
            seq, cp = [], self.cp
            outs = []
            while cp["status"] not in kernel.FINAL and cp["state_id"] not in ("OK_END", "FALLBACK") and len(outs) < 12:
                st = self.pkg.machine.states[cp["state_id"]].action
                if st.kind == "judge":
                    o = {"label": rnd.choice(labels)}
                elif cp["state_id"] == "M":
                    o = {"flag": rnd.choice([True, False]), "count": rnd.choice([0, 1]), "note": ""}
                else:
                    o = rnd.choice([{"flag": True}, {"flag": False}, {"flag": "x"}])
                outs.append((cp["state_id"], o))
                nxt = kernel.apply(cp, obs(cp, st.kind, o), self.pkg).checkpoint
                # monotonic revision, step budget and counter; writes confined to declared outputs
                self.assertEqual(nxt["revision"], cp["revision"] + 1)
                self.assertGreaterEqual(nxt["budget"]["used"]["steps"], cp["budget"]["used"]["steps"])
                self.assertGreaterEqual(nxt["variables"]["tries"], cp["variables"]["tries"])
                self.assertLessEqual(nxt["variables"]["tries"], 2)
                changed = {k for k in nxt["variables"] if nxt["variables"].get(k) != cp["variables"].get(k)}
                self.assertTrue(changed <= set(self.pkg.machine.states[cp["state_id"]].action.writes) | {"tries"})
                seq.append(canonical.digest(nxt))
                cp = nxt
            # replay the same observations: identical sequence of checkpoints
            cp2, seq2 = self.cp, []
            for sid, o in outs:
                st = self.pkg.machine.states[sid].action
                cp2 = kernel.apply(cp2, obs(cp2, st.kind, o), self.pkg).checkpoint
                seq2.append(canonical.digest(cp2))
            self.assertEqual(seq, seq2)

    def test_stable_serialization(self):
        a = canonical.canonical_bytes({"b": [3, 1], "a": {"y": 1, "x": "é"}})
        self.assertEqual(a, '{"a":{"x":"é","y":1},"b":[3,1]}'.encode())


if __name__ == "__main__":
    unittest.main()
