"""Trace-driven refinement (brief §9.3-9.5).

``propose_update`` never mutates the parent. It (1) checks archive eligibility, (2) tries the parent
first, (3) asks an aligner for operations, validates each operation independently of the aligner's
rationale, (4) builds the candidate on a deep copy, and (5) runs every gate: policy non-widening,
static validation, replay of the new trace, replay of EVERY protected trace, and the negative
corpus. At most two candidate attempts; the second is marked restrictive. Deployment is a separate
admission step (:func:`hexis_service.artifacts.registry.admit`) with a parent compare-and-swap.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Optional, Protocol

from ..artifacts.diff import package_diff
from ..artifacts.efsm import load_machine
from ..artifacts.package import Contracts, Lineage, MachinePackage
from ..artifacts.validate import validate_package
from ..canonical import digest
from ..replay.replay import replay_structural
from ..tools.catalog import ToolCatalog
from .model import Trace
from .normalize import eligibility, normalize

MAX_ATTEMPTS = 2


class Aligner(Protocol):
    model_id: str

    def propose(self, context: dict) -> list[dict]:
        """Return operations: add_variable, add_state, add_edge, retarget_edge, set_coverage, match, ignore."""


@dataclass
class UpdateProposal:
    status: str  # NO_CHANGE | CANDIDATE | REJECTED | EXCLUDED
    parent_hash: str
    trace_id: str
    candidate: Optional[MachinePackage] = None
    diff: dict = field(default_factory=dict)
    gates: dict = field(default_factory=dict)
    attempts: list[dict] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)
    negative_additions: list[str] = field(default_factory=list)
    requires_review: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"status": self.status, "parent_hash": self.parent_hash, "trace_id": self.trace_id,
                "candidate_hash": self.candidate.artifact_hash if self.candidate else None, "diff": self.diff,
                "gates": self.gates, "attempts": self.attempts, "diagnostics": self.diagnostics,
                "negative_additions": self.negative_additions, "requires_review": self.requires_review}


# --------------------------------------------------------------------------- #
def _validate_ops(parent: MachinePackage, ops: list[dict], events: list, catalog: ToolCatalog) -> list[str]:
    errs = []
    m = parent.machine
    new_states = {o["state"]["id"]: o["state"] for o in ops if o.get("op") == "add_state"}
    all_states = set(m.states) | set(new_states)
    for o in ops:
        kind = o.get("op")
        if kind == "match":
            st = m.states.get(o.get("state")) or None
            sd = new_states.get(o.get("state"))
            action = st.action.model_dump() if st else (sd or {}).get("action")
            idx = o.get("event_index")
            if action is None or idx is None or idx >= len(events):
                errs.append(f"match references unknown state/event: {o}")
                continue
            ev = events[idx]
            ok = (ev.kind == "tool" and action.get("kind") == "tool" and action.get("name") == ev.tool
                  and (not action.get("phase") or not ev.phase or action.get("phase") == ev.phase)) or \
                 (ev.kind == "user" and action.get("kind") == "user") or \
                 (ev.kind == "terminal" and action.get("kind") == "end" and action.get("terminal") == ev.terminal)
            if not ok:
                errs.append(f"match of event {idx} ({ev.kind}:{ev.tool or ev.terminal}) to {o.get('state')} is "
                            f"incompatible regardless of rationale")
        elif kind == "ignore":
            if not o.get("reason"):
                errs.append(f"ignore of event {o.get('event_index')} has no reason")
        elif kind == "add_state":
            a = o["state"].get("action", {})
            if o["state"]["id"] in m.states:
                errs.append(f"add_state {o['state']['id']} already exists")
            if a.get("kind") == "tool" and catalog.get(a.get("name")) is None:
                errs.append(f"add_state uses unregistered tool {a.get('name')}")
        elif kind in ("add_edge", "retarget_edge"):
            if o.get("from") not in all_states or o.get("edge", {}).get("to", o.get("to")) not in all_states:
                errs.append(f"{kind} references unknown state: {o}")
        elif kind not in ("add_variable", "set_coverage"):
            errs.append(f"unknown operation {kind!r}")
        if kind in ("add_state", "add_edge", "retarget_edge", "add_variable") and not o.get("rationale"):
            errs.append(f"{kind} needs a rationale")
    return errs


def apply_ops(parent: MachinePackage, ops: list[dict]) -> MachinePackage:
    md = copy.deepcopy(parent.machine.to_json())
    cd = copy.deepcopy(parent.contracts.model_dump(mode="json", by_alias=True))
    for o in ops:
        k = o["op"]
        if k == "add_variable":
            md["variables"].append(o["variable"])
            cd["variables"][o["variable"]["name"]] = o["contract"]
        elif k == "add_state":
            st = {"transitions": [], "origin": "trace", **o["state"]}
            md["states"][st["id"]] = st
            if o.get("interaction"):
                cd["interactions"][st["id"]] = o["interaction"]
        elif k == "add_edge":
            trans = md["states"][o["from"]]["transitions"]
            edge = {"if": "", "to": "", "inc": None, "support": 1, "origin": "trace", **o["edge"]}
            pos = o.get("position", len([t for t in trans if t.get("if")]))
            trans.insert(pos, edge)
        elif k == "retarget_edge":
            md["states"][o["from"]]["transitions"][o["index"]]["to"] = o["to"]
        elif k == "set_coverage":
            cd["clause_coverage"][o["clause"]] = o["coverage"]
    lineage = Lineage(parent_hash=parent.artifact_hash,
                      changes=[{kk: vv for kk, vv in op.items() if kk in ("op", "rationale", "clause", "from", "to",
                                                                          "event_index")} for op in ops])
    return MachinePackage(machine=load_machine(md), source_manifest=parent.source_manifest,
                          compiler_manifest=parent.compiler_manifest, contracts=Contracts.model_validate(cd),
                          execution_policy=parent.execution_policy, lineage=lineage).sealed()


def policy_widening(parent: MachinePackage, cand: MachinePackage) -> list[str]:
    """Trace-driven updates may add states/variables/coverage; they may not weaken policy."""
    out = []
    if parent.execution_policy.model_dump() != cand.execution_policy.model_dump():
        out.append("execution policy changed (capabilities/budgets/fallback) - requires separate policy review")
    pc, cc = parent.contracts, cand.contracts
    if [o.model_dump() for o in pc.ordering] != [o.model_dump() for o in cc.ordering]:
        out.append("ordering requirements changed")
    if {k: v.model_dump() for k, v in pc.terminals.items()} != {k: v.model_dump() for k, v in cc.terminals.items()}:
        out.append("terminal contracts / evidence requirements changed")
    for k, v in pc.interactions.items():
        if k not in cc.interactions or cc.interactions[k].model_dump() != v.model_dump():
            out.append(f"existing interaction {k} changed or removed (approval cannot be removed by an update)")
    for k, v in pc.variables.items():
        if k not in cc.variables or cc.variables[k].model_dump() != v.model_dump():
            out.append(f"variable contract {k} changed or removed")
    if {k: v.model_dump() for k, v in pc.field_scoped_writes.items()} != \
            {k: v.model_dump() for k, v in cc.field_scoped_writes.items()}:
        out.append("field-scoped write contracts changed")
    if pc.task_input_schema != cc.task_input_schema:
        out.append("task input contract changed")
    for cid, cov in pc.clause_coverage.items():
        new = cc.clause_coverage.get(cid)
        if cov.classification == "executable_control" and (new is None or new.classification != "executable_control"):
            out.append(f"coverage of clause {cid} downgraded")
    return out


def evaluate_candidate(parent: MachinePackage, cand: MachinePackage, trace: Trace, protected: list[Trace],
                       negative: list[Trace], catalog: ToolCatalog, skill_text: Optional[str] = None) -> dict:
    gates: dict = {}
    widen = policy_widening(parent, cand)
    gates["policy_non_widening"] = {"passed": not widen, "findings": widen}
    rep = validate_package(cand, catalog, "production", skill_text=skill_text)
    gates["static_validation"] = {"passed": rep.passed, "findings": [f.to_json() for f in rep.errors]}
    nr = replay_structural(cand, trace)
    gates["new_trace_replay"] = {"passed": nr.status == "PASS", "report": nr.to_json()}
    prot = [replay_structural(cand, t) for t in protected]
    gates["protected_replay"] = {"passed": all(r.status == "PASS" for r in prot), "count": len(prot),
                                 "failures": [r.to_json() for r in prot if r.status != "PASS"]}
    neg = [replay_structural(cand, t) for t in negative]
    gates["negative_corpus"] = {"passed": all(r.status != "PASS" for r in neg), "count": len(neg),
                                "now_representable": [r.trace_id for r in neg if r.status == "PASS"]}
    gates["passed"] = all(v["passed"] for v in gates.values() if isinstance(v, dict))
    return gates


def propose_update(parent: MachinePackage, trace: Trace, protected: list[Trace], negative: list[Trace],
                   catalog: ToolCatalog, aligner: Aligner, skill_text: Optional[str] = None) -> UpdateProposal:
    prop = UpdateProposal("REJECTED", parent.artifact_hash, trace.trace_id)
    integ = trace.integrity_errors()
    if integ:
        prop.status = "EXCLUDED"
        prop.diagnostics = ["trace integrity: " + e for e in integ]
        return prop
    viol = eligibility(trace, parent)
    if viol:
        prop.status = "EXCLUDED"
        prop.diagnostics = [f"{v['code']} at step {v.get('step')}: {v.get('requirement') or v.get('claim') or ''}"
                            for v in viol]
        prop.negative_additions = [trace.trace_id]
        return prop
    first = replay_structural(parent, trace)
    if first.status == "PASS":
        prop.status = "NO_CHANGE"
        prop.gates = {"new_trace_replay": {"passed": True, "report": first.to_json()}}
        return prop
    events, dropped = normalize(trace)
    diagnostics = [first.to_json()]
    for attempt in range(1, MAX_ATTEMPTS + 1):
        ctx = {"attempt": attempt, "restrictive": attempt > 1, "machine": parent.machine.to_json(),
               "events": [e.model_dump() for e in events], "dropped": dropped, "divergence": first.divergence,
               "diagnostics": diagnostics, "clauses": [c.model_dump() for c in parent.source_manifest.clauses]}
        ops = aligner.propose(ctx)
        op_errs = _validate_ops(parent, ops, events, catalog)
        entry: dict = {"attempt": attempt, "restrictive": attempt > 1, "operations": ops, "op_errors": op_errs}
        if op_errs:
            prop.attempts.append(entry)
            diagnostics = [{"op_errors": op_errs}]
            continue
        try:
            cand = apply_ops(parent, ops)
        except Exception as exc:  # noqa: BLE001
            entry["op_errors"] = [f"candidate construction failed: {exc}"]
            prop.attempts.append(entry)
            diagnostics = [{"op_errors": entry["op_errors"]}]
            continue
        gates = evaluate_candidate(parent, cand, trace, protected, negative, catalog, skill_text)
        entry["candidate_hash"] = cand.artifact_hash
        entry["gates"] = {k: v["passed"] for k, v in gates.items() if isinstance(v, dict)}
        prop.attempts.append(entry)
        if gates["passed"]:
            prop.status, prop.candidate, prop.gates = "CANDIDATE", cand, gates
            prop.diff = package_diff(parent, cand, catalog)
            if prop.diff["newly_reachable_effects"]:
                prop.requires_review.append("new consequential effects reachable: "
                                            + ", ".join(prop.diff["newly_reachable_effects"]))
            return prop
        prop.gates = gates
        diagnostics = [{k: v for k, v in gates.items() if isinstance(v, dict) and not v["passed"]}]
    prop.diagnostics = ["all candidate attempts failed; parent machine and archive unchanged"]
    return prop


def archive_manifest(protected: list[Trace], negative: list[Trace]) -> dict:
    return {"protected": [{"trace_id": t.trace_id, "records_digest": t.records_digest()} for t in protected],
            "negative": [{"trace_id": t.trace_id, "records_digest": t.records_digest()} for t in negative],
            "held_out": "never stored here; held-out tasks are not given to the compiler or aligner"}


def manifest_digest(protected: list[Trace], negative: list[Trace]) -> str:
    return digest(archive_manifest(protected, negative))
