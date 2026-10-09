"""Executable registry of every paper experiment evidenced by the accessible sources.

Each experiment names its judge configuration, the run selection, the manifests its reports are scored on, the
number of trials, the reference rows it can be compared with, and the artifacts it depends on. ``status()``
combines artifact availability, configuration capability, and dataset contents into ``runnable`` or ``blocked``
with every blocker listed; ``run_configs()`` turns a runnable experiment into concrete run configurations.

The S8 grids (legacy partition) are reproduced the way the release organizes them: one run per configuration over
the whole release, scored separately against the legacy AH manifest (S8.T1), the legacy AH-S manifest (S8.T2), and
the full release for exact category recall (S8.T3). Fixed denominators come from each manifest.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from agenthorizon.judging.registry import (
    CONFIGS,
    INTERFACE_LABELS,
    LABEL_TO_INTERFACE,
    MODELS_BY_KEY,
    NAME_TO_MODEL_KEY,
)

S8 = "agenthorizon-repo@8584a347:docs/supplementary-results.md"


@dataclass(frozen=True)
class ReportSpec:
    report_id: str
    manifest_kind: str  # legacy-AH | legacy-AH-S | full-release | revised-AH | revised-AH-S | revised-AH-D
    reference: dict | None = None  # {"table_id", "line"} for paper-reported comparison


@dataclass(frozen=True)
class Experiment:
    experiment_id: str
    title: str
    kind: str  # reference_grid | direct | splitter_legacy | splitter_revised | revised_main | development | ablation | trials
    judge_config: str | None
    selection: str  # full-release | revised-AH | ... | unknown
    reports: tuple[ReportSpec, ...]
    trials: int = 1
    requires: tuple[str, ...] = ()  # artifact ids (DATA_AVAILABILITY) that must be acquired
    analyses: tuple[str, ...] = ()
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


DATA = ("ah-markdowns", "ah-jsons", "ah-media")
LEGACY_LABELS = ("ah-legacy-labels-main", "ah-legacy-labels-simple")


def _grid_experiments(tables: list[dict] | None) -> list[Experiment]:
    by_pair: dict[tuple[str, str], dict] = {}
    if tables:
        for t in tables:
            for r in t["rows"]:
                key = (NAME_TO_MODEL_KEY.get(r["model"], r["model"]), LABEL_TO_INTERFACE.get(r["interface"], r["interface"]))
                by_pair.setdefault(key, {})[t["table_id"]] = r["line"]
    out = []
    for c in CONFIGS:
        if c.evidence_class != "paper_row":  # S8 rows only (revised splitters are brief-only)
            continue
        lines = by_pair.get((c.model_key, c.interface), {})
        m = MODELS_BY_KEY[c.model_key]
        reports = (
            ReportSpec("S8.T1", "legacy-AH", {"table_id": "S8.T1", "line": lines.get("S8.T1")} if "S8.T1" in lines else None),
            ReportSpec("S8.T2", "legacy-AH-S", {"table_id": "S8.T2", "line": lines.get("S8.T2")} if "S8.T2" in lines else None),
            ReportSpec("S8.T3", "full-release", {"table_id": "S8.T3", "line": lines.get("S8.T3")} if "S8.T3" in lines else None),
        )
        out.append(Experiment(
            f"grid:{c.config_id}", f"{m.display_name} · {INTERFACE_LABELS[c.interface]} on the full release (S8 legacy grids)",
            "reference_grid", c.config_id, "full-release", reports, 1, DATA + LEGACY_LABELS,
            ("slices", "resources", "reference_compare"),
            "Legacy-partition sensitivity grid; comparisons to S8 require the same model id, harness version, prompt and "
            "AGENTS.md (the official file is unreleased, so agentic runs are extensions unless an operator registers it)."
            + (" Also the legacy splitter configuration (its row is affected by defining the partition)." if c.role == "splitter" else ""),
        ))
    return out


def experiments(tables: list[dict] | None = None) -> list[Experiment]:
    if tables is None:
        try:
            from agenthorizon.reference.tables import supplementary_tables
            tables = supplementary_tables()
        except Exception:  # noqa: BLE001 — source checkout unavailable: grid rows without line references
            tables = None
    out = _grid_experiments(tables)
    for c in CONFIGS:
        if c.interface == "direct":
            out.append(Experiment(f"direct:{c.config_id.split(':', 1)[1]}", f"{MODELS_BY_KEY[c.model_key].display_name} direct judge ({c.preprocessing})",
                                  "direct", c.config_id, "full-release",
                                  (ReportSpec("full", "full-release"), ReportSpec("legacy-AH", "legacy-AH"), ReportSpec("legacy-AH-S", "legacy-AH-S")),
                                  1, DATA, ("slices", "resources"),
                                  "Direct-table rows are unreadable (S1 inaccessible); results are new measurements without a paper row."))
    out.append(Experiment(
        "splitter:legacy", "Legacy partition reconstruction: Qwen 3.5 122B-A10B splitter, 8 trials over the full release",
        "splitter_legacy", "opencode:qwen3.5-122b-a10b:splitter", "full-release", (ReportSpec("full", "full-release"),), 8,
        DATA + LEGACY_LABELS, ("legacy_partition_agreement",),
        "Easy iff >= 7/8 verdicts agree with gold (scripts/aggregate_difficulty.py). The released legacy membership is the "
        "comparison target; a reconstruction is never relabelled as the official partition."))
    for c in CONFIGS:
        if c.config_id.endswith(":splitter:revised"):
            out.append(Experiment(
                f"splitter:revised:{c.model_key}", f"Revised splitter {MODELS_BY_KEY[c.model_key].display_name}, 8 verdicts per item",
                "splitter_revised", c.config_id, "full-release", (ReportSpec("full", "full-release"),), 8, DATA,
                ("revised_partition_reconstruction",),
                "One of three revised splitters (MP §2); harness and identifiers for Inkling and Kimi K2.7 Code are unknown."))
    for c in CONFIGS:
        if c.evidence_class == "paper_row" and c.role == "judge":
            out.append(Experiment(
                f"revised:{c.config_id}", f"{MODELS_BY_KEY[c.model_key].display_name} · {INTERFACE_LABELS[c.interface]} on revised AH / AH-S",
                "revised_main", c.config_id, "revised-full",
                (ReportSpec("AH", "revised-AH"), ReportSpec("AH-S", "revised-AH-S")), 1,
                DATA + ("ah-revised-manifests", "ah-paper"), ("slices", "resources"),
                "Headline paper rows; the revised membership and the paper's table are both unavailable."))
    out += [
        Experiment("development:AH-D", "AH-D development reports (separate from held-out evaluation)", "development", None,
                   "revised-AH-D", (ReportSpec("AH-D", "revised-AH-D"),), 1, DATA + ("ah-revised-manifests",), (),
                   "Development membership not located; an engineering smoke selection is never relabelled as AH-D."),
        Experiment("ablation:input-removal", "Input-removal ablations on their stated examples", "ablation", None, "unknown",
                   (), 1, DATA + ("ah-ablation-membership", "ah-paper"), (),
                   "Ablation membership and the exact removed fields are not located; headline denominators are not reused."),
        Experiment("trials:repeated", "Repeated-trial variance (if the paper reports it)", "trials", None, "unknown", (), 1,
                   ("ah-paper",), (), "Whether and how repeated trials were reported cannot be determined from accessible sources."),
    ]
    return out


@dataclass
class ExperimentStatus:
    experiment_id: str
    status: str  # runnable | blocked
    blockers: list[str] = field(default_factory=list)
    data_blockers: list[str] = field(default_factory=list)
    config_blockers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def manifest_id_for(kind: str, dataset_version_id: str, available: set[str]) -> str | None:
    mid = {"legacy-AH": f"{dataset_version_id}:legacy-AH", "legacy-AH-S": f"{dataset_version_id}:legacy-AH-S",
           "full-release": f"{dataset_version_id}:full-release"}.get(kind)
    return mid if mid in available else None


def status(e: Experiment, availability: dict[str, str], capabilities: dict[str, dict], *,
           dataset_manifests: set[str] | None = None, dataset_version_id: str | None = None,
           dataset_synthetic: bool = False) -> ExperimentStatus:
    st = ExperimentStatus(e.experiment_id, "runnable")
    for a in e.requires:
        s = availability.get(a, "unknown")
        if s != "acquired":
            st.data_blockers.append(f"{a}: {s}")
    if dataset_version_id is not None:
        for r in e.reports:
            if r.manifest_kind.startswith("revised"):
                continue
            if manifest_id_for(r.manifest_kind, dataset_version_id, dataset_manifests or set()) is None:
                st.data_blockers.append(f"manifest {r.manifest_kind} absent from {dataset_version_id}")
        if dataset_synthetic:
            st.blockers.append("dataset version is the synthetic fixture: runs exercise the pipeline only")
    if e.selection in ("unknown",) or any(r.manifest_kind.startswith("revised") for r in e.reports) or e.selection.startswith("revised"):
        st.data_blockers.append("selection/membership not located")
    if e.judge_config:
        cap = capabilities.get(e.judge_config) or {}
        if cap.get("status") == "blocked":
            st.config_blockers += [r for r in cap.get("reasons", []) if not r.startswith("no live probe")]
        elif not cap:
            st.config_blockers.append("no capability report (run `agenthorizon judges doctor`)")
    elif e.kind in ("development", "ablation", "trials"):
        st.config_blockers.append("judge configurations for this experiment are not stated in accessible sources")
    st.blockers = st.data_blockers + st.config_blockers + st.blockers
    if st.data_blockers or st.config_blockers:
        st.status = "blocked"
    return st


def run_configs(e: Experiment, dataset_version_id: str, available_manifests: set[str], *, operator: dict | None = None):
    """RunConfig per trial for a runnable experiment (full-release selection; reports score against sub-manifests)."""
    from agenthorizon.runs.plan import RunConfig

    if e.judge_config is None or e.selection != "full-release":
        raise ValueError(f"{e.experiment_id} has no executable selection")
    mid = manifest_id_for("full-release", dataset_version_id, available_manifests)
    if mid is None:
        raise ValueError(f"{dataset_version_id} has no full-release manifest")
    op = operator or {}
    return [RunConfig(dataset_version=dataset_version_id, judge_config=e.judge_config, manifest=mid, trial=t,
                      provider_model_id=op.get("provider_model_id"), route=op.get("route"), base_url=op.get("base_url"),
                      effort=op.get("effort"), instructions=op.get("instructions", "rubric-extension"),
                      label=f"{e.experiment_id} trial {t}" if e.trials > 1 else e.experiment_id)
            for t in range(1, e.trials + 1)]


def get(experiment_id: str) -> Experiment:
    for e in experiments():
        if e.experiment_id == experiment_id:
            return e
    raise KeyError(f"unknown experiment {experiment_id!r}")
