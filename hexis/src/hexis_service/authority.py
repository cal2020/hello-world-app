"""Host-side authority: principals, deterministic policy, approvals, evidence receipts.

None of these can be modified by the compiler, the updater or a model. A
model-produced ``approved`` value has no authority: approvals are only created
by ``ApprovalService.respond`` for an authenticated principal supplied by the
host, and are re-checked by the broker at dispatch time.

Identities in the demo are simulated host principals; this is not production
authentication.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from . import canonical
from .store import Store

ALLOW, DENY, INDETERMINATE = "ALLOW", "DENY", "INDETERMINATE"


@dataclass(frozen=True)
class Principal:
    principal_id: str
    tenant_id: str
    roles: tuple[str, ...]
    authenticated: bool = True


@dataclass
class Decision:
    result: str
    reason: str
    policy_version: str


class PolicyService:
    """Deterministic policy evaluation. Missing data gives INDETERMINATE, never ALLOW."""

    def __init__(self, doc: dict):
        self.doc = doc
        self.revoked: set[tuple[str, str]] = set()

    @property
    def version(self) -> str:
        return self.doc["policy_version"]

    def revoke(self, principal_id: str, capability: str) -> None:
        self.revoked.add((principal_id, capability))

    def capabilities(self, p: Principal) -> set[str]:
        caps: set[str] = set()
        for r in p.roles:
            caps |= set(self.doc["roles"].get(r, []))
        return {c for c in caps if (p.principal_id, c) not in self.revoked}

    def evaluate(self, p: Principal, tenant_id: str, capability: str, args: dict) -> Decision:
        v = self.version
        if not p.authenticated:
            return Decision(DENY, "principal is not authenticated", v)
        if p.tenant_id != tenant_id:
            return Decision(DENY, f"principal tenant {p.tenant_id} cannot act in tenant {tenant_id}", v)
        tenant = self.doc["tenants"].get(tenant_id)
        if tenant is None:
            return Decision(INDETERMINATE, f"no policy for tenant {tenant_id}", v)
        if capability not in self.capabilities(p):
            return Decision(DENY, f"principal lacks capability {capability}", v)
        bu = args.get("business_unit")
        if bu is not None and bu not in tenant["business_units"]:
            return Decision(DENY, f"business unit {bu!r} is outside tenant scope", v)
        return Decision(ALLOW, "permitted", v)

    def can_approve(self, p: Principal, tenant_id: str, tool: str) -> Decision:
        v = self.version
        if not p.authenticated or p.tenant_id != tenant_id:
            return Decision(DENY, "approver is not authenticated for this tenant", v)
        if self.doc["approval"]["approver_role"] not in p.roles:
            return Decision(DENY, "principal does not hold the approver role", v)
        if f"approve:{tool}" not in self.capabilities(p):
            return Decision(DENY, f"principal may not approve {tool}", v)
        return Decision(ALLOW, "approver authorized", v)


class ApprovalError(PermissionError):
    pass


class ApprovalService:
    def __init__(self, store: Store, policy: PolicyService):
        self.store = store
        self.policy = policy

    def create(self, c, request: dict) -> None:
        c.execute("INSERT OR IGNORE INTO approval_requests VALUES(?,?,?)",
                  (request["tenant_id"], request["interaction_id"], json.dumps(request, sort_keys=True)))

    def get(self, tenant: str, interaction_id: str) -> tuple[dict | None, dict | None]:
        req = self.store.q("SELECT request_json FROM approval_requests WHERE tenant_id=? AND interaction_id=?",
                           (tenant, interaction_id))
        resp = self.store.q("SELECT response_json FROM approval_responses WHERE tenant_id=? AND interaction_id=?",
                            (tenant, interaction_id))
        return (json.loads(req[0][0]) if req else None, json.loads(resp[0][0]) if resp else None)

    def record_response(self, c, request: dict, principal: Principal, decision: str, now: float,
                        run_principal_id: str) -> str:
        """Authenticate and authorize the approver, then persist the decision. Returns the effective decision."""
        if decision not in ("approved", "rejected"):
            raise ApprovalError(f"decision must be 'approved' or 'rejected', got {decision!r}")
        if not isinstance(principal, Principal) or not principal.authenticated:
            raise ApprovalError("approval requires an authenticated host principal")
        d = self.policy.can_approve(principal, request["tenant_id"], request["tool"])
        if d.result != ALLOW:
            raise ApprovalError(d.reason)
        if not self.policy.doc["approval"].get("self_approval", False) and principal.principal_id == run_principal_id:
            raise ApprovalError("the run's initiator cannot approve its own action")
        effective = "expired" if now > request["expires_at"] else decision
        resp = {"interaction_id": request["interaction_id"], "principal_id": principal.principal_id,
                "roles": list(principal.roles), "decision": effective, "responded_at": now,
                "policy_version": self.policy.version, "approval_digest": request["approval_digest"]}
        c.execute("INSERT INTO approval_responses VALUES(?,?,?)",
                  (request["tenant_id"], request["interaction_id"], json.dumps(resp, sort_keys=True)))
        return effective

    def check_for_dispatch(self, tenant: str, intent: dict, evidence: dict, now: float) -> tuple[bool, str]:
        """Find an approval bound to exactly this logical action and argument digest; re-check authority."""
        rows = self.store.q("SELECT request_json FROM approval_requests WHERE tenant_id=?", (tenant,))
        for (raw,) in rows:
            req = json.loads(raw)
            if req["run_id"] != intent["run_id"] or req["tool"] != intent["tool"]:
                continue
            if req["logical_action_id"] != intent["logical_action_id"] or req["args_digest"] != intent["args_digest"]:
                continue
            _, resp = self.get(tenant, req["interaction_id"])
            if not resp or resp["decision"] != "approved":
                continue
            if req["tool_version"] != intent["tool_version"]:
                return False, "approved tool version differs from the dispatched version"
            if req["policy_version"] != self.policy.version:
                return False, "policy version changed since approval"
            if req["evidence"] != evidence:
                return False, "evidence changed since approval"
            if now > req["expires_at"]:
                return False, "approval expired"
            approver = Principal(resp["principal_id"], tenant, tuple(resp["roles"]))
            d = self.policy.can_approve(approver, tenant, intent["tool"])
            if d.result != ALLOW:
                return False, f"approver authority no longer valid: {d.reason}"
            return True, req["interaction_id"]
        return False, "no valid approval bound to this exact action and argument digest"


def approval_digest(binding: dict) -> str:
    return canonical.digest(binding)


@dataclass
class EvidenceService:
    store: Store
    issued: list[str] = field(default_factory=list)

    def issue(self, c, tenant: str, run_id: str, verifier: str, verifier_version: str, subject: dict,
              claim: str, result: str, source_ref: str, observed_at: float) -> str:
        body = {"tenant_id": tenant, "run_id": run_id, "verifier": verifier, "verifier_version": verifier_version,
                "subject": subject, "claim": claim, "result": result, "source_ref": source_ref,
                "observed_at": observed_at,
                "invalidation": ["subject version changes", "subject payload hash changes",
                                 "policy version changes", "receipt explicitly invalidated"]}
        rid = "ev-" + canonical.digest(body)[7:23]
        c.execute("INSERT OR IGNORE INTO evidence_receipts VALUES(?,?,?,?,NULL)",
                  (tenant, rid, run_id, json.dumps({**body, "receipt_id": rid}, sort_keys=True)))
        return rid

    def get(self, tenant: str, receipt_id: str) -> tuple[dict, str | None] | None:
        rows = self.store.q("SELECT receipt_json, invalidated_reason FROM evidence_receipts WHERE tenant_id=? "
                            "AND receipt_id=?", (tenant, receipt_id))
        return (json.loads(rows[0][0]), rows[0][1]) if rows else None

    def invalidate(self, tenant: str, receipt_id: str, reason: str) -> None:
        with self.store.tx() as c:
            c.execute("UPDATE evidence_receipts SET invalidated_reason=? WHERE tenant_id=? AND receipt_id=?",
                      (reason, tenant, receipt_id))

    def for_run(self, tenant: str, run_id: str) -> list[dict]:
        rows = self.store.q("SELECT receipt_json, invalidated_reason FROM evidence_receipts WHERE tenant_id=? AND "
                            "run_id=? ORDER BY rowid", (tenant, run_id))
        return [{**json.loads(r), "invalidated_reason": inv} for r, inv in rows]
