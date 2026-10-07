/* Parity for HX.reference (demo/reference.py) against golden/update.json from golden/gen_update.py. */
(function () {
  const U = globalThis.UPD;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  test("reference: anchor 2 - every reference trace's JSONL is byte-identical, digests and normalization match", () => {
    const g = golden("update").reference;
    const R = HX.reference;
    const built = { missing: R.missing_docs_trace(), shortcut: R.shortcut_trace(), forbidden: R.forbidden_write_trace(),
      duplicate: R.duplicate_write_trace() };
    assert.deepEqual(Object.keys(built).sort(), Object.keys(g).sort());
    for (const [n, t] of Object.entries(built)) {
      const w = g[n];
      assert.equal(t.trace_id, w.trace_id, n);
      assert.equal(HX.traces.to_jsonl(t), w.jsonl, n + " jsonl");
      assert.equal(HX.traces.records_digest(t), w.records_digest, n);
      assert.equal(HX.traces.header_digest(t), w.header_digest, n);
      assert.deepEqual(HX.traces.integrity_errors(t), w.integrity, n);
      const [ev, dropped] = HX.normalize.normalize(t);
      U.same(ev, w.events, n + " events");
      U.same(dropped, w.dropped, n + " dropped");
      /* loading Python's text gives the same trace, sealed */
      const [loaded, errs] = HX.traces.from_jsonl(w.jsonl);
      assert.deepEqual(errs, []);
      assert.equal(HX.traces.to_jsonl(loaded), w.jsonl);
      assert.equal(HX.canonical.canonical_text(HX.traces.model_dump(loaded)), HX.canonical.canonical_text(HX.traces.model_dump(t)));
    }
    /* deterministic: building again gives the same bytes (fresh fakes per executor) */
    assert.equal(HX.traces.to_jsonl(R.missing_docs_trace()), g.missing.jsonl);
  });

  test("reference: TOOL_WRITES, REQUEST_INPUT_OPS (with Python's key order), aligner ids and proposals", () => {
    const g = golden("update");
    const R = HX.reference;
    assert.deepEqual(R.TOOL_WRITES, g.tool_writes);
    /* key order matters: repr() of an operation appears in operation error messages */
    assert.equal(JSON.stringify(R.REQUEST_INPUT_OPS), JSON.stringify(U.loads(g.request_input_ops_json)));
    for (const [k, cls] of Object.entries(U.ALIGNERS)) {
      assert.equal(new cls().model_id, g.model_ids[k], k);
      if (k !== "variant") assert.equal(cls.model_id, g.model_ids[k], k);
      const F = U.fixtures();
      assert.equal(JSON.stringify(new cls().propose(U.fake_context(F.initial))), JSON.stringify(U.loads(g.aligner_outputs[k])), k);
      assert.equal(JSON.stringify(new cls().propose(U.fake_context(F.refined))),
        JSON.stringify(U.loads(g.aligner_outputs_refined[k])), k + " refined");
    }
    /* the fixture aligner proposes nothing without a document_ids input event */
    assert.deepEqual(new R.FixtureAligner().propose({ events: [{ kind: "tool", outputs: { document_ids: [] } }],
      machine: { states: {} } }), []);
    /* aligners return fresh top-level dicts (shallow copies, like Python's dict(o)) */
    const a = new R.FixtureAligner().propose(U.fake_context(U.fixtures().initial));
    assert.notEqual(a[0], R.REQUEST_INPUT_OPS[0]);
    assert.equal(a[0].variable, R.REQUEST_INPUT_OPS[0].variable);
  });

  test("reference: ReferenceExecutor records, tool context and ERP state", () => {
    const R = HX.reference;
    const x = new R.ReferenceExecutor();
    assert.deepEqual(x.ctx, { tenant_id: "acme", idempotency_key: "", logical_action_id: "" });
    const out = x.tool("documents.read", { document_ids: ["DOC-W9-10042"] });
    assert.equal(x.last["documents.read"], out);
    assert.deepEqual([x.ctx.idempotency_key, x.ctx.logical_action_id], ["ref-0", "ref-la-0"]);
    assert.deepEqual(x.records[0].meta, { writes: R.TOOL_WRITES["documents.read"], logical_action_id: "ref-la-0" });
    x.user("input", { document_ids: ["x"] });
    assert.deepEqual(x.records[1].meta, { writes: ["document_ids"], interaction_type: "input" });
    x.end("END_UNVERIFIED");
    assert.deepEqual(x.records[2].action, { kind: "end", terminal: "END_UNVERIFIED" });
    assert.throws(() => x.tool("erp.delete", {}), (e) => e.code === "KeyError");
    const t = x.trace("t:1", { a: 1 });
    assert.equal(t.verdict, "accepted");
    assert.equal(t.source, "reference-execution (fixture)");
    assert.deepEqual(HX.traces.integrity_errors(t), []);
    assert.equal(new R.ReferenceExecutor("globex").ctx.tenant_id, "globex");
    /* duplicate writes: two ERP rows, distinct logical action ids */
    const d = R.duplicate_write_trace();
    assert.deepEqual(d.records.map((r) => r.meta.logical_action_id || null), ["ref-la-0", "ref-la-1", null]);
    assert.equal(d.verdict, "unknown");
    assert.ok(hasOwn(d.task, "input"));
  });
})();
