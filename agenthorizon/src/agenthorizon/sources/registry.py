"""Registry of primary and supplemental sources.

Citation keys follow the master prompt (S1..S10). URLs are discovery locations; the lock records the
resolved immutable revision (commit SHA, dataset revision SHA, paper version) actually retrieved.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

SourceKind = Literal["paper", "git", "hf_dataset", "dataverse", "repo_document", "instruction_document"]
SourceRole = Literal[
    "target_specification",  # defines the scientific claim (paper)
    "executable_reference",  # code/configs that define executable detail
    "benchmark_data",  # official released data
    "documentation",  # protocol/rubric documents
    "supplemental_data",  # external corpora (never blended into AgentHorizon denominators)
    "task_brief",  # the implementation brief supplied by the user
]


@dataclass(frozen=True)
class SourceSpec:
    source_id: str
    citation: str
    kind: SourceKind
    role: SourceRole
    title: str
    urls: tuple[str, ...]
    requested_revision: str | None = None
    # For repo documents: which git source and path they live in.
    parent_source_id: str | None = None
    path: str | None = None
    probe_urls: tuple[str, ...] = ()
    notes: str = ""
    expected_license_files: tuple[str, ...] = ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING")
    tags: tuple[str, ...] = field(default_factory=tuple)


AH_REPO_URL = "https://github.com/ServiceNow/agenthorizon"
AH_DATASET_REPO = "ServiceNow/AgentHorizon"
ARB_REPO_URL = "https://github.com/McGill-NLP/agent-reward-bench"
ARB_DATASET_REPO = "McGill-NLP/agent-reward-bench"
OSWORLD_REPO_URL = "https://github.com/xlang-ai/OSWorld"

SOURCES: tuple[SourceSpec, ...] = (
    SourceSpec(
        source_id="agenthorizon-paper",
        citation="S1",
        kind="paper",
        role="target_specification",
        title="AgentHorizon: Evaluating Agentic Judges for Long-Horizon Computer-Use Tasks (arXiv:2610.11050v1)",
        urls=(
            "https://arxiv.org/abs/2610.11050",
            "https://arxiv.org/html/2610.11050v1",
            "https://arxiv.org/pdf/2610.11050v1",
        ),
        requested_revision="v1",
        probe_urls=("https://arxiv.org/abs/2610.11050", "https://export.arxiv.org/abs/2610.11050"),
        notes="Target claim definition. Versioned PDF is the citable artifact.",
    ),
    SourceSpec(
        source_id="agenthorizon-repo",
        citation="S2",
        kind="git",
        role="executable_reference",
        title="ServiceNow/agenthorizon (authors' evaluation harness)",
        urls=(AH_REPO_URL,),
        requested_revision="main",
        notes="Branch names are not reproducible identifiers; the lock pins the resolved commit.",
    ),
    SourceSpec(
        source_id="agenthorizon-dataset",
        citation="S3",
        kind="hf_dataset",
        role="benchmark_data",
        title="Hugging Face dataset ServiceNow/AgentHorizon",
        urls=(f"https://huggingface.co/datasets/{AH_DATASET_REPO}",),
        requested_revision="main",
        probe_urls=(f"https://huggingface.co/api/datasets/{AH_DATASET_REPO}",),
        notes="Trajectories, labels, screenshots. ~43 GB advertised at prompt preparation; pinned bytes must be re-queried.",
    ),
    SourceSpec(
        source_id="agenthorizon-standard",
        citation="S4",
        kind="repo_document",
        role="documentation",
        title="Trajectory standard (STANDARD.md)",
        urls=(f"{AH_REPO_URL}/blob/main/STANDARD.md",),
        parent_source_id="agenthorizon-repo",
        path="STANDARD.md",
    ),
    SourceSpec(
        source_id="agenthorizon-eval-protocol",
        citation="S5",
        kind="repo_document",
        role="documentation",
        title="Judge evaluation protocol",
        urls=(f"{AH_REPO_URL}/blob/main/docs/evaluation-protocol.md",),
        parent_source_id="agenthorizon-repo",
        path="docs/evaluation-protocol.md",
    ),
    SourceSpec(
        source_id="agenthorizon-construction",
        citation="S6",
        kind="repo_document",
        role="documentation",
        title="Benchmark construction and review",
        urls=(f"{AH_REPO_URL}/blob/main/docs/benchmark-construction.md",),
        parent_source_id="agenthorizon-repo",
        path="docs/benchmark-construction.md",
    ),
    SourceSpec(
        source_id="agenthorizon-taxonomy",
        citation="S7",
        kind="repo_document",
        role="documentation",
        title="Failure-type annotation rubric",
        urls=(f"{AH_REPO_URL}/blob/main/docs/mistake-taxonomy.md",),
        parent_source_id="agenthorizon-repo",
        path="docs/mistake-taxonomy.md",
    ),
    SourceSpec(
        source_id="agenthorizon-supplementary",
        citation="S8",
        kind="repo_document",
        role="documentation",
        title="Supplementary results and legacy-partition warning",
        urls=(f"{AH_REPO_URL}/blob/main/docs/supplementary-results.md",),
        parent_source_id="agenthorizon-repo",
        path="docs/supplementary-results.md",
    ),
    SourceSpec(
        source_id="agenthorizon-dataverse",
        citation="S2:paper/croissant.json",
        kind="dataverse",
        role="benchmark_data",
        title="Harvard Dataverse deposit doi:10.7910/DVN/J9KNWR (named in the authors' Croissant metadata)",
        urls=("https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/J9KNWR",),
        probe_urls=("https://dataverse.harvard.edu", "https://doi.org/10.7910/DVN/J9KNWR"),
        notes="Croissant lists anonymous-review download URLs and SHA-256 digests for labels, difficulty buckets, "
        "Markdown/JSON archives. Listed for provenance; the official download path is S3.",
    ),
    SourceSpec(
        source_id="agentrewardbench-repo",
        citation="S9",
        kind="git",
        role="supplemental_data",
        title="McGill-NLP/agent-reward-bench (code, expert annotations, splits)",
        urls=(ARB_REPO_URL,),
        requested_revision="main",
    ),
    SourceSpec(
        source_id="agentrewardbench-dataset",
        citation="S9",
        kind="hf_dataset",
        role="supplemental_data",
        title="Hugging Face dataset McGill-NLP/agent-reward-bench (trajectories, screenshots, judgments)",
        urls=(f"https://huggingface.co/datasets/{ARB_DATASET_REPO}",),
        requested_revision="main",
        probe_urls=(f"https://huggingface.co/api/datasets/{ARB_DATASET_REPO}",),
    ),
    SourceSpec(
        source_id="osworld-repo",
        citation="S10",
        kind="git",
        role="supplemental_data",
        title="xlang-ai/OSWorld (task definitions, evaluator configs, trace export format)",
        urls=(OSWORLD_REPO_URL,),
        requested_revision="main",
        notes="Task definitions are not trajectories; the repository does not itself ship agent traces.",
    ),
    SourceSpec(
        source_id="master-prompt",
        citation="MP",
        kind="instruction_document",
        role="task_brief",
        title="AgentHorizon full-stack implementation master prompt (prepared 2026-10-09)",
        urls=(),
        notes="User-supplied brief. Facts it attributes to S1 are recorded as 'described only by MP' until S1 is read.",
    ),
)

SOURCES_BY_ID = {s.source_id: s for s in SOURCES}


def get_source(source_id: str) -> SourceSpec:
    try:
        return SOURCES_BY_ID[source_id]
    except KeyError as exc:
        raise KeyError(f"unknown source {source_id!r}; known: {sorted(SOURCES_BY_ID)}") from exc
