"""Tool broker: prepare / dispatch / reconcile (brief section 11).

Order of checks immediately before any dispatch:
1. the worker's fencing token is still current (a stale worker cannot dispatch);
2. the tool and version come from the pinned package's trusted catalog;
3. deterministic policy evaluation for the authenticated principal
   (``DENY``/``INDETERMINATE`` both block);
4. for tools that require approval: an authenticated approval bound to this
   logical action id and canonical argument digest, re-checked for expiry,
   policy version, evidence and approver authority.

Effect handling:
* read / pure: bounded transport retry;
* idempotent or reconcilable write: an existing intent in ``dispatching`` or
  ``unknown_effect`` is first reconciled by business reference; only when the
  connector proves no record exists is it re-sent with the *same* key;
* non-idempotent write: an uncertain outcome stays ``unknown_effect`` and the
  run pauses; it is never blindly repeated.
A timeout after dispatch is ``unknown_effect``, never "nothing happened".
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import canonical
from . import jsonschema_lite as JS
from .authority import ALLOW, ApprovalService, EvidenceService, PolicyService, Principal
from .connectors import CallContext, ConnectorError, ConnectorSet, ConnectorTimeout
from .package import LoadedPackage
from .store import Store


class StaleLeaseError(RuntimeError):
    pass


class SimulatedCrash(RuntimeError):
    """Raised at an injected crash point to model a process dying mid-step."""


@dataclass
class Outcome:
    certainty: str                 # certain | unknown_effect | denied | failed
    result: dict | None = None
    reason: str = ""
    receipt_id: str | None = None
    evidence_receipts: list[str] = field(default_factory=list)


def canonical_args_digest(tool: str, version: str, args: dict) -> str:
    return canonical.digest({"tool": tool, "version": version, "args": args})


class ToolBroker:
    def __init__(self, store: Store, policy: PolicyService, approvals: ApprovalService, evidence: EvidenceService,
                 connectors: ConnectorSet, clock=time.time, transport_retries: int = 2):
        self.store = store
        self.policy = policy
        self.approvals = approvals
        self.evidence = evidence
        self.connectors = connectors
        self.clock = clock
        self.transport_retries = transport_retries
        self.crash_points: set[str] = set()
        self.dispatch_log: list[dict] = []

    def _crash(self, point: str) -> None:
        if point in self.crash_points:
            self.crash_points.discard(point)
            raise SimulatedCrash(point)

    def _receipt(self, intent: dict, attempt: int, dispatch_state: str, certainty: str, result: dict | None,
                 reason: str = "", external_ref: str | None = None) -> str:
        rid = f"rcpt-{canonical.digest(intent['logical_action_id'])[7:23]}-{attempt}-{dispatch_state}"
        self.store.add_receipt(intent["tenant_id"], {
            "receipt_id": rid, "logical_action_id": intent["logical_action_id"], "run_id": intent["run_id"],
            "attempt": attempt, "tool": intent["tool"], "tool_version": intent["tool_version"],
            "args_digest": intent["args_digest"], "idempotency_key": intent["idempotency_key"],
            "dispatch_state": dispatch_state, "certainty": certainty, "external_ref": external_ref,
            "result_digest": canonical.digest(result) if result is not None else None, "result": result,
            "reason": reason, "recorded_at": self.clock()})
        return rid

    def dispatch(self, pkg: LoadedPackage, intent: dict, principal: Principal, fencing_token: int,
                 approval_evidence: dict | None = None) -> Outcome:
        tenant = intent["tenant_id"]
        if self.store.current_token(tenant, intent["run_id"]) != fencing_token:
            raise StaleLeaseError("fencing token is stale; dispatch refused")
        spec = pkg.catalog.get(intent["tool"])
        if spec is None or spec.version != intent["tool_version"]:
            return Outcome("denied", reason="tool/version not in the pinned trusted catalog")
        errs = JS.errors(intent["args"], spec.input_schema, f"{spec.name}.input")
        if errs:
            return Outcome("denied", reason="; ".join(errs))
        decision = self.policy.evaluate(principal, tenant, spec.capability, intent["args"])
        if decision.result != ALLOW:
            rid = self._receipt(intent, intent["attempts"], "not_dispatched", "denied", None,
                                f"policy {decision.result}: {decision.reason}")
            self.store.update_intent(tenant, intent["logical_action_id"], status="denied")
            return Outcome("denied", reason=f"policy {decision.result}: {decision.reason}", receipt_id=rid)
        if spec.name in pkg.contracts.get("approval_required_tools", []):
            ok, why = self.approvals.check_for_dispatch(tenant, intent, approval_evidence or {}, self.clock())
            if not ok:
                rid = self._receipt(intent, intent["attempts"], "not_dispatched", "denied", None, why)
                self.store.update_intent(tenant, intent["logical_action_id"], status="denied")
                return Outcome("denied", reason=f"approval check failed: {why}", receipt_id=rid)

        ctx = CallContext(tenant_id=tenant, principal_id=principal.principal_id,
                          idempotency_key=intent["idempotency_key"], business_reference=intent["business_reference"])
        current = self.store.get_intent(tenant, intent["logical_action_id"])
        if current["status"] == "committed":
            last = [r for r in self.store.receipts(tenant, intent["logical_action_id"]) if r["certainty"] == "certain"]
            return Outcome("certain", result=last[-1]["result"], receipt_id=last[-1]["receipt_id"],
                           reason="deduplicated: logical action already committed")
        if spec.is_write and current["status"] in ("dispatching", "unknown_effect"):
            rec = self.reconcile(pkg, current)
            if rec is not None:
                return rec

        executor = self.connectors.executor(spec.name)
        attempts_allowed = 1 + (self.transport_retries if spec.effect in ("read", "pure") else 0)
        attempt = current["attempts"]
        for _ in range(attempts_allowed):
            attempt += 1
            self.store.update_intent(tenant, intent["logical_action_id"], status="dispatching", attempts=attempt,
                                     fencing_token=fencing_token)
            self.dispatch_log.append({"tool": spec.name, "logical_action_id": intent["logical_action_id"],
                                      "attempt": attempt})
            try:
                result = executor(intent["args"], ctx)
            except ConnectorTimeout as exc:
                if spec.effect in ("read", "pure"):
                    continue
                self._crash("after_timeout_before_receipt")
                rid = self._receipt(intent, attempt, "timeout", "unknown_effect", None, str(exc))
                self.store.update_intent(tenant, intent["logical_action_id"], status="unknown_effect")
                return Outcome("unknown_effect", reason=str(exc), receipt_id=rid)
            except ConnectorError as exc:
                rid = self._receipt(intent, attempt, "rejected", "failed", None, str(exc))
                self.store.update_intent(tenant, intent["logical_action_id"], status="failed")
                return Outcome("failed", reason=str(exc), receipt_id=rid)
            self._crash("after_dispatch_before_receipt")
            return self._certain(pkg, intent, attempt, result)
        rid = self._receipt(intent, attempt, "timeout", "failed", None, "read transport retries exhausted")
        self.store.update_intent(tenant, intent["logical_action_id"], status="failed")
        return Outcome("failed", reason="transport retries exhausted", receipt_id=rid)

    def _certain(self, pkg: LoadedPackage, intent: dict, attempt: int, result: dict) -> Outcome:
        tenant = intent["tenant_id"]
        spec = pkg.catalog[intent["tool"]]
        ext = result.get("draft_ref") if isinstance(result, dict) else None
        rid = self._receipt(intent, attempt, "acknowledged", "certain", result, external_ref=ext)
        self.store.update_intent(tenant, intent["logical_action_id"], status="committed", external_ref=ext)
        evidence_ids: list[str] = []
        if spec.verifier and result.get("status") == "match":
            args = intent["args"]
            with self.store.tx() as c:
                evidence_ids.append(self.evidence.issue(
                    c, tenant, intent["run_id"], spec.name, spec.version,
                    {"draft_ref": args["draft_ref"], "version": args["draft_version"],
                     "payload_hash": args["persisted"].get("payload_hash")},
                    "persisted ERP draft matches the approved canonical payload", "match",
                    intent["logical_action_id"], self.clock()))
        self._crash("after_receipt_before_commit")
        return Outcome("certain", result=result, receipt_id=rid, evidence_receipts=evidence_ids)

    def reconcile(self, pkg: LoadedPackage, intent: dict) -> Outcome | None:
        """Look the effect up by business reference. Returns a certain outcome when found,
        None when the connector proves the effect did not happen (safe to resend with the
        same idempotency key), or unknown_effect when it cannot be decided."""
        spec = pkg.catalog[intent["tool"]]
        if spec.effect == "non_idempotent_write":
            return Outcome("unknown_effect", reason="non-idempotent write with uncertain outcome needs manual resolution")
        if spec.effect == "reconcilable_write" and spec.name == "erp.create_draft":
            found = self.connectors.erp.find_by_reference(intent["business_reference"], intent["tenant_id"])
            if found:
                return self._certain(pkg, intent, intent["attempts"], found)
            return None
        if spec.effect == "idempotent_write":
            return None
        return Outcome("unknown_effect", reason="no reconciliation procedure for this connector")

    def read_current(self, pkg: LoadedPackage, tenant: str, draft_ref: str, principal: Principal) -> dict | None:
        """Fresh authoritative read used for terminal evidence checks (policy-checked, logged)."""
        spec = pkg.catalog["erp.read_draft"]
        d = self.policy.evaluate(principal, tenant, spec.capability, {})
        if d.result != ALLOW:
            return None
        ctx = CallContext(tenant, principal.principal_id, idempotency_key="terminal-check", business_reference="")
        out = self.connectors.executor("erp.read_draft")({"draft_ref": draft_ref}, ctx)
        self.dispatch_log.append({"tool": "erp.read_draft", "purpose": "terminal_evidence_check"})
        return out["record"] if out["status"] == "available" else None
