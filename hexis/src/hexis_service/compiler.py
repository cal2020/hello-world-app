"""Initial compilation pipeline (brief section 8).

1. snapshot and hash inputs (skill bytes, tool catalog, contracts, policy);
   scripts referenced by the skill are never executed;
2. index source clauses with stable IDs and exact byte spans;
3. obtain a coverage classification for every clause;
4. build the compiler context (tool interfaces, guard grammar, action kinds,
   terminal vocabulary, numbered clauses) - nothing else;
5. draft a machine through a compiler-model adapter;
6. validate; 7. repair within a bounded budget, refusing any repair that drops
   coverage of a protected clause; 8. normalize deterministically and
   revalidate; 9. emit an *unadmitted* package with rejected drafts kept.

Two compiler-model adapters exist: ``FixtureCompilerModel`` (deterministic,
reads recorded responses; used by the demo and tests) and the live provider
adapter in ``models.py``. Fixture output validates the software path; it
says nothing about how well a live model compiles skills.
"""
from __future__ import annotations

import copy
import os
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import canonical
from . import guards as G
from .machine import MachineFormatError, parse_machine
from .package import build_package, load_package, PackageError
from .validator import validate_package

COMPILER_VERSION = "hexis_service.compiler/1"
NORMALIZER_VERSION = "hexis_service.normalizer/1"
CLASSIFICATIONS = {"executable_control", "state_local_knowledge", "external_precondition", "unsupported"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def index_clauses(skill: bytes) -> list[dict]:
    """Every heading-scoped sentence line or list item becomes a clause ``<section-slug>.<n>``
    with its exact UTF-8 byte span. Headings themselves are not clauses."""
    clauses: list[dict] = []
    section, counter, offset = "preamble", 0, 0
    for raw_line in skill.split(b"\n"):
        line = raw_line.decode("utf-8")
        start = offset
        offset += len(raw_line) + 1
        stripped = line.strip()
        if not stripped:
            continue
        m = re.match(r"^(#+)\s+(.*)$", stripped)
        if m:
            section, counter = slug(m.group(2)), 0
            continue
        body = re.sub(r"^(?:[-*]|\d+\.)\s+", "", stripped)
        lead = len(line) - len(line.lstrip()) + (len(stripped) - len(body))
        b_start = start + len(line[:lead].encode("utf-8"))
        b_end = b_start + len(body.encode("utf-8"))
        counter += 1
        clauses.append({"id": f"{section}.{counter}", "heading": section, "text": body,
                        "span": [b_start, b_end]})
    for c in clauses:
        assert skill[c["span"][0]:c["span"][1]].decode("utf-8") == c["text"]
    return clauses


def verify_quotes(skill: bytes, clauses: list[dict]) -> list[str]:
    bad = []
    for c in clauses:
        s, e = c["span"]
        if skill[s:e].decode("utf-8", errors="replace") != c["text"]:
            bad.append(c["id"])
    return bad


class CompilerModel(Protocol):
    model_id: str

    def classify(self, context: dict) -> dict: ...

    def draft(self, context: dict, attempt: int, diagnostics: list[dict]) -> dict: ...


def apply_patch(doc: Any, ops: list[dict]) -> Any:
    """Minimal RFC 6902 subset (add/replace/remove) used by fixture responses."""
    doc = copy.deepcopy(doc)
    for op in ops:
        parts = [p.replace("~1", "/").replace("~0", "~") for p in op["path"].lstrip("/").split("/")]
        parent = doc
        for p in parts[:-1]:
            parent = parent[int(p)] if isinstance(parent, list) else parent[p]
        last = parts[-1]
        if isinstance(parent, list):
            idx = len(parent) if last == "-" else int(last)
            if op["op"] == "add":
                parent.insert(idx, op["value"])
            elif op["op"] == "replace":
                parent[idx] = op["value"]
            elif op["op"] == "remove":
                del parent[idx]
        else:
            if op["op"] in ("add", "replace"):
                parent[last] = op["value"]
            elif op["op"] == "remove":
                del parent[last]
    return doc


@dataclass
class FixtureCompilerModel:
    """Deterministic compiler model backed by a recorded-response fixture file."""
    fixture_path: str
    model_id: str = "fixture:compiler"
    calls: list[dict] = field(default_factory=list)

    def _fixture(self) -> dict:
        return canonical.load_file(self.fixture_path)

    def classify(self, context: dict) -> dict:
        self.calls.append({"op": "classify"})
        return self._fixture()["coverage"]

    def draft(self, context: dict, attempt: int, diagnostics: list[dict]) -> dict:
        self.calls.append({"op": "draft", "attempt": attempt, "diagnostics": len(diagnostics)})
        fx = self._fixture()
        responses = fx["responses"]
        resp = responses[min(attempt, len(responses) - 1)]
        base = canonical.load_file(os.path.join(os.path.dirname(self.fixture_path), resp["base"]))
        machine = apply_patch(base, resp.get("patch", []))
        return {"machine": machine, "clause_map": resp.get("clause_map")}


@dataclass
class CompileResult:
    ok: bool
    package: dict | None
    report: dict
    rejected_drafts: list[dict]


def normalize(machine: dict) -> dict:
    """Deterministic canonical transformations. Only moves the default edge last
    (semantics-preserving: runtime already evaluates it last) and strips
    surrounding whitespace in guards; revalidated afterwards."""
    m = copy.deepcopy(machine)
    for s in m.get("states", {}).values():
        edges = s.get("transitions", [])
        for e in edges:
            if "if" in e:
                e["if"] = e["if"].strip()
        s["transitions"] = [e for e in edges if e.get("if")] + [e for e in edges if not e.get("if")]
    return m


def compile_skill(skill_path: str, tool_catalog: dict, contracts: dict, execution_policy: dict,
                  compiler_model: CompilerModel, max_attempts: int = 3, profile: str = "production") -> CompileResult:
    with open(skill_path, "rb") as fh:
        skill = fh.read()
    clauses = index_clauses(skill)
    context = {
        "clauses": [{"id": c["id"], "text": c["text"]} for c in clauses],
        "tools": {n: {k: t[k] for k in ("version", "effect", "input_schema", "output_schema")}
                  for n, t in tool_catalog["tools"].items()},
        "guard_grammar": G.__doc__,
        "action_kinds": ["tool", "model", "judge", "user", "end"],
        "terminal_kinds": ["verified", "unverified", "fallback"],
    }
    coverage = compiler_model.classify(context)
    diagnostics_log: list[dict] = []
    coverage_findings = []
    for c in clauses:
        cov = coverage.get(c["id"])
        if cov is None or cov.get("classification") not in CLASSIFICATIONS:
            coverage_findings.append({"clause": c["id"], "problem": "clause not classified"})
            cov = {"classification": "unsupported", "justification": "not classified by compiler", "critical": True}
        c["coverage"] = {"classification": cov["classification"], "justification": cov.get("justification", "")}
        c["critical"] = bool(cov.get("critical", False))
    for extra in set(coverage) - {c["id"] for c in clauses}:
        coverage_findings.append({"clause": extra, "problem": "classification refers to unknown clause"})
    source_manifest = {
        "skill_path": os.path.basename(skill_path), "skill_sha256": canonical.sha256_hex(skill),
        "tool_catalog_hash": canonical.digest(tool_catalog), "clauses": clauses,
    }
    compiler_manifest = {
        "compiler": COMPILER_VERSION, "normalizer": NORMALIZER_VERSION, "model_id": compiler_model.model_id,
        "context_hash": canonical.digest(context), "max_attempts": max_attempts,
        "mode": "fixture" if compiler_model.model_id.startswith("fixture:") else "live",
    }
    protected = {c["id"] for c in clauses if c["critical"] and c["coverage"]["classification"] == "executable_control"}
    rejected: list[dict] = []
    diagnostics: list[dict] = []
    package = None
    report = None
    previously_covered: set[str] | None = None
    for attempt in range(max_attempts):
        proposal = compiler_model.draft(context, attempt, diagnostics)
        machine_raw = normalize(proposal["machine"])
        try:
            parse_machine(machine_raw)
        except MachineFormatError as exc:
            diagnostics = [{"code": "FORMAT", "location": exc.location, "message": exc.message}]
            rejected.append({"attempt": attempt, "findings": diagnostics, "machine": machine_raw})
            continue
        covered = {s.get("clause") for s in machine_raw["states"].values()} | {
            r.get("clause") for r in contracts.get("ordering", [])}
        if previously_covered is not None and (previously_covered & protected) - covered:
            lost = sorted((previously_covered & protected) - covered)
            diagnostics = [{"code": "REPAIR_DROPPED_REQUIREMENT", "location": "clauses",
                            "message": f"repair removed protected clause coverage {lost}"}]
            rejected.append({"attempt": attempt, "findings": diagnostics, "machine": machine_raw})
            continue
        previously_covered = covered
        pkg = build_package(machine_raw, source_manifest, compiler_manifest, tool_catalog, contracts, execution_policy)
        try:
            loaded = load_package(pkg)
        except (PackageError, MachineFormatError) as exc:
            diagnostics = [{"code": "PACKAGE", "location": "package", "message": str(exc)}]
            rejected.append({"attempt": attempt, "findings": diagnostics, "machine": machine_raw})
            continue
        vr = validate_package(loaded, profile)
        diagnostics = [{"code": f.code, "location": f.location, "message": f.message} for f in vr.errors()]
        diagnostics_log.append({"attempt": attempt, "ok": vr.ok, "findings": diagnostics})
        if vr.ok and not coverage_findings:
            pkg["validation_manifest"] = {"static": vr.to_dict(), "replay": None, "limitations": [
                "Structural validity does not establish business correctness or extraction accuracy."]}
            package, report = pkg, vr.to_dict()
            break
        rejected.append({"attempt": attempt, "findings": diagnostics, "machine": machine_raw})
    quote_errors = verify_quotes(skill, clauses)
    result_report = {
        "attempts": len(rejected) + (1 if package else 0), "max_attempts": max_attempts,
        "coverage_findings": coverage_findings, "quote_mismatches": quote_errors,
        "coverage": [{"clause": c["id"], "classification": c["coverage"]["classification"], "critical": c["critical"],
                      "states": sorted(sid for sid, s in (package or {"machine": {"states": {}}})["machine"]["states"].items()
                                       if s.get("clause") == c["id"])} for c in clauses],
        "validation": report, "attempt_log": diagnostics_log, "model_calls": len(getattr(compiler_model, "calls", [])),
        "status": "unadmitted" if package else "failed",
    }
    return CompileResult(ok=package is not None and not quote_errors, package=package, report=result_report,
                         rejected_drafts=rejected)
