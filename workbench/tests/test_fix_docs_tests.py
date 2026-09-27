"""Regression tests for docs, test-oracle and evaluation findings (cluster C6). Each test names the finding index
it covers. Doc checks tie a claim in the Markdown to the code it describes, so the two cannot drift apart silently."""
import copy
import inspect
import json
import os
import pathlib
import re
import sys
import tempfile
import types
import unittest
from unittest import mock

from lucidwb import authz, links, projection, stack
from lucidwb.util import digest
from scripts import evaluate
from tests import test_integration
from tests.helpers import ROOT, StackCase

DOCS = pathlib.Path(ROOT)


def doc(name):
    return (DOCS / name).read_text()


def demo_rows():
    """(time, 'What I say', 'What I show / do') for each row of the DEMO_SCRIPT table."""
    rows = []
    for line in doc("DEMO_SCRIPT.md").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 6 and re.match(r"\d:\d\d", cells[0]):
            rows.append(tuple(cells[:3]))
    return rows


def run_quietly(test):
    result = unittest.TestResult()
    test.run(result)
    return result


class DocClaims(unittest.TestCase):
    # ------------------------------------------------------------ 27
    def test_f27_demo_script_steps_are_done_by_an_identity_allowed_to_do_them(self):
        grants = {u[2]: {perm for project, perm in u[4] if project == "ehm"} for u in authz.DEMO_USERS}
        needs = {"Import": "import", "Build": "release:manage", "checks": "release:manage",
                 "Activate": "release:manage", "Approve": "projection:review", "Run deterministic": "link:review",
                 "Reject": "link:review", "accept": links.DECISIONS["accept"], "Accept": links.DECISIONS["accept"],
                 "Outbox": "release:manage", "Inject": "release:manage"}
        index = doc("web/index.html")
        who = re.search(r'<option value="([^"]+)" selected>', index).group(1)  # the UI's starting identity
        steps = 0
        for when, _, cell in demo_rows():
            for m in re.finditer(r"demo-[a-z]+|" + "|".join(rf"\b{re.escape(k)}\b" for k in needs), cell):
                if m.group().startswith("demo-"):
                    who = m.group()
                    continue
                steps += 1
                self.assertIn(needs[m.group()], grants[who], f"{when}: '{m.group()}' as {who}")
        self.assertGreater(steps, 10)
        # The activation retry replays only if the request carried a key, and the UI sends none by default.
        self.assertNotRegex(index, r'id="send-idem"[^>]*checked')
        self.assertIn("tick **send Idempotency-Key**", doc("DEMO_SCRIPT.md"))

    # ------------------------------------------------------------ 28
    def test_f28_docs_do_not_deny_the_container_deployment(self):
        self.assertNotIn("container or disconnected-environment deployment was performed", doc("ARCHITECTURE.md"))
        self.assertIn("A container build and run were verified", doc("ARCHITECTURE.md"))
        self.assertNotIn("Nothing here was deployed to a cloud", doc("README.md"))
        self.assertIn("Railway", re.search(r"To host it.*", doc("README.md")).group())
        self.assertNotIn("any deployment beyond the local machine", doc("DEMO_SCRIPT.md"))
        self.assertNotIn("no cloud deployment has been made", doc("DEPLOY.md"))

    # ------------------------------------------------------------ 45
    def test_f45_docker_host_option_publishes_on_loopback_only(self):
        blocks = "\n".join(re.findall(r"```sh\n(.*?)```", doc("DEPLOY.md"), re.S))
        runs = re.findall(r"docker run[^\n]*(?:\\\n[^\n]*)*", blocks)
        self.assertTrue(runs)
        for cmd in runs:
            ports = re.findall(r"-p\s+(\S+)", cmd)
            self.assertTrue(ports and all(p.startswith("127.0.0.1:") for p in ports), cmd)

    # ------------------------------------------------------------ 49
    def test_f49_docs_hard_code_no_test_count(self):
        for name in ("README.md", "DEPLOY.md", "DEMO_SCRIPT.md", "ARCHITECTURE.md"):
            self.assertIsNone(re.search(r"\b\d+ (automated )?tests\b", doc(name)), name)

    # ------------------------------------------------------------ 50
    def test_f50_model_output_boundary_names_every_field_the_validator_keeps(self):
        kept = re.search(r"allowed_keys = \{([^}]*)\}", inspect.getsource(links._store_candidate)).group(1)
        kept = set(re.findall(r'"(\w+)"', kept))
        words = {"record_id": "record ID", "element_id": "element ID", "predicate": "predicate",
                 "evidence": "evidence", "contradictions": "contradiction", "confidence": "confidence",
                 "method_detail": "`method_detail`", "rationale": "`rationale`"}
        self.assertEqual(kept, set(words))
        bullet = re.search(r"\* \*\*Proposer output → validator\.\*\*.*", doc("ARCHITECTURE.md")).group()
        for key in sorted(kept):
            self.assertIn(words[key], bullet, key)
        self.assertIn("ignored_model_field", bullet)

    # ------------------------------------------------------------ 51
    def test_f51_relation_mapping_is_part_of_the_contract_and_field_mapping_is_not(self):
        base = json.loads((DOCS / "fixtures/projections/equipment-health_1.0.0.json").read_text())
        field, relation = copy.deepcopy(base), copy.deepcopy(base)
        field["resources"]["sensors"]["fields"]["serialNumber"]["from"] = "properties.assetSerial"
        relation["resources"]["sensors"]["relations"]["gateway"]["predicate"] = "reportsTo"
        d = lambda p: digest(projection.generate_contract(p))  # noqa: E731 (as release.build_candidate digests it)
        self.assertEqual(d(field), d(base))
        self.assertNotEqual(d(relation), d(base))
        self.assertIn("`x-relation`", doc("ARCHITECTURE.md"))
        self.assertIn("`x-relation`", projection.generate_contract.__doc__)
        self.assertNotIn("not from source mappings", doc("ARCHITECTURE.md"))

    # ------------------------------------------------------------ 52
    def test_f52_428_is_cited_from_rfc_6585(self):
        refs = doc("ARCHITECTURE.md").split("## Reference basis")[1]
        self.assertNotRegex(refs, r"RFC 9110[^\n]*428")
        self.assertRegex(refs, r"RFC 6585[^\n]*428")

    # ------------------------------------------------------------ 53
    def test_f53_consumer_is_documented_as_part_of_the_workbench_process(self):
        arch = doc("ARCHITECTURE.md")
        self.assertNotIn("Mock consumer process", arch)
        self.assertIn('subgraph PROC["One Python process', arch)
        self.assertNotIn("two processes", inspect.getsource(stack))

    # ------------------------------------------------------------ 54
    def test_f54_demo_script_claims_no_model_capability(self):
        self.assertNotIn("model path can find aliases", doc("DEMO_SCRIPT.md"))
        _, said, shown = next(r for r in demo_rows() if r[0].startswith("1:50"))
        self.assertIn("fixture-model", shown)
        self.assertIn("The model path here is scripted", said)

    # ------------------------------------------------------------ 55
    def test_f55_each_dated_verification_list_describes_the_image_of_its_date(self):
        text = doc("DEPLOY.md")
        sections = dict(re.findall(r"\*\*(2026-\d\d-\d\d)[^\n]*\n(.*?)(?=\n\*\*2026-|\n\*\*Tests|\n## )", text, re.S))
        self.assertEqual(sorted(sections), ["2026-09-24", "2026-09-25", "2026-09-27"])
        # scripts/entrypoint.sh (root start, then setpriv) was added on 2026-09-25.
        self.assertNotIn("starts as root", sections["2026-09-24"])
        self.assertIn("entrypoint", sections["2026-09-25"])


