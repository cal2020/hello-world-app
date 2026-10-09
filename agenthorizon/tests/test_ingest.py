"""Ingestion pipeline tests over the synthetic fixture (test data, not benchmark content)."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.data.ingest import IngestError, IngestOptions, ingest
from agenthorizon.data.layout import detect_layout
from agenthorizon.data.materialize import current_assets, materialize_media, media_coverage
from agenthorizon.sources.hf import HFDatasetClient, HFError
from agenthorizon.testing.fake_hf import FakeHub
from agenthorizon.testing.fixture import build_fixture


@pytest.fixture(scope="module")
def fixture_dir(tmp_path_factory) -> tuple[Path, dict]:
    d = tmp_path_factory.mktemp("fixture")
    summary = build_fixture(d)
    return d, summary


def settings_for(tmp: Path, **kw) -> Settings:
    return Settings(var_dir=tmp / "var", **kw)


def test_layout_detection(fixture_dir):
    d, _ = fixture_dir
    info = detect_layout(d)
    assert info.kind == "hf-release"
    assert info.md_dir == d / "sandbox" / "data" / "markdowns"
    assert sorted(p.name for p in info.label_files) == ["AgentHorizon-Simple.jsonl", "AgentHorizon.jsonl"]


def test_local_ingest_is_idempotent_and_complete(tmp_path, fixture_dir):
    d, fx = fixture_dir
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="local", local_dir=d, media="all"))
    assert r.status == "ingested" and r.dataset_version_id.startswith("fixture-synthetic@")
    dv = DatasetVersion(Path(r.root))
    assert dv.synthetic is True
    assert len(list(dv.examples())) == fx["n_examples"]
    again = ingest(s, IngestOptions(source="local", local_dir=d, media="all"))
    assert again.status == "already_ingested" and again.dataset_version_id == r.dataset_version_id
    # tamper with the stored identity: a different input digest under the same id must be refused
    v = json.loads((Path(r.root) / "version.json").read_text())
    v["input_digest"] = "0" * 64
    (Path(r.root) / "version.json").write_text(json.dumps(v))
    with pytest.raises(IngestError, match="refusing to replace"):
        ingest(s, IngestOptions(source="local", local_dir=d, media="all"))


def test_labels_live_only_in_private_store(tmp_path, fixture_dir):
    d, fx = fixture_dir
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="local", local_dir=d, media="none"))
    root = Path(r.root)
    label_keys = {"label", "negative_source", "paired_id", "mistake_type", "original_id"}

    def walk(o, where):
        if isinstance(o, dict):
            assert not (label_keys & set(o)), f"label-bearing keys {label_keys & set(o)} in {where}"
            for v in o.values():
                walk(v, where)
        elif isinstance(o, list):
            for v in o:
                walk(v, where)

    for p in root.rglob("*"):
        if not p.is_file():
            continue
        assert p.name not in ("AgentHorizon.jsonl", "AgentHorizon-Simple.jsonl"), p
        if p.suffix == ".json":
            walk(json.loads(p.read_text()), p)
        elif p.suffix == ".jsonl":
            for line in p.read_text().splitlines():
                if line.strip():
                    walk(json.loads(line), p)
    priv = s.private_dir / r.dataset_version_id
    assert stat.S_IMODE(os.stat(priv).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(priv / "gold_labels.jsonl").st_mode) == 0o600
    store = PrivateStore(s.private_dir, r.dataset_version_id)
    assert len(store.gold) == fx["n_examples"]


def test_untyped_negative_stays_untyped_and_manifests_score(tmp_path, fixture_dir):
    d, fx = fixture_dir
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="local", local_dir=d, media="none"))
    dv = DatasetVersion(Path(r.root))
    store = PrivateStore(s.private_dir, dv.id)
    untyped = [g for g in store.gold.values() if g["label"] == "negative" and g["category"] is None]
    assert len(untyped) == 1 and untyped[0]["category_status"] == "absent"
    plural = [g for g in store.gold.values() if g["mistake_type_native"] == "Misunderstanding of the Instructions"]
    assert plural and all(g["category"] == "misunderstanding_of_the_instruction" for g in plural)
    full = next(m for m in dv.manifests() if m.partition == "full-release")
    sm = store.scoring_manifest(full)
    assert sum(1 for i in sm.items if i.label == "positive") == fx["n_positive"]
    assert sum(1 for i in sm.items if i.label == "negative") == fx["n_negative"]
    assert sum(1 for i in sm.items if i.label == "negative" and i.category is None) == 1
    legacy = [m for m in dv.manifests() if m.partition == "legacy-submitted"]
    assert sorted(len(m.example_ids) for m in legacy) == sorted(fx["label_files"].values())
    assert all(m.official is False for m in dv.manifests())  # synthetic data is never official


def test_grouping_recovers_pair_components(tmp_path, fixture_dir):
    d, _ = fixture_dir
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="local", local_dir=d, media="none"))
    store = PrivateStore(s.private_dir, r.dataset_version_id)
    sizes = sorted({g["component_id"]: g["component_size"] for g in store.grouping.values()}.values())
    assert sizes == [3, 4, 4, 4]  # one pair lost a positive to review exclusion
    ingest_report = json.loads((Path(r.root) / "reports" / "ingest.json").read_text())
    lab_stage = next(x for x in ingest_report["stages"] if x["stage"] == "labels")
    assert lab_stage["details"]["label_grouping_available"] is True


def test_invalid_record_is_quarantined_not_dropped(tmp_path, fixture_dir):
    d, _ = fixture_dir
    broken = tmp_path / "broken"
    import shutil

    shutil.copytree(d, broken)
    victim = sorted((broken / "sandbox" / "data" / "jsons").glob("*.json"))[0]
    victim.write_text("{ this is not json")
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="local", local_dir=broken, media="none"))
    root = Path(r.root)
    assert (root / "quarantine" / victim.name).is_file()
    val = json.loads((root / "reports" / "validation.json").read_text())
    q = next(c for c in val["checks"] if c["check"] == "quarantine")
    assert q["status"] == "fail" and q["count"] == 1 and victim.stem in q["examples"]
    orphan = next(c for c in val["checks"] if c["check"] == "orphan_labels")
    assert orphan["status"] == "pass"  # the label of a quarantined record is not reported as orphaned
    full = next(m for m in DatasetVersion(root).manifests() if m.partition == "full-release")
    assert victim.stem not in full.example_ids


def test_hf_ingest_metadata_then_lazy_media_with_faults(tmp_path, fixture_dir):
    d, _ = fixture_dir
    hub = FakeHub(d, page_size=40)
    client = HFDatasetClient("ServiceNow/AgentHorizon", transport=hub.transport(), backoff_base=0.0)
    s = settings_for(tmp_path)
    r = ingest(s, IngestOptions(source="hf", media="none"), client=client)
    dv = DatasetVersion(Path(r.root))
    assert dv.info["source"]["revision"] == "f" * 8 + "0123456789abcdef0123456789abcdef"
    cov = media_coverage(dv)
    assert cov["by_status"] == {"not_materialized": cov["assets"]}
    assert all(a["expected_digest"][0] == "sha256" for a in current_assets(dv).values())
    # pick one recording and inject faults on three of its images
    ex = next(dv.examples())
    keys = [s_["asset_key"] for s_ in dv.steps(ex["recording_id"])]
    base = "sandbox/data/media/images/"
    hub.faults[base + keys[0]] = ["503"]
    hub.faults[base + keys[1]] = ["drop"]
    hub.faults[base + keys[2]] = ["corrupt"]
    out = materialize_media(s, dv, recording_id=ex["recording_id"], client=client)
    assert out["materialized"] == len(keys) and out["failed"] == 0
    ranged = [h for (_m, p, h) in hub.requests if p.endswith(keys[1]) and "range" in h]
    assert ranged, "a dropped transfer must resume with a Range request"
    assets = current_assets(dv)
    assert all(assets[k]["status"] == "materialized" for k in keys)
    # a permanently missing file is reported, not hidden
    other = next(e for e in dv.examples() if e["recording_id"] != ex["recording_id"])
    k2 = [s_["asset_key"] for s_ in dv.steps(other["recording_id"])][0]
    hub.faults[base + k2] = ["404"]
    out2 = materialize_media(s, dv, keys=[k2], client=client)
    assert out2["failed"] == 1 and current_assets(dv)[k2]["status"] == "fetch_failed"


def test_hf_egress_denial_is_classified(tmp_path, fixture_dir):
    d, _ = fixture_dir
    hub = FakeHub(d, deny_all=True)
    client = HFDatasetClient("ServiceNow/AgentHorizon", transport=hub.transport())
    with pytest.raises(HFError) as ei:
        ingest(settings_for(tmp_path), IngestOptions(source="hf"), client=client)
    assert ei.value.kind == "egress_denied"


def test_storage_limit_refuses_transfer(tmp_path, fixture_dir):
    d, _ = fixture_dir
    s = settings_for(tmp_path, storage_limit_bytes=10_000)
    with pytest.raises(IngestError, match="storage limit"):
        ingest(s, IngestOptions(source="local", local_dir=d, media="all"))
