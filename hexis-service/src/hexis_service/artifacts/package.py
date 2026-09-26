"""``hexis-production-package/1``: the versioned wrapper around an ``efsm-v1`` machine.

Hash payload (explicit, see brief §6.2): ``package_schema``, ``machine``, ``source_manifest``,
``compiler_manifest``, ``contracts`` and ``execution_policy``. Excluded: ``artifact_hash`` itself,
``validation_manifest``, ``lineage`` and ``admission`` (records that refer back to the hash).
Admission records are signed separately and bind the hash to the validation report digest.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..canonical import digest
from .efsm import Machine

PACKAGE_SCHEMA = "hexis-production-package/1"
HASHED_FIELDS = ("package_schema", "machine", "source_manifest", "compiler_manifest", "contracts", "execution_policy")

Owner = Literal["model", "tool", "user", "engine", "task"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClauseRef(_Strict):
    id: str
    start: int
    end: int
    heading: str = ""
    text: str
    sha256: str


class SourceManifest(_Strict):
    skill_path: str = ""
    skill_sha256: str
    resources: dict[str, str] = Field(default_factory=dict)
    clauses: list[ClauseRef] = Field(default_factory=list)
    tool_catalog_sha256: str
    input_contract_sha256: str = ""
    deployment_policy_sha256: str = ""


class CompilerManifest(_Strict):
    compiler: str
    compiler_commit: str = "unknown"
    prompts_sha256: str = ""
    model_id: str
    model_settings: dict = Field(default_factory=dict)
    validator_version: str
    normalizer_version: str
    upstream_reference: str = "Worldbuilder013/HEXIS@96be2719ee79fc5071dc7eb2aeed816dc03aaa6c (format reference only)"


class VariableContract(_Strict):
    owner: Owner
    # JSON Schema (Draft 2020-12) for the value. Null is only valid if the schema allows it.
    schema_: dict = Field(default_factory=dict, alias="schema")
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class EvidenceRequirement(_Strict):
    claim: str
    verifier_tool: str
    # Variables whose current values form the subject of the claim; a later write to any invalidates.
    subject_vars: list[str]


class TerminalContract(_Strict):
    category: Literal["verified", "unverified", "fallback"]
    evidence: list[EvidenceRequirement] = Field(default_factory=list)
    verification_scope: str = ""


class OrderingRequirement(_Strict):
    """Every path to a state satisfying ``before`` must pass a state satisfying ``requires`` after
    the last write to any ``invalidated_by`` variable. Selectors: ``tool:<name>``, ``state:<id>``,
    ``terminal:<id>``, ``user:<interaction type>``."""

    id: str
    requires: list[str]
    before: str
    invalidated_by: list[str] = Field(default_factory=list)
    clause: str = ""


class InteractionContract(_Strict):
    type: Literal["input", "approval"]
    # For approvals: the tool state whose exact action this approval authorizes.
    approves_state: str = ""
    response_schema: dict = Field(default_factory=dict)
    required_role: str = ""


class ClauseCoverage(_Strict):
    classification: Literal["executable_control", "state_local_knowledge", "external_precondition", "unsupported",
                            "non_material"]
    justification: str
    states: list[str] = Field(default_factory=list)
    critical: bool = False


class FieldScope(_Strict):
    """A model state may change only the object fields named by an issue list (e.g. repair)."""

    variable: str
    allowed_fields_from: str
    field_key: str = "field"


class Contracts(_Strict):
    variables: dict[str, VariableContract]
    field_scoped_writes: dict[str, FieldScope] = Field(default_factory=dict)
    task_input_schema: dict = Field(default_factory=dict)
    terminals: dict[str, TerminalContract]
    ordering: list[OrderingRequirement] = Field(default_factory=list)
    interactions: dict[str, InteractionContract] = Field(default_factory=dict)
    clause_coverage: dict[str, ClauseCoverage] = Field(default_factory=dict)
    # States deliberately unreachable (e.g. reserved fallback) with a reason.
    explained_unreachable: dict[str, str] = Field(default_factory=dict)


class Budgets(_Strict):
    max_steps: int = 64
    max_tool_calls: int = 32
    max_model_calls: int = 16
    max_tokens: int = 200_000
    max_elapsed_s: int = 7 * 24 * 3600
    max_spend_usd: Optional[float] = None


class ExecutionPolicy(_Strict):
    capability_ceiling: list[str]
    fallback_mode: Literal["stop_for_review", "sandbox_interpret"] = "stop_for_review"
    budgets: Budgets = Field(default_factory=Budgets)
    structured_output_repairs: int = 1
    transport_retries: int = 2
    approval_expiry_s: int = 24 * 3600
    # Operator-approved ceiling for learned loop bounds (the paper's ~1.5x heuristic is only a proposal).
    max_loop_bound: int = 3
    write_workflow: bool = True


class ValidationManifest(_Strict):
    profile: str = ""
    report_digest: str = ""
    passed: bool = False
    findings: list[dict] = Field(default_factory=list)
    replay_archive_digest: str = ""
    unresolved_limitations: list[str] = Field(default_factory=list)


class Lineage(_Strict):
    parent_hash: Optional[str] = None
    changes: list[dict] = Field(default_factory=list)
    trace_ids: list[str] = Field(default_factory=list)


class AdmissionRecord(_Strict):
    artifact_hash: str
    environment: str
    approver: str
    admitted_at: str
    validation_report_digest: str
    replay_archive_digest: str
    key_id: str
    signature: str = ""


class MachinePackage(_Strict):
    package_schema: Literal["hexis-production-package/1"] = PACKAGE_SCHEMA
    machine: Machine
    artifact_hash: str = ""
    source_manifest: SourceManifest
    compiler_manifest: CompilerManifest
    contracts: Contracts
    execution_policy: ExecutionPolicy
    validation_manifest: ValidationManifest = Field(default_factory=ValidationManifest)
    lineage: Lineage = Field(default_factory=Lineage)
    admission: Optional[AdmissionRecord] = None

    def hash_payload(self) -> dict:
        full = self.to_json()
        return {k: full[k] for k in HASHED_FIELDS}

    def compute_hash(self) -> str:
        return digest(self.hash_payload())

    def sealed(self) -> "MachinePackage":
        """Return a copy with ``artifact_hash`` set to the computed hash."""
        p = self.model_copy(deep=True)
        p.artifact_hash = p.compute_hash()
        return p

    def verify_hash(self) -> bool:
        return bool(self.artifact_hash) and self.artifact_hash == self.compute_hash()

    def to_json(self) -> dict:
        return self.model_dump(mode="json", by_alias=True)

    @classmethod
    def from_json(cls, data: dict) -> "MachinePackage":
        return cls.model_validate(data)


# --------------------------------------------------------------------------- #
# Admission signatures (HMAC-SHA256 development signer; see docs/LIMITATIONS.md)
# --------------------------------------------------------------------------- #
def _signing_payload(rec: AdmissionRecord) -> bytes:
    from ..canonical import canonical_bytes
    body = rec.model_dump(mode="json")
    body.pop("signature", None)
    return canonical_bytes(body)


def sign_admission(rec: AdmissionRecord, key: bytes) -> AdmissionRecord:
    sig = hmac.new(key, _signing_payload(rec), hashlib.sha256).hexdigest()
    return rec.model_copy(update={"signature": "hmac-sha256:" + sig})


def verify_admission(rec: AdmissionRecord, key: bytes) -> bool:
    expected = "hmac-sha256:" + hmac.new(key, _signing_payload(rec), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, rec.signature)


def package_digest_of(data: Any) -> str:
    return digest(data)
