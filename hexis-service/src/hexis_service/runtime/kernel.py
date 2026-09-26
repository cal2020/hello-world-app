"""Pure transition kernel (brief §7.1).

``advance`` performs no network access, model calls, database writes, randomness or clock reads.
Everything external arrives inside a recorded :class:`Observation`. Given the same checkpoint,
observation and package, it returns the same result (property-tested).
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .. import guards as G
from ..artifacts.package import MachinePackage
from ..canonical import digest
from ..tools.catalog import validate_against

Status = Literal["READY", "RUNNING", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL", "RECONCILING", "COMPLETED",
                 "FAILED", "CANCELLED"]
TERMINAL_STATUSES = ("COMPLETED", "FAILED", "CANCELLED")
_WHOLE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
_PART = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class KernelError(Exception):
    def __init__(self, code: str, message: str, detail: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.detail = code, message, detail or {}


class Budget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: int = 0
    tool_calls: int = 0
    model_calls: int = 0
    tokens: int = 0
    output_repairs: int = 0


class Assurance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entered_fallback: bool = False
    fallback_reason: str = ""
    missing_evidence: list[str] = Field(default_factory=list)
    policy_violations: list[str] = Field(default_factory=list)
    unresolved_effects: list[str] = Field(default_factory=list)
    verification_scope: str = ""
    diagnostics: list[dict] = Field(default_factory=list)


class RunCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_schema: Literal["hexis-checkpoint/1"] = "hexis-checkpoint/1"
    tenant_id: str
    run_id: str
    artifact_hash: str
    state_id: str
    revision: int = 0
    variables: dict[str, Any]
    budget: Budget = Field(default_factory=Budget)
    status: Status = "RUNNING"
    outcome: Optional[dict] = None
    assurance: Assurance = Field(default_factory=Assurance)
    evidence_refs: list[str] = Field(default_factory=list)

    def digest(self) -> str:
        return digest(self.model_dump(mode="json"))


class Observation(BaseModel):
    """A validated, recorded input to one state visit."""

    model_config = ConfigDict(extra="forbid")
    record_schema: Literal["hexis-observation/1"] = "hexis-observation/1"
    run_id: str
    state_id: str
    revision: int
    kind: Literal["tool", "model", "judge", "user", "end"]
    outputs: dict[str, Any] = Field(default_factory=dict)
    actor: str = ""
    receipt_ref: str = ""
    usage: dict[str, int] = Field(default_factory=dict)
    # Recorded host decisions (e.g. terminal admission, fallback routing). Never model-authored.
    engine: dict[str, Any] = Field(default_factory=dict)
    failure: str = ""

    def digest(self) -> str:
        return digest(self.model_dump(mode="json"))


@dataclass
class KernelResult:
    checkpoint: RunCheckpoint
    events: list[dict] = field(default_factory=list)
    delta: dict = field(default_factory=dict)
    edge: Optional[dict] = None


# --------------------------------------------------------------------------- #
# Task input, templates
# --------------------------------------------------------------------------- #
def resolve_path(task_input: dict, init_from: str) -> tuple[bool, Any]:
    """Resolve ``task.input.a.b`` (dot path) or ``/a/b`` (JSON-Pointer style) with full nesting."""
    if init_from.startswith("/"):
        parts = [p.replace("~1", "/").replace("~0", "~") for p in init_from[1:].split("/")]
    else:
        parts = init_from.split(".")
        if parts[:2] != ["task", "input"]:
            raise KernelError("BAD_INIT_FROM", f"unsupported init_from {init_from!r}")
        parts = parts[2:]
    cur: Any = task_input
    for p in parts:
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return False, None
    return True, cur


def initial_checkpoint(package: MachinePackage, tenant_id: str, run_id: str, task_input: dict) -> RunCheckpoint:
    errs = validate_against(package.contracts.task_input_schema or {"type": "object"}, task_input)
    if errs:
        raise KernelError("TASK_INPUT_INVALID", "; ".join(errs[:5]), {"errors": errs})
    vals: dict[str, Any] = {}
    for v in package.machine.variables:
        if v.init_from:
            found, val = resolve_path(task_input, v.init_from)
            if found:
                vals[v.name] = copy.deepcopy(val)
        elif v.init is not None:
            vals[v.name] = copy.deepcopy(v.init)
    return RunCheckpoint(tenant_id=tenant_id, run_id=run_id, artifact_hash=package.artifact_hash,
                         state_id=package.machine.initial, variables=vals)


def fill_template(obj: Any, values: dict) -> Any:
    """Strict binding: a missing variable is an explicit error, never None or ''."""
    if isinstance(obj, str):
        m = _WHOLE.match(obj)
        if m:
            if m.group(1) not in values:
                raise KernelError("MISSING_INPUT_BINDING", f"template variable {m.group(1)!r} is unset",
                                  {"variable": m.group(1)})
            return copy.deepcopy(values[m.group(1)])

        def sub(mm: re.Match) -> str:
            name = mm.group(1)
            if name not in values:
                raise KernelError("MISSING_INPUT_BINDING", f"template variable {name!r} is unset", {"variable": name})
            v = values[name]
            if isinstance(v, bool) or not isinstance(v, (str, int, float)):
                raise KernelError("TEMPLATE_TYPE", f"cannot interpolate {type(v).__name__} {name!r} into text")
            return str(v)
        return _PART.sub(sub, obj)
    if isinstance(obj, dict):
        return {k: fill_template(v, values) for k, v in obj.items()}
    if isinstance(obj, list):
        return [fill_template(v, values) for v in obj]
    return copy.deepcopy(obj)


# --------------------------------------------------------------------------- #
# Output validation
# --------------------------------------------------------------------------- #
_TYPE_OK = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def validate_declared_outputs(package: MachinePackage, state_id: str, obs: Observation,
                              current: dict) -> dict:
    st = package.machine.states[state_id]
    a = st.action
    writes = list(getattr(a, "writes", []) or [])
    if a.kind == "tool":
        bound = {a.binds.get(k, k): v for k, v in obs.outputs.items()}
        missing = [w for w in writes if w not in bound]
        if missing:
            raise KernelError("OUTPUT_INCOMPLETE", f"tool output lacks declared writes {missing}", {"missing": missing})
        delta = {w: bound[w] for w in writes}
    else:
        keys = set(obs.outputs)
        extra, missing = sorted(keys - set(writes)), sorted(set(writes) - keys)
        if extra:
            raise KernelError("UNEXPECTED_OUTPUT_KEYS", f"{a.kind} output has undeclared keys {extra}",
                              {"extra": extra})
        if missing:
            raise KernelError("OUTPUT_INCOMPLETE", f"{a.kind} output lacks declared writes {missing}",
                              {"missing": missing})
        delta = dict(obs.outputs)
        if a.kind == "judge":
            label = delta[writes[0]]
            if label not in a.labels:
                raise KernelError("INVALID_JUDGE_LABEL", f"label {label!r} not in {a.labels}", {"label": label})
    expected_owner = {"tool": "tool", "model": "model", "judge": "model", "user": "user"}[a.kind]
    types = package.machine.var_types()
    for k, v in delta.items():
        vc = package.contracts.variables.get(k)
        if vc is None or vc.owner != expected_owner:
            raise KernelError("WRITE_OWNERSHIP", f"{a.kind} may not write {k!r}", {"variable": k})
        if v is not None and not _TYPE_OK[types[k]](v):
            raise KernelError("OUTPUT_TYPE", f"{k!r} expects {types[k]}, got {type(v).__name__}", {"variable": k})
        errs = validate_against(vc.schema_ or {}, v)
        if v is None and not vc.schema_:
            errs = [f"{k}: null is not allowed without an explicit schema"]
        if errs:
            raise KernelError("OUTPUT_SCHEMA", f"{k!r} fails its schema: {errs[0]}", {"variable": k, "errors": errs})
    scope = package.contracts.field_scoped_writes.get(state_id)
    if scope and scope.variable in delta:
        old, new = current.get(scope.variable) or {}, delta[scope.variable]
        allowed = {i.get(scope.field_key) for i in (current.get(scope.allowed_fields_from) or [])
                   if isinstance(i, dict)}
        changed = {k for k in set(old) | set(new) if old.get(k) != new.get(k)}
        outside = sorted(changed - allowed)
        if outside:
            raise KernelError("FIELD_SCOPE_VIOLATION", f"{state_id} changed fields outside {sorted(allowed)}: {outside}",
                              {"fields": outside})
    return copy.deepcopy(delta)


def select_edge(package: MachinePackage, state_id: str, variables: dict) -> tuple[Optional[int], Optional[str]]:
    """First enabled edge, default last. Guard errors are returned, never treated as false."""
    st = package.machine.states[state_id]
    ordered = [(i, t) for i, t in enumerate(st.transitions) if t.cond] + \
              [(i, t) for i, t in enumerate(st.transitions) if not t.cond]
    for i, t in ordered:
        if not t.cond:
            return i, None
        try:
            if G.evaluate(t.cond, variables):
                return i, None
        except G.GuardError as exc:
            return None, f"edge {i} guard {t.cond!r}: {exc}"
    return None, None


# --------------------------------------------------------------------------- #
# The reducer
# --------------------------------------------------------------------------- #
def _stop(cp: RunCheckpoint, status: str, code: str, message: str, events: list, **detail) -> KernelResult:
    a = cp.assurance.model_copy(deep=True)
    a.diagnostics.append({"code": code, "message": message, "state": cp.state_id, "revision": cp.revision, **detail})
    new = cp.model_copy(update={"status": status, "assurance": a, "revision": cp.revision + 1})
    events.append({"type": "RUN_STOPPED", "status": status, "code": code, "state": cp.state_id, "message": message})
    return KernelResult(new, events)


def _charge(budget: Budget, obs: Observation) -> Budget:
    b = budget.model_copy()
    b.steps += 1
    b.tool_calls += int(obs.usage.get("tool_calls", 0))
    b.model_calls += int(obs.usage.get("model_calls", 0))
    b.tokens += int(obs.usage.get("tokens", 0))
    b.output_repairs += int(obs.usage.get("output_repairs", 0))
    return b


def _over_budget(package: MachinePackage, b: Budget) -> Optional[str]:
    lim = package.execution_policy.budgets
    if b.steps > min(lim.max_steps, package.machine.max_steps):
        return "steps"
    if b.tool_calls > lim.max_tool_calls:
        return "tool_calls"
    if b.model_calls > lim.max_model_calls:
        return "model_calls"
    if b.tokens > lim.max_tokens:
        return "tokens"
    return None


def advance(checkpoint: RunCheckpoint, obs: Observation, package: MachinePackage) -> KernelResult:
    if checkpoint.artifact_hash != package.artifact_hash:
        raise KernelError("ARTIFACT_MISMATCH", "checkpoint is pinned to a different artifact")
    if checkpoint.status in TERMINAL_STATUSES:
        raise KernelError("RUN_FINISHED", f"run already {checkpoint.status}")
    if (obs.run_id, obs.state_id, obs.revision) != (checkpoint.run_id, checkpoint.state_id, checkpoint.revision):
        raise KernelError("OBSERVATION_IDENTITY", "observation does not belong to this state visit",
                          {"expected": [checkpoint.run_id, checkpoint.state_id, checkpoint.revision],
                           "got": [obs.run_id, obs.state_id, obs.revision]})
    st = package.machine.states.get(checkpoint.state_id)
    if st is None:
        raise KernelError("UNKNOWN_STATE", checkpoint.state_id)
    if obs.kind != st.action.kind:
        raise KernelError("OBSERVATION_KIND", f"state {st.id} is {st.action.kind}, observation is {obs.kind}")
    events: list[dict] = [{"type": "OBSERVATION_ACCEPTED", "state": st.id, "revision": checkpoint.revision,
                           "kind": obs.kind, "observation_digest": obs.digest(), "actor": obs.actor,
                           "receipt_ref": obs.receipt_ref}]
    budget = _charge(checkpoint.budget, obs)
    cp = checkpoint.model_copy(update={"budget": budget})

    if st.action.kind == "end":
        return _finish(cp, obs, package, events)

    if obs.failure:
        # Recorded host decision: this state could not produce a valid observation (bounded repair exhausted,
        # tool error). Route to the reserved fallback state; record entry permanently.
        a = cp.assurance.model_copy(deep=True)
        a.entered_fallback = True
        a.fallback_reason = f"{st.id}: {obs.failure}"
        fb = package.machine.fallback
        new = cp.model_copy(update={"state_id": fb, "revision": cp.revision + 1, "assurance": a, "status": "RUNNING"})
        events.append({"type": "FALLBACK_ENTERED", "from": st.id, "to": fb, "reason": obs.failure})
        return KernelResult(new, events)

    delta = validate_declared_outputs(package, st.id, obs, cp.variables)
    after = {**copy.deepcopy(cp.variables), **delta}
    idx, gerr = select_edge(package, st.id, after)
    if gerr:
        return _stop(cp.model_copy(update={"variables": after}), "FAILED", "GUARD_EVALUATION_ERROR", gerr, events)
    if idx is None:
        return _stop(cp.model_copy(update={"variables": after}), "FAILED", "NO_ENABLED_TRANSITION",
                     f"no edge enabled from {st.id}", events)
    edge = st.transitions[idx]
    if edge.inc:  # guard saw the old counter; increment follows selection
        after[edge.inc] = int(after.get(edge.inc, 0)) + 1
    over = _over_budget(package, budget)
    if over:
        return _stop(cp.model_copy(update={"variables": after}), "FAILED", "BUDGET_EXHAUSTED",
                     f"run budget '{over}' exhausted", events)
    new = cp.model_copy(update={"variables": after, "state_id": edge.to, "revision": cp.revision + 1,
                                "status": "RUNNING"})
    e = {"index": idx, "if": edge.cond, "to": edge.to, "inc": edge.inc}
    events.append({"type": "TRANSITION", "from": st.id, "to": edge.to, "edge": e, "delta_keys": sorted(delta),
                   "delta_digest": digest(delta), "revision": new.revision})
    return KernelResult(new, events, delta, e)


def _finish(cp: RunCheckpoint, obs: Observation, package: MachinePackage, events: list) -> KernelResult:
    st = package.machine.states[cp.state_id]
    tid = st.action.terminal
    term = package.machine.terminal(tid)
    tc = package.contracts.terminals.get(tid)
    missing = [o for o in (term.output if term else []) if o not in cp.variables]
    if missing:
        return _stop(cp, "FAILED", "TERMINAL_OUTPUT_MISSING", f"terminal {tid} lacks outputs {missing}", events)
    adm = obs.engine.get("terminal_admission", {})
    a = cp.assurance.model_copy(deep=True)
    a.unresolved_effects = list(adm.get("unresolved_effects", []))
    if tc is not None and tc.category == "verified":
        if not adm.get("evidence_valid") or a.unresolved_effects:
            a.missing_evidence = list(adm.get("missing", ["no valid evidence receipt"]))
            return _stop(cp.model_copy(update={"assurance": a}), "FAILED", "TERMINAL_ADMISSION_DENIED",
                         f"verified terminal {tid} not supported by current evidence", events,
                         missing=a.missing_evidence)
        a.verification_scope = tc.verification_scope
    outputs = {o: cp.variables[o] for o in (term.output if term else [])}
    outcome = {"terminal": tid, "category": tc.category if tc else (term.kind if term else ""), "outputs": outputs,
               "evidence_receipts": list(adm.get("receipts", []))}
    new = cp.model_copy(update={"status": "COMPLETED", "outcome": outcome, "assurance": a,
                                "revision": cp.revision + 1,
                                "evidence_refs": list(adm.get("receipts", []))})
    events.append({"type": "TERMINAL_ADMITTED", "terminal": tid, "category": outcome["category"]})
    return KernelResult(new, events)
