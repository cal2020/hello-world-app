"""Tool broker (brief §4, §11.1, §12): the only path to external effects.

Immediately before every dispatch it independently re-checks: worker fencing, cancellation,
input schema, tenant, capability ceiling ∩ principal permissions, approval scope (for
approval-gated capabilities) and evidence validity. It never trusts a model's or machine's claim
that authorization, approval or verification occurred.
"""

from __future__ import annotations

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
                 faults: Optional[FaultInjector] = None):
        import time
        self.store, self.catalog, self.policy = store, catalog, policy
        self.connectors = connectors
        self.reconcilers = reconcilers or {}
        self.clock = clock or time.time
        self.faults = faults or FaultInjector()

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
        prior = self.store.receipts(tenant, lid)
        done = [r for r in prior if r["dispatch_state"] == "SUCCEEDED"]
        if done:  # deduplicate repeated delivery of the same logical action
            r = done[-1]
            return BrokerResult("SUCCEEDED", r["result"], "deduplicated", f"{lid}#{r['seq']}", r["certainty"])
        if intent["status"] in ("DISPATCHING", "UNKNOWN_EFFECT"):
            return self.reconcile(intent=intent, principal=principal, package=package, business_unit=business_unit,
                                  approval_check=approval_check, lease_token=lease_token,
                                  subject_values=subject_values, transport_retries=transport_retries)
        ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                 business_unit=business_unit, approval_check=approval_check, lease_token=lease_token)
        if not ok:
            self.store.update_intent(tenant, lid, "DENIED", self.clock())
            self.store.add_receipt(tenant, lid, intent["run_id"], spec.name, spec.version, intent["args_digest"],
                                   intent["idempotency_key"], "DENIED", "no_effect", None, {"reason": why}, "broker",
                                   self.clock())
            return BrokerResult("DENIED", reason=why)
        return self._call(intent, spec, subject_values, transport_retries, lease_token)

    def _call(self, intent: dict, spec: ToolSpec, subject_values: dict, retries: int,
              lease_token: Optional[int]) -> BrokerResult:
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        ctx = {"tenant_id": tenant, "idempotency_key": intent["idempotency_key"], "logical_action_id": lid}
        attempts = 0
        while True:
            attempts += 1
            self.faults.hit("before_dispatch")
            # Fencing is enforced again atomically with the DISPATCHING transition.
            self.store.update_intent(tenant, lid, "DISPATCHING", self.clock(), bump_attempt=True,
                                     require_token=lease_token)
            try:
                out = self.connectors[spec.name](intent["args"], ctx)
            except ToolTimeout as exc:
                if spec.effect in ("read", "pure") and attempts <= retries:
                    continue  # transport retry of the same read-only operation
                if spec.effect in ("read", "pure"):
                    self._receipt(intent, spec, "FAILED", "no_effect", None, {"error": str(exc)})
                    self.store.update_intent(tenant, lid, "FAILED", self.clock())
                    return BrokerResult("FAILED", reason=f"TIMEOUT: {exc}")
                self._receipt(intent, spec, "UNKNOWN_EFFECT", "unknown", None, {"error": str(exc)})
                self.store.update_intent(tenant, lid, "UNKNOWN_EFFECT", self.clock())
                return BrokerResult("UNKNOWN_EFFECT", reason=f"TIMEOUT_AFTER_DISPATCH: {exc}")
            except ToolFailure as exc:
                certainty = "no_effect" if not spec.is_write else "unknown"
                state = "FAILED" if not spec.is_write else "UNKNOWN_EFFECT"
                self._receipt(intent, spec, state, certainty, None, {"error": str(exc)})
                self.store.update_intent(tenant, lid, state, self.clock())
                return BrokerResult(state, reason=f"TOOL_FAILURE: {exc}")
            self.faults.hit("after_remote_call")
            return self._accept(intent, spec, out, "certain", subject_values)

    def _receipt(self, intent: dict, spec: ToolSpec, state: str, certainty: str, ext: Optional[str],
                 result: Any) -> int:
        return self.store.add_receipt(intent["tenant_id"], intent["logical_action_id"], intent["run_id"], spec.name,
                                      spec.version, intent["args_digest"], intent["idempotency_key"], state, certainty,
                                      ext, result, f"connector:{spec.name}@{spec.version}", self.clock())

    def _accept(self, intent: dict, spec: ToolSpec, out: Any, certainty: str, subject_values: dict) -> BrokerResult:
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        errs = validate_against(spec.output_schema, out)
        if errs:  # spoofed / malformed connector output never reaches machine variables
            state = "UNKNOWN_EFFECT" if spec.is_write else "FAILED"
            self._receipt(intent, spec, state, "unknown" if spec.is_write else "no_effect", None,
                          {"invalid_output": errs[:3]})
            self.store.update_intent(tenant, lid, state, self.clock())
            return BrokerResult(state, reason="OUTPUT_SCHEMA: " + "; ".join(errs[:3]))
        ext = None
        if isinstance(out, dict):
            ext = out.get("draft_id") or out.get("receipt_id")
        seq = self._receipt(intent, spec, "SUCCEEDED", certainty, ext, out)
        self.store.update_intent(tenant, lid, "SUCCEEDED", self.clock())
        self.faults.hit("after_receipt")
        evidence = []
        if spec.verifier_claims:
            from ..evidence.receipts import make_receipt, subject_of
            subj = subject_of(subject_values, sorted(subject_values))
            for claim in spec.verifier_claims:
                rec = make_receipt(intent["run_id"], claim, spec.name, spec.version, subj, str(out.get("status")),
                                   f"{lid}#{seq}", self.clock(),
                                   receipt_id=(out.get("receipt_id") if isinstance(out, dict) else None))
                self.store.add_evidence(tenant, rec)
                evidence.append(rec)
        return BrokerResult("SUCCEEDED", out, "", f"{lid}#{seq}", certainty, evidence)

    # ------------------------------------------------------------------------------------- #
    def reconcile(self, *, intent: dict, principal: Principal, package, business_unit: Optional[str],
                  approval_check: Callable[[], tuple[bool, str]], lease_token: Optional[int], subject_values: dict,
                  transport_retries: int = 2) -> BrokerResult:
        """Resolve a dispatched action whose outcome is unknown. Never blindly repeats a
        non-idempotent write."""
        tenant, lid = intent["tenant_id"], intent["logical_action_id"]
        spec = self.catalog.get(intent["tool"])
        assert spec is not None
        ctx = {"tenant_id": tenant, "idempotency_key": intent["idempotency_key"], "logical_action_id": lid}
        if spec.effect in ("read", "pure"):
            # No external effect to reconcile: safe to (re)dispatch under full authorization.
            self.store.update_intent(tenant, lid, "PENDING", self.clock())
            ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                     business_unit=business_unit, approval_check=approval_check,
                                     lease_token=lease_token)
            if not ok:
                return BrokerResult("DENIED", reason=why)
            return self._call({**intent, "status": "PENDING"}, spec, subject_values, transport_retries, lease_token)
        if spec.effect == "reconciliable_write" and spec.name in self.reconcilers:
            found = self.reconcilers[spec.name](intent["args"], ctx)
            if found is not None:
                return self._accept(intent, spec, found, "reconciled", subject_values)
            # Proven absent by business-reference lookup: a retry with the same key is safe, but only
            # under a fresh authorization/approval check.
        elif spec.effect == "idempotent_write":
            pass  # retry with same key and identical arguments
        else:
            self.store.update_intent(tenant, lid, "UNKNOWN_EFFECT", self.clock())
            return BrokerResult("NEEDS_RESOLUTION", reason="non-idempotent write with unknown effect: human resolution "
                                                            "required; no automatic retry")
        if intent["attempts"] > transport_retries:
            return BrokerResult("NEEDS_RESOLUTION", reason="retry budget for uncertain write exhausted")
        ok, why = self.authorize(intent=intent, spec=spec, principal=principal, package=package,
                                 business_unit=business_unit, approval_check=approval_check, lease_token=lease_token)
        if not ok:
            return BrokerResult("DENIED", reason=why)
        return self._call(intent, spec, subject_values, 0, lease_token)


def args_digest(args: Any) -> str:
    return digest(args)
