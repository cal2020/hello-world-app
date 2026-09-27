"""Trace-driven refinement with atomic acceptance (brief sections 9.3-9.5).

``propose_update`` never touches the registry: it returns an ``UpdateProposal``.
The parent package, the protected archive and the active pointer are unchanged
whatever happens. A candidate is built on a deep copy and must pass, in order:
static validation (production profile), replay of the new trace, replay of
*every* protected trace, the negative corpus (the candidate must not newly
represent a prohibited trace), and a policy-diff gate (no new tools or
capabilities, no removed approval requirement, ordering rule or evidence
requirement, no raised loop bound above the ceiling). At most two attempts; the
second alignment is restricted to states reachable through zero-width states.

``admit_update`` then admits the candidate and promotes it with a
compare-and-swap against the expected parent, publishing the new archive
manifest in the same transaction.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import canonical
from .machine import MachineFormatError
from .package import PackageError, build_package, load_package, LoadedPackage
from .traces import eligibility, normalize, structural_replay
from .validator import reachable, validate_package

MAX_ATTEMPTS = 2


class Aligner(Protocol):
    name: str

    def propose(self, pkg: LoadedPackage, trace: dict, divergence: dict, restrictive: bool) -> dict | None: ...


def _zero_width(pkg: LoadedPackage, sid: str) -> bool:
    a = pkg.machine.states[sid].action
    return a.kind == "judge" or (a.kind == "model" and not a.observable)


def _compatible(pkg: LoadedPackage, sid: str, ev: dict) -> bool:
    a = pkg.machine.states[sid].action
    if ev["kind"] == "end":
        return a.kind == "end" and a.terminal == ev["terminal"]
    if ev["kind"] == "tool":
        return a.kind == "tool" and a.name == ev["tool"] and a.phase == ev.get("phase", "")
    return a.kind == ev["kind"]


class DeterministicAligner:
    """Staged alignment (paper section 4 / brief 9.3) without a model.

    At a divergence in state S with next event e: (1) candidates are states
    compatible with e by kind, tool, phase and exact terminal; (2) prefer S
    itself or states reachable from S through zero-width states; (3) only in
    the non-restrictive attempt consider other compatible states. The new edge
    is guarded on S's enum-typed outputs as observed in the trace. A repeat of
    S becomes a bounded self-loop whose bound follows the paper's heuristic
    (ceil(1.5 x observed repeats)), clamped to the operator ceiling.
    """
    name = "deterministic-aligner/1"

    def propose(self, pkg, trace, divergence, restrictive):
        m = pkg.machine
        events, _ = normalize(trace)
        idx = divergence.get("event_index")
        src = divergence.get("previous_anchor")
        if idx is None or src is None or idx >= len(events):
            return None
        ev = events[idx]
        near = {src} | {t.to for t in m.states[src].transitions if t.to in m.states and _zero_width(pkg, t.to)}
        cands = [s for s in sorted(near) if _compatible(pkg, s, ev)]
        if not cands and not restrictive:
            cands = [s for s in m.states if _compatible(pkg, s, ev)]
        if not cands:
            return None
        target = cands[0]
        prev_ev = events[idx - 1]
        src_state = m.states[src]
        enums = pkg.enums()
        conds = []
        values = {}
        if prev_ev["kind"] == "tool" and prev_ev["output"]:
            for key, var in src_state.action.binds.items():
                if var in enums and key in prev_ev["output"]:
                    values[var] = prev_ev["output"][key]
        elif prev_ev["kind"] in ("user", "model") and prev_ev["output"]:
            values = {k: v for k, v in prev_ev["output"].items() if k in enums}
        for var, val in sorted(values.items()):
            conds.append(f'{var} == "{val}"')
        if not conds:
            return None  # no deterministic variable separates the continuation
        ops: dict[str, Any] = {"add_edges": [], "add_variables": [], "loop_bounds": {}, "rationale": ""}
        edge = {"if": " and ".join(conds), "to": target, "origin": "trace"}
        observed = edge["if"]
        if target == src:
            repeats, j = 1, idx
            while j + 1 < len(events) and _compatible(pkg, src, events[j + 1]):
                repeats, j = repeats + 1, j + 1
            counter = f"{src.lower()}_retries"
            bound = math.ceil(1.5 * repeats)
            ceiling = pkg.policy.get("max_loop_bound")
            if ceiling is not None:
                bound = min(bound, ceiling)
            edge["if"] += f" and {counter} < {bound}"
            edge["inc"] = counter
            ops["add_variables"].append({"name": counter, "type": "integer", "init": 0,
                                         "contract": {"owner": "engine", "schema": {"type": "integer", "minimum": 0}}})
            ops["loop_bounds"][counter] = bound
            ops["rationale"] = (f"trace repeats {src} {repeats} time(s) after {observed}; bounded retry "
                                f"(bound {bound} = ceil(1.5 x {repeats}) clamped to ceiling {ceiling})")
        else:
            ops["rationale"] = f"trace continues from {src} to {target} when {edge['if']}"
        ops["add_edges"].append({"state": src, "edge": edge, "position": "before_default"})
        ops["clause"] = src_state.clause
        return ops


@dataclass
class FixtureAligner:
    """Stand-in for an alignment *model*: returns recorded proposals. Used to show that a
    plausible-looking but unsafe proposal is rejected by the independent gates."""
    proposals: list[dict]
    name: str = "fixture-aligner"
    calls: int = 0

    def propose(self, pkg, trace, divergence, restrictive):
        self.calls += 1
        if self.calls > len(self.proposals):
            return None
        return copy.deepcopy(self.proposals[self.calls - 1])


def apply_ops(parent: dict, ops: dict, trace_id: str) -> dict:
    machine = copy.deepcopy(parent["machine"])
    contracts = copy.deepcopy(parent["contracts"])
    for v in ops.get("add_variables", []):
        machine["variables"].append({k: v[k] for k in ("name", "type", "init") if k in v})
        contracts["variables"][v["name"]] = v["contract"]
    contracts.setdefault("loop_bounds", {}).update(ops.get("loop_bounds", {}))
    for e in ops.get("add_edges", []):
        edges = machine["states"][e["state"]]["transitions"]
        pos = len([x for x in edges if x.get("if")]) if e.get("position") == "before_default" else e.get("index", 0)
        edges.insert(pos, e["edge"])
    for r in ops.get("retarget_default", []):
        for x in machine["states"][r["state"]]["transitions"]:
            if not x.get("if"):
                x["to"] = r["to"]
    lineage = {"parent_hash": parent["artifact_hash"], "changes": [ops], "trace_ids": [trace_id]}
    return build_package(machine, parent["source_manifest"], parent["compiler_manifest"], parent["tool_catalog"],
                         contracts, parent["execution_policy"], lineage=lineage)


def reachable_tools(pkg: LoadedPackage) -> set[str]:
    m = pkg.machine
    return {m.states[s].action.name for s in reachable(m, m.initial) if m.states[s].action.kind == "tool"}


def policy_diff(parent: LoadedPackage, cand: LoadedPackage) -> list[str]:
    problems = []
    new_tools = reachable_tools(cand) - reachable_tools(parent)
    if new_tools:
        problems.append(f"newly reachable tools {sorted(new_tools)} require a policy-change review")
    pc, cc = parent.contracts, cand.contracts
    if set(pc.get("approval_required_tools", [])) - set(cc.get("approval_required_tools", [])):
        problems.append("approval requirement removed")
    if {r["id"] for r in pc.get("ordering", [])} - {r["id"] for r in cc.get("ordering", [])}:
        problems.append("ordering rule removed")
    for tid, t in pc.get("terminals", {}).items():
        if set(t.get("required_evidence", [])) - set(cc.get("terminals", {}).get(tid, {}).get("required_evidence", [])):
            problems.append(f"evidence requirement removed from {tid}")
    for k, b in pc.get("loop_bounds", {}).items():
        if cc.get("loop_bounds", {}).get(k, b) > b:
            problems.append(f"loop bound {k} raised")
    if parent.policy != cand.policy or parent.raw["tool_catalog"] != cand.raw["tool_catalog"]:
        problems.append("execution policy or tool catalog changed")
    return problems


def diff_packages(parent: LoadedPackage, cand: LoadedPackage) -> dict:
    pm, cm = parent.raw["machine"], cand.raw["machine"]
    added_states = sorted(set(cm["states"]) - set(pm["states"]))
    removed_states = sorted(set(pm["states"]) - set(cm["states"]))
    changed_edges = {}
    for sid in set(pm["states"]) & set(cm["states"]):
        if pm["states"][sid]["transitions"] != cm["states"][sid]["transitions"]:
            changed_edges[sid] = {"before": pm["states"][sid]["transitions"], "after": cm["states"][sid]["transitions"]}
    return {"added_states": added_states, "removed_states": removed_states, "changed_edges": changed_edges,
            "added_variables": sorted({v["name"] for v in cm["variables"]} - {v["name"] for v in pm["variables"]}),
            "loop_bounds": {"before": parent.contracts.get("loop_bounds"), "after": cand.contracts.get("loop_bounds")},
            "newly_reachable_tools": sorted(reachable_tools(cand) - reachable_tools(parent))}


@dataclass
class UpdateProposal:
    status: str                       # no_change | candidate_ready | rejected | excluded
    parent_hash: str
    candidate: dict | None = None
    attempts: list[dict] = field(default_factory=list)
    diff: dict | None = None
    eligibility: dict | None = None
    archive_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"status": self.status, "parent_hash": self.parent_hash,
                "candidate_hash": self.candidate["artifact_hash"] if self.candidate else None,
                "attempts": self.attempts, "diff": self.diff, "eligibility": self.eligibility,
                "archive_ids": self.archive_ids}


def propose_update(parent_raw: dict, trace: dict, protected: list[dict], negative: list[dict],
                   aligners: list[Aligner]) -> UpdateProposal:
    parent = load_package(parent_raw)
    tid = trace["header"]["trace_id"]
    el = eligibility(trace, parent)
    prop = UpdateProposal("rejected", parent.artifact_hash, eligibility={"verdict": el.verdict, "reasons": el.reasons})
    if el.verdict != "protected":
        prop.status = "excluded"
        return prop
    base = structural_replay(parent, trace)
    if base.ok:
        prop.status = "no_change"
        prop.archive_ids = sorted({t["header"]["trace_id"] for t in protected} | {tid})
        prop.attempts.append({"attempt": 0, "result": "parent already represents the trace",
                              "replay": base.to_dict()})
        return prop
    divergence = base.detail
    for attempt in range(MAX_ATTEMPTS):
        aligner = aligners[min(attempt, len(aligners) - 1)]
        rec: dict = {"attempt": attempt, "aligner": aligner.name, "restrictive": attempt > 0,
                     "divergence": divergence}
        ops = aligner.propose(parent, trace, divergence, restrictive=attempt > 0)
        if ops is None:
            rec["result"] = "no safe proposal"
            prop.attempts.append(rec)
            continue
        rec["proposal"] = ops
        cand_raw = gate_candidate(parent_raw, parent, ops, trace, protected, negative, rec)
        prop.attempts.append(rec)
        if cand_raw is None:
            continue
        cand = load_package(cand_raw)
        prop.status = "candidate_ready"
        prop.candidate = cand_raw
        prop.diff = diff_packages(parent, cand)
        prop.archive_ids = sorted({t["header"]["trace_id"] for t in protected} | {tid})
        return prop
    return prop


def gate_candidate(parent_raw: dict, parent: LoadedPackage, ops: dict, trace: dict, protected: list[dict],
                   negative: list[dict], rec: dict) -> dict | None:
    """Run every acceptance gate for one proposal. Fills ``rec`` and returns the candidate or None."""
    tid = trace["header"]["trace_id"]
    try:
        cand_raw = apply_ops(parent_raw, ops, tid)
        cand = load_package(cand_raw)
    except (PackageError, MachineFormatError, KeyError) as exc:
        rec["result"] = f"candidate could not be built: {exc}"
        return None
    vr = validate_package(cand, "production")
    if not vr.ok:
        rec["result"] = "static validation rejected the candidate"
        rec["findings"] = [{"code": f.code, "location": f.location, "message": f.message} for f in vr.errors()]
        return None
    new_r = structural_replay(cand, trace)
    if not new_r.ok:
        rec["result"] = "candidate does not replay the new trace"
        rec["replay"] = new_r.to_dict()
        return None
    broken = [r.to_dict() for r in (structural_replay(cand, t) for t in protected) if not r.ok]
    if broken:
        rec["result"] = f"candidate breaks {len(broken)} protected trace(s)"
        rec["broken"] = broken
        return None
    newly_negative = [t["header"]["trace_id"] for t in negative
                      if structural_replay(cand, t).ok and not structural_replay(parent, t).ok]
    if newly_negative:
        rec["result"] = f"candidate newly represents prohibited traces {newly_negative}"
        return None
    problems = policy_diff(parent, cand)
    if problems:
        rec["result"] = "policy-diff gate rejected the candidate"
        rec["problems"] = problems
        return None
    rec["result"] = "candidate passed all gates"
    rec["protected_replayed"] = len(protected)
    return cand_raw


def archive_manifest(skill_id: str, traces: list[dict], artifact_hash: str) -> dict:
    return {"skill_id": skill_id, "artifact_hash": artifact_hash,
            "traces": sorted(({"trace_id": t["header"]["trace_id"], "records_sha256": t["header"]["records_sha256"]}
                              for t in traces), key=lambda x: x["trace_id"])}


def admit_update(registry, tenant: str, proposal: UpdateProposal, expected_parent_hash: str, archive: list[dict],
                 approver: str) -> dict:
    """Admit and promote atomically (CAS on the active pointer). Raises ConflictError if the
    parent moved, in which case the proposal must be rebased and every gate rerun."""
    from .registry import AdmissionRejected
    if proposal.status != "candidate_ready":
        raise ValueError(f"proposal status is {proposal.status}")
    if proposal.parent_hash != expected_parent_hash:
        raise AdmissionRejected(f"proposal was built on {proposal.parent_hash}, not the expected parent "
                                f"{expected_parent_hash}; rebase and rerun every gate")
    cand = proposal.candidate
    loaded_cand = load_package(cand)
    reports = [structural_replay(loaded_cand, t).to_dict() for t in archive]
    replay = {"ok": all(r["result"] == "PASS" for r in reports), "mode": "structural",
              "protected": [t["header"]["trace_id"] for t in archive],
              "failures": [r for r in reports if r["result"] != "PASS"]}
    if not replay["ok"]:
        raise AdmissionRejected("candidate does not replay the archive being published", replay)
    registry.register_draft(cand)
    record = registry.admit(cand, approver=approver, environment="local-offline", replay_report=replay)
    manifest = archive_manifest(cand["machine"]["skill_id"], archive, cand["artifact_hash"])
    gen = registry.promote(tenant, cand["artifact_hash"], expected_parent_hash, manifest)
    return {"admission": record, "generation": gen, "archive_manifest_digest": canonical.digest(manifest)}
