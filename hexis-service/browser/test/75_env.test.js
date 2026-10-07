/* Runtime parity for HX.env (demo/env.py) and the coverage check for every runtime golden scenario. */
(function () {
  const RT = globalThis.RT_RUNTIME;

  RT.cover(["restart_while_waiting", "self_approval_refused"]);

  test("env: ManualClock, TASK, task(), make_seq_ids", () => {
    const c = new HX.env.ManualClock();
    assert.equal(c(), 1790000000.0);
    c.advance(0.25);
    assert.equal(c(), 1790000000.25);
    assert.ok(c instanceof HX.env.ManualClock && typeof c === "function");
    assert.deepEqual(JSON.parse(JSON.stringify(HX.env.TASK)), HX.data.task);
    const t = HX.env.task({ supplier_ref: "X" });
    assert.equal(t.supplier_ref, "X");
    t.document_ids.push("Y");
    assert.equal(HX.env.TASK.document_ids.length, 2);
    const ids = HX.env.make_seq_ids(1);
    assert.equal(ids(), "00000000000000010000000000000001");
    assert.equal(ids(), "00000000000000020000000000000002");
  });

  test("env: build_env wiring, restart semantics, keyword checks", () => {
    let n = 0;
    const clock = new HX.env.ManualClock(1790000000.25);
    const timer = () => ++n;
    const ids = HX.env.make_seq_ids(1);
    const env = HX.env.build_env("/env-test/state", { clock, timer, ids });
    assert.equal(env.store.path, "/env-test/state/hexis.db");
    assert.equal(env.erp.path, "/env-test/state/fake_erp.db");
    assert.equal(env.service.environment, "sandbox");
    assert.equal(env.service.lease_ttl, 300);
    assert.equal(env.broker.faults, env.faults);
    assert.equal(env.service.faults, env.faults);
    assert.equal(env.service.catalog, env.broker.catalog);
    assert.deepEqual(Object.keys(env.broker.connectors), ["documents.read", "supplier.lookup", "draft.validate",
      "erp.create_draft", "erp.read_draft", "draft.verify_persisted"]);
    assert.deepEqual(Object.keys(env.broker.reconcilers), ["erp.create_draft"]);
    assert.deepEqual(Object.keys(env.service.freshness), ["persisted_draft_matches_approved_payload"]);
    assert.equal(env.principal("user:alice").tenant_id, "acme");
    env.erp.inject("timeout_after_commit");
    const env2 = env.restart();
    assert.notEqual(env2.store, env.store);
    assert.notEqual(env2.erp, env.erp); /* path-backed ERP: a new instance over the same rows, like FakeERP(path) */
    assert.deepEqual(env2.erp.faults, []);
    assert.equal(env2.policy, env.policy);
    assert.equal(env2.clock, clock);
    assert.equal(env2.timer, timer);
    assert.equal(env2.ids, ids);
    assert.equal(env2.model, env.model);
    const m = new HX.fakes.FixtureExtractionModel({ unavailable: true });
    assert.equal(env.restart(m).model, m);
    const mem = HX.env.build_env({ clock, timer, ids });
    assert.equal(mem.store.path, ":memory:");
    assert.equal(mem.restart().erp, mem.erp); /* ":memory:" ERP: the same object */
    assert.throws(() => HX.env.build_env(null, { colck: clock }), (e) => e.code === "TypeError");
    HX.store.Store.reset_storage("/env-test/state/hexis.db");
    HX.fakes.FakeERP.reset_storage("/env-test/state/fake_erp.db");
  });

  test("env: load_catalog/load_policy are fresh copies; compile_procurement matches Python's hash", () => {
    const a = HX.env.load_catalog(), b = HX.env.load_catalog();
    a.tools["erp.create_draft"].effect = "non_idempotent_write";
    assert.equal(b.tools["erp.create_draft"].effect, "reconciliable_write");
    assert.equal(HX.catalog.digest(b), HX.data.python_build.catalog_digest);
    assert.equal(HX.env.load_policy().policy_version, HX.data.policy.policy_version);
    assert.equal(RT.pkgs().initial.artifact_hash, HX.data.python_build.initial_artifact_hash);
    assert.equal(RT.pkgs().refined.artifact_hash, HX.data.python_build.refined_artifact_hash);
  });

  test("runtime: every golden scenario is replayed by exactly one test", () => {
    const all = Array.from(RT.scenarios().keys());
    const missing = all.filter((n) => !RT.covered.has(n));
    assert.deepEqual(missing, []);
    assert.equal(RT.covered.size, all.length);
  });
})();
