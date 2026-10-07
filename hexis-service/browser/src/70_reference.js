/* Port of hexis_service/demo/reference.py: reference traces and fixture aligners for the refinement demonstration.
 *
 * FIXTURE MODE: the reference executor replays a scripted, operator-style execution against the fake connectors
 * (``HX.fakes``) to produce development traces (as an external trace adapter would). The aligners are
 * deterministic stand-ins for an alignment model; their proposals still pass through independent operation
 * validation and every gate (``HX.update``).
 *
 * API: TOOL_WRITES, new ReferenceExecutor(tenant = "acme") (``tool(name, args)``, ``model_step(state, inputs)``,
 * ``user(typ, output)``, ``end(terminal)``, ``happy_tail(draft, digest, ref)``, ``trace(trace_id, task_input,
 * verdict = "accepted")`` -> a sealed ``HX.traces`` trace), missing_docs_trace(), shortcut_trace(),
 * forbidden_write_trace(), duplicate_write_trace(), REQUEST_INPUT_OPS, and the aligners FixtureAligner,
 * ShortcutAligner, BreakingAligner, MismatchAligner (``new X().propose(context) -> ops``, ``model_id``).
 *
 * ``REQUEST_INPUT_OPS`` is a module-level list of plain objects shared like Python's (aligners return shallow
 * copies of its entries, so nested objects are shared); its key order is Python's, which matters for ``repr()`` in
 * operation error messages.
 */
