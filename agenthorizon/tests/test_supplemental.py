"""Supplemental sources: AgentRewardBench and OSWorld adapters on the pinned real repositories, plus offline trace
imports, judge-ready export, and the separation audit. Trajectory/trace inputs built here are SYNTHETIC test data in
the documented formats (the real trajectory releases are not reachable from this environment)."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest
from PIL import Image

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.supplemental import arb, osworld
from agenthorizon.supplemental.dedup import audit, items_from_dataset, items_from_supplemental
from agenthorizon.supplemental.records import SupplementalStore
from agenthorizon.supplemental.standard_export import export_standard, trajectory_id
from agenthorizon.testing.fixture import build_fixture


@pytest.fixture(scope="module")
def arb_checkout():
    try:
        from agenthorizon.sources.cache import checkout
        return checkout("agentrewardbench-repo").path
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"ARB checkout unavailable: {exc}")


@pytest.fixture(scope="module")
def osworld_checkout():
    try:
        from agenthorizon.sources.cache import checkout
        return checkout("osworld-repo").path
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"OSWorld checkout unavailable: {exc}")


@pytest.mark.reference
def test_arb_import_matches_release_rules(arb_checkout):
    from conftest import load_reference_functions

    recs, summary = arb.load_repo(arb_checkout, "rev", None)
    rows = list(csv.DictReader((arb_checkout / "agent_reward_bench/data/annotations.csv").open()))
    assert summary["annotation_rows"] == len(rows) == sum(len([1 for lab in r.labels if lab.field == "trajectory_success"]) for r in recs)
    ref = load_reference_functions(arb_checkout / "agent_reward_bench/judge/utils.py", ["infer_annotator_type", "normalize_task_id"])
    existing: set = set()
    theirs = [(a["benchmark"], a["model_name"], a["task_id"], ref.infer_annotator_type(a, existing)) for a in rows]
    ours = []
    for r in recs:
        for lab in r.labels:
            if lab.field == "trajectory_success":
                ours.append((r.native_ids["benchmark"], r.native_ids["model_name"], r.native_ids["task_id"], lab.role))
    assert sorted(ours) == sorted(theirs)  # identical primary/secondary assignment
    splits = {r["task_id"]: r["split"] for r in csv.DictReader((arb_checkout / "agent_reward_bench/data/splits.csv").open())}
    for r in recs:
        assert r.split == splits[ref.normalize_task_id(r.native_ids["task_id"])]
        assert r.kind == "annotation_only" and "screenshots" in r.missing
    gold = arb.primary_binary_gold(recs)
    unsure_primary = sum(1 for r in recs for lab in r.labels
                         if lab.field == "trajectory_success" and lab.role == "primary" and lab.value_native == "Unsure")
    assert len(gold) == len(recs) - unsure_primary  # Unsure never becomes a label
    assert all(isinstance(v, bool) for v in gold.values())
    from agenthorizon.supplemental.records import coverage_report
    assert coverage_report(recs)["records_with_compatible_binary_label"] == len(gold)  # a secondary never fills in
    assert summary["alias_files"][0]["identical_to_primary_copy"] is True
    agr = arb.annotation_agreement(recs)
    assert agr["pairs"] == summary["multi_annotated"]
    s = agr["by_field"]["trajectory_success"]
    assert 0 < s["agree"] <= s["pairs"] <= agr["pairs"]


@pytest.mark.reference
def test_osworld_task_definitions_are_not_trajectories(osworld_checkout):
    recs, summary = osworld.load_task_definitions(osworld_checkout, "rev")
    for fname in osworld.SPLIT_FILES:
        n = sum(len(v) for v in json.loads((osworld_checkout / "evaluation_examples" / fname).read_text()).values())
        assert summary["split_files"][fname] == n
    assert all(r.kind == "task_definition" and r.labels == [] and r.steps is None for r in recs)
    rep = audit(items_from_supplemental([r.to_dict() for r in recs]))
    assert len(rep["native_id_aliases"]) == summary["by_platform"]["windows"]  # Windows ports reuse Ubuntu ids
    assert rep["supplemental_overlapping_ah_evaluation"] == []


def _png(path: Path, color) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 40), color).save(path)


def test_osworld_trace_export_import_is_post_action_and_machine_labelled(tmp_path):
    task = osworld.SupRecord("osworld-task:ubuntu/os/t1", "osworld", "task_definition", {"id": "t1", "domain": "os", "platform": "ubuntu"},
                             "osworld-task-json", "SYNTHETIC: open a terminal", None, [], "test_all", {}, {}, [], {"path": "x"},
                             dedup={"evaluator_funcs": ["check_include_exclude"]})
    root = tmp_path / "results"
    for ex, score in (("t1", "1.0\n"), ("t2", "0.5\n")):
        d = root / "pyautogui" / "screenshot" / "test-model" / "os" / ex
        rows = []
        for n in (1, 2):
            shot = f"step_{n}_20260101@0000{n}.png"
            _png(d / shot, (40 * n, 10, 10))
            rows.append(json.dumps({"step_num": n, "action_timestamp": f"20260101@0000{n}", "action": f"pyautogui.click({n}, {n})",
                                    "response": "SYNTHETIC reasoning", "reward": 0, "done": n == 2, "info": {},
                                    "screenshot_file": shot}))
        (d / "traj.jsonl").write_text("\n".join(rows) + "\n")
        (d / "result.txt").write_text(score)
    traces, summ = osworld.import_trace_exports(root, {"t1": task}, run_label="synthetic")
    assert summ["traces"] == 2 and summ["without_task_definition"] == ["t2"]
    t1 = next(t for t in traces if t.native_ids["id"] == "t1")
    assert t1.instruction.startswith("SYNTHETIC") and all(s.observation["timing"] == "post_action" for s in t1.steps)
    lab = t1.labels[0]
    assert lab.kind == "machine_evaluator" and lab.binary is True and lab.compatible_binary is False
    t2 = next(t for t in traces if t.native_ids["id"] == "t2")
    assert t2.labels[0].binary is None  # fractional evaluator score: no binary label
    out = tmp_path / "export"
    res = export_standard(traces, root, out, benchmark="osworld")
    assert res["exported"] == 1 and res["label_files"] == {}  # machine labels are never exported by default
    res2 = export_standard(traces, root, tmp_path / "export2", benchmark="osworld", include_machine_labels=True)
    assert list(res2["label_files"]) == ["osworld-test_all-machine-evaluator.jsonl"]


@pytest.mark.reference
def test_arb_trajectories_become_a_separate_scorable_dataset(arb_checkout, tmp_path):
    recs, _ = arb.load_repo(arb_checkout, "rev", None)
    pick = [r for r in recs if r.split == "dev"][:3]
    cleaned = tmp_path / "cleaned"
    for i, r in enumerate(pick):
        b, m, t = r.native_ids["benchmark"], r.native_ids["model_name"], r.native_ids["task_id"]
        shots = []
        for n in range(3):
            rel = f"trajectories/screenshots/{b}/{m}/{t}/screenshot_step_{n}.png"
            _png(tmp_path / "snap" / rel, (10 * i, 20 * n, 30))
            shots.append(rel)
        obj = {"benchmark": b, "agent": m, "model": "x", "valid": True, "experiment": "e", "goal": f"SYNTHETIC goal {i} for {t}",
               "steps": [{"num": n, "reasoning": "r", "action": f"click('a{n}')" if n < 2 else None, "screenshot_path": shots[n],
                          "url": "http://example.invalid", "axtree": "[1] button"} for n in range(3)]}
        p = cleaned / b / m / f"{m}_on_{b}.dev" / f"{t}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj))
    stats = arb.attach_trajectories(pick, cleaned)
    assert stats["parsed"] == 3 and all(r.kind == "trajectory" for r in pick)
    out = tmp_path / "export"
    res = export_standard(pick, tmp_path / "snap", out, benchmark="agentrewardbench")
    assert res["exported"] == 3
    md = (out / "sandbox/data/markdowns" / f"{trajectory_id(pick[0].record_id)}.md").read_text()
    assert "click('a0')" in md  # native browser actions reach the judge verbatim
    s = Settings(var_dir=tmp_path / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=out, media="all", benchmark="agentrewardbench"))
    dv = DatasetVersion(Path(r.root))
    assert dv.id.startswith("agentrewardbench@") and not any(m.official for m in dv.manifests())
    assert {m.partition for m in dv.manifests()} >= {"unclassified-label-file"}
    rec = dv.report("reconciliation")
    assert next(c for c in rec["checks"] if c["check"] == "release_totals")["status"] == "not_applicable"
    priv = PrivateStore(s.private_dir, dv.id)
    assert all(g.get("category") is None for g in priv.gold.values())  # categories unavailable for this source
    steps = dv.steps(next(iter(dv.examples()))["recording_id"])
    assert steps[0]["observation_timing"] == "pre_action"


def test_separation_audit_flags_overlap_and_never_merges(tmp_path):
    build_fixture(tmp_path / "fx")
    s = Settings(var_dir=tmp_path / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=tmp_path / "fx", media="all"))
    dv = DatasetVersion(Path(r.root))
    ah = items_from_dataset(dv)
    some = ah[0]
    supp = [{"key": "supp:exact", "source": "suppsrc", "instruction": some["instruction"].upper() + "  ", "screenshots": [],
             "recording": None, "native_id": None, "is_ah_eval": False},
            {"key": "supp:near", "source": "suppsrc", "instruction": some["instruction"].replace("SYNTHETIC FIXTURE:", "") + " now",
             "screenshots": [], "recording": None, "native_id": None, "is_ah_eval": False},
            {"key": "supp:shot", "source": "suppsrc", "instruction": "unrelated words entirely", "screenshots": some["screenshots"][:1],
             "recording": None, "native_id": None, "is_ah_eval": False}]
    rep = audit(ah + supp, threshold=0.6)
    exact = [g for g in rep["exact_instruction_duplicates"] if "supp:exact" in g["members"]]
    assert exact and exact[0]["cross_source"]
    assert any({"supp:near"} & {p["a"], p["b"]} for p in rep["possible_duplicates"])
    assert all(p["decision"].startswith("review") for p in rep["possible_duplicates"])
    assert {"supp:exact", "supp:shot"} <= set(rep["supplemental_overlapping_ah_evaluation"])
    assert rep["intentional_shared_recordings"]  # matched/crossed pairs share recordings by design
    shared = {m for g in rep["intentional_shared_recordings"] for m in g["members"]}
    assert not any(set(g["members"]) <= shared for g in rep["exact_screenshot_duplicates"])  # not mislabelled as duplicates


def test_store_round_trip(tmp_path, arb_checkout):
    recs, _ = arb.load_repo(arb_checkout, "rev0123456789", None)
    st = SupplementalStore.for_source(tmp_path, "agentrewardbench", "rev0123456789")
    v = st.write(recs[:50], {"source_id": "agentrewardbench"})
    assert v["records"] == 50 and len(st.records()) == 50
    assert st.coverage()["missing_material"]["screenshots"] == 50
