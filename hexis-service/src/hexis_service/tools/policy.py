"""Independent, deterministic policy boundary (brief §12.2).

Authorization derives from the authenticated principal and server-side policy. A machine's
capability ceiling can only narrow it. Anything the policy cannot evaluate is INDETERMINATE,
which the broker treats as a denial requiring review.

The identity directory here is SIMULATED for the offline demonstration (docs/LIMITATIONS.md).
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..canonical import digest


class Principal(BaseModel):
    """Host-authenticated identity. Never constructed from task input or model output."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    tenant_id: str
    roles: tuple[str, ...] = ()
    authenticated_by: str = "simulated-directory"


@dataclass
class Decision:
    outcome: str  # ALLOW | DENY | INDETERMINATE
    reasons: list[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.outcome == "ALLOW"


class PolicyDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy_version: str
    note: str = ""
    principals: dict[str, dict]
    approval_required_capabilities: list[str] = Field(default_factory=list)
    approver_role: str
    separation_of_duties: bool = True


class PolicyService:
    def __init__(self, doc: dict):
        self.doc = PolicyDocument.model_validate(copy.deepcopy(doc))

    @property
    def version(self) -> str:
        return self.doc.policy_version

    def digest(self) -> str:
        return digest(self.doc.model_dump(mode="json"))

    def authenticate(self, principal_id: str) -> Principal:
        """Simulated host authentication against the directory."""
        p = self.doc.principals.get(principal_id)
        if p is None:
            raise PermissionError(f"unknown principal {principal_id!r}")
        return Principal(id=principal_id, tenant_id=p["tenant_id"], roles=tuple(p.get("roles", [])))

    def _entry(self, principal: Principal) -> Optional[dict]:
        e = self.doc.principals.get(principal.id)
        if e is None or e["tenant_id"] != principal.tenant_id:
            return None
        return e

    def evaluate_dispatch(self, principal: Principal, tenant_id: str, capability: str, ceiling: list[str],
                          business_unit: Optional[str]) -> Decision:
        e = self._entry(principal)
        if e is None:
            return Decision("INDETERMINATE", ["principal not found in current policy"])
        reasons = []
        if principal.tenant_id != tenant_id:
            reasons.append("cross-tenant dispatch")
        if capability not in ceiling:
            reasons.append(f"capability {capability} outside package ceiling")
        if capability not in e.get("capabilities", []):
            reasons.append(f"principal lacks capability {capability}")
        if business_unit is None:
            return Decision("INDETERMINATE", reasons + ["business unit unknown"])
        if business_unit not in e.get("business_units", []):
            reasons.append(f"principal not scoped to business unit {business_unit}")
        return Decision("DENY", reasons) if reasons else Decision("ALLOW")

    def requires_approval(self, capability: str) -> bool:
        return capability in self.doc.approval_required_capabilities

    def can_approve(self, approver: Principal, initiator_id: str, tenant_id: str, required_role: str) -> Decision:
        e = self._entry(approver)
        if e is None:
            return Decision("INDETERMINATE", ["approver not found in current policy"])
        reasons = []
        if approver.tenant_id != tenant_id:
            reasons.append("approver from another tenant")
        role = required_role or self.doc.approver_role
        if role not in e.get("roles", []):
            reasons.append(f"approver lacks role {role}")
        if self.doc.separation_of_duties and approver.id == initiator_id:
            reasons.append("separation of duties: initiator cannot approve")
        return Decision("DENY", reasons) if reasons else Decision("ALLOW")

    # ---- administrative mutation (tests / demo); produces a new policy version ------------ #
    def revoke_capability(self, principal_id: str, capability: str) -> None:
        caps = self.doc.principals[principal_id].setdefault("capabilities", [])
        if capability in caps:
            caps.remove(capability)
        self.doc.policy_version = self.doc.policy_version.split("+")[0] + "+rev" + digest(self.doc.principals)[7:15]
