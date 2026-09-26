"""Trace normalization (brief §9.2) and archive eligibility (brief §9.1).

Normalization keeps pointers to the original records. Only recognized orchestration noise is
removed; non-observable model/judge steps are zero-width (they stay in the raw trace). Consecutive
same-tool records merge ONLY when the adapter established one logical operation (same
``meta.logical_action_id``) -- distinct writes, approvals, failures and verifications never merge.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..artifacts.package import MachinePackage, OrderingRequirement
from ..artifacts.validate import derived_ordering
from ..evidence.receipts import POSITIVE_RESULTS
from .model import Trace

NORMALIZER_VERSION = "hexis-service-trace-normalizer/1"
NOISE_KINDS = ("noop", "heartbeat", "log", "orchestration")


class NormalizedEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int
    source_steps: list[int]
    kind: str  # tool | model_output | user | terminal
    tool: str = ""
    phase: str = ""
    inputs: Any = None
    outputs: dict = Field(default_factory=dict)
    outcome: str = ""
    role: str = ""
    labels: list[str] = Field(default_factory=list)
    terminal: str = ""
    interaction_type: str = ""


def normalize(trace: Trace) -> tuple[list[NormalizedEvent], list[dict]]:
    """Return (events, dropped) where dropped lists every removed record with its reason."""
    events: list[NormalizedEvent] = []
    dropped: list[dict] = []
    for r in trace.records:
        kind = r.action.get("kind", "")
        if kind in NOISE_KINDS:
            dropped.append({"step": r.step, "reason": f"orchestration noise ({kind})"})
            continue
        if kind in ("model", "judge") and not r.meta.get("observable"):
            dropped.append({"step": r.step, "reason": "zero-width (non-observable model/judge step)"})
            continue
        if kind == "tool":
            lid = r.meta.get("logical_action_id")
            prev = events[-1] if events else None
            if prev is not None and prev.kind == "tool" and prev.tool == r.action.get("name") and lid \
                    and prev.role == f"lid:{lid}":
                prev.source_steps.append(r.step)
                prev.outputs = dict(r.output)  # last attempt's observation of the same logical operation
                continue
            events.append(NormalizedEvent(index=len(events), source_steps=[r.step], kind="tool",
                                          tool=r.action.get("name", ""), phase=r.action.get("phase", ""),
                                          inputs=r.action.get("input"), outputs=dict(r.output),
                                          outcome=str(r.output.get("status", "")), role=f"lid:{lid}" if lid else "",
                                          labels=list(r.action.get("labels", []))))
        elif kind in ("model", "judge"):
            events.append(NormalizedEvent(index=len(events), source_steps=[r.step], kind="model_output",
                                          outputs=dict(r.output)))
        elif kind == "user":
            events.append(NormalizedEvent(index=len(events), source_steps=[r.step], kind="user",
                                          outputs=dict(r.output), interaction_type=r.meta.get("interaction_type", "")))
        elif kind == "end":
            events.append(NormalizedEvent(index=len(events), source_steps=[r.step], kind="terminal",
                                          terminal=r.action.get("terminal", "")))
        else:
            dropped.append({"step": r.step, "reason": f"unrecognized kind {kind!r} (kept out of alignment)"})
    for i, e in enumerate(events):
        e.index = i
    return events, dropped


def _matches(sel: str, r) -> bool:
    kind, _, val = sel.partition(":")
    a = r.action
    if kind == "tool":
        return a.get("kind") == "tool" and a.get("name") == val
    if kind == "state":
        return r.state == val
    if kind == "terminal":
        return a.get("kind") == "end" and a.get("terminal") == val
    if kind == "user":
        return a.get("kind") == "user" and r.meta.get("interaction_type") == val
    return False


def eligibility(trace: Trace, package: MachinePackage) -> list[dict]:
    """Constraint violations that make a trace ineligible for the protected archive. Checked on
    the raw record stream (including zero-width steps), with invalidation on writes."""
    violations: list[dict] = []
    if trace.verdict == "rejected":
        violations.append({"code": "REJECTED_VERDICT", "step": trace.error_step})
    reqs: list[OrderingRequirement] = list(package.contracts.ordering) + derived_ordering(package)
    for req in reqs:
        inval = set(req.invalidated_by)
        satisfied = False
        for r in trace.records:
            if _matches(req.before, r) and not satisfied:
                violations.append({"code": "ORDERING_VIOLATION", "requirement": req.id, "step": r.step,
                                   "clause": req.clause})
                break
            if any(_matches(q, r) for q in req.requires):
                satisfied = True
            elif set(r.meta.get("writes", list(r.output.keys()))) & inval:
                satisfied = False
    # A verified terminal must be preceded by a positive verifier result (no misleading success claims).
    verified = {t for t, c in package.contracts.terminals.items() if c.category == "verified"}
    for r in trace.records:
        if r.action.get("kind") == "end" and r.action.get("terminal") in verified:
            for ev in package.contracts.terminals[r.action["terminal"]].evidence:
                last = [x for x in trace.records if x.step < r.step and x.action.get("name") == ev.verifier_tool]
                if not last or str(last[-1].output.get("status")) not in POSITIVE_RESULTS:
                    violations.append({"code": "UNSUPPORTED_SUCCESS_CLAIM", "step": r.step, "claim": ev.claim})
    # Broker denials recorded in the trace mean an unauthorized action was attempted.
    for r in trace.records:
        if r.meta.get("broker_status") == "DENIED":
            violations.append({"code": "UNAUTHORIZED_ACTION_ATTEMPT", "step": r.step})
    return violations


def first_step(violations: list[dict]) -> Optional[int]:
    steps = [v["step"] for v in violations if v.get("step") is not None]
    return min(steps) if steps else None
