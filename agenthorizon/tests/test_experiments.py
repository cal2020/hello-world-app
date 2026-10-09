"""Experiment registry, analyses, and reports (synthetic fixture + scripted judge; no model is called)."""

from __future__ import annotations

from pathlib import Path

import pytest

from agenthorizon.analysis.bootstrap import grouped_bootstrap, groups_from_private
from agenthorizon.analysis.partition import legacy_reconstruction, verdict_matrix
from agenthorizon.analysis.slices import example_meta, slice_scores
from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestOptions, ingest
from agenthorizon.experiments.registry import experiments, get, run_configs, status
from agenthorizon.experiments.report import experiment_report, render_markdown
from agenthorizon.judging.registry import CONFIGS
from agenthorizon.runs.orchestrator import Orchestrator, RunControls
from agenthorizon.runs.plan import RunConfig, resolve
from agenthorizon.runs.policy import POLICIES
from agenthorizon.runs.store import FileRunStore
from agenthorizon.testing.fake_judge import ScriptedJudge
from agenthorizon.testing.fixture import build_fixture


@pytest.mark.reference
def test_registry_covers_every_configuration_and_reference_row():
    from agenthorizon.reference.tables import supplementary_tables

    exps = experiments()
    ids = [e.experiment_id for e in exps]
    assert len(ids) == len(set(ids))
    used = {e.judge_config for e in exps}
    assert {c.config_id for c in CONFIGS} <= used  # every registered configuration is in some experiment
    refs = {(r.reference["table_id"], r.reference["line"]) for e in exps for r in e.reports if r.reference}
    for t in supplementary_tables():
        for row in t["rows"]:
            assert (t["table_id"], row["line"]) in refs, (t["table_id"], row["model"], row["interface"])
    assert get("splitter:legacy").trials == 8


def test_status_logic_names_every_blocker():
    e = get("grid:claude_code:claude-opus-4.7")
    nothing = status(e, {}, {})
    assert nothing.status == "blocked" and any("ah-markdowns" in b for b in nothing.data_blockers)
    assert any("capability" in b for b in nothing.config_blockers)
    avail = {a: "acquired" for a in e.requires}
    ok = status(e, avail, {e.judge_config: {"status": "unverified", "reasons": ["no live probe run"]}})
    assert ok.status == "runnable" and ok.blockers == []
    cred = status(e, avail, {e.judge_config: {"status": "blocked", "reasons": ["credentials missing: ANTHROPIC_API_KEY"]}})
    assert cred.status == "blocked" and cred.config_blockers == ["credentials missing: ANTHROPIC_API_KEY"]
    rev = status(get("revised:claude_code:claude-opus-4.7"), {a: "acquired" for a in ("ah-markdowns", "ah-jsons", "ah-media", "ah-paper")},
                 {"claude_code:claude-opus-4.7": {"status": "unverified"}})
    assert rev.status == "blocked" and any("ah-revised-manifests" in b for b in rev.data_blockers)
    assert status(get("ablation:input-removal"), {}, {}).status == "blocked"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("exp")
    build_fixture(base / "fx")
    s = Settings(var_dir=base / "var")
    r = ingest(s, IngestOptions(source="local", local_dir=base / "fx", media="all"))
    return s, DatasetVersion(Path(r.root))


@pytest.mark.reference
def test_trials_are_separate_run_identities(env):
    s, dv = env
    cfgs = run_configs(get("splitter:legacy"), dv.id, {m.manifest_id for m in dv.manifests()},
                       operator={"base_url": "https://vllm.invalid/v1"})
    assert [c.trial for c in cfgs] == list(range(1, 9))
    run_ids = {resolve(s, c)[0].run_id for c in cfgs}
    assert len(run_ids) == 8


def _run(s, cfg: RunConfig, judge) -> FileRunStore:
    d, _ = resolve(s, cfg)
    store, _ = FileRunStore.create_or_open(s.runs_dir, d, {})
    Orchestrator(store, judge, POLICIES[d.attempt_policy["policy_id"]], controls=RunControls(concurrency=2, metered=False),
                 item_cost={}, price=None).run()
    return store


