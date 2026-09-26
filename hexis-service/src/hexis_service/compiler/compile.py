"""Initial compilation pipeline (brief §8): snapshot → clause index → context → draft → validate →
bounded repair → deterministic normalization → unadmitted package.

The compiler model is an injected adapter. It proposes; it never admits. Every draft, its findings
and its diff to the previous draft are kept in the result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field

from ..artifacts.diff import package_diff
from ..artifacts.efsm import Machine, load_machine
from ..artifacts.package import (CompilerManifest, Contracts, ExecutionPolicy, Lineage, MachinePackage,
                                 SourceManifest, ValidationManifest)
from ..artifacts.validate import VALIDATOR_VERSION, Finding, ValidationReport, reachable, validate_package
from ..canonical import digest, sha256_hex
from ..tools.catalog import ToolCatalog
from .clauses import index_clauses, is_critical

COMPILER_VERSION = "hexis-service-compiler/1"
NORMALIZER_VERSION = "hexis-service-normalizer/1"
GUARD_GRAMMAR = ("Guards: boolean and/or/not over typed comparisons (==, !=, <, <=, >, >=), membership in literal "
                 "lists (x in ['a','b']), and empty(x)/nonempty(x). No calls, attributes, imports or null literals. "
                 "Guarded edges must be pairwise exclusive; exactly one default edge (empty 'if'), placed last.")
ACTION_KINDS = ("tool", "model", "judge", "user", "end")
TERMINAL_CATEGORIES = ("verified", "unverified", "fallback")


class SkillSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = ""
    text: str
    resources: dict[str, str] = Field(default_factory=dict)  # name -> content (never executed)


class DeploymentPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    environment: str = "sandbox"
    execution_policy: ExecutionPolicy
    task_input_schema: dict
    profile: str = "production"


class CompilerModel(Protocol):
    model_id: str
    settings: dict

    def draft(self, context: dict, diagnostics: list[dict], attempt: int) -> dict:
        """Return ``{"machine": <efsm-v1 dict>, "contracts": <Contracts dict>}``."""


@dataclass
class CompileResult:
    status: str  # "validated" | "rejected"
    package: Optional[MachinePackage]
    report: Optional[ValidationReport]
    attempts: list[dict] = field(default_factory=list)
    coverage: list[dict] = field(default_factory=list)
    review_required: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"status": self.status, "artifact_hash": self.package.artifact_hash if self.package else None,
                "attempts": self.attempts, "coverage": self.coverage, "review_required": self.review_required,
                "report": self.report.to_json() if self.report else None}


def build_context(source: SkillSource, clauses: list, catalog: ToolCatalog, policy: DeploymentPolicy) -> dict:
    """Only approved interfaces, grammar, action schema, terminal vocabulary and numbered source content."""
    return {
        "clauses": [{"id": c.id, "heading": c.heading, "text": c.text, "critical": is_critical(c)} for c in clauses],
        "tools": {n: {"version": t.version, "input_schema": t.input_schema, "output_schema": t.output_schema,
                      "effect": t.effect, "verifier_claims": t.verifier_claims} for n, t in catalog.tools.items()},
        "guard_grammar": GUARD_GRAMMAR,
        "action_kinds": ACTION_KINDS,
        "terminal_categories": TERMINAL_CATEGORIES,
        "task_input_schema": policy.task_input_schema,
        "capability_ceiling": policy.execution_policy.capability_ceiling,
        "max_loop_bound": policy.execution_policy.max_loop_bound,
    }


def normalize_machine(m: Machine) -> Machine:
    """Documented canonical transformations; none changes behavior:
    1. default edges move after guarded edges (the runtime already evaluates them last);
    2. variables are sorted by name;
    3. states are ordered initial-first, then breadth-first, then the rest by id."""
    data = m.to_json()
    for st in data["states"].values():
        trans = st.get("transitions", [])
        st["transitions"] = [t for t in trans if t.get("if")] + [t for t in trans if not t.get("if")]
    data["variables"] = sorted(data["variables"], key=lambda v: v["name"])
    order: list[str] = []
    seen: set[str] = set()
    queue = [m.initial]
    while queue:
        s = queue.pop(0)
        if s in seen or s not in data["states"]:
            continue
        seen.add(s)
        order.append(s)
        queue.extend(t["to"] for t in data["states"][s]["transitions"])
    order += sorted(set(data["states"]) - seen)
    data["states"] = {s: data["states"][s] for s in order}
    return load_machine(data)


def _coverage_regressions(prev: dict, cur: dict, critical_ids: set[str]) -> list[Finding]:
    out = []
    for cid in sorted(critical_ids):
        p, c = prev.get(cid), cur.get(cid)
        if p and p.get("classification") == "executable_control" and (
                not c or c.get("classification") != "executable_control" or not c.get("states")):
            out.append(Finding("REQUIREMENT_DROPPED", f"repair removed executable coverage of critical clause {cid}",
                               clause=cid))
    return out


def compile_skill(source: SkillSource, tool_catalog: ToolCatalog, deployment_policy: DeploymentPolicy,
                  model: CompilerModel, max_attempts: int = 3) -> CompileResult:
    clauses = index_clauses(source.text)
    critical_ids = {c.id for c in clauses if is_critical(c)}
    context = build_context(source, clauses, tool_catalog, deployment_policy)
    manifest = SourceManifest(
        skill_path=source.path, skill_sha256=sha256_hex(source.text),
        resources={k: sha256_hex(v) for k, v in sorted(source.resources.items())}, clauses=clauses,
        tool_catalog_sha256=tool_catalog.digest(), input_contract_sha256=digest(deployment_policy.task_input_schema),
        deployment_policy_sha256=digest(deployment_policy.model_dump(mode="json")))
    cmanifest = CompilerManifest(compiler=COMPILER_VERSION, prompts_sha256=digest(context), model_id=model.model_id,
                                 model_settings=model.settings, validator_version=VALIDATOR_VERSION,
                                 normalizer_version=NORMALIZER_VERSION)
    attempts: list[dict] = []
    diagnostics: list[dict] = []
    prev_pkg: Optional[MachinePackage] = None
    prev_cov: dict = {}
    report: Optional[ValidationReport] = None
    for attempt in range(1, max_attempts + 1):
        raw = model.draft(context, diagnostics, attempt)
        try:
            machine = load_machine(raw["machine"])
            contracts = Contracts.model_validate(raw["contracts"])
        except Exception as exc:  # noqa: BLE001 - malformed proposals are findings, not crashes
            diagnostics = [{"code": "DRAFT_SCHEMA", "message": str(exc)[:2000]}]
            attempts.append({"attempt": attempt, "status": "malformed", "findings": diagnostics})
            continue
        contracts = contracts.model_copy(update={"task_input_schema": deployment_policy.task_input_schema})
        pkg = MachinePackage(machine=machine, source_manifest=manifest, compiler_manifest=cmanifest,
                             contracts=contracts, execution_policy=deployment_policy.execution_policy,
                             lineage=Lineage()).sealed()
        report = validate_package(pkg, tool_catalog, deployment_policy.profile, skill_text=source.text)
        cov = {k: v.model_dump() for k, v in contracts.clause_coverage.items()}
        regress = _coverage_regressions(prev_cov, cov, critical_ids)
        report.findings.extend(regress)
        entry = {"attempt": attempt, "draft_hash": pkg.artifact_hash, "status": "valid" if report.passed else "invalid",
                 "findings": [f.to_json() for f in report.findings if f.severity == "error"]}
        if prev_pkg is not None:
            entry["diff_from_previous"] = package_diff(prev_pkg, pkg, tool_catalog)
        attempts.append(entry)
        prev_pkg, prev_cov = pkg, (cov if not prev_cov else {**prev_cov, **cov})
        if report.passed:
            normalized = MachinePackage(machine=normalize_machine(machine), source_manifest=manifest,
                                        compiler_manifest=cmanifest, contracts=contracts,
                                        execution_policy=deployment_policy.execution_policy).sealed()
            nreport = validate_package(normalized, tool_catalog, deployment_policy.profile, skill_text=source.text)
            if not nreport.passed:
                attempts.append({"attempt": attempt, "status": "normalization_broke_validity",
                                 "findings": [f.to_json() for f in nreport.errors]})
                return CompileResult("rejected", None, nreport, attempts)
            rj = nreport.to_json()
            final = normalized.model_copy(update={"validation_manifest": ValidationManifest(
                profile=deployment_policy.profile, report_digest=rj["report_digest"], passed=True,
                findings=rj["findings"],
                unresolved_limitations=[f"clause {k}: {v.classification} - {v.justification}"
                                        for k, v in contracts.clause_coverage.items()
                                        if v.classification == "unsupported"])})
            coverage = _coverage_table(final)
            review = [f"{r['clause']} ({r['classification']}): {r['justification']}" for r in coverage
                      if r["classification"] == "unsupported"]
            return CompileResult("validated", final, nreport, attempts, coverage, review)
        diagnostics = [f.to_json() for f in report.errors]
    return CompileResult("rejected", prev_pkg, report, attempts)


def _coverage_table(pkg: MachinePackage) -> list[dict]:
    reach = reachable(pkg.machine, pkg.machine.initial)
    rows = []
    for c in pkg.source_manifest.clauses:
        cov = pkg.contracts.clause_coverage.get(c.id)
        rows.append({"clause": c.id, "critical": is_critical(c), "text": c.text,
                     "classification": cov.classification if cov else "UNCLASSIFIED",
                     "states": [s for s in (cov.states if cov else []) if s in reach],
                     "justification": cov.justification if cov else ""})
    return rows


def coverage_markdown(rows: list[dict]) -> str:
    lines = ["| Clause | Critical | Classification | States | Text |", "|---|---|---|---|---|"]
    for r in rows:
        text = r["text"].replace("|", "\\|")
        lines.append(f"| {r['clause']} | {'yes' if r['critical'] else ''} | {r['classification']} | "
                     f"{', '.join(r['states'])} | {text[:90]}{'…' if len(text) > 90 else ''} |")
    return "\n".join(lines)


def load_json_file(path: str) -> Any:
    from ..canonical import strict_loads
    with open(path, "rb") as fh:
        return strict_loads(fh.read())
