"""Immutable dataset-version store.

Judge-visible material (released Markdown/JSON, normalized examples and steps, manifests) lives under
``datasets/<version>/``. Scorer-only material (label files, gold labels, pair grouping) lives under the
separate ``private/<version>/`` root, which is never mounted into judge workspaces and is opened only through
``PrivateStore``. Judge-staging code must not import this module's ``PrivateStore`` (enforced by a test).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from functools import cached_property
from pathlib import Path

from agenthorizon.data.splits import Manifest
from agenthorizon.scoring.categories import normalize_native
from agenthorizon.scoring.protocol import GoldItem, ScoringManifest
from agenthorizon.util.io import read_jsonl


class DatasetNotFound(KeyError):
    pass


class DatasetVersion:
    def __init__(self, root: Path):
        self.root = Path(root)
        if not (self.root / "version.json").is_file():
            raise DatasetNotFound(f"no dataset version at {self.root}")

    @cached_property
    def info(self) -> dict:
        return json.loads((self.root / "version.json").read_text())

    @property
    def id(self) -> str:
        return self.info["dataset_version_id"]

    @property
    def synthetic(self) -> bool:
        return bool(self.info.get("synthetic"))

    @cached_property
    def _examples(self) -> dict[str, dict]:
        p = self.root / "normalized" / "examples.jsonl"
        return {r["example_id"]: r for _, r in read_jsonl(p)} if p.is_file() else {}

    def examples(self) -> Iterator[dict]:
        yield from self._examples.values()

    def example(self, example_id: str) -> dict:
        try:
            return self._examples[example_id]
        except KeyError as exc:
            raise DatasetNotFound(f"{example_id} not in {self.id}") from exc

    def example_ids(self) -> frozenset[str]:
        return frozenset(self._examples)

    @cached_property
    def _recordings(self) -> dict[str, dict]:
        p = self.root / "normalized" / "recordings.jsonl"
        return {r["recording_id"]: r for _, r in read_jsonl(p)} if p.is_file() else {}

    def recording(self, recording_id: str) -> dict:
        return self._recordings[recording_id]

    def steps(self, recording_id: str) -> list[dict]:
        return json.loads((self.root / "normalized" / "steps" / f"{recording_id}.json").read_text())

    @cached_property
    def assets(self) -> dict[str, dict]:
        p = self.root / "normalized" / "assets.jsonl"
        return {r["asset_key"]: r for _, r in read_jsonl(p)} if p.is_file() else {}

    def released_markdown(self, example_id: str) -> str | None:
        rel = self.example(example_id)["source_files"].get("markdown")
        if not rel:
            return None
        p = self.root / "raw" / rel["path"]
        return p.read_text(encoding="utf-8") if p.is_file() else None

    def released_json(self, example_id: str) -> dict | None:
        rel = self.example(example_id)["source_files"].get("json")
        if not rel:
            return None
        p = self.root / "raw" / rel["path"]
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    def manifests(self) -> list[Manifest]:
        d = self.root / "manifests"
        return [Manifest.from_dict(json.loads(p.read_text())) for p in sorted(d.glob("*.json"))] if d.is_dir() else []

    def manifest(self, manifest_id: str) -> Manifest:
        for m in self.manifests():
            if m.manifest_id == manifest_id:
                return m
        raise DatasetNotFound(f"manifest {manifest_id} not in {self.id}")

    def report(self, name: str) -> dict | None:
        p = self.root / "reports" / f"{name}.json"
        return json.loads(p.read_text()) if p.is_file() else None


class PrivateStore:
    """Scorer-only view of a dataset version. Construct only in scoring/research code paths."""

    def __init__(self, private_root: Path, dataset_version_id: str):
        self.root = Path(private_root) / dataset_version_id
        self.dataset_version_id = dataset_version_id

    def available(self) -> bool:
        return (self.root / "gold_labels.jsonl").is_file()

    @cached_property
    def gold(self) -> dict[str, dict]:
        p = self.root / "gold_labels.jsonl"
        return {r["example_id"]: r for _, r in read_jsonl(p)} if p.is_file() else {}

    @cached_property
    def grouping(self) -> dict[str, dict]:
        p = self.root / "grouping.jsonl"
        return {r["example_id"]: r for _, r in read_jsonl(p)} if p.is_file() else {}

    def scoring_manifest(self, manifest: Manifest) -> ScoringManifest:
        items = []
        missing = []
        for eid in sorted(manifest.example_ids):
            g = self.gold.get(eid)
            if g is None:
                missing.append(eid)
                continue
            cat = None
            if g["label"] == "negative":
                cat, _ = normalize_native(g.get("mistake_type_native"))
            items.append(GoldItem(eid, g["label"], cat, g.get("mistake_type_native")))
        if missing:
            raise ValueError(f"{len(missing)} manifest members lack gold labels (e.g. {missing[:3]}); "
                             "a manifest cannot be scored without complete labels")
        return ScoringManifest(manifest.manifest_id, manifest.dataset_version_id, tuple(items), role=manifest.role,
                               partition=manifest.partition, official=manifest.official)
