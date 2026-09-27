"""MachinePackage (``hexis-production-package/1``), tool catalog, hashing, admission signatures.

The package wraps an unmodified ``efsm-v1`` machine and carries the production
extension contracts separately, so the machine stays upstream-shaped.

Hash payload (``artifact_hash``) = canonical JSON of
``{package_schema, machine, source_manifest, compiler_manifest, tool_catalog,
contracts, execution_policy}``. Excluded: ``artifact_hash`` itself,
``lineage``, ``validation_manifest`` and ``admission`` (they refer back to the
hash). An admission record binds the hash to the validation report and is
signed; the signature is a local HMAC for development, labelled as such.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import os
from dataclasses import dataclass

from . import canonical
from .machine import Machine, parse_machine

PACKAGE_SCHEMA = "hexis-production-package/1"
HASHED_FIELDS = ("package_schema", "machine", "source_manifest", "compiler_manifest", "tool_catalog",
                 "contracts", "execution_policy")
REQUIRED_FIELDS = set(HASHED_FIELDS) | {"artifact_hash", "lineage", "validation_manifest", "admission"}
EFFECT_CLASSES = {"read", "pure", "idempotent_write", "reconcilable_write", "non_idempotent_write"}
WRITE_EFFECTS = {"idempotent_write", "reconcilable_write", "non_idempotent_write"}
OWNERS = {"model", "tool", "user", "engine", "task"}
LIFECYCLE = ("draft", "validated", "admitted", "active", "revoked")


class PackageError(ValueError):
    pass


@dataclass(frozen=True)
class ToolSpec:
    name: str
    version: str
    effect: str
    capability: str
    input_schema: dict
    output_schema: dict
    verifier: bool = False
    business_reference: str = ""

    @property
    def is_write(self) -> bool:
        return self.effect in WRITE_EFFECTS


def parse_catalog(obj: dict) -> dict[str, ToolSpec]:
    if not isinstance(obj, dict) or not isinstance(obj.get("tools"), dict):
        raise PackageError("tool catalog must be an object with a 'tools' map")
    out = {}
    for name, t in obj["tools"].items():
        if t.get("effect") not in EFFECT_CLASSES:
            raise PackageError(f"tool {name}: unknown effect class {t.get('effect')!r}")
        for key in ("version", "capability", "input_schema", "output_schema"):
            if key not in t:
                raise PackageError(f"tool {name}: missing {key}")
        out[name] = ToolSpec(name=name, version=t["version"], effect=t["effect"], capability=t["capability"],
                             input_schema=t["input_schema"], output_schema=t["output_schema"],
                             verifier=bool(t.get("verifier", False)),
                             business_reference=t.get("business_reference", ""))
    return out


def hash_payload(pkg: dict) -> dict:
    return {k: pkg[k] for k in HASHED_FIELDS}


def compute_hash(pkg: dict) -> str:
    return canonical.digest(hash_payload(pkg))


def build_package(machine: dict, source_manifest: dict, compiler_manifest: dict, tool_catalog: dict,
                  contracts: dict, execution_policy: dict, lineage: dict | None = None,
                  validation_manifest: dict | None = None) -> dict:
    pkg = {
        "package_schema": PACKAGE_SCHEMA,
        "machine": copy.deepcopy(machine),
        "source_manifest": copy.deepcopy(source_manifest),
        "compiler_manifest": copy.deepcopy(compiler_manifest),
        "tool_catalog": copy.deepcopy(tool_catalog),
        "contracts": copy.deepcopy(contracts),
        "execution_policy": copy.deepcopy(execution_policy),
        "lineage": copy.deepcopy(lineage or {"parent_hash": None, "changes": [], "trace_ids": []}),
        "validation_manifest": copy.deepcopy(validation_manifest or {}),
        "admission": None,
    }
    pkg["artifact_hash"] = compute_hash(pkg)
    return pkg


@dataclass
class LoadedPackage:
    raw: dict
    machine: Machine
    catalog: dict[str, ToolSpec]

    @property
    def artifact_hash(self) -> str:
        return self.raw["artifact_hash"]

    @property
    def contracts(self) -> dict:
        return self.raw["contracts"]

    @property
    def policy(self) -> dict:
        return self.raw["execution_policy"]

    def owner(self, var: str) -> str | None:
        v = self.contracts.get("variables", {}).get(var)
        return v.get("owner") if v else None

    def var_schema(self, var: str) -> dict:
        v = self.contracts.get("variables", {}).get(var, {})
        if "schema" in v:
            return v["schema"]
        mv = self.machine.var(var)
        return {"type": mv.type} if mv else {}

    def enums(self) -> dict[str, list]:
        """Finite domains used by guard analysis: only enums the runtime actually enforces
        (the variable's validation schema), never an unenforced annotation."""
        out = {}
        for v in self.machine.variables:
            schema = self.var_schema(v.name)
            if isinstance(schema.get("enum"), list):
                out[v.name] = list(schema["enum"])
        return out

    def var_types(self) -> dict[str, str]:
        return {v.name: v.type for v in self.machine.variables}


def load_package(obj: dict, verify_hash: bool = True) -> LoadedPackage:
    if not isinstance(obj, dict):
        raise PackageError("package must be a JSON object")
    if obj.get("package_schema") != PACKAGE_SCHEMA:
        raise PackageError(f"unsupported package_schema {obj.get('package_schema')!r}")
    missing = REQUIRED_FIELDS - set(obj)
    if missing:
        raise PackageError(f"package missing field(s) {sorted(missing)}")
    extra = set(obj) - REQUIRED_FIELDS
    if extra:
        raise PackageError(f"package has unknown field(s) {sorted(extra)}")
    if verify_hash and compute_hash(obj) != obj["artifact_hash"]:
        raise PackageError("artifact_hash does not match package contents (tampered or stale)")
    return LoadedPackage(raw=obj, machine=parse_machine(obj["machine"]), catalog=parse_catalog(obj["tool_catalog"]))


# ------------------------------------------------------------ admission ---
def _key() -> bytes:
    key = os.environ.get("HEXIS_ADMISSION_KEY")
    if key:
        return key.encode("utf-8")
    # Development-only fallback key. Labelled in every record as dev-hmac.
    return b"hexis-local-development-admission-key"


def sign_admission(record: dict) -> dict:
    body = {k: v for k, v in record.items() if k not in ("signature", "key_id")}
    sig = hmac.new(_key(), canonical.canonical_bytes(body), hashlib.sha256).hexdigest()
    key_id = "env:HEXIS_ADMISSION_KEY" if os.environ.get("HEXIS_ADMISSION_KEY") else "dev-hmac:local"
    return {**body, "signature": sig, "key_id": key_id}


def verify_admission(record: dict) -> bool:
    if not record or "signature" not in record:
        return False
    body = {k: v for k, v in record.items() if k not in ("signature", "key_id")}
    expected = hmac.new(_key(), canonical.canonical_bytes(body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, record["signature"])
