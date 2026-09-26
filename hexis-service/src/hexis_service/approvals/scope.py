"""Approval scope binding (brief §12.1).

An approval binds: tenant, run, interaction, artifact hash, logical action id, tool/version,
canonical argument digest, target business reference, evidence versions, policy version, required
approver role and expiry. The broker recomputes the scope at dispatch; any difference -- changed
arguments, target, evidence, policy or artifact -- invalidates the approval.
"""

from __future__ import annotations

from ..canonical import digest, sha256_hex


def logical_action_id(run_id: str, state_id: str, revision: int, args_digest: str) -> str:
    return "la_" + sha256_hex(f"{run_id}|{state_id}|{revision}|{args_digest}")[:24]


def idempotency_key(tenant_id: str, lid: str) -> str:
    return "idem_" + sha256_hex(f"{tenant_id}|{lid}")[:32]


def approval_scope(*, tenant_id: str, run_id: str, interaction_id: str, artifact_hash: str, lid: str, tool: str,
                   tool_version: str, args_digest: str, business_reference: object, evidence: list[dict],
                   policy_version: str, required_role: str, expires_at: float) -> dict:
    return {"tenant_id": tenant_id, "run_id": run_id, "interaction_id": interaction_id, "artifact_hash": artifact_hash,
            "logical_action_id": lid, "tool": tool, "tool_version": tool_version, "args_digest": args_digest,
            "target": {"business_reference": business_reference}, "evidence": evidence,
            "policy_version": policy_version, "required_role": required_role, "expires_at": expires_at}


def scope_digest(scope: dict) -> str:
    return digest(scope)
