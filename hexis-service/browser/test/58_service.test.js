/* Runtime parity for HX.service and HX.metrics: golden scenario transcripts (interpreter in 50_broker.test.js)
 * plus API-shape checks. */
(function () {
  const RT = globalThis.RT_RUNTIME;
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

  RT.cover(["happy_path", "approval_authentication", "non_idempotent_reconciling", "resolve_present",
    "resolve_absent_then_cancel", "resolve_retired_tool", "resolve_verifier_forbidden", "resolve_validator_forbidden",
    "cancel_races_write", "cancel_unresolvable", "cancel_while_waiting", "cancel_retired_tool", "cancel_proven_absent",
    "revoke_proven_absent", "retry_budget_exhausted", "A10_repairs_exhausted", "A20_policy_change", "A20_changed_args",
    "A20_altered_digest", "A21_revoked_capability", "A25_out_of_band", "A26_gullible", "A26_document_text",
    "cross_tenant", "A28_tamper", "A29_invalid_outputs", "invalid_output_repaired", "model_unavailable",
    "approval_expiry", "request_dedup", "freshness_rereads_after_crash", "freshness_never_deduplicated",
    "C18_second_run_same_draft", "C19_losing_response", "registry_conflict_review", "metrics_mixed", "metrics_priced",
    "metrics_float_sums", "metrics_integer_keys", "approval_integral_clock", "approval_default_clock",
    "response_schema_order"]);

  test("metrics: py_fsum is Python 3.12's compensated sum()", () => {
    const num = (r) => (r === "inf" ? Infinity : r === "-inf" ? -Infinity : r === "nan" ? NaN : Number(r));
    const fmt = (x) => (Number.isNaN(x) ? "nan" : x === Infinity ? "inf" : x === -Infinity ? "-inf" : HX.canonical.py_float_repr(x));
    for (const [xs, want] of golden("runtime").fsum) {
      assert.equal(fmt(HX.metrics.py_fsum(xs.map(num))), want, xs.join(","));
    }
    assert.equal(HX.metrics.py_fsum([]), 0);
  });

  test("broker: schema errors in python-jsonschema's order (keyword order, sorted extras)", () => {
    for (const [schema, value, want] of golden("runtime").schema_order) {
      assert.deepEqual(HX.broker._validate_against(JSON.parse(schema), JSON.parse(value)), want, schema + " / " + value);
    }
  });

  test("service: approval scope digest hashes expires_at as a Python float", () => {
    const scope = { b: "x", expires_at: 1790086400, a: [1, 2.5] };
    assert.equal(HX.service._scope_digest(scope),
      "sha256:" + HX.canonical.sha256_hex('{"a":[1,2.5],"b":"x","expires_at":1790086400.0}'));
    assert.equal(HX.service._scope_digest(Object.assign({}, scope, { expires_at: 1.25 })), HX.canonical.digest(
      Object.assign({}, scope, { expires_at: 1.25 })));
    assert.equal(HX.service._scope_digest({ a: 1 }), HX.canonical.digest({ a: 1 }));
  });

  /* seeded random operation sequences (results and snapshots compared by canonical digest) */
  const randoms = Array.from(RT.scenarios().keys()).filter((n) => n.startsWith("random_"));
  test("runtime: random scenarios are present in the golden", () => assert.ok(randoms.length >= 60, String(randoms.length)));
  RT.cover(randoms);

  const mkenv = () => {
    let n = 0;
    return HX.env.build_env({ clock: new HX.env.ManualClock(1790000000.25), timer: () => 0.125 * ++n,
      ids: HX.env.make_seq_ids(1) });
  };

  test("service: RunError, StepResult, CancellationResult and RunHandle shapes", () => {
    const e = new HX.service.RunError("NOT_FOUND", "run x not found for tenant");
    assert.ok(e instanceof HX.HXError);
    assert.equal(e.code, "NOT_FOUND");
    assert.equal(e.message, "run x not found for tenant");
    assert.equal(String(e), "NOT_FOUND: run x not found for tenant");
    assert.deepEqual(plain(new HX.service.StepResult({ a: 1 }, "RUNNING")), { checkpoint: { a: 1 }, status: "RUNNING",
      detail: "", interaction: null });
    assert.deepEqual(plain(new HX.service.CancellationResult("CANCELLED")), { status: "CANCELLED", disclosed_effects: [],
      unresolved: [] });
    assert.deepEqual(plain(new HX.service.RunHandle("r", "t", "h", "RUNNING", 0)), { run_id: "r", tenant_id: "t",
      artifact_hash: "h", status: "RUNNING", revision: 0 });
  });

  test("service: keyword options are validated like Python keyword arguments", () => {
    const env = mkenv();
    assert.throws(() => new HX.service.RunService(env.store, env.catalog, env.policy, env.broker, env.model, { bogus: 1 }),
      (e) => e.code === "TypeError");
    const p = env.principal("user:alice");
    assert.throws(() => env.service.advance_run("run_x", p, { worker: "w" }), (e) => e.code === "TypeError");
    assert.throws(() => env.service.resolve_effect("run_x", "la", "absent", p, { outputs: {} }), (e) => e.code === "TypeError");
    assert.throws(() => env.service.advance_run("run_x", p), (e) => e instanceof HX.service.RunError && e.code === "NOT_FOUND");
    assert.throws(() => env.service.package("sha256:nope"), (e) => e.code === "UNKNOWN_ARTIFACT");
    assert.throws(() => env.service.run_until_blocked("run_x", p, "w", 1, 2), (e) => e.code === "TypeError");
  });

  test("service: SimulatedCrash escapes start/advance/resume/cancel and is never wrapped", () => {
    const env = mkenv();
    const pkg = RT.pkgs().initial;
    assert.equal(HX.env.admit_initial(env, pkg).status, "ADMITTED");
    const p = env.principal("user:alice");
    const h = env.service.start_run(pkg.artifact_hash, HX.env.task(), p);
    const crash = new HX.broker.SimulatedCrash("model died");
    env.service.model = { model_id: "m", generate() { throw crash; } };
    assert.throws(() => env.service.run_until_blocked(h.run_id, p), (e) => e === crash);
    env.store.request_cancel = () => { throw crash; };
    assert.throws(() => env.service.cancel_run(h.run_id, null, p, { worker_id: "worker-1" }), (e) => e === crash);
    /* the step that crashed recorded no TIMING event (Python: the exception escapes before _record_timing) */
    const timing = env.store.events("acme", h.run_id).filter((e) => e.type === "TIMING");
    assert.ok(timing.every((e) => e.state !== "EXTRACT_DRAFT"));
  });

  test("service: TIMING events stay out of checkpoints and observations", () => {
    const env = mkenv();
    const pkg = RT.pkgs().initial;
    HX.env.admit_initial(env, pkg);
    const p = env.principal("user:alice");
    const h = env.service.start_run(pkg.artifact_hash, HX.env.task(), p);
    const r = env.service.run_until_blocked(h.run_id, p);
    assert.equal(r.status, "WAITING_FOR_APPROVAL");
    const evs = env.store.events("acme", h.run_id);
    const tev = evs.filter((e) => e.type === "TIMING");
    assert.ok(tev.length > 3 && tev.every((e) => e.schema === "hexis-timing/1"));
    for (const c of env.store.checkpoints("acme", h.run_id)) assert.ok(!/latency|timing/i.test(JSON.stringify(c)));
    for (const e of evs.filter((x) => x.type === "OBSERVATION")) assert.ok(!/latency/.test(JSON.stringify(e.observation)));
    const user = tev.filter((e) => e.kind === "user");
    assert.deepEqual(user.map((e) => e.human_wait_s), [null]);
  });

  test("metrics: percentile, escape_label and Prometheus number formatting", () => {
    const M = HX.metrics;
    assert.equal(M.percentile([], 50), null);
    assert.equal(M.percentile([3, 1, 2], 50), 2);
    assert.equal(M.percentile([3, 1, 2, 4], 95), 4);
    assert.equal(M.percentile([0.5], 0), 0.5);
    assert.equal(M.escape_label('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
    assert.equal(M._num(1, true), "1.0");
    assert.equal(M._num(1, false), "1");
    assert.equal(M._num(true, false), "1");
    assert.equal(M._num(0.1 + 0.2, true), "0.30000000000000004");
    assert.equal(M._num(1e16, true), "1e+16");
    assert.equal(M._num(NaN, true), "NaN");
    assert.equal(M._num(-Infinity, true), "-Inf");
    const empty = M.collect(new HX.store.Store(":memory:"), "acme");
    assert.deepEqual(plain(empty), { schema: "hexis-metrics/1", tenant_id: "acme", filters: { run_id: null, artifact_hash: null },
      runs: 0, by_model: {}, by_state: {}, by_tool: {}, per_run: {},
      totals: { engine_s: 0, model_s: 0, tool_s: 0, human_wait_s: 0, steps: 0, cost_usd: null } });
    assert.equal(M.render_prometheus(empty), [
      "# HELP hexis_seconds_total Time by component across the selected runs.", "# TYPE hexis_seconds_total counter",
      'hexis_seconds_total{component="engine"} 0.0', 'hexis_seconds_total{component="model"} 0.0',
      'hexis_seconds_total{component="tool"} 0.0', 'hexis_seconds_total{component="human_wait"} 0.0',
      "# HELP hexis_runs Runs included in this report.", "# TYPE hexis_runs gauge", "hexis_runs 0", ""].join("\n"));
    assert.throws(() => M.collect(new HX.store.Store(":memory:"), "acme", { tenant: "x" }), (e) => e.code === "TypeError");
  });
})();
