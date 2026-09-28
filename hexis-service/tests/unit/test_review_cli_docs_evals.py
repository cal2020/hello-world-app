"""Regression tests for review findings C33, C34, C35, X11, X12 (CLI exit codes, eval honesty, demo checks)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from hexis_service.cli.main import EXIT_INVALID, demo_ok, main
from hexis_service.demo import reference as R

ROOT = Path(__file__).resolve().parents[2]
EX = ROOT / "examples" / "procurement_onboarding"


@pytest.fixture(scope="module")
def pkg_path(tmp_path_factory):
    d = tmp_path_factory.mktemp("cli")
    out = d / "pkg.json"
    assert main(["compile", "--skill", str(EX / "SKILL.md"), "--out", str(out)]) == 0
    assert main(["admit", "--package", str(out), "--state", str(d / "s")]) == 0
    return out


def _w(p: Path, text: str) -> str:
    p.write_text(text)
    return str(p)


# ---- C33: invalid input exits 2 with a message, never a traceback ------------------------------ #
def test_c33_run_malformed_and_duplicate_key_input_exit_2(pkg_path, tmp_path, capsys):
    state = str(pkg_path.parent / "s")
    for body in ("not json", '{"a":1,"a":2}'):
        inp = _w(tmp_path / "in.json", body)
        assert main(["run", "--package", str(pkg_path), "--input", inp, "--state", state]) == EXIT_INVALID
    assert "error:" in capsys.readouterr().err


def test_c33_unknown_principal_exit_2(pkg_path):
    state = str(pkg_path.parent / "s")
    assert main(["run", "--package", str(pkg_path), "--input", str(EX / "task.json"), "--state", state,
                 "--as", "user:nobody"]) == EXIT_INVALID


def test_c33_inspect_unknown_or_foreign_run_exit_2(pkg_path, capsys):
    state = str(pkg_path.parent / "s")
    assert main(["inspect", "--run", "run_nonexistent", "--state", state]) == EXIT_INVALID
    capsys.readouterr()
    assert main(["--json", "run", "--package", str(pkg_path), "--input", str(EX / "task.json"),
                 "--state", state]) == 5
    run_id = json.loads(capsys.readouterr().out)["run_id"]
    assert main(["inspect", "--run", run_id, "--state", state, "--as", "user:mallory"]) == EXIT_INVALID


def test_c33_schema_invalid_package_exit_2(tmp_path):
    assert main(["validate", "--package", _w(tmp_path / "empty.json", "{}")]) == EXIT_INVALID


def test_c33_update_with_empty_trace_dir_exit_2(pkg_path, tmp_path):
    (tmp_path / "empty").mkdir()
    assert main(["update", "--parent", str(pkg_path), "--trace", str(tmp_path / "empty"),
                 "--out", str(tmp_path / "o")]) == EXIT_INVALID


# ---- C34: --profile must be one of the known profiles ---------------------------------------- #
@pytest.mark.parametrize("cmd", ["validate", "compile"])
@pytest.mark.parametrize("profile", ["Production", "prod"])
def test_c34_unknown_profile_rejected(pkg_path, tmp_path, cmd, profile):
    arg = ["--package", str(pkg_path)] if cmd == "validate" else ["--skill", str(EX / "SKILL.md"), "--out",
                                                                   str(tmp_path / "p.json")]
    with pytest.raises(SystemExit) as ei:
        main([cmd, *arg, "--profile", profile])
    assert ei.value.code == EXIT_INVALID


# ---- C35 / X11: eval metrics and development-trace overlap ------------------------------------ #
@pytest.fixture(scope="module")
def eval_result(tmp_path_factory):
    spec = importlib.util.spec_from_file_location("run_eval_mod", ROOT / "evals" / "run_eval.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = tmp_path_factory.mktemp("eval")
    argv = sys.argv
    sys.argv = ["run_eval.py", "--out", str(out)]
    try:
        mod.main()
    finally:
        sys.argv = argv
    return mod, json.loads((out / "results.json").read_text()), (out / "report.md").read_text()


def test_c35_fallback_rate_counts_fallback_terminals(eval_result):
    _, res, _ = eval_result
    for arm in res["arms"].values():
        h4 = next(r for r in arm["rows"] if r["task"] == "H4-registry-conflict")
        assert h4["category"] == "fallback" and h4["fallback_outcome"] is True
        assert arm["summary"]["fallback_rate"] == pytest.approx(1 / 7)
        assert arm["summary"]["failure_fallback_rate"] == 0.0


def test_c35_verification_doc_no_longer_misdescribes_deltas():
    text = (ROOT / "docs" / "VERIFICATION.md").read_text()
    assert "The only difference is" not in text
    assert "the extra approvals come from runs that now complete" not in text
    assert "H7-missing-twice" in text


def test_x11_dev_trace_overlap_is_detected_and_reported(eval_result):
    mod, res, report = eval_result
    dev = R.missing_docs_trace()
    tasks = json.loads((ROOT / "evals" / "heldout_tasks.json").read_text())["tasks"]
    overlapping = {t["id"] for t in tasks if mod.dev_overlap(t, dev)}
    assert overlapping == {"H3-missing-then-supplied"}
    assert set(res["dev_overlap"]) == {"H3-missing-then-supplied"}
    h0 = res["arms"]["initial_compiled"]["strictly_heldout_summary"]
    h1 = res["arms"]["trace_refined"]["strictly_heldout_summary"]
    assert h0["tasks"] == h1["tasks"] == 6
    assert h0["business_success"] == h1["business_success"] == 1.0  # no gain on truly held-out tasks
    assert "NOT held out" in report
    assert "Never supplied to the compiler fixture or aligners" not in (ROOT / "evals" / "heldout_tasks.json"
                                                                          ).read_text()


# ---- X12: demo exit logic and narrated properties --------------------------------------------- #
def _summary(**shortcut):
    sc = {"eligibility": "EXCLUDED", "static_gate_passed": False, "negative_gate_passed": False,
          "active_unchanged": True, **shortcut}
    return {"steps": {"run": {"erp_drafts": 1}, "shortcut": sc, "self_approval": {"refused": True}}}


def test_x12_demo_exit_requires_gates_to_reject_shortcut():
    assert demo_ok(_summary())
    # active_unchanged is trivially true (candidate never submitted), so it alone must not make the demo pass
    assert not demo_ok(_summary(static_gate_passed=True, negative_gate_passed=True))
    assert not demo_ok(_summary(negative_gate_passed=True))
    s = _summary()
    s["steps"]["self_approval"]["refused"] = False
    assert not demo_ok(s)


def test_x12_demo_isolates_separation_of_duties(tmp_path):
    from hexis_service.demo.procurement_demo import run_demo
    s = run_demo(str(tmp_path / "demo"), say=lambda _: None)
    sa = s["steps"]["self_approval"]
    assert sa["refused"] is True
    assert sa["sod_isolated"] == {"outcome": "DENY", "reasons": ["separation of duties: initiator cannot approve"]}
    assert demo_ok(s)
