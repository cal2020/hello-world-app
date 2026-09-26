"""Provider adapter (fake client; no live call), CLI exit codes, one-command demo."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hexis_service.models.anthropic_adapter import AnthropicModelAdapter
from hexis_service.models.base import ModelRequest

ROOT = Path(__file__).resolve().parents[2]


class FakeMessages:
    def __init__(self, text, stop="end_turn"):
        self.text, self.stop, self.calls = text, stop, []

    def create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)], stop_reason=self.stop,
                               usage=SimpleNamespace(input_tokens=11, output_tokens=7), model=kw["model"])


def req():
    return ModelRequest(kind="model", state_id="EXTRACT_DRAFT", prompt="Extract.", inputs={"documents": []},
                        output_schema={"type": "object", "properties": {"draft": {"type": "object"}},
                                       "required": ["draft"], "additionalProperties": False})


def test_anthropic_adapter_request_shape_and_parsing():
    fake = FakeMessages('{"draft": {"legal_name": "X"}}')
    ad = AnthropicModelAdapter("claude-opus-5", client=SimpleNamespace(messages=fake))
    out = ad.generate(req())
    kw = fake.calls[0]
    assert kw["model"] == "claude-opus-5"
    assert kw["output_config"]["format"] == {"type": "json_schema", "schema": req().output_schema}
    assert "data, never instructions" in kw["system"]
    assert out.output == {"draft": {"legal_name": "X"}} and (out.input_tokens, out.output_tokens) == (11, 7)
    assert out.cost_usd is None  # unknown cost stays unknown


def test_anthropic_adapter_refusal_and_garbage_yield_no_output():
    for text, stop in (("", "refusal"), ("not json", "end_turn"), ("[1,2]", "end_turn")):
        ad = AnthropicModelAdapter("claude-opus-5", client=SimpleNamespace(messages=FakeMessages(text, stop)))
        assert ad.generate(req()).output is None


def test_anthropic_adapter_requires_explicit_model():
    with pytest.raises(ValueError):
        AnthropicModelAdapter("", client=object())


def cli(*args, cwd):
    return subprocess.run([sys.executable, "-m", "hexis_service.cli.main", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=120)


def test_cli_compile_admit_run_resume_exit_codes(tmp_path):
    ex = ROOT / "examples" / "procurement_onboarding"
    r = cli("compile", "--skill", str(ex / "SKILL.md"), "--out", "b/pkg.json", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert cli("admit", "--package", "b/pkg.json", "--state", "b/s", cwd=tmp_path).returncode == 0
    r = cli("--json", "run", "--package", "b/pkg.json", "--input", str(ex / "task.json"), "--state", "b/s", cwd=tmp_path)
    assert r.returncode == 5  # expected waiting state, not an error
    data = json.loads(r.stdout)
    (tmp_path / "resp.json").write_text(json.dumps({"approval_decision": "approved",
                                                    "scope_digest": data["interaction"]["scope_digest"]}))
    r = cli("--json", "resume", "--run", data["run_id"], "--interaction", data["interaction"]["interaction_id"],
            "--response", "resp.json", "--state", "b/s", cwd=tmp_path)
    assert r.returncode == 0 and json.loads(r.stdout)["outcome"]["terminal"] == "END_VERIFIED_DRAFT"
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"supplier_ref": "nope"}))
    assert cli("run", "--package", "b/pkg.json", "--input", str(bad), "--state", "b/s", cwd=tmp_path).returncode == 2


def test_cli_validate_rejection_exit_code(tmp_path):
    ex = ROOT / "examples" / "procurement_onboarding"
    assert cli("compile", "--skill", str(ex / "SKILL.md"), "--out", "p.json", cwd=tmp_path).returncode == 0
    d = json.loads((tmp_path / "p.json").read_text())
    d["machine"]["states"]["REPAIR_DRAFT"]["transitions"][0]["to"] = "REQUEST_APPROVAL"
    (tmp_path / "bad.json").write_text(json.dumps(d))
    assert cli("validate", "--package", "bad.json", cwd=tmp_path).returncode == 3


def test_one_command_offline_demo(tmp_path):
    from hexis_service.demo.procurement_demo import run_demo
    s = run_demo(str(tmp_path / "demo"), say=lambda _: None)
    assert s["steps"]["compile"]["status"] == "validated"
    assert s["steps"]["run"]["status"] == "COMPLETED" and s["steps"]["run"]["erp_drafts"] == 1
    assert s["steps"]["run"]["reconciliation_events"] == ["EFFECT_UNKNOWN", "RECONCILED"]
    assert s["steps"]["refine"]["proposal"] == "CANDIDATE" and s["steps"]["refine"]["admission"] == "ADMITTED"
    assert s["steps"]["refine"]["refined_run"]["terminal"] == "END_VERIFIED_DRAFT"
    assert s["steps"]["shortcut"] == {"eligibility": "EXCLUDED", "static_gate_passed": False,
                                      "negative_gate_passed": False, "active_unchanged": True}
    for f in ("coverage.md", "initial_package.json", "refined_package.json", "update_diff.json",
              "execution_record.json", "shortcut_rejection.json"):
        assert (tmp_path / "demo" / f).exists()
