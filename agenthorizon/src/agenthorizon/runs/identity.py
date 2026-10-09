"""Canonical run identity.

A run is identified by the digest of everything that can change a judgment or which judgments are made: dataset
version (and its input digest), the selected example IDs, the judge configuration as resolved (interface, route,
exact model identifier, harness binary version and digest, effort, sampling, endpoint), prompt and instruction
revisions, preprocessing, staging mode, attempt policy and selection rule, execution policy, the digest of the
judging/run code, and the trial index. Concurrency and budget are run *controls*, not identity: they decide how
fast or how far a run proceeds, never what a judgment means.

Different definitions produce different identities, so changing the model, prompt, or code always creates a new
run; resuming is allowed only for an identical definition. Repeated trials are separate identities (``trial``).
"""

from __future__ import annotations

import subprocess
from dataclasses import asdict, dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from agenthorizon.util.hashing import digest_json, sha256_file

DEFINITION_SCHEMA = "ah-run-definition/1"
_PKG_ROOT = Path(__file__).resolve().parents[1]
CORE_DIRS = ("judging", "runs", "data", "util")


@dataclass(frozen=True)
class RunDefinition:
    dataset_version_id: str
    dataset_input_digest: str
    normalizer_version: str
    synthetic_data: bool
    selection: dict
    scoring_manifest_id: str | None
    judge: dict
    prompt: dict
    instructions: dict | None
    preprocessing: dict | None
    staging_mode: str
    attempt_policy: dict
    execution: dict
    code: dict
    trial: int = 1
    classification: dict = field(default_factory=dict)
    schema: str = DEFINITION_SCHEMA

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def digest(self) -> str:
        return digest_json(self.to_dict())

    @property
    def run_id(self) -> str:
        return f"run-{self.digest[:20]}"

    @property
    def example_ids(self) -> list[str]:
        return list(self.selection["example_ids"])

    @classmethod
    def from_dict(cls, d: dict) -> RunDefinition:
        return cls(**d)


def core_code_digest() -> str:
    files = []
    for sub in CORE_DIRS:
        for p in sorted((_PKG_ROOT / sub).rglob("*.py")):
            files.append([str(p.relative_to(_PKG_ROOT)), sha256_file(p)])
    return digest_json(files)


def package_version() -> str:
    try:
        return version("agenthorizon")
    except PackageNotFoundError:
        return "0+unknown"


def code_identity() -> dict:
    return {"package_version": package_version(), "core_digest": core_code_digest()}


def git_state() -> dict:
    """Informational only (not part of identity): the working tree may be dirty during development."""
    root = _PKG_ROOT.parents[1]
    try:
        commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                                timeout=10, check=False).stdout.strip() or None
        dirty = bool(subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--", "src"], capture_output=True,
                                    text=True, timeout=10, check=False).stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        commit, dirty = None, None
    return {"git_commit": commit, "git_dirty_src": dirty}


def classify_result_kind(*, prompt_paper_mode: bool, instructions_paper_mode: bool | None, model_id_evidenced: bool,
                         preprocessing_paper_mode: bool | None, staging_mode: str, policy_reference: bool,
                         synthetic_data: bool, official_selection: bool) -> dict:
    """Label per MP §9: a *new paper-compatible run* only when every protocol element matches the release."""
    reasons = []
    if synthetic_data:
        reasons.append("synthetic test data (never a benchmark result)")
    if not prompt_paper_mode:
        reasons.append("prompt is not the released prompt")
    if instructions_paper_mode is False:
        reasons.append("harness instruction file is not the official AGENTS.md (unreleased); extension substitute staged")
    if not model_id_evidenced:
        reasons.append("model identifier not evidenced by a released artifact (operator-supplied)")
    if preprocessing_paper_mode is False:
        reasons.append("preprocessing mode is an extension")
    if staging_mode != "paper-paths":
        reasons.append(f"staging mode {staging_mode} (path remapping)")
    if not policy_reference:
        reasons.append("attempt policy differs from the released runner")
    kind = "new_paper_compatible" if not reasons else "extension"
    if synthetic_data:
        kind = "test_fixture"
    return {"result_kind": kind, "reasons": reasons,
            "official_selection": official_selection,
            "note": "Even a paper-compatible run is a new measurement, not the paper's reported result."}
