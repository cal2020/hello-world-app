/* Parity of HX.fakes with demo/fakes.py, tools/errors.py and models/base.py (golden/fakes.json). */
(function () {
  const FK = HX.fakes;
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const parse = (t) => HX.canonical.strict_loads(t);
  const G = () => golden("fakes");
  const errKey = (e) => e[0] + "\u0000" + JSON.stringify(e[1]);
  const sortErrs = (list) => list.map((e) => [e[0], e[1]]).sort((a, b) => (errKey(a) < errKey(b) ? -1 : errKey(a) > errKey(b) ? 1 : 0));

  function excName(e) {
    if (e instanceof HX.errors.ToolTimeout) return "ToolTimeout";
    if (e instanceof HX.errors.ToolFailure) return "ToolFailure";
    if (e instanceof HX.models.ModelUnavailable) return "ModelUnavailable";
    if (e instanceof HX.canonical.CanonicalError) return "CanonicalError";
    if (e instanceof FK.ValidationError) return "ValidationError";
    if (e instanceof HX.HXError) return e.code;
    return e.name;
  }

  /** Run fn and compare with a Python ``run()`` record. */
  function same(label, fn, py) {
    let got, err;
    try { got = fn(); } catch (e) { err = e; }
    if (py.exc === undefined) {
      assert.ok(!err, `${label}: unexpected ${err && excName(err)}: ${err && err.message}`);
      assert.deepEqual(plain(got), py.ok, label);
      return;
    }
    assert.ok(err, `${label}: expected ${py.exc} but got ${JSON.stringify(got)}`);
    assert.equal(excName(err), py.exc, `${label}: ${err.message}`);
    if (["ToolTimeout", "ToolFailure", "ModelUnavailable", "KeyError"].indexOf(py.exc) >= 0) {
      assert.equal(err.message, py.message, `${label}: message`);
    }
    if (py.exc === "ValidationError") assert.deepEqual(sortErrs(err.errors.map((e) => [e.type, e.loc])), sortErrs(py.errors), label);
  }

  test("constants: DEFAULT_DOCUMENTS, DEFAULT_REGISTRY ('tenant|ref' keys), SANCTIONED, model ids", () => {
    const g = G();
    assert.deepEqual(FK.DEFAULT_DOCUMENTS, g.DEFAULT_DOCUMENTS);
    assert.deepEqual(FK.DEFAULT_REGISTRY, g.DEFAULT_REGISTRY);
    assert.deepEqual(FK.SANCTIONED, g.SANCTIONED);
    assert.equal(FK.FixtureExtractionModel.model_id, g.extractor_model_id);
    assert.equal(new FK.FixtureExtractionModel().model_id, g.extractor_model_id);
  });

  test("DocumentStore.read matches Python (tenant isolation, missing ids, malformed input)", () => {
    for (const c of G().documents) {
      const store = new FK.DocumentStore(c.docs === null ? undefined : c.docs);
      same(`read ${JSON.stringify(c.args)} ${JSON.stringify(c.ctx)}`, () => store.read(c.args, c.ctx), c.result);
    }
  });

  test("SupplierRegistry.lookup matches Python (new / compatible / conflict, Python == semantics)", () => {
    for (const c of G().registry) {
      const reg = new FK.SupplierRegistry(c.records === null ? undefined : c.records);
      same(`lookup ${JSON.stringify(c.args)} ${JSON.stringify(c.ctx)}`, () => reg.lookup(c.args, c.ctx), c.result);
    }
    const reg = new FK.SupplierRegistry([[["t", "R"], { business_unit: "B" }]]);
    assert.equal(reg.lookup({ supplier_ref: "R", business_unit: "B" }, { tenant_id: "t" }).status, "exists_compatible");
    assert.throws(() => new FK.SupplierRegistry({ nobar: {} }), TypeError);
  });

  test("validate_draft matches Python on 330+ drafts (emails, tax ids incl. trailing newlines, missing fields, sanctions, orphan links)", () => {
    const cases = G().validate;
    assert.ok(cases.length >= 330);
    for (const c of cases) same(`validate ${c.args_json}`, () => FK.validate_draft(parse(c.args_json), { tenant_id: "acme" }), c.result);
    const statuses = new Set(cases.filter((c) => c.result.ok).map((c) => c.result.ok.status));
    assert.deepEqual([...statuses].sort(), ["fail", "pass", "repairable"]);
  });

  test("verify_persisted and draft_digest match Python (receipt ids)", () => {
    for (const c of G().verify) same(`verify ${JSON.stringify(c.args)}`, () => FK.verify_persisted(c.args, c.ctx), c.result);
    for (const d of G().digests) assert.equal(FK.draft_digest(d.draft), d.digest);
  });

  test("FakeERP operation sequences with faults match Python (idempotency, D-%04d ids, reconcile scan order, calls)", () => {
    const g = G();
    const pool = (i) => JSON.parse(JSON.stringify(g.erp_args_pool[i]));
    for (const [n, c] of g.erp.entries()) {
      const erp = new FK.FakeERP();
      c.ops.forEach((op, i) => {
        const ctx = (t, k) => FK.ToolContext({ tenant_id: t, idempotency_key: k === undefined ? "k-1" : k, logical_action_id: "la-1" });
        const label = `seq ${n} op ${i} ${JSON.stringify(op)}`;
        const fn = {
          create: () => erp.create_draft(pool(op[3]), ctx(op[1], op[2])),
          inject: () => erp.inject(...op[1]),
          reconcile: () => erp.reconcile_create(pool(op[3]), ctx(op[1], op[2])),
          read: () => erp.read_draft({ draft_id: op[2] }, ctx(op[1])),
          modify: () => erp.modify_out_of_band(op[1], op[2], op[3]),
          tamper: () => erp.tamper_payload(op[1], op[2], op[3]),
          count: () => erp.count(op[1]),
        }[op[0]];
        same(label, fn, c.results[i]);
      });
      assert.deepEqual(erp.calls, c.calls, `seq ${n} calls`);
      assert.deepEqual(erp.faults, c.faults, `seq ${n} faults`);
      for (const t of Object.keys(c.counts)) assert.equal(erp.count(t), c.counts[t]);
    }
  });

  test("FakeERP: path-backed instances share rows (restart) while faults and calls are per instance", () => {
    FK.FakeERP.reset_storage("/tmp/test-erp.db");
    const a = new FK.FakeERP("/tmp/test-erp.db");
    const ctx = { tenant_id: "acme", idempotency_key: "k", logical_action_id: "l" };
    a.inject("read_unavailable");
    assert.deepEqual(a.create_draft({ draft: { a: 1 }, draft_digest: "d", supplier_ref: "S" }, ctx), { status: "created", draft_id: "D-0001", version: 1 });
    const b = new FK.FakeERP("/tmp/test-erp.db");
    assert.deepEqual(b.faults, []);
    assert.deepEqual(b.calls, []);
    assert.equal(b.count("acme"), 1);
    assert.equal(b.read_draft({ draft_id: "D-0001" }, ctx).status, "found");
    assert.equal(new FK.FakeERP().count("acme"), 0, ":memory: is private");
    const c = b.reopen();
    assert.notEqual(c, b);
    assert.equal(c.count("acme"), 1);
    const mem = new FK.FakeERP();
    assert.equal(mem.reopen(), mem);
    FK.FakeERP.reset_storage("/tmp/test-erp.db");
    assert.equal(new FK.FakeERP("/tmp/test-erp.db").count("acme"), 0);
  });

  test("FixtureExtractionModel: every mode (default, gullible, invalid_outputs, unavailable) matches Python", () => {
    for (const c of G().model) {
      const model = new FK.FixtureExtractionModel(c.mode);
      c.requests_json.forEach((t, i) => same(`${JSON.stringify(c.mode)} call ${i} ${t.slice(0, 80)}`, () => model.generate(parse(t)), c.results[i]));
      assert.equal(model.requests.length, c.n_requests);
      assert.equal(model.invalid_outputs, c.invalid_outputs_after);
      assert.ok(model.requests.every((r) => Array.isArray(r.labels) && typeof r.repair_feedback === "string"));
    }
    const m = new FK.FixtureExtractionModel();
    for (const c of G().model_malformed) same(`malformed ${c.request_json}`, () => m.generate(parse(c.request_json)), c.result);
  });

  test("ModelRequest / ModelResponse validation and output_schema_for match models/base.py", () => {
    for (const c of G().model_request) same(`ModelRequest ${JSON.stringify(c.input)}`, () => FK.ModelRequest.model_validate(c.input), c.result);
    for (const c of G().model_response) same(`ModelResponse ${JSON.stringify(c.input)}`, () => FK.ModelResponse.model_validate(c.input), c.result);
    for (const c of G().output_schema_for) {
      assert.deepEqual(plain(FK.output_schema_for(c.writes, c.var_schemas, c.labels)), c.result, JSON.stringify(c.writes));
    }
    assert.equal(HX.models.ModelRequest, FK.ModelRequest);
    assert.equal(HX.models.output_schema_for, FK.output_schema_for);
  });

  test("errors: ToolTimeout/ToolFailure on HX.errors and HX.fakes, ModelUnavailable on HX.models; str(exc) is .message", () => {
    assert.equal(FK.ToolTimeout, HX.errors.ToolTimeout);
    assert.equal(FK.ToolFailure, HX.errors.ToolFailure);
    assert.equal(FK.ModelUnavailable, HX.models.ModelUnavailable);
    const t = new HX.errors.ToolTimeout("timed out before commit");
    assert.ok(t instanceof HX.HXError && t instanceof Error);
    assert.equal(t.message, "timed out before commit");
    assert.equal(t.name, "ToolTimeout");
    assert.equal(new HX.errors.ToolFailure().message, "");
    assert.equal(new HX.models.ModelUnavailable("x").name, "ModelUnavailable");
  });

  test("inputs are never mutated: deep-frozen args, contexts, requests, documents (fakes, fixture, clauses)", () => {
    const freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
    const ctx = freeze({ tenant_id: "acme", idempotency_key: "k-1", logical_action_id: "la" });
    const docs = new FK.DocumentStore(freeze(JSON.parse(JSON.stringify(FK.DEFAULT_DOCUMENTS))));
    const read = docs.read(freeze({ document_ids: ["DOC-W9-10042", "DOC-FORM-10042"] }), ctx);
    new FK.SupplierRegistry(freeze({ "acme|R": { business_unit: "B" } })).lookup(freeze({ supplier_ref: "R", business_unit: "B" }), ctx);
    const model = new FK.FixtureExtractionModel({ gullible: true });
    const ext = model.generate(freeze({ kind: "model", state_id: "EXTRACT_DRAFT", prompt: "", output_schema: {},
      inputs: { documents: read.documents, supplier_ref: "SUP-1", business_unit: "BU" } }));
    const draft = freeze(ext.output.draft);
    const v = FK.validate_draft(freeze({ draft, required_fields: ["legal_name", "contact_email"] }), ctx);
    model.generate(freeze({ kind: "model", state_id: "REPAIR_DRAFT", prompt: "", output_schema: {},
      inputs: { draft, validation_issues: v.issues, documents: read.documents } }));
    const erp = new FK.FakeERP();
    const args = freeze({ draft, draft_digest: v.draft_digest, supplier_ref: "SUP-1" });
    const c = erp.create_draft(args, ctx);
    assert.deepEqual(erp.create_draft(args, ctx), { status: "existing", draft_id: c.draft_id, version: 1 });
    const rb = erp.read_draft(freeze({ draft_id: c.draft_id }), ctx);
    rb.draft.legal_name = "mutating the read result does not touch the ERP";
    assert.equal(erp.read_draft({ draft_id: c.draft_id }, ctx).draft.legal_name, draft.legal_name);
    erp.modify_out_of_band("acme", c.draft_id, freeze({ legal_name: "L" }));
    assert.equal(FK.verify_persisted(freeze({ draft_id: c.draft_id, persisted_version: 2,
      persisted_draft: freeze(erp.read_draft({ draft_id: c.draft_id }, ctx).draft), approved_digest: v.draft_digest }), ctx).status, "mismatch");
    new HX.fixture.FixtureCompilerModel().draft(freeze({}), freeze([{ code: "ORDERING_VIOLATION" }]), 1);
    HX.clauses.index_clauses(HX.data.skill_md);
  });

  test("python json.dumps formatting used for raw_text and token estimates", () => {
    const d = FK.py_json_dumps;
    assert.equal(d({ a: [1, 0.5, null, true], "\u00e9": "\u00e9\ud83d\ude00\n\"\\\u007f" }), '{"a": [1, 0.5, null, true], "\\u00e9": "\\u00e9\\ud83d\\ude00\\n\\"\\\\\\u007f"}');
    assert.equal(d({}), "{}");
    assert.equal(d([]), "[]");
    assert.equal(d({ b: 1, a: { d: 1, c: 2 } }, true), '{"a": {"c": 2, "d": 1}, "b": 1}');
    assert.equal(d(1e-7), "1e-07");
  });
})();