(function (HX) {
  "use strict";
  const reference = (HX.reference = HX.reference || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const pyerr = (cls, msg) => HX.traces._pyerr(cls, msg);
  /** ``d[key]`` (KeyError when missing). */
  function item(d, key) {
    if (!hasOwn(d, key)) throw pyerr("KeyError", HX.traces._py_repr_msg(key));
    return d[key];
  }
  const shallow = (o) => {
    const out = {};
    for (const k of Object.keys(o)) HX.traces._set_own(out, k, o[k]);
    return out;
  };

  reference.TOOL_WRITES = {
    "documents.read": ["docs_status", "documents", "missing_document_ids"],
    "supplier.lookup": ["lookup_status", "existing_supplier"],
    "draft.validate": ["validation_status", "validation_issues", "draft_digest"],
    "erp.create_draft": ["persist_status", "erp_draft_id", "erp_version"],
    "erp.read_draft": ["readback_status", "persisted_draft", "persisted_version"],
    "draft.verify_persisted": ["verify_status", "verification_receipt"],
  };

  class ReferenceExecutor {
    constructor(tenant) {
      const F = HX.fakes;
      this.ctx = F.ToolContext({ tenant_id: tenant === undefined ? "acme" : tenant, idempotency_key: "",
        logical_action_id: "" });
      this.docs = new F.DocumentStore();
      this.reg = new F.SupplierRegistry();
      this.erp = new F.FakeERP();
      this.model = new F.FixtureExtractionModel();
      this.records = [];
      this.last = {};
    }

    _rec(action, output, meta) {
      this.records.push(HX.traces.new_record({ step: this.records.length, action, output, meta: meta || {} }));
      return output;
    }

    tool(name, args) {
      const F = HX.fakes;
      this.ctx.idempotency_key = "ref-" + this.records.length;
      this.ctx.logical_action_id = "ref-la-" + this.records.length;
      const fns = {
        "documents.read": (a, c) => this.docs.read(a, c),
        "supplier.lookup": (a, c) => this.reg.lookup(a, c),
        "draft.validate": (a, c) => F.validate_draft(a, c),
        "erp.create_draft": (a, c) => this.erp.create_draft(a, c),
        "erp.read_draft": (a, c) => this.erp.read_draft(a, c),
        "draft.verify_persisted": (a, c) => F.verify_persisted(a, c),
      };
      const fn = item(fns, name);
      const out = fn(args, this.ctx);
      HX.traces._set_own(this.last, name, out);
      return this._rec({ kind: "tool", name, input: args }, out,
        { writes: item(reference.TOOL_WRITES, name), logical_action_id: this.ctx.logical_action_id });
    }

    model_step(state, inputs) {
      const out = this.model.generate({ kind: "model", state_id: state, prompt: "", inputs, output_schema: {} }).output;
      return this._rec({ kind: "model" }, out, { writes: HX.traces._py_list(out), observable: false });
    }

    user(typ, output) {
      return this._rec({ kind: "user" }, output, { writes: HX.traces._py_list(output), interaction_type: typ });
    }

    end(terminal) {
      this._rec({ kind: "end", terminal }, {});
    }

    happy_tail(draft, digest_, ref) {
      const c = this.tool("erp.create_draft", { draft, draft_digest: digest_, supplier_ref: ref });
      const rb = this.tool("erp.read_draft", { draft_id: c.draft_id });
      const v = this.tool("draft.verify_persisted", { draft_id: c.draft_id, persisted_version: rb.version,
        persisted_draft: rb.draft, approved_digest: digest_ });
      this.end(v.status === "match" ? "END_VERIFIED_DRAFT" : "END_UNVERIFIED");
    }

    trace(trace_id, task_input, verdict) {
      return HX.traces.seal(HX.traces.new_trace({ trace_id, task: { task_id: trace_id, input: task_input },
        verdict: verdict === undefined ? "accepted" : verdict, source: "reference-execution (fixture)",
        tenant_id: this.ctx.tenant_id, records: this.records }));
    }
  }
  reference.ReferenceExecutor = ReferenceExecutor;

  function extract(x, task, d, lk) {
    return x.model_step("EXTRACT_DRAFT", { documents: d.documents, supplier_ref: task.supplier_ref,
      business_unit: task.business_unit, required_fields: task.required_fields, existing_supplier: lk.existing }).draft;
  }

  /** Documents missing -> requester supplies them once -> normal verified path. */
  reference.missing_docs_trace = function missing_docs_trace() {
    const task = HX.env.task({ supplier_ref: "SUP-40002", document_ids: ["DOC-LATE-MISSING"] });
    const x = new ReferenceExecutor();
    x.tool("documents.read", { document_ids: task.document_ids });
    x.user("input", { document_ids: ["DOC-LATE-40002"] });
    const d = x.tool("documents.read", { document_ids: ["DOC-LATE-40002"] });
    const lk = x.tool("supplier.lookup", { supplier_ref: task.supplier_ref, business_unit: task.business_unit });
    const draft = extract(x, task, d, lk);
    const v = x.tool("draft.validate", { draft, required_fields: task.required_fields, policy_version: task.policy_version });
    x.user("approval", { approval_decision: "approved" });
    x.happy_tail(draft, v.draft_digest, task.supplier_ref);
    return x.trace("dev:missing-docs-then-supplied", task);
  };

  /** Repairs the draft and goes straight to approval without re-validating (a shortcut). */
  reference.shortcut_trace = function shortcut_trace() {
    const task = HX.env.task();
    const x = new ReferenceExecutor();
    const d = x.tool("documents.read", { document_ids: task.document_ids });
    const lk = x.tool("supplier.lookup", { supplier_ref: task.supplier_ref, business_unit: task.business_unit });
    let draft = extract(x, task, d, lk);
    const v = x.tool("draft.validate", { draft, required_fields: task.required_fields, policy_version: task.policy_version });
    draft = x.model_step("REPAIR_DRAFT", { draft, validation_issues: v.issues, documents: d.documents }).draft;
    x.user("approval", { approval_decision: "approved" });
    x.happy_tail(draft, HX.fakes.draft_digest(draft), task.supplier_ref);
    return x.trace("dev:repair-then-approve-without-revalidation", task);
  };

  /** Correct final answer reached through a forbidden action: ERP write without approval. */
  reference.forbidden_write_trace = function forbidden_write_trace() {
    const task = HX.env.task({ supplier_ref: "SUP-20077", document_ids: ["DOC-W9-20077"] });
    const x = new ReferenceExecutor();
    const d = x.tool("documents.read", { document_ids: task.document_ids });
    const lk = x.tool("supplier.lookup", { supplier_ref: task.supplier_ref, business_unit: task.business_unit });
    const draft = extract(x, task, d, lk);
    const v = x.tool("draft.validate", { draft, required_fields: task.required_fields, policy_version: task.policy_version });
    x.happy_tail(draft, v.draft_digest, task.supplier_ref);
    return x.trace("dev:write-without-approval", task);
  };

  /** Two distinct ERP writes by the same tool/phase (A16): normalization must keep both. */
  reference.duplicate_write_trace = function duplicate_write_trace() {
    const x = new ReferenceExecutor();
    for (const [ref, dig] of [["SUP-1", "sha256:a"], ["SUP-2", "sha256:b"]]) {
      x.tool("erp.create_draft", { draft: { legal_name: ref }, draft_digest: dig, supplier_ref: ref });
    }
    x.end("END_UNVERIFIED");
    return x.trace("dev:two-distinct-writes", HX.env.task(), "unknown");
  };

  /* ------------------------------------------------------------------------------------------ */
  reference.REQUEST_INPUT_OPS = [
    { op: "add_variable", rationale: "bound the request-input loop (S1.2 'request them ... once')",
      variable: { name: "input_requests", type: "integer", init: 0, init_from: null },
      contract: { owner: "engine", schema: { type: "integer", minimum: 0 } } },
    { op: "add_state", clause: "S1.2", rationale: "trace event 1 is an authenticated input response supplying " +
                                                  "document_ids after documents.read reported missing",
      state: { id: "REQUEST_INPUT", clause: "S1.2",
        action: { kind: "user", prompt: "Some intake documents are missing. Provide replacement document ids.",
          reads: ["missing_document_ids"], writes: ["document_ids"] },
        transitions: [{ "if": "", to: "READ_INTAKE", inc: null, support: 1, origin: "trace" }] },
      interaction: { type: "input", response_schema: {
        type: "object", additionalProperties: false, required: ["document_ids"],
        properties: { document_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } } } } },
    { op: "add_edge", from: "READ_INTAKE", position: 1, event_index: 1,
      rationale: "missing documents route to one input request before ending unverified",
      edge: { "if": "docs_status == 'missing' and input_requests < 1", to: "REQUEST_INPUT", inc: "input_requests" } },
    { op: "match", event_index: 0, state: "READ_INTAKE" },
    { op: "match", event_index: 1, state: "REQUEST_INPUT" },
    { op: "match", event_index: 2, state: "READ_INTAKE" },
    { op: "set_coverage", clause: "S1.2",
      coverage: { classification: "executable_control", justification: "REQUEST_INPUT loop bounded by " +
                  "input_requests < 1; second miss ends unverified.", states: ["READ_INTAKE", "REQUEST_INPUT"],
                  critical: false } },
  ];

  class FixtureAligner {
    constructor() { this.model_id = FixtureAligner.model_id; }

    propose(context) {
      const T = HX.traces;
      const has_input = T._py_list(item(context, "events")).some((e) =>
        T._py_eq(item(e, "kind"), "user") && hasOwn(item(e, "outputs"), "document_ids"));
      if (has_input && !hasOwn(item(item(context, "machine"), "states"), "REQUEST_INPUT")) {
        return reference.REQUEST_INPUT_OPS.map(shallow);
      }
      return [];
    }
  }
  FixtureAligner.model_id = "fixture:aligner/1";
  reference.FixtureAligner = FixtureAligner;

  /** Proposes the shortcut an unconstrained aligner might learn: repair -> approval. */
  class ShortcutAligner {
    constructor() { this.model_id = ShortcutAligner.model_id; }

    propose(context) { // eslint-disable-line no-unused-vars
      return [{ op: "retarget_edge", from: "REPAIR_DRAFT", index: 0, to: "REQUEST_APPROVAL",
        rationale: "trace went from repair directly to approval" }];
    }
  }
  ShortcutAligner.model_id = "fixture:shortcut-aligner/1";
  reference.ShortcutAligner = ShortcutAligner;

  /** Fits the new trace but also retargets the registry-conflict path (breaks a protected trace). */
  class BreakingAligner {
    constructor() { this.model_id = BreakingAligner.model_id; }

    propose(context) { // eslint-disable-line no-unused-vars
      return reference.REQUEST_INPUT_OPS.map(shallow).concat([
        { op: "retarget_edge", from: "LOOKUP_SUPPLIER", index: 1, to: "END_UNVERIFIED",
          rationale: "simplify: conflicts end unverified" }]);
    }
  }
  BreakingAligner.model_id = "fixture:breaking-aligner/1";
  reference.BreakingAligner = BreakingAligner;

  /** Claims a semantic match between incompatible event and state (must be rejected). */
  class MismatchAligner {
    constructor() { this.model_id = MismatchAligner.model_id; }

    propose(context) { // eslint-disable-line no-unused-vars
      return [{ op: "match", event_index: 1, state: "VALIDATE_DRAFT", similarity: 0.99 }];
    }
  }
  MismatchAligner.model_id = "fixture:mismatch-aligner/1";
  reference.MismatchAligner = MismatchAligner;
})(globalThis.HX = globalThis.HX || {});
