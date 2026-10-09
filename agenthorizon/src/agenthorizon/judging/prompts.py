"""Prompt revisions, imported at the locked revision (never re-typed or "improved").

* ``ah-official-agentic@8584a347`` — ``prompts/evaluate_trajectory.txt`` (the P6 variant per the runner's help
  text), templated with ``{{TRAJECTORY_ID}}``; the judge reads trajectory files from its working directory.
* ``ah-official-direct@8584a347`` — the ``EVAL_PROMPT`` system message embedded in
  ``llm_judges/preprocess_compress.py`` (identical in ``preprocess_filter.py``), extracted with ``ast`` so no
  code from the repository is executed.

The agentic prompt instructs judges to read AGENTS.md / CLAUDE.md / GEMINI.md, which are not present in the
release we could read (see DATA_AVAILABILITY.json ``ah-harness-instructions``). Paper-mode agentic runs are
therefore *blocked* unless an operator registers the official file with provenance. Comparison with the paper's
prompt figure is blocked while S1 is inaccessible.
"""

from __future__ import annotations

import ast
from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.sources.cache import locked_revision, pinned_file
from agenthorizon.util.hashing import sha256_file, sha256_text

AH = "agenthorizon-repo"


@dataclass
class PromptRevision:
    prompt_id: str
    kind: str  # agentic | direct | harness_instructions
    text: str
    sha256: str
    source: dict
    template_vars: list[str] = field(default_factory=list)
    paper_mode: bool = True
    notes: list[str] = field(default_factory=list)

    def render(self, **values: str) -> str:
        out = self.text
        for k in self.template_vars:
            if k not in values:
                raise KeyError(f"prompt {self.prompt_id} needs {k}")
            out = out.replace("{{" + k + "}}", values[k])
        return out

    def to_dict(self, include_text: bool = True) -> dict:
        d = asdict(self)
        if not include_text:
            d.pop("text")
        return d


def _string_constant(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, str):
                return value
    raise KeyError(f"{name} not found as a string constant in {path}")


def official_agentic_prompt() -> PromptRevision:
    rel = "prompts/evaluate_trajectory.txt"
    p = pinned_file(AH, rel)
    raw = p.read_text()
    text = raw.strip()  # the runner applies .strip() before use (evaluate_trajectories.py:run)
    rev = locked_revision(AH)
    return PromptRevision(
        prompt_id=f"ah-official-agentic@{rev[:8]}",
        kind="agentic",
        text=text,
        sha256=sha256_text(text),
        source={"source_id": AH, "revision": rev, "path": rel, "file_sha256": sha256_file(p),
                "transform": "str.strip() as in scripts/evaluate_trajectories.py:run"},
        template_vars=["TRAJECTORY_ID"],
        notes=["Requires AGENTS.md/CLAUDE.md/GEMINI.md in the working directory (not located in the release).",
               "Paper prompt-figure comparison blocked: S1 inaccessible."],
    )


def official_direct_prompt() -> PromptRevision:
    rel = "llm_judges/preprocess_compress.py"
    p = pinned_file(AH, rel)
    text = _string_constant(p, "EVAL_PROMPT")
    other = _string_constant(pinned_file(AH, "llm_judges/preprocess_filter.py"), "EVAL_PROMPT")
    rev = locked_revision(AH)
    notes = ["Identical EVAL_PROMPT in preprocess_filter.py" if other == text else "EVAL_PROMPT differs in preprocess_filter.py"]
    return PromptRevision(
        prompt_id=f"ah-official-direct@{rev[:8]}",
        kind="direct",
        text=text,
        sha256=sha256_text(text),
        source={"source_id": AH, "revision": rev, "path": rel, "symbol": "EVAL_PROMPT", "file_sha256": sha256_file(p),
                "extraction": "ast.literal_eval of the module-level assignment (no code executed)"},
        notes=notes + ["Paper prompt-figure comparison blocked: S1 inaccessible."],
    )


def harness_instructions(operator_file: Path | None = None) -> PromptRevision | None:
    """The judge-framework file the agentic prompt references. Only an operator-registered file counts."""
    if operator_file is None or not Path(operator_file).is_file():
        return None
    text = Path(operator_file).read_text()
    return PromptRevision(
        prompt_id=f"operator-harness-instructions@{sha256_text(text)[:8]}",
        kind="harness_instructions",
        text=text,
        sha256=sha256_text(text),
        source={"source_id": "operator", "path": str(operator_file)},
        paper_mode=True,
        notes=["Operator-registered; its provenance must be the official release file for paper mode."],
    )


def rubric_extension_instructions() -> PromptRevision:
    """EXTENSION (not paper mode): stage the released S7 rubric as the harness instruction file."""
    rel = "docs/mistake-taxonomy.md"
    p = pinned_file(AH, rel)
    text = p.read_text()
    rev = locked_revision(AH)
    return PromptRevision(
        prompt_id=f"ext-rubric-as-agents-md@{rev[:8]}",
        kind="harness_instructions",
        text=text,
        sha256=sha256_text(text),
        source={"source_id": AH, "revision": rev, "path": rel, "file_sha256": sha256_file(p)},
        paper_mode=False,
        notes=["Extension: substitutes the public rubric for the unreleased AGENTS.md. Never a paper-mode run."],
    )


def registry() -> dict[str, PromptRevision]:
    out = {}
    for fn in (official_agentic_prompt, official_direct_prompt, rubric_extension_instructions):
        p = fn()
        out[p.prompt_id] = p
    return out
