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

  test("DocumentStore with malformed collections follows Python's .get / in / [] (messages too)", () => {
    const EXACT = ["AttributeError", "IndexError", "TypeError", "KeyError"];
    const check = (label, store, args, ctx, py) => {
      let got, err;
      try { got = store.read(args, ctx); } catch (e) { err = e; }
      if (py.exc === undefined) {
        assert.ok(!err, `${label}: unexpected ${err && excName(err)}: ${err && err.message}`);
        assert.deepEqual(plain(got), py.ok, label);
      } else {
        assert.ok(err, `${label}: expected ${py.exc}, got ${JSON.stringify(got)}`);
        assert.equal(excName(err), py.exc, `${label}: ${err.message}`);
        if (EXACT.indexOf(py.exc) >= 0) assert.equal(err.message, py.message, `${label}: message`);
      }
    };
    let malformed = 0;
    for (const c of G().documents) {
      if (c.docs === null || (HX.util.is_plain_object(c.docs) && Object.values(c.docs).every(HX.util.is_plain_object))) continue;
      malformed++;
      check(`read ${JSON.stringify(c.docs)} ${JSON.stringify(c.args)} ${JSON.stringify(c.ctx)}`, new FK.DocumentStore(c.docs), c.args, c.ctx, c.result);
    }
    assert.ok(malformed >= 30, `${malformed}`);
    for (const c of G().documents_escaped) {
      check(`read ${c.docs_json} ${c.args_json}`, new FK.DocumentStore(JSON.parse(c.docs_json)), JSON.parse(c.args_json),
        JSON.parse(c.ctx_json), JSON.parse(c.result_json));
    }
    /* the verifier's cases */
    const acme = { tenant_id: "acme" };
    assert.deepEqual(new FK.DocumentStore({ acme: ["x"] }).read({ document_ids: ["0"] }, acme), { status: "missing", documents: [], missing_ids: ["0"] });
    assert.throws(() => new FK.DocumentStore(["x"]).read({ document_ids: ["0"] }, { tenant_id: "0" }), (e) => e.code === "AttributeError");
    assert.throws(() => new FK.DocumentStore({ acme: "hello" }).read({ document_ids: ["ell"] }, acme), (e) => e.code === "TypeError");
  });

  test("FakeERP SQL parameter binding: ProgrammingError / OverflowError / UnicodeEncodeError / KeyError like sqlite3", () => {
    const EXACT = ["ProgrammingError", "OverflowError", "KeyError", "TypeError"];
    for (const c of G().erp_bind) {
      const erp = new FK.FakeERP();
      erp.create_draft({ draft: { n: 1 }, draft_digest: "d0", supplier_ref: "S0" }, { tenant_id: "acme", idempotency_key: "k-1" });
      const args = JSON.parse(c.args_json), ctx = JSON.parse(c.ctx_json), py = JSON.parse(c.result_json);
      const fn = {
        create: () => erp.create_draft(args, ctx), reconcile: () => erp.reconcile_create(args, ctx),
        read: () => erp.read_draft(args, ctx), count: () => erp.count(args),
        modify: () => erp.modify_out_of_band(...args), tamper: () => erp.tamper_payload(...args),
      }[c.op];
      const label = `${c.op} ${c.args_json} ${c.ctx_json}`;
      let got, err;
      try { got = fn(); } catch (e) { err = e; }
      if (c.js) {
        /* documented: Python stores floats (as SQLite text); the JS port refuses them and writes nothing */
        assert.ok(err && err.code === c.js, `${label}: expected ${c.js}`);
        assert.ok(py.exc === undefined, label);
        assert.equal(erp.count("acme"), 1, `${label}: rows`);
        continue;
      } else if (py.exc === undefined) {
        assert.ok(!err, `${label}: unexpected ${err && excName(err)}: ${err && err.message}`);
        assert.deepEqual(plain(got), py.ok, label);
      } else {
        assert.ok(err, `${label}: expected ${py.exc}`);
        assert.equal(excName(err), py.exc, `${label}: ${err.message}`);
        if (EXACT.indexOf(py.exc) >= 0) assert.equal(err.message, py.message, `${label}: message`);
      }
      assert.equal(erp.count("acme"), c.rows, `${label}: rows`);
    }
    /* integers the golden files cannot carry: Python's outcome vs the documented JS behavior */
    const big = G().erp_big_ints;
    const py = (k) => JSON.parse(big[k]);
    const A0 = () => ({ supplier_ref: "S", draft_digest: "d", draft: {} });
    const code = (fn) => { try { fn(); } catch (e) { return excName(e); } return "ok"; };
    assert.equal(py("tenant_2_64").exc, "OverflowError");
    assert.equal(code(() => new FK.FakeERP().create_draft(A0(), { tenant_id: 2 ** 64, idempotency_key: "k" })), "OverflowError");
    assert.equal(py("count_2_70").exc, "OverflowError");
    assert.equal(code(() => new FK.FakeERP().count(2 ** 70)), "OverflowError");
    /* Python accepts 64-bit integers beyond 2^53 (stored as text): the port refuses them (documented) */
    assert.equal(py("tenant_2_60").ok.status, "created");
    assert.equal(code(() => new FK.FakeERP().create_draft(A0(), { tenant_id: 2 ** 60, idempotency_key: "k" })), "InterfaceError");
    assert.equal(py("count_2_60").ok, 0);
    assert.equal(code(() => new FK.FakeERP().count(2 ** 60)), "InterfaceError");
    /* -2^63-1 is -2^63 as a JS number (a 64-bit value): Python OverflowError, JS InterfaceError, both refuse */
    assert.equal(py("tenant_neg_2_63_minus_1").exc, "OverflowError");
    assert.equal(code(() => new FK.FakeERP().create_draft(A0(), { tenant_id: -(2 ** 63) - 1, idempotency_key: "k" })), "InterfaceError");
    /* unsafe integers anywhere in the arguments fail the argument digest first (canonical deviation) */
    assert.equal(py("supplier_2_70").exc, "OverflowError");
    assert.equal(code(() => new FK.FakeERP().create_draft(Object.assign(A0(), { supplier_ref: 2 ** 70 }), { tenant_id: "a", idempotency_key: "k" })), "CanonicalError");
    assert.equal(py("draft_2_60").ok.status, "created");
    assert.equal(code(() => new FK.FakeERP().create_draft(Object.assign(A0(), { draft: { n: 2 ** 60 } }), { tenant_id: "a", idempotency_key: "k" })), "CanonicalError");
  });

  test("SupplierRegistry.lookup matches Python (new / compatible / conflict, Python == semantics)", () => {
    for (const c of G().registry) {
      /* records === null is Python's default (None); constructor errors (dict() of a non-mapping) count too */
      same(`lookup ${JSON.stringify(c.records)} ${JSON.stringify(c.args)} ${JSON.stringify(c.ctx)}`,
        () => new FK.SupplierRegistry(c.records === null ? undefined : c.records).lookup(c.args, c.ctx), c.result);
      if (c.result.exc && ["TypeError", "ValueError"].indexOf(c.result.exc) >= 0 && c.records !== null && typeof c.records !== "object") {
        assert.throws(() => new FK.SupplierRegistry(c.records), (e) => e.code === c.result.exc && e.message === c.result.message);
      }
    }
    const reg = new FK.SupplierRegistry([[["t", "R"], { business_unit: "B" }]]);
    assert.equal(reg.lookup({ supplier_ref: "R", business_unit: "B" }, { tenant_id: "t" }).status, "exists_compatible");
    /* Python's dict() accepts any hashable key; one that is not a (tenant, ref) pair never matches */
    assert.equal(new FK.SupplierRegistry({ nobar: { business_unit: "B" } }).lookup({ supplier_ref: "SUP-1", business_unit: "B" },
      { tenant_id: "acme" }).status, "new");
    assert.throws(() => new FK.SupplierRegistry([[{ x: 1 }, 1]]), (e) => e.code === "TypeError" && /unhashable/.test(e.message));
  });

  test("documented (models.md): integer-like free-form keys reorder validate_draft issues, which changes downstream digests", () => {
    const out = FK.validate_draft({ draft: { legal_name: "A", source_links: { ghost: "D1", 12: "D1" } }, required_fields: [] }, {});
    /* Python (insertion order ghost, 12): fields ['ghost', '12'],
       digest sha256:54432b63c93e47c9390b526ebb25b8c8cd6fd19806f5b01a27becdba8f076ca2. JS iterates '12' first, which is
       exactly Python's result for the input {'12': 'D1', 'ghost': 'D1'}. */
    assert.deepEqual(out.issues.map((i) => i.field), ["12", "ghost"]);
    assert.equal(HX.canonical.digest(out), "sha256:59dee1cd88f7e595043c14efb6af6ae1b715a53cbd319c94dade7a9727fc5e02");
    assert.notEqual(HX.canonical.digest(out), "sha256:54432b63c93e47c9390b526ebb25b8c8cd6fd19806f5b01a27becdba8f076ca2");
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
    /* documented (models.md): dict([[1, 2]]) has an int key, which a JS object cannot hold; Python returns {1: 2} */
    assert.throws(() => FK._py_dict([[1, 2]]), (e) => e.code === "TypeError");
    assert.deepEqual(FK._py_dict(""), {});
    assert.throws(() => FK._py_dict("ab"), (e) => e.code === "ValueError" && /element #0 has length 1/.test(e.message));
  });

  test("FixtureExtractionModel arguments: Python truthiness, n > 0 comparison, keyword/positional forms", () => {
    const g = G();
    assert.ok(g.model_args.length >= 12);
    for (const c of g.model_args) {
      const label = c.kwargs === null ? `positional ${JSON.stringify(c.positional)}` : `kwargs ${JSON.stringify(c.kwargs)}`;
      same(label, () => {
        const m = c.kwargs === null ? new FK.FixtureExtractionModel(c.positional) : new FK.FixtureExtractionModel(c.kwargs);
        const calls = [0, 1, 2].map(() => {
          try { return { ok: plain(m.generate(JSON.parse(JSON.stringify(g.model_args_request)))) }; } catch (e) {
            return { exc: excName(e), message: e.message };
          }
        });
        /* compare exception classes (and ModelUnavailable messages) like same() does */
        return { calls: calls.map((x) => (x.exc === undefined || x.exc === "ModelUnavailable" ? x : { exc: x.exc })),
          invalid_outputs_after: m.invalid_outputs, n_requests: m.requests.length };
      }, c.result.exc ? c.result : { ok: Object.assign({}, c.result.ok, {
        calls: c.result.ok.calls.map((x) => (x.exc === undefined || x.exc === "ModelUnavailable" ? x : { exc: x.exc })) }) });
    }
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