class EvaluationReport(unittest.TestCase):
    def report(self, **r):
        base = {"generated_at": "t", "code_version": "v", "python": "3.11", "platform": "Linux",
                "live_requested": False, "tests": {"ran": 0, "failed": [], "skipped": 0, "cases": []},
                "relationships": {}, "timings": {}}
        path = pathlib.Path(tempfile.mkdtemp(prefix="lwb-eval-report-")) / "EVALUATION.md"
        evaluate.write_report(dict(base, **r), path)
        return path.read_text()

    # ------------------------------------------------------------ 29
    def test_f29_gold_counts_and_live_status_come_from_the_run(self):
        labels = [g for s in evaluate.GOLD["splits"].values() for g in s["labels"].values()]
        text = self.report()
        self.assertIn(f"{len(labels)} records: ", text)
        self.assertIn(f"including {labels.count(None)} records where the correct answer is *no link*", text)
        self.assertIn("**Not run**: `LWB_EVAL_LIVE=1` was not set", text)
        self.assertNotIn("no credentials configured", text)
        failed = {"dev": {"model:live": {"status": "failed", "error": "Model API credentials missing or rejected."}}}
        text = self.report(live_requested=True, relationships=failed)
        self.assertIn("**The live run failed** (Model API credentials missing or rejected.)", text)

    # ------------------------------------------------------------ 63
    def test_f63_valid_proposals_about_unlabeled_records_are_false_links(self):
        def prop(record, target, validation="valid"):
            return {"record": {"id": record}, "target": {"source_id": target} if target else None,
                    "validation": validation, "predicate": evaluate.GOLD["predicate"],
                    "evidence": [{"valid": validation == "valid"}]}
        proposals = [prop("MR-1", "el-A"), prop("N-1", "el-B"), prop("N-2", "el-C", "record_kind_not_allowed")]
        s = evaluate.score(proposals, {"MR-1": "el-A"})
        self.assertEqual((s["summary"]["false_links"], s["summary"]["precision_of_valid_candidates"]), (1, "1/2"))
        self.assertEqual((s["summary"]["records"], s["summary"]["unlabeled_records_with_proposals"]), (1, 2))
        self.assertEqual((s["summary"]["rejected_by_validation"], s["summary"]["needs_review"]), (1, 2))
        self.assertEqual(s["summary"]["citation_validity"], "2/3")
        self.assertEqual({r["record"]: r["outcome"] for r in s["per_record"]},
                         {"MR-1": "correct", "N-1": "unlabeled_false_link", "N-2": "unlabeled_no_valid_link"})


