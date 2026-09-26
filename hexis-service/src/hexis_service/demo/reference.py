"""Reference traces and fixture aligners for the refinement demonstration.

FIXTURE MODE: the reference executor replays a scripted, operator-style execution against the fake
connectors to produce development traces (as an external trace adapter would). The aligners are
deterministic stand-ins for an alignment model; their proposals still pass through independent
operation validation and every gate.
"""

from __future__ import annotations

from typing import Any

from ..traces.model import Record, Trace
from . import fakes
from .env import TASK

TOOL_WRITES = {
    "documents.read": ["docs_status", "documents", "missing_document_ids"],
    "supplier.lookup": ["lookup_status", "existing_supplier"],
    "draft.validate": ["validation_status", "validation_issues", "draft_digest"],
    "erp.create_draft": ["persist_status", "erp_draft_id", "erp_version"],
    "erp.read_draft": ["readback_status", "persisted_draft", "persisted_version"],
    "draft.verify_persisted": ["verify_status", "verification_receipt"],
}


class ReferenceExecutor:
    def __init__(self, tenant: str = "acme"):
        self.ctx = fakes.ToolContext(tenant_id=tenant, idempotency_key="", logical_action_id="")
        self.docs, self.reg, self.erp = fakes.DocumentStore(), fakes.SupplierRegistry(), fakes.FakeERP()
        self.model = fakes.FixtureExtractionModel()
        self.records: list[Record] = []
        self.last: dict[str, Any] = {}

    def _rec(self, action: dict, output: dict, **meta: Any) -> dict:
        self.records.append(Record(step=len(self.records), action=action, output=output, meta=meta))
        return output

    def tool(self, name: str, args: dict) -> dict:
        self.ctx["idempotency_key"] = f"ref-{len(self.records)}"
        self.ctx["logical_action_id"] = f"ref-la-{len(self.records)}"
        fn = {"documents.read": self.docs.read, "supplier.lookup": self.reg.lookup,
              "draft.validate": fakes.validate_draft, "erp.create_draft": self.erp.create_draft,
              "erp.read_draft": self.erp.read_draft, "draft.verify_persisted": fakes.verify_persisted}[name]
        out = fn(args, self.ctx)
        self.last[name] = out
        return self._rec({"kind": "tool", "name": name, "input": args}, out, writes=TOOL_WRITES[name],
                         logical_action_id=self.ctx["logical_action_id"])

    def model_step(self, state: str, inputs: dict) -> dict:
        from ..models.base import ModelRequest
        out = self.model.generate(ModelRequest(kind="model", state_id=state, prompt="", inputs=inputs,
                                               output_schema={})).output
        return self._rec({"kind": "model"}, out, writes=list(out), observable=False)

    def user(self, typ: str, output: dict) -> dict:
        return self._rec({"kind": "user"}, output, writes=list(output), interaction_type=typ)

    def end(self, terminal: str) -> None:
        self._rec({"kind": "end", "terminal": terminal}, {})

    def happy_tail(self, draft: dict, digest_: str, ref: str) -> None:
        c = self.tool("erp.create_draft", {"draft": draft, "draft_digest": digest_, "supplier_ref": ref})
        rb = self.tool("erp.read_draft", {"draft_id": c["draft_id"]})
        v = self.tool("draft.verify_persisted", {"draft_id": c["draft_id"], "persisted_version": rb["version"],
                                                 "persisted_draft": rb["draft"], "approved_digest": digest_})
        self.end("END_VERIFIED_DRAFT" if v["status"] == "match" else "END_UNVERIFIED")

    def trace(self, trace_id: str, task_input: dict, verdict: str = "accepted") -> Trace:
        return Trace(trace_id=trace_id, task={"task_id": trace_id, "input": task_input}, verdict=verdict,
                     source="reference-execution (fixture)", tenant_id=self.ctx["tenant_id"],
                     records=self.records).seal()


def missing_docs_trace() -> Trace:
    """Documents missing → requester supplies them once → normal verified path."""
    task = dict(TASK, supplier_ref="SUP-40002", document_ids=["DOC-LATE-MISSING"])
    x = ReferenceExecutor()
    x.tool("documents.read", {"document_ids": task["document_ids"]})
    x.user("input", {"document_ids": ["DOC-LATE-40002"]})
    d = x.tool("documents.read", {"document_ids": ["DOC-LATE-40002"]})
    lk = x.tool("supplier.lookup", {"supplier_ref": task["supplier_ref"], "business_unit": task["business_unit"]})
    draft = x.model_step("EXTRACT_DRAFT", {"documents": d["documents"], "supplier_ref": task["supplier_ref"],
                                           "business_unit": task["business_unit"],
                                           "required_fields": task["required_fields"],
                                           "existing_supplier": lk["existing"]})["draft"]
    v = x.tool("draft.validate", {"draft": draft, "required_fields": task["required_fields"],
                                  "policy_version": task["policy_version"]})
    x.user("approval", {"approval_decision": "approved"})
    x.happy_tail(draft, v["draft_digest"], task["supplier_ref"])
    return x.trace("dev:missing-docs-then-supplied", task)


def shortcut_trace() -> Trace:
    """Repairs the draft and goes straight to approval without re-validating (a shortcut)."""
    task = dict(TASK)
    x = ReferenceExecutor()
    d = x.tool("documents.read", {"document_ids": task["document_ids"]})
    lk = x.tool("supplier.lookup", {"supplier_ref": task["supplier_ref"], "business_unit": task["business_unit"]})
    draft = x.model_step("EXTRACT_DRAFT", {"documents": d["documents"], "supplier_ref": task["supplier_ref"],
                                           "business_unit": task["business_unit"],
                                           "required_fields": task["required_fields"],
                                           "existing_supplier": lk["existing"]})["draft"]
    v = x.tool("draft.validate", {"draft": draft, "required_fields": task["required_fields"],
                                  "policy_version": task["policy_version"]})
    draft = x.model_step("REPAIR_DRAFT", {"draft": draft, "validation_issues": v["issues"],
                                          "documents": d["documents"]})["draft"]
    x.user("approval", {"approval_decision": "approved"})
    x.happy_tail(draft, fakes.draft_digest(draft), task["supplier_ref"])
    return x.trace("dev:repair-then-approve-without-revalidation", task)


