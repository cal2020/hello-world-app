"""Split manifests and partition procedures.

Official membership is *imported* from released files. The procedures below exist to (a) document and test
the exact rules, and (b) recompute a partition from released verdicts when those exist. A partition computed
here always gets its own identity (``partition="reconstructed:..."``, ``official=False``) and lineage; it is
never registered as the official AH/AH-S/AH-D membership.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field

from agenthorizon.util.hashing import digest_json

# Released label-file names (S3 README) -> legacy manifest identity.
LEGACY_LABEL_FILES = {
    "AgentHorizon.jsonl": ("legacy-AH", "AgentHorizon (legacy submitted partition, challenging)"),
    "AgentHorizon-Simple.jsonl": ("legacy-AH-S", "AgentHorizon-Simple (legacy submitted partition)"),
}
REVISED_NAMES = ("AH-D", "AH", "AH-S")


@dataclass
class Manifest:
    manifest_id: str
    name: str
    dataset_version_id: str
    partition: str  # legacy-submitted | revised | reconstructed:<proc> | custom | engineering-smoke | full-release
    role: str  # evaluation | development | subset | engineering-smoke
    official: bool
    example_ids: list[str]
    lineage: dict
    notes: list[str] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return digest_json(sorted(self.example_ids))

    def to_dict(self) -> dict:
        d = asdict(self)
        d["example_ids"] = sorted(self.example_ids)
        d["n_items"] = len(self.example_ids)
        d["digest"] = self.digest
        return d

    @classmethod
    def from_dict(cls, d: dict) -> Manifest:
        return cls(d["manifest_id"], d["name"], d["dataset_version_id"], d["partition"], d["role"], d["official"],
                   list(d["example_ids"]), d.get("lineage", {}), d.get("notes", []))


# ---- legacy procedure (scripts/aggregate_difficulty.py @8584a347) ---------------------------------------
LEGACY_K = 8
LEGACY_EASY_THRESHOLD = 7


def verdict_agrees(success: object, gold_label: str) -> bool:
    """Strict agreement: only JSON Booleans count (aggregate_difficulty uses ``is True`` / ``is False``)."""
    return (success is True and gold_label == "positive") or (success is False and gold_label == "negative")


def legacy_difficulty(success_count: int, attempts_seen: int, error_count: int,
                      k: int = LEGACY_K, threshold: int = LEGACY_EASY_THRESHOLD) -> str:
    if error_count > 0:
        return "error"
    if attempts_seen < k:
        return "incomplete"
    return "easy" if success_count >= threshold else "hard"


# ---- revised procedure (MP §2, attributed to S1) ---------------------------------------------------------
REVISED_SPLITTERS = ("qwen3.5-122b-a10b", "inkling", "kimi-k2.7-code")
REVISED_VERDICTS_PER_MODEL = 8
REVISED_AH_MAX_CORRECT = 18  # <= 18 of 24 correct -> AH ; > 18 -> AH-S


@dataclass
class RevisedAssignment:
    example_id: str
    correct: int
    total: int
    bucket: str | None  # "AH" | "AH-S" | None when the verdict matrix is incomplete
    reason: str


def revised_bucket(example_id: str, gold_label: str, verdicts: Mapping[str, Sequence[object]],
                   splitters: Sequence[str] = REVISED_SPLITTERS,
                   per_model: int = REVISED_VERDICTS_PER_MODEL,
                   max_correct_for_ah: int = REVISED_AH_MAX_CORRECT) -> RevisedAssignment:
    """``verdicts[model]`` is the list of ``success`` values (any JSON type) from that model's attempts.

    Invalid verdicts (non-Boolean or missing) occupy a slot and are not correct. A model with fewer than
    ``per_model`` recorded slots makes the item incomplete (no bucket) rather than silently shrinking 24.
    """
    total = len(splitters) * per_model
    for m in splitters:
        got = len(verdicts.get(m, ()))
        if got != per_model:
            return RevisedAssignment(example_id, 0, total, None, f"incomplete: {m} has {got}/{per_model} verdict slots")
    correct = sum(1 for m in splitters for v in verdicts[m] if verdict_agrees(v, gold_label))
    bucket = "AH" if correct <= max_correct_for_ah else "AH-S"
    return RevisedAssignment(example_id, correct, total, bucket, f"{correct}/{total} correct")


def reconstructed_manifests(assignments: Iterable[RevisedAssignment], dataset_version_id: str, *,
                            procedure: str, inputs_digest: str) -> list[Manifest]:
    ah, ahs, inc = [], [], []
    for a in assignments:
        (ah if a.bucket == "AH" else ahs if a.bucket == "AH-S" else inc).append(a.example_id)
    lineage = {"procedure": procedure, "inputs_digest": inputs_digest,
               "rule": f"<= {REVISED_AH_MAX_CORRECT} of 24 correct -> AH", "incomplete": len(inc)}
    tag = f"reconstructed:{procedure}"
    return [
        Manifest(f"{tag}:AH", "AH (reconstructed, NOT official)", dataset_version_id, tag, "evaluation", False, ah, lineage),
        Manifest(f"{tag}:AH-S", "AH-S (reconstructed, NOT official)", dataset_version_id, tag, "evaluation", False, ahs, lineage),
    ]


def engineering_smoke_selection(candidate_ids: Sequence[str], n: int, dataset_version_id: str, *, seed_note: str) -> Manifest:
    """Deterministic smoke selection for pipeline exercise. Never a development set, never used for tuning."""
    chosen = sorted(candidate_ids, key=lambda x: digest_json([seed_note, x]))[:n]
    return Manifest(f"smoke:{digest_json(chosen)[:10]}", f"Engineering smoke selection ({n})", dataset_version_id,
                    "engineering-smoke", "engineering-smoke", False, chosen,
                    {"procedure": "sha256-ordered selection", "seed_note": seed_note},
                    ["Not AH-D. Every example touched is recorded; do not use for prompt tuning."])