@pytest.mark.reference
def test_grid_experiment_report_scores_three_manifests_and_caveats_paper_rows(env):
    s, dv = env
    e = get("grid:claude_code:claude-opus-4.7")
    (cfg,) = run_configs(e, dv.id, {m.manifest_id for m in dv.manifests()})
    store = _run(s, cfg, ScriptedJudge(default="verdict:false", tokens=(1500, 90)))
    rep = experiment_report(s, e, [store], bootstrap_B=200)
    assert rep["warnings"] and rep["warnings"][0].startswith("SYNTHETIC")
    reports = {r["report_id"]: r for r in rep["trials"][0]["reports"]}
    assert set(reports) == {"S8.T1", "S8.T2", "S8.T3"}
    t1, t2, t3 = reports["S8.T1"]["score"], reports["S8.T2"]["score"], reports["S8.T3"]["score"]
    assert t1["manifest"]["n_items"] + t2["manifest"]["n_items"] == t3["manifest"]["n_items"]  # legacy AH + AH-S = release
    assert t3["metrics"]["negative_accuracy"]["value"] == 1.0 and t3["metrics"]["positive_accuracy"]["value"] == 0.0
    pr = reports["S8.T1"]["paper_reference"]
    assert pr["comparable"] is False and any("test_fixture" in c for c in pr["caveats"])
    assert next(x for x in pr["rows"] if x["metric"] == "balanced_accuracy")["paper_reported"] == 77.6
    assert "slices" in reports["S8.T3"] and reports["S8.T3"]["bootstrap_extension"]["extension"].startswith("ext-")
    res = rep["trials"][0]["resources"]["fields"]["input_tokens"]
    assert res["mean"] == 1500 and res["coverage"] == 1.0
    md = render_markdown(rep)
    assert "NOT directly comparable" in md and "SYNTHETIC" in md


def test_slices_partition_single_valued_dimensions(env):
    s, dv = env
    priv = PrivateStore(s.private_dir, dv.id)
    sm = priv.scoring_manifest(dv.manifest(f"{dv.id}:full-release"))
    from agenthorizon.scoring.protocol import PredictionSet

    ps = PredictionSet("empty", dv.id, dv.example_ids(), [])
    out = slice_scores(sm, ps, example_meta(dv))
    for dim in ("length_bin", "os", "domain"):
        rows = out["dimensions"][dim]
        assert sum(r["n"] for r in rows) == len(sm.items)
        assert all(r["P"] + r["N"] == r["n"] and r["missing"] == r["n"] for r in rows)  # every unpredicted item is missing
    assert sum(r["n"] for r in out["dimensions"]["application"]) >= len(sm.items)  # multi-application items overlap


def test_grouped_bootstrap_properties(env):
    s, dv = env
    priv = PrivateStore(s.private_dir, dv.id)
    sm = priv.scoring_manifest(dv.manifest(f"{dv.id}:full-release"))
    from agenthorizon.judging.parsing import parse_agentic
    from agenthorizon.scoring.protocol import PredictionSet, SelectedPrediction

    recs = [SelectedPrediction(i.example_id, parse_agentic('{"success": true, "reasoning": "r"}')) for i in sm.items[::2]]
    ps = PredictionSet("p", dv.id, dv.example_ids(), recs)
    a = grouped_bootstrap(sm, ps, groups_from_private(priv, {i.example_id for i in sm.items}), B=300, seed=7)
    b = grouped_bootstrap(sm, ps, groups_from_private(priv, {i.example_id for i in sm.items}), B=300, seed=7)
    assert a == b and a["basis"].startswith("groups")
    ci = a["intervals"]["balanced_accuracy"]
    assert ci["low"] <= a["point"]["balanced_accuracy"] <= ci["high"]
    one = grouped_bootstrap(sm, ps, {i.example_id: "all" for i in sm.items}, B=50)
    assert one["intervals"]["balanced_accuracy"]["low"] == one["intervals"]["balanced_accuracy"]["high"] == one["point"]["balanced_accuracy"]
    assert "NO grouping" in grouped_bootstrap(sm, ps, None, B=20)["basis"]


@pytest.mark.reference
def test_legacy_partition_reconstruction_from_eight_trials(env):
    s, dv = env
    priv = PrivateStore(s.private_dir, dv.id)
    gold = priv.gold
    easy = set(dv.manifest(f"{dv.id}:legacy-AH-S").example_ids)
    e = get("splitter:legacy")
    cfgs = run_configs(e, dv.id, {m.manifest_id for m in dv.manifests()}, operator={"base_url": "https://vllm.invalid/v1"})
    stores = []
    for cfg in cfgs:
        def right(eid):
            return "verdict:true" if gold[eid]["label"] == "positive" else "verdict:false"

        def wrong(eid):
            return "verdict:false" if gold[eid]["label"] == "positive" else "verdict:true"
        script = {eid: [right(eid) if (eid in easy or cfg.trial <= 4) else wrong(eid)] for eid in gold}
        stores.append(_run(s, cfg, ScriptedJudge(script)))
    m = verdict_matrix(stores, sorted(gold))
    released = {x: "AH-S" for x in easy} | {x: "AH" for x in dv.manifest(f"{dv.id}:legacy-AH").example_ids}
    lp = legacy_reconstruction(m, gold, released)
    assert lp["agreement"] == 1.0 and lp["compared"] == len(released)
    full = experiment_report(s, e, stores, bootstrap_B=50)
    assert full["legacy_partition_reconstruction"]["agreement"] == 1.0