class TestOracles(unittest.TestCase):
    # ------------------------------------------------------------ 59
    def test_f59_ic14_fails_when_an_accept_commits_on_a_stale_head(self):
        real = links.freshness

        def ignores_head_changes(c, p):  # the bug IC14 exists to catch
            iv = json.loads(p["input_vector_json"])
            return dict(real(c, p), model_head=iv["model_revision"], record_head=iv["record_revision"],
                        issues=[], status="current")
        with mock.patch.object(links, "freshness", ignores_head_changes):
            result = run_quietly(test_integration.Links("test_IC14_concurrent_head_update_during_acceptance"))
        self.assertEqual(len(result.failures), 1, result.errors)
        self.assertIn("accept committed after the head advanced", result.failures[0][1])

    # ------------------------------------------------------------ 60
    def test_f60_the_suite_never_calls_a_live_model_even_when_one_is_configured(self):
        sdk = types.ModuleType("anthropic")  # a working SDK, as after `pip install -r requirements-live.txt`
        for name in ("APIConnectionError", "AuthenticationError", "RateLimitError", "APIStatusError"):
            setattr(sdk, name, type(name, (Exception,), {}))
        calls = []

        def create(**kw):
            calls.append(kw["model"])
            return types.SimpleNamespace(stop_reason="end_turn", model=kw["model"],
                                         content=[types.SimpleNamespace(type="text", text='{"proposals": []}')],
                                         usage=types.SimpleNamespace(input_tokens=1, output_tokens=1))
        sdk.Anthropic = lambda: types.SimpleNamespace(messages=types.SimpleNamespace(create=create))
        with mock.patch.dict(sys.modules, {"anthropic": sdk}), \
                mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-test-not-a-real-key"}):
            result = run_quietly(test_integration.Links("test_live_mode_failure_is_visible_and_not_replaced_by_fixture"))
        self.assertTrue(result.wasSuccessful(), result.failures + result.errors)
        self.assertEqual(calls, [])


class EtagMatching(StackCase):
    # ------------------------------------------------------------ 52 (the behavior the note now describes)
    def test_f52_only_the_exact_current_etag_matches(self):
        self.release_a()
        p = self.find_prop(self.proposals(), "MR-1005", "el-TS101")
        for etag in ("*", f'{p["etag"]}, "other"'):
            st, body, _ = self.accept(p, etag=etag)
            self.assertEqual((st, body["error"]["code"]), (412, "precondition_failed"))
        self.assertEqual(self.ok(self.accept(p))["authority"], "reviewer_accepted")


if __name__ == "__main__":
    unittest.main()
