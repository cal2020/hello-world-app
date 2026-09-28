"""Tool broker (brief §4, §11.1, §12): the only path to external effects.

Immediately before every dispatch it independently re-checks: worker fencing, cancellation,
input schema, tenant, capability ceiling ∩ principal permissions, approval scope (for
approval-gated capabilities) and evidence validity. It never trusts a model's or machine's claim
that authorization, approval or verification occurred.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol

from ..canonical import digest
from .catalog import ToolCatalog, ToolSpec, validate_against
from .errors import ToolFailure, ToolTimeout
from .policy import PolicyService, Principal


class SimulatedCrash(BaseException):
    """Process death at an injected boundary (BaseException so it is never swallowed)."""


class FaultInjector:
    POINTS = ("after_intent", "before_dispatch", "after_remote_call", "after_receipt", "before_commit")

    def __init__(self) -> None:
        self.armed: set[str] = set()

    def arm(self, *points: str) -> None:
        for p in points:
            assert p in self.POINTS, p
            self.armed.add(p)

    def hit(self, point: str) -> None:
        if point in self.armed:
            self.armed.discard(point)
            raise SimulatedCrash(point)


class Connector(Protocol):
    def __call__(self, args: dict, ctx: dict) -> dict: ...


@dataclass
class BrokerResult:
    status: str  # SUCCEEDED | DENIED | UNKNOWN_EFFECT | FAILED | NEEDS_RESOLUTION
    output: Optional[dict] = None
    reason: str = ""
    receipt_ref: str = ""
    certainty: str = ""
    evidence: list[dict] = field(default_factory=list)


class ToolBroker:
    def __init__(self, store, catalog: ToolCatalog, policy: PolicyService, connectors: dict[str, Callable],
                 reconcilers: Optional[dict[str, Callable]] = None, clock: Callable[[], float] = None,
                 faults: Optional[FaultInjector] = None, timer: Callable[[], float] = time.perf_counter):
        self.store, self.catalog, self.policy = store, catalog, policy
        self.connectors = connectors
        self.reconcilers = reconcilers or {}
        self.clock = clock or time.time
        # Monotonic timer for latency metrics only; never used for expiry/leases and never recorded in
        # observations, receipts or checkpoints (see metrics.py).
        self.timer = timer
        self.faults = faults or FaultInjector()
        self._local = threading.local()

    # ---- latency instrumentation (per thread; drained by RunService after each step) ------------ #
    def _timings(self) -> list[dict]:
        buf = getattr(self._local, "timings", None)
        if buf is None:
            buf = self._local.timings = []
        return buf

    def take_timings(self) -> list[dict]:
        """Return and clear the connector/reconciler call timings recorded on this thread."""
        buf = self._timings()
        out = list(buf)
        buf.clear()
        return out

    def _timed(self, spec: ToolSpec, op: str, attempt: int, fn: Callable[[], Any]) -> Any:
        t0 = self.timer()
        outcome = "error"
        try:
            out = fn()
            outcome = "ok"
            return out
        except ToolTimeout:
            outcome = "timeout"
            raise
        except ToolFailure:
            outcome = "failure"
            raise
        finally:
            self._timings().append({"tool": spec.name, "tool_version": spec.version, "op": op, "attempt": attempt,
                                    "latency_s": self.timer() - t0, "outcome": outcome})

    # ------------------------------------------------------------------------------------- #
    def authorize(self, *, intent: dict, spec: ToolSpec, principal: Principal, package, business_unit: Optional[str],
                  approval_check: Callable[[], tuple[bool, str]], lease_token: Optional[int]) -> tuple[bool, str]:
        tenant = intent["tenant_id"]
        if lease_token is not None and self.store.lease_token(tenant, intent["run_id"]) != lease_token:
            return False, "STALE_LEASE"
        run = self.store.get_run(tenant, intent["run_id"])
        if run is None or run["tenant_id"] != principal.tenant_id:
            return False, "TENANT_SCOPE"
        if run["cancel_requested"] and spec.is_write:
            return False, "RUN_CANCELLED"
        if self.store.is_revoked(run["artifact_hash"]) and spec.is_write:
            return False, "ARTIFACT_REVOKED"
        if spec.version != intent["tool_version"]:
            return False, "TOOL_VERSION_CHANGED"
        errs = validate_against(spec.input_schema, intent["args"])
        if errs:
            return False, "INPUT_SCHEMA: " + "; ".join(errs[:3])
        # The business unit the effect actually targets is the one in the arguments, not only the run's
        # task variable: every business unit named in the arguments must be the run's scoped unit.
        targeted = sorted(_business_units_in(intent["args"]))
        foreign = [b for b in targeted if b != business_unit]
        if foreign:
            return False, (f"POLICY_DENY: tool arguments target business unit(s) {foreign} outside the run's scoped "
                           f"business unit {business_unit}")
        d = self.policy.evaluate_dispatch(principal, tenant, spec.capability, package.execution_policy.capability_ceiling,
                                          business_unit)
        if not d.allowed:
            return False, f"POLICY_{d.outcome}: " + "; ".join(d.reasons)
        if self.policy.requires_approval(spec.capability):
            ok, why = approval_check()
            if not ok:
                return False, "APPROVAL_INVALID: " + why
        return True, ""

    def dispatch(self, *, intent: dict, principal: Principal, package, business_unit: Optional[str],
                 approval_check: Callable[[], tuple[bool, str]], lease_token: Optional[int],
                 subject_values: dict, transport_retries: int = 2) -> BrokerResult:
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        spec = self.catalog.get(intent["tool"])
        if spec is None:
            return BrokerResult("DENIED", reason="UNKNOWN_TOOL")
        # Never trust the caller's snapshot of the intent: another worker may have moved it on.
        stored = self.store.intent(tenant, lid)
        if stored is not None:
            intent = {**intent, "status": stored["status"], "attempts": stored["attempts"]}
        prior = self.store.receipts(tenant, lid)
        done = [r for r in prior if r["dispatch_state"] == "SUCCEEDED"]
        if done:  # deduplicate repeated delivery of the same logical action
            r = done[-1]
            if stored is not None and stored["status"] != "SUCCEEDED":
                # Receipts are authoritative: repair an intent left behind by an interrupted update.
                self.store.update_intent(tenant, lid, "SUCCEEDED", self.clock())
            evidence = self._recover_evidence(intent, spec, r, subject_values)
            return BrokerResult("SUCCEEDED", r["result"], "deduplicated", f"{lid}#{r['seq']}", r["certainty"],
                                evidence)
        if intent["status"] in ("DISPATCHING", "UNKNOWN_EFFECT"):
            return self.reconcile(intent=intent, principal=principal, package=package, business_unit=business_unit,
                                  approval_check=approval_check, lease_token=lease_token,
                                  subject_values=subject_values, transport_retries=transport_retries)
        ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                 business_unit=business_unit, approval_check=approval_check, lease_token=lease_token)
        if not ok:
            if why == "STALE_LEASE":  # a fenced-off worker must not touch the ledger at all
                return BrokerResult("DENIED", reason=why)
            seq = self.store.record_outcome(
                tenant, lid, intent["run_id"], spec.name, spec.version, intent["args_digest"],
                intent["idempotency_key"], "DENIED", "no_effect", None, {"reason": why}, "broker", self.clock(),
                intent_status="DENIED" if stored is not None else None, require_token=lease_token,
                expect_status=_DENIABLE if stored is not None else None)
            if seq is None:  # fenced off, or another worker moved the intent past PENDING meanwhile
                return BrokerResult("DENIED", reason="STALE_LEASE: intent changed concurrently")
            return BrokerResult("DENIED", reason=why)
        return self._call(intent, spec, subject_values, transport_retries, lease_token)

    def _call(self, intent: dict, spec: ToolSpec, subject_values: dict, retries: int,
              lease_token: Optional[int], op: str = "dispatch") -> BrokerResult:
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        ctx = {"tenant_id": tenant, "idempotency_key": intent["idempotency_key"], "logical_action_id": lid}
        attempts = 0
        while True:
            attempts += 1
            self.faults.hit("before_dispatch")
            # Fencing is enforced again atomically with the DISPATCHING transition.
            self.store.update_intent(tenant, lid, "DISPATCHING", self.clock(), bump_attempt=True,
                                     require_token=lease_token, run_id=intent["run_id"])
            try:
                out = self._timed(spec, op, attempts,
                                  lambda: self.connectors[spec.name](intent["args"], ctx))
            except ToolTimeout as exc:
                if spec.effect in ("read", "pure") and attempts <= retries:
                    continue  # transport retry of the same read-only operation
                if spec.effect in ("read", "pure"):
                    self._receipt(intent, spec, "FAILED", "no_effect", None, {"error": str(exc)}, "FAILED")
                    return BrokerResult("FAILED", reason=f"TIMEOUT: {exc}")
                self._receipt(intent, spec, "UNKNOWN_EFFECT", "unknown", None, {"error": str(exc)}, "UNKNOWN_EFFECT")
                return BrokerResult("UNKNOWN_EFFECT", reason=f"TIMEOUT_AFTER_DISPATCH: {exc}")
            except ToolFailure as exc:
                certainty = "no_effect" if not spec.is_write else "unknown"
                state = "FAILED" if not spec.is_write else "UNKNOWN_EFFECT"
                self._receipt(intent, spec, state, certainty, None, {"error": str(exc)}, state)
                return BrokerResult(state, reason=f"TOOL_FAILURE: {exc}")
            self.faults.hit("after_remote_call")
            return self._accept(intent, spec, out, "certain", subject_values)

    def _receipt(self, intent: dict, spec: ToolSpec, state: str, certainty: str, ext: Optional[str],
                 result: Any, intent_status: Optional[str] = None,
                 evidence: Optional[Callable[[int], list[dict]]] = None) -> int:
        """Append a receipt and (atomically) move the intent to ``intent_status`` / issue evidence."""
        seq = self.store.record_outcome(intent["tenant_id"], intent["logical_action_id"], intent["run_id"], spec.name,
                                        spec.version, intent["args_digest"], intent["idempotency_key"], state,
                                        certainty, ext, result, f"connector:{spec.name}@{spec.version}", self.clock(),
                                        intent_status=intent_status, evidence=evidence)
        assert seq is not None
        return seq

    def _evidence_for(self, intent: dict, spec: ToolSpec, out: Any, seq: int, subject_values: dict,
                      observed_at: float) -> list[dict]:
        if not spec.verifier_claims or not isinstance(out, dict):
            return []
        from ..evidence.receipts import make_receipt, subject_of
        subj = subject_of(subject_values, sorted(subject_values))
        return [make_receipt(intent["run_id"], claim, spec.name, spec.version, subj, str(out.get("status")),
                             f"{intent['logical_action_id']}#{seq}", observed_at, receipt_id=out.get("receipt_id"))
                for claim in spec.verifier_claims]

    def _recover_evidence(self, intent: dict, spec: ToolSpec, receipt: dict, subject_values: dict) -> list[dict]:
        """Evidence is derived from the SUCCEEDED receipt; re-issue it (idempotently) if it is missing,
        e.g. after a crash of a process that stored the receipt under an older, non-atomic layout."""
        if not spec.verifier_claims or not subject_values:
            return []
        ref = f"{intent['logical_action_id']}#{receipt['seq']}"
        have = [e for e in self.store.evidence(intent["tenant_id"], intent["run_id"]) if e["source_ref"] == ref]
        if have:
            return have
        recs = self._evidence_for(intent, spec, receipt["result"], receipt["seq"], subject_values,
                                  receipt["created_at"])
        for rec in recs:
            self.store.add_evidence(intent["tenant_id"], rec)
        return recs

    def _accept(self, intent: dict, spec: ToolSpec, out: Any, certainty: str, subject_values: dict) -> BrokerResult:
        lid = intent["logical_action_id"]
        errs = validate_against(spec.output_schema, out)
        if errs:  # spoofed / malformed connector output never reaches machine variables
            state = "UNKNOWN_EFFECT" if spec.is_write else "FAILED"
            self._receipt(intent, spec, state, "unknown" if spec.is_write else "no_effect", None,
                          {"invalid_output": errs[:3]}, state)
            return BrokerResult(state, reason="OUTPUT_SCHEMA: " + "; ".join(errs[:3]))
        ext = None
        if isinstance(out, dict):
            ext = out.get("draft_id") or out.get("receipt_id")
        now = self.clock()
        issued: list[dict] = []

        def evidence(seq: int) -> list[dict]:
            issued.extend(self._evidence_for(intent, spec, out, seq, subject_values, now))
            return issued

        # Receipt, intent status and evidence are one transaction: a crash leaves all or none of them.
        seq = self._receipt(intent, spec, "SUCCEEDED", certainty, ext, out, "SUCCEEDED", evidence)
        self.faults.hit("after_receipt")
        return BrokerResult("SUCCEEDED", out, "", f"{lid}#{seq}", certainty, issued)

    # ------------------------------------------------------------------------------------- #
    def reconcile(self, *, intent: dict, principal: Principal, package, business_unit: Optional[str],
                  approval_check: Callable[[], tuple[bool, str]], lease_token: Optional[int], subject_values: dict,
                  transport_retries: int = 2) -> BrokerResult:
        """Resolve a dispatched action whose outcome is unknown. Never blindly repeats a
        non-idempotent write."""
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        spec = self.catalog.get(intent["tool"])
        if spec is None:
            return BrokerResult("NEEDS_RESOLUTION", reason=f"tool {intent['tool']} is not in the current catalog; "
                                                           "cannot reconcile automatically")
        ctx = {"tenant_id": tenant, "idempotency_key": intent["idempotency_key"], "logical_action_id": lid}
        if spec.effect in ("read", "pure"):
            # No external effect to reconcile: safe to (re)dispatch under full authorization.
            self.store.update_intent(tenant, lid, "PENDING", self.clock(), require_token=lease_token,
                                     run_id=intent["run_id"])
            ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                     business_unit=business_unit, approval_check=approval_check,
                                     lease_token=lease_token)
            if not ok:
                return BrokerResult("DENIED", reason=why)
            return self._call({**intent, "status": "PENDING"}, spec, subject_values, transport_retries, lease_token,
                              "redispatch")
        proven_absent = False
        if spec.effect == "reconciliable_write" and spec.name in self.reconcilers:
            found = self._timed(spec, "reconcile", 1, lambda: self.reconcilers[spec.name](intent["args"], ctx))
            if found is not None:
                return self._accept(intent, spec, found, "reconciled", subject_values)
            # Proven absent by business-reference lookup: a retry with the same key is safe, but only
            # under a fresh authorization/approval check.
            proven_absent = True
        elif spec.effect == "idempotent_write":
            pass  # retry with same key and identical arguments
        else:
            self.store.update_intent(tenant, lid, "UNKNOWN_EFFECT", self.clock(),
                                     expect_status=("DISPATCHING", "UNKNOWN_EFFECT"))
            return BrokerResult("NEEDS_RESOLUTION", reason="non-idempotent write with unknown effect: human resolution "
                                                            "required; no automatic retry")
        ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                 business_unit=business_unit, approval_check=approval_check, lease_token=lease_token)
        if not ok:
            if proven_absent and why != "STALE_LEASE":
                # The effect provably did not happen and will not be retried (cancelled, revoked, denied):
                # resolve it as no-effect so it is not reported as unresolved forever.
                self.store.record_outcome(
                    tenant, lid, intent["run_id"], spec.name, spec.version, intent["args_digest"],
                    intent["idempotency_key"], "ABANDONED", "no_effect", None,
                    {"reason": "proven absent by business-reference lookup; retry not authorized: " + why},
                    "broker:reconcile", self.clock(), intent_status="ABANDONED", require_token=lease_token,
                    expect_status=("DISPATCHING", "UNKNOWN_EFFECT"))
            return BrokerResult("DENIED", reason=why)
        if intent["attempts"] > transport_retries:
            return BrokerResult("NEEDS_RESOLUTION", reason="retry budget for uncertain write exhausted")
        return self._call(intent, spec, subject_values, 0, lease_token, "redispatch")


# Intent statuses a broker denial may overwrite. DISPATCHING / UNKNOWN_EFFECT / SUCCEEDED never are.
_DENIABLE = ("PENDING", "DENIED", "FAILED", "ABANDONED")


def _business_units_in(value: Any) -> set[str]:
    """Every ``business_unit`` value named anywhere in a tool's arguments."""
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            if k == "business_unit" and isinstance(v, str):
                found.add(v)
            else:
                found |= _business_units_in(v)
    elif isinstance(value, list):
        for v in value:
            found |= _business_units_in(v)
    return found


def args_digest(args: Any) -> str:
    return digest(args)
