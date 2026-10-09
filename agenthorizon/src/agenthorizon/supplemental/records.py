"""Supplemental source records (kept apart from AgentHorizon datasets and denominators).

A record is one native unit of a supplemental source: an annotated trajectory, a trajectory with its observation
sequence, or a task definition (which is NOT a trajectory). Every record preserves upstream provenance (URL, revision,
licence, file digest and line), native identifiers and schema, the original labels with how they were obtained,
modality/field coverage, grouping and split, and deduplication lineage. Labels obtained from machine evaluators, or
inferred/synthetic, are flagged and never used for official reproduction.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.util.hashing import digest_json, sha256_text
from agenthorizon.util.io import atomic_write_json, utcnow_iso

RECORD_KINDS = ("annotation_only", "trajectory", "task_definition")
LABEL_KINDS = ("expert_annotation", "machine_evaluator", "inferred", "synthetic")


@dataclass
class SupLabel:
    field: str  # native field name, e.g. trajectory_success
    value_native: object
    kind: str  # expert_annotation | machine_evaluator | inferred | synthetic
    annotator: str | None = None
    role: str | None = None  # primary | secondary (ARB) | None
    binary: bool | None = None  # derived success label when the native value maps unambiguously
    compatible_binary: bool = False  # usable as a binary success label for judge evaluation
    rule: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SupStep:
    index: int
    action_native: object
    action_text: str
    observation: dict  # {"screenshot_ref", "timing", ...}
    thought: str | None = None
    extra: dict = field(default_factory=dict)


@dataclass
class SupRecord:
    record_id: str
    source_id: str
    kind: str
    native_ids: dict
    native_schema: str
    instruction: str | None
    steps: list[SupStep] | None
    labels: list[SupLabel]
    split: str | None
    groups: dict
    coverage: dict
    missing: list[str]
    provenance: dict
    flags: list[str] = field(default_factory=list)
    dedup: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["content_hash"] = self.content_hash
        return d

    @property
    def content_hash(self) -> str:
        """Exact-duplicate key: normalized instruction + action sequence (screenshots are hashed separately)."""
        acts = [s.action_text for s in self.steps] if self.steps else []
        return digest_json([normalize_text(self.instruction or ""), acts])


def normalize_text(s: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in s).split())


class SupplementalStore:
    """``var/supplemental/<source_id>@<revision>/``: records.jsonl, version.json, coverage.json."""

    def __init__(self, root: Path):
        self.root = Path(root)

    @classmethod
    def for_source(cls, var_dir: Path, source_id: str, revision: str) -> SupplementalStore:
        return cls(Path(var_dir) / "supplemental" / f"{source_id}@{revision[:12]}")

    def write(self, records: list[SupRecord], version: dict) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        ids = [r.record_id for r in records]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate supplemental record ids")
        lines = [json.dumps(r.to_dict(), sort_keys=True) for r in sorted(records, key=lambda r: r.record_id)]
        tmp = self.root / "records.jsonl.partial"
        tmp.write_text("".join(x + "\n" for x in lines))
        tmp.replace(self.root / "records.jsonl")
        cov = coverage_report(records)
        atomic_write_json(self.root / "coverage.json", cov)
        v = {**version, "records": len(records), "records_sha256": sha256_text("".join(x + "\n" for x in lines)),
             "written_at": utcnow_iso()}
        atomic_write_json(self.root / "version.json", v)
        return v

    def version(self) -> dict:
        return json.loads((self.root / "version.json").read_text())

    def records(self) -> list[dict]:
        p = self.root / "records.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.is_file() else []

    def coverage(self) -> dict:
        p = self.root / "coverage.json"
        return json.loads(p.read_text()) if p.is_file() else {}


def coverage_report(records: list[SupRecord]) -> dict:
    by_kind: dict[str, int] = {}
    fields: dict[str, int] = {}
    missing: dict[str, int] = {}
    label_kinds: dict[str, int] = {}
    binary = 0
    for r in records:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
        for k, v in r.coverage.items():
            if v:
                fields[k] = fields.get(k, 0) + 1
        for m in r.missing:
            missing[m] = missing.get(m, 0) + 1
        for lab in r.labels:
            label_kinds[lab.kind] = label_kinds.get(lab.kind, 0) + 1
        # the gold rule: a multi-annotated source's primary annotation decides (a secondary never fills in for an
        # 'Unsure' primary); single-annotation sources have role None
        binary += any(lab.compatible_binary and lab.binary is not None and lab.role in (None, "primary")
                      for lab in r.labels)
    n = len(records) or 1
    return {"records": len(records), "by_kind": by_kind, "field_coverage": {k: v / n for k, v in sorted(fields.items())},
            "missing_material": missing, "label_kinds": label_kinds, "records_with_compatible_binary_label": binary,
            "note": "Coverage is the fraction of records carrying each field; missing material lists what the release "
                    "does not provide here (or what was unreachable). Usable binary labels follow the gold rule "
                    "(primary annotation only)."}
