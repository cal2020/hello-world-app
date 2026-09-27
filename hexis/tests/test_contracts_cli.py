"""Published schemas match real artifacts; CLI exit codes; the one-command demo."""
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

from helpers import Env, compiled_package

from hexis_service import app, canonical
from hexis_service import jsonschema_lite as JS
from hexis_service.traces import export_run_trace

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))


def schema(name):
    return canonical.load_file(os.path.join(ROOT, "schemas", name))


class TestSchemas(unittest.TestCase):
    def test_artifacts_conform_to_published_schemas(self):
        env = Env(self)
        run_id, cp = env.start()
        JS.validate(compiled_package(), schema("machine-package.schema.json"))
        JS.validate(app.load_example_inputs()["tool_catalog"], schema("tool-catalog.schema.json"))
        JS.validate(cp, schema("run-checkpoint.schema.json"))
        req, _ = env.svc.approvals.get(app.TENANT, cp["pending"]["interaction_id"])
        JS.validate(req, schema("approval-request.schema.json"))
        env.approve(run_id, cp)
        cp = env.rt.run(run_id, app.REQUESTER)
        for e in env.svc.store.events(app.TENANT, run_id):
            JS.validate(e, schema("runtime-event.schema.json"))
        for ev in env.svc.evidence.for_run(app.TENANT, run_id):
            JS.validate(ev, schema("evidence-receipt.schema.json"))
        t = export_run_trace(env.svc.store, app.TENANT, run_id, "supplier-onboarding-draft", env.task, "t")
        JS.validate(t["header"], schema("trace-header.schema.json"))
        for r in t["records"]:
            JS.validate(r, schema("trace-record.schema.json"))


class TestCLI(unittest.TestCase):
    def cli(self, *args, cwd):
        proc = subprocess.run([os.path.join(ROOT, "hexisctl"), "--json", *args], cwd=cwd, capture_output=True,
                              text=True, timeout=120)
        return proc.returncode, (json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else proc.stdout)

    def test_cli_exit_codes_and_flow(self):
        with tempfile.TemporaryDirectory() as d:
            skill = os.path.join(ROOT, "examples", "procurement_onboarding", "SKILL.md")
            code, out = self.cli("compile", "--skill", skill, "--out", "build/package.json", cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(self.cli("validate", "--package", "build/package.json", cwd=d)[0], 0)
            task = os.path.join(ROOT, "examples", "procurement_onboarding", "task.json")
            code, out = self.cli("--data", "s", "run", "--package", "build/package.json", "--input", task, cwd=d)
            self.assertEqual(code, 3, "an unadmitted package cannot run")
            self.assertEqual(self.cli("--data", "s", "admit", "--package", "build/package.json", cwd=d)[0], 0)
            code, out = self.cli("--data", "s", "run", "--package", "build/package.json", "--input", task,
                                 "--request-id", "x", cwd=d)
            self.assertEqual(code, 10, "waiting for approval is not an error")
            cp = out["checkpoint"]
            with open(os.path.join(d, "ok.json"), "w") as fh:
                fh.write('{"decision": "approved"}')
            code, _ = self.cli("--data", "s", "resume", "--run", cp["run_id"], "--interaction",
                               cp["pending"]["interaction_id"], "--response", "ok.json", "--as", "u-requester", cwd=d)
            self.assertEqual(code, 3)
            code, out = self.cli("--data", "s", "resume", "--run", cp["run_id"], "--interaction",
                                 cp["pending"]["interaction_id"], "--response", "ok.json", cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(out["checkpoint"]["outcome"]["terminal"], "END_VERIFIED_DRAFT")
            with open(os.path.join(d, "bad.json"), "w") as fh:
                fh.write('{"a": 1, "a": 2}')
            self.assertEqual(self.cli("validate", "--package", "bad.json", cwd=d)[0], 2)


class TestDemo(unittest.TestCase):
    def test_full_demo_is_reproducible(self):
        from hexis_service.demo import run_demo
        with tempfile.TemporaryDirectory() as d:
            with redirect_stdout(io.StringIO()):
                a = run_demo(os.path.join(d, "a"), quiet=True)
                b = run_demo(os.path.join(d, "b"), quiet=True)
        steps = a["steps"]
        self.assertEqual(steps["compile"]["attempts"], 2)
        self.assertEqual(steps["main_run"]["outcome"]["terminal"], "END_VERIFIED_DRAFT")
        self.assertEqual(steps["main_run"]["erp_drafts"], 1)
        self.assertEqual(steps["main_run"]["reconciliations"], 1)
        self.assertEqual(steps["recorded_replay"]["result"], "PASS")
        self.assertEqual(steps["shortcut"]["eligibility"], "negative")
        self.assertTrue(steps["shortcut"]["active_unchanged"])
        self.assertIn("ORDERING_BYPASS", steps["shortcut"]["codes"])
        self.assertEqual(steps["refinement"]["status"], "candidate_ready")
        self.assertEqual(steps["refinement"]["rerun_outcome"], "END_VERIFIED_DRAFT")
        strip = lambda r: [ln.replace(os.path.join(d, "a"), "").replace(os.path.join(d, "b"), "") for ln in r["transcript"]]
        self.assertEqual(strip(a), strip(b), "deterministic transcript")


if __name__ == "__main__":
    unittest.main()
