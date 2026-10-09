"""Blindness boundary beyond the sandbox probe (test_isolation.py): what judge-side code can name, and what a staged
workspace actually contains. Synthetic fixture data only."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.data.media import LocalMediaStore
from agenthorizon.judging.harnesses import ADAPTERS, HarnessRun
from agenthorizon.judging.prompts import official_agentic_prompt, rubric_extension_instructions
from agenthorizon.judging.workspace import stage_workspace
from agenthorizon.testing.fixture import build_fixture

PKG = Path(__file__).resolve().parents[1] / "src" / "agenthorizon"
JUDGE_SIDE = sorted([*PKG.glob("judging/**/*.py"), PKG / "runs" / "judges.py", PKG / "runs" / "orchestrator.py",
                     PKG / "runs" / "policy.py", PKG / "runs" / "store.py", PKG / "data" / "layout.py",
                     PKG / "data" / "media.py", PKG / "data" / "markdown.py", PKG / "testing" / "replay_harness.py"])
FORBIDDEN = {"PrivateStore", "private_dir", "private_root", "gold_labels", "gold_labels.jsonl", "grouping.jsonl",
             "scoring_manifest"}


@pytest.mark.parametrize("path", JUDGE_SIDE, ids=lambda p: str(p.relative_to(PKG)))
def test_judge_side_code_cannot_name_private_material(path):
    tree = ast.parse(path.read_text())
    hits = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in FORBIDDEN:
            hits.add(node.id)
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN:
            hits.add(node.attr)
        elif isinstance(node, ast.alias) and node.name.split(".")[-1] in FORBIDDEN:
            hits.add(node.name)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in FORBIDDEN:
            hits.add(node.value)
    assert not hits, f"{path.name} references private material: {sorted(hits)}"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("leak")
    fx = base / "fx"
    summary = build_fixture(fx)
    s = Settings(var_dir=base / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=fx, media="all"))
    dv = DatasetVersion(Path(r.root))
    return s, dv, PrivateStore(s.private_dir, dv.id), summary


def _all_bytes(ws: Path) -> list[tuple[str, bytes]]:
    return [(str(p.relative_to(ws)), p.read_bytes()) for p in sorted(ws.rglob("*")) if p.is_file()]


@pytest.mark.parametrize("mode", ["paper-paths", "opaque-paths"])
def test_staged_workspace_holds_only_this_items_evidence(env, tmp_path, mode):
    s, dv, private, summary = env
    by_rec: dict[str, list[str]] = {}
    for e in dv.examples():
        by_rec.setdefault(e["recording_id"], []).append(e["example_id"])
    pairs = [ids for ids in by_rec.values() if len(ids) >= 2]
    assert pairs, "fixture must contain examples sharing a recording"
    instr = {e["example_id"]: e["instruction"] for e in dv.examples()}
    label_files = list(summary["label_files"])  # file name -> row count
    for ids in pairs:
        me, other = ids[0], ids[1]
        assert instr[me] != instr[other]
        st = stage_workspace(dv, LocalMediaStore(s.media_dir), me, tmp_path / mode / me, prompt=official_agentic_prompt(),
                             instructions=rubric_extension_instructions(), mode=mode, secret=b"k" * 32)
        files = _all_bytes(st.workspace)
        names = {n for n, _ in files}
        md_json = {n for n in names if n.startswith(("agenthorizon_md/", "agenthorizon_json/"))}
        assert md_json == {f"agenthorizon_md/{me}.md", f"agenthorizon_json/{me}.json"}  # no other trajectory
        for n, b in files:
            text = b.decode("utf-8", errors="ignore")
            assert instr[other] not in text, f"counterpart instruction leaked via {n}"
            assert other not in text and other not in n, f"counterpart id leaked via {n}"
            for lf in label_files:
                assert lf not in text and lf not in n
            assert str(s.private_dir) not in text
        if mode == "opaque-paths":
            original = private.gold[me]["original_id"]
            assert original, "fixture label rows carry original ids"
            for n, b in files:
                assert original not in n and original not in b.decode("utf-8", errors="ignore"), n
            imgs = [f for f in st.files if f["kind"] == "image"]
            assert imgs and all(f["pixels_verified"] for f in imgs)


@pytest.mark.parametrize("interface,route", [("claude_code", "anthropic"), ("codex", "openrouter"),
                                             ("gemini_cli", "google"), ("opencode", "vllm"), ("openhands", "google")])
def test_harness_environment_carries_only_route_credentials(interface, route, monkeypatch):
    monkeypatch.setenv("AH_DATABASE_URL", "postgresql://scorer:secret@db/ah")
    monkeypatch.setenv("AH_SCORER_DATABASE_URL", "postgresql://scorer:secret@db/ah")
    a = ADAPTERS[interface]
    run = HarnessRun(model="m/x", route=route, prompt_text="p", base_url="https://vllm.invalid/v1" if route == "vllm" else None)
    secrets = {k: f"value-of-{k}" for k in a.required_secrets(route)}
    inv = a.invocation(run, secrets)
    allowed_secret_values = set(secrets.values())
    for k, v in inv.env.items():
        assert not k.startswith("AH_") and "DATABASE" not in k, k
        assert "postgresql://" not in v
        if v.startswith("value-of-"):
            assert v in allowed_secret_values
    assert all(h for h in inv.allowed_hosts)
    blob = json.dumps(inv.env)
    assert "scorer:secret" not in blob


SHELL_CALLS = {("os", "system"), ("os", "popen"), ("subprocess", "getoutput"), ("subprocess", "getstatusoutput")}


def test_no_shell_execution_anywhere():
    """Recorded actions and dataset strings are data: nothing in the package hands a string to a shell (MP §7, §12).
    Subprocesses take argument vectors; ``shell=True`` and the shell-only helpers are absent everywhere."""
    hits = []
    for path in sorted(PKG.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and (f.value.id, f.attr) in SHELL_CALLS:
                hits.append(f"{path.relative_to(PKG)}:{node.lineno} {f.value.id}.{f.attr}")
            for kw in node.keywords:
                if kw.arg == "shell" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                    hits.append(f"{path.relative_to(PKG)}:{node.lineno} shell=")
    assert hits == []