def forbidden_write_trace() -> Trace:
    """Correct final answer reached through a forbidden action: ERP write without approval."""
    task = dict(TASK, supplier_ref="SUP-20077", document_ids=["DOC-W9-20077"])
    x = ReferenceExecutor()
    d = x.tool("documents.read", {"document_ids": task["document_ids"]})
    lk = x.tool("supplier.lookup", {"supplier_ref": task["supplier_ref"], "business_unit": task["business_unit"]})
    draft = x.model_step("EXTRACT_DRAFT", {"documents": d["documents"], "supplier_ref": task["supplier_ref"],
                                           "business_unit": task["business_unit"],
                                           "required_fields": task["required_fields"],
                                           "existing_supplier": lk["existing"]})["draft"]
    v = x.tool("draft.validate", {"draft": draft, "required_fields": task["required_fields"],
                                  "policy_version": task["policy_version"]})
    x.happy_tail(draft, v["draft_digest"], task["supplier_ref"])
    return x.trace("dev:write-without-approval", task)


def duplicate_write_trace() -> Trace:
    """Two distinct ERP writes by the same tool/phase (A16): normalization must keep both."""
    x = ReferenceExecutor()
    for ref, dig in (("SUP-1", "sha256:a"), ("SUP-2", "sha256:b")):
        x.tool("erp.create_draft", {"draft": {"legal_name": ref}, "draft_digest": dig, "supplier_ref": ref})
    x.end("END_UNVERIFIED")
    return x.trace("dev:two-distinct-writes", dict(TASK), verdict="unknown")


# --------------------------------------------------------------------------- #
REQUEST_INPUT_OPS = [
    {"op": "add_variable", "rationale": "bound the request-input loop (S1.2 'request them ... once')",
     "variable": {"name": "input_requests", "type": "integer", "init": 0, "init_from": None},
     "contract": {"owner": "engine", "schema": {"type": "integer", "minimum": 0}}},
    {"op": "add_state", "clause": "S1.2", "rationale": "trace event 1 is an authenticated input response supplying "
                                                      "document_ids after documents.read reported missing",
     "state": {"id": "REQUEST_INPUT", "clause": "S1.2",
               "action": {"kind": "user", "prompt": "Some intake documents are missing. Provide replacement "
                                                    "document ids.", "reads": ["missing_document_ids"],
                          "writes": ["document_ids"]},
               "transitions": [{"if": "", "to": "READ_INTAKE", "inc": None, "support": 1, "origin": "trace"}]},
     "interaction": {"type": "input", "response_schema": {
         "type": "object", "additionalProperties": False, "required": ["document_ids"],
         "properties": {"document_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                                         "maxItems": 20}}}}},
    {"op": "add_edge", "from": "READ_INTAKE", "position": 1, "event_index": 1,
     "rationale": "missing documents route to one input request before ending unverified",
     "edge": {"if": "docs_status == 'missing' and input_requests < 1", "to": "REQUEST_INPUT",
              "inc": "input_requests"}},
    {"op": "match", "event_index": 0, "state": "READ_INTAKE"},
    {"op": "match", "event_index": 1, "state": "REQUEST_INPUT"},
    {"op": "match", "event_index": 2, "state": "READ_INTAKE"},
    {"op": "set_coverage", "clause": "S1.2",
     "coverage": {"classification": "executable_control", "justification": "REQUEST_INPUT loop bounded by "
                  "input_requests < 1; second miss ends unverified.", "states": ["READ_INTAKE", "REQUEST_INPUT"],
                  "critical": False}},
]


class FixtureAligner:
    model_id = "fixture:aligner/1"

    def propose(self, context: dict) -> list[dict]:
        has_input = any(e["kind"] == "user" and "document_ids" in e["outputs"] for e in context["events"])
        if has_input and "REQUEST_INPUT" not in context["machine"]["states"]:
            return [dict(o) for o in REQUEST_INPUT_OPS]
        return []


class ShortcutAligner:
    """Proposes the shortcut an unconstrained aligner might learn: repair → approval."""

    model_id = "fixture:shortcut-aligner/1"

    def propose(self, context: dict) -> list[dict]:
        return [{"op": "retarget_edge", "from": "REPAIR_DRAFT", "index": 0, "to": "REQUEST_APPROVAL",
                 "rationale": "trace went from repair directly to approval"}]


class BreakingAligner:
    """Fits the new trace but also retargets the registry-conflict path (breaks a protected trace)."""

    model_id = "fixture:breaking-aligner/1"

    def propose(self, context: dict) -> list[dict]:
        return [dict(o) for o in REQUEST_INPUT_OPS] + [
            {"op": "retarget_edge", "from": "LOOKUP_SUPPLIER", "index": 1, "to": "END_UNVERIFIED",
             "rationale": "simplify: conflicts end unverified"}]


class MismatchAligner:
    """Claims a semantic match between incompatible event and state (must be rejected)."""

    model_id = "fixture:mismatch-aligner/1"

    def propose(self, context: dict) -> list[dict]:
        return [{"op": "match", "event_index": 1, "state": "VALIDATE_DRAFT", "similarity": 0.99}]
