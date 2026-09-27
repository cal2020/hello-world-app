"""Deterministic connectors for the procurement demonstration (fixture mode).

``FakeERP`` persists to a JSON file so a process restart does not lose remote
state. It honours idempotency keys, supports lookup by business reference for
reconciliation, and can inject ``timeout_after_commit`` (the draft is stored,
then the call raises ``ConnectorTimeout``). It is a simulation: it does not
establish compatibility with any real ERP.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from . import canonical


class ConnectorTimeout(Exception):
    """The call may or may not have taken effect."""


class ConnectorError(Exception):
    """Definite failure: the connector guarantees no effect."""


@dataclass
class CallContext:
    tenant_id: str
    principal_id: str
    idempotency_key: str
    business_reference: str
    expected_version: int | None = None


class FakeERP:
    def __init__(self, path: str):
        self.path = path
        self.faults: list[str] = []
        self.calls: list[dict] = []
        if not os.path.exists(path):
            self._save({"drafts": {}, "by_key": {}, "by_reference": {}, "seq": 0})

    def _load(self) -> dict:
        with open(self.path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def _save(self, data: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, self.path)

    def inject(self, fault: str) -> None:
        self.faults.append(fault)

    def create_draft(self, args: dict, ctx: CallContext) -> dict:
        self.calls.append({"op": "create_draft", "key": ctx.idempotency_key})
        data = self._load()
        if ctx.idempotency_key in data["by_key"]:
            ref = data["by_key"][ctx.idempotency_key]
            d = data["drafts"][ref]
            return {"status": "already_exists", "draft_ref": ref, "version": d["version"]}
        data["seq"] += 1
        ref = f"D-{data['seq']:03d}"
        fields = dict(args["draft"])
        if "persist_wrong_value" in self.faults:  # simulate a connector that stores a different value
            self.faults.remove("persist_wrong_value")
            fields["address"] = fields.get("address", "") + " (truncated"
        record = {"draft_ref": ref, "version": 1, "tenant_id": ctx.tenant_id, "business_unit": args["business_unit"],
                  "fields": {k: v for k, v in fields.items() if k != "source_refs"},
                  "payload_hash": canonical.digest({k: v for k, v in fields.items() if k != "source_refs"}),
                  "business_reference": ctx.business_reference}
        data["drafts"][ref] = record
        data["by_key"][ctx.idempotency_key] = ref
        data["by_reference"][ctx.business_reference] = ref
        self._save(data)
        if "timeout_after_commit" in self.faults:
            self.faults.remove("timeout_after_commit")
            raise ConnectorTimeout("ERP did not acknowledge within the deadline")
        return {"status": "created", "draft_ref": ref, "version": 1}

    def find_by_reference(self, business_reference: str, tenant_id: str) -> dict | None:
        data = self._load()
        ref = data["by_reference"].get(business_reference)
        if not ref or data["drafts"][ref]["tenant_id"] != tenant_id:
            return None
        d = data["drafts"][ref]
        return {"status": "already_exists", "draft_ref": ref, "version": d["version"]}

    def read_draft(self, args: dict, ctx: CallContext) -> dict:
        self.calls.append({"op": "read_draft"})
        if "read_unavailable" in self.faults:
            self.faults.remove("read_unavailable")
            return {"status": "unavailable", "record": {}}
        d = self._load()["drafts"].get(args["draft_ref"])
        if d is None or d["tenant_id"] != ctx.tenant_id:
            return {"status": "unavailable", "record": {}}
        return {"status": "available", "record": {k: d[k] for k in
                ("draft_ref", "version", "tenant_id", "business_unit", "fields", "payload_hash")}}

    def modify_out_of_band(self, draft_ref: str, field_name: str, value: Any) -> None:
        """Simulate someone editing the persisted draft after verification (A25)."""
        data = self._load()
        d = data["drafts"][draft_ref]
        d["fields"][field_name] = value
        d["version"] += 1
        d["payload_hash"] = canonical.digest(d["fields"])
        self._save(data)

    def count(self) -> int:
        return len(self._load()["drafts"])


class DocumentStore:
    def __init__(self, directory: str, tenant_scope: dict[str, list[str]] | None = None):
        self.directory = directory
        self.tenant_scope = tenant_scope or {}

    def read(self, args: dict, ctx: CallContext) -> dict:
        docs, missing = [], []
        allowed = self.tenant_scope.get(ctx.tenant_id)
        for ref in list(args["document_refs"]) + list(args["supplemental_refs"]):
            path = os.path.join(self.directory, ref["doc_id"] + ".txt")
            if (allowed is not None and ref["doc_id"] not in allowed) or not os.path.exists(path):
                missing.append(ref["doc_id"])
                continue
            with open(path, "rb") as fh:
                raw = fh.read()
            if canonical.sha256_hex(raw) != ref["sha256"]:
                missing.append(ref["doc_id"])  # hash mismatch is treated as not available
                continue
            docs.append({"doc_id": ref["doc_id"], "sha256": ref["sha256"], "content": raw.decode("utf-8")})
        if missing:
            return {"status": "missing", "documents": docs, "missing": missing}
        return {"status": "available", "documents": docs, "missing": []}


class SupplierMaster:
    def __init__(self, records: list[dict] | None = None):
        self.records = records or []

    def lookup(self, args: dict, ctx: CallContext) -> dict:
        for r in self.records:
            if r["tenant_id"] != ctx.tenant_id:
                continue
            if r["name"].lower() == args["supplier_name"].lower():
                status = "existing_in_scope" if r["business_unit"] == args["business_unit"] else "conflict"
                return {"status": status, "record": {k: r[k] for k in ("supplier_id", "name", "business_unit")}}
        return {"status": "new", "record": {}}


EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def make_validator(policy: dict) -> Callable[[dict, CallContext], dict]:
    """Deterministic draft validation: schema-like field checks, evidence coverage
    (every field cites a verbatim quote from a supplied document), and policy
    constraints (allowed countries, tenant business units)."""
    required = ["legal_name", "registration_number", "country", "address", "contact_email"]

    def validate(args: dict, ctx: CallContext) -> dict:
        draft, docs = args["draft"], {d["doc_id"]: d["content"] for d in args["documents"]}
        issues: list[dict] = []
        fatal = False
        if args["policy_version"] != policy["policy_version"]:
            issues.append({"field": "*", "code": "POLICY_VERSION", "message": "draft built for a different policy"})
            fatal = True
        units = policy["tenants"].get(ctx.tenant_id, {}).get("business_units", [])
        if args["business_unit"] not in units:
            issues.append({"field": "business_unit", "code": "SCOPE", "message": "business unit not in tenant scope"})
            fatal = True
        refs = {r["field"]: r for r in draft.get("source_refs", [])}
        for f in required:
            v = draft.get(f)
            if not isinstance(v, str) or not v.strip():
                issues.append({"field": f, "code": "MISSING", "message": "required field is empty"})
                continue
            ref = refs.get(f)
            if not ref or ref["doc_id"] not in docs or ref["quote"] not in docs[ref["doc_id"]]:
                issues.append({"field": f, "code": "UNSUPPORTED", "message": "no verbatim source quote for this field"})
        if isinstance(draft.get("country"), str) and draft["country"] not in policy["allowed_countries"]:
            issues.append({"field": "country", "code": "COUNTRY_CODE",
                           "message": f"country must be one of {policy['allowed_countries']} (ISO alpha-2)"})
        if isinstance(draft.get("contact_email"), str) and not EMAIL.match(draft["contact_email"]):
            issues.append({"field": "contact_email", "code": "EMAIL", "message": "invalid email address"})
        status = "fail" if fatal else ("repairable" if issues else "pass")
        return {"status": status, "issues": issues, "draft_digest": canonical.digest(draft)}

    return validate


def verify_persisted(args: dict, ctx: CallContext) -> dict:
    approved = {k: v for k, v in args["approved_draft"].items() if k != "source_refs"}
    rec = args["persisted"]
    mismatches = sorted(k for k in set(approved) | set(rec.get("fields", {}))
                        if approved.get(k) != rec.get("fields", {}).get(k))
    if rec.get("draft_ref") != args["draft_ref"]:
        mismatches.append("draft_ref")
    if rec.get("version") != args["draft_version"]:
        mismatches.append("version")
    if rec.get("tenant_id") != ctx.tenant_id:
        mismatches.append("tenant_id")
    if rec.get("payload_hash") != canonical.digest(approved):
        mismatches.append("payload_hash")
    return {"status": "mismatch" if mismatches else "match", "mismatch_fields": sorted(set(mismatches))}


@dataclass
class ConnectorSet:
    erp: FakeERP
    documents: DocumentStore
    suppliers: SupplierMaster
    validator: Callable[[dict, CallContext], dict]
    calls: list[str] = field(default_factory=list)

    def executor(self, tool: str) -> Callable[[dict, CallContext], dict]:
        table = {
            "documents.read": self.documents.read,
            "supplier.lookup": self.suppliers.lookup,
            "draft.validate": self.validator,
            "erp.create_draft": self.erp.create_draft,
            "erp.read_draft": self.erp.read_draft,
            "draft.verify_persisted": verify_persisted,
        }
        if tool not in table:
            raise ConnectorError(f"no registered executor for {tool}")
        fn = table[tool]

        def call(args: dict, ctx: CallContext) -> dict:
            self.calls.append(tool)
            return fn(args, ctx)

        return call
