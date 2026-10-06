/* Parity of HX.kernel with runtime/kernel.py (golden/kernel.json + kernel_walks_<n>.json from gen_kernel.py). */
(function () {
  const K = HX.kernel;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const BUILTIN = ["KeyError", "TypeError", "AttributeError", "ValueError", "IndexError", "OverflowError"];

  function deep_freeze(v) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const k of Object.keys(v)) deep_freeze(v[k]);
    }
    return v;
  }

  const err_key = (e) => JSON.stringify([e[0], e[1]]);
  function run(fn) {
    try {
      return { ok: fn() };
    } catch (e) {
      if (e instanceof K.KernelError) {
        const detail = plain(e.detail);
        delete detail.errors; /* jsonschema message texts (the golden drops them too) */
        return { exc: "KernelError", code: e.code, message: e.message, detail };
      }
      if (e instanceof K.ValidationError) {
        return { exc: "ValidationError", errors: e.errors.map((x) => [x.type, x.loc]).sort((a, b) => (err_key(a) < err_key(b) ? -1 : 1)) };
      }
      if (e instanceof HX.canonical.CanonicalError) return { exc: "CanonicalError", message: e.message };
      if (e instanceof HX.HXError && BUILTIN.indexOf(e.code) >= 0) return { exc: e.code, message: e.message };
      throw e;
    }
  }

  /* Messages are compared except where they embed jsonschema/canonical texts (those differ by design). */
  const MESSAGE_FREE = new Set(["OUTPUT_SCHEMA", "TASK_INPUT_INVALID"]);
  function same(got, want, label) {
    if (want.exc === undefined) {
      assert.ok(got.exc === undefined, label + ": JS raised " + JSON.stringify(got));
      return;
    }
    assert.equal(got.exc, want.exc, label + ": " + JSON.stringify(got) + " vs " + JSON.stringify(want));
    if (want.exc === "KernelError") {
      assert.equal(got.code, want.code, label);
      assert.deepEqual(plain(got.detail), want.detail, label + " detail");
      const canon = want.code === "FIELD_SCOPE_VIOLATION" && /not canonical JSON/.test(want.message);
      if (!MESSAGE_FREE.has(want.code) && !canon) assert.equal(got.message, want.message, label + " message");
    } else if (want.exc === "ValidationError") {
      const w = want.errors.map(err_key).sort(), g = got.errors.map(err_key).sort();
      assert.deepEqual(g, w, label + " pydantic errors");
    }
  }

  function result_dump(r) {
    return plain({ checkpoint: r.checkpoint, events: r.events, delta: r.delta, edge: r.edge });
  }

  let PKGS = null;
  function packages() {
    if (PKGS) return PKGS;
    const G = golden("kernel");
    PKGS = {};
    for (const name of Object.keys(G.packages)) PKGS[name] = deep_freeze(HX.pkg.normalize_package(G.packages[name]));
    return PKGS;
  }

  test("kernel golden packages normalize and hash exactly like Python (initial, refined, mini packages)", () => {
    const G = golden("kernel");
    const P = packages();
    for (const name of Object.keys(P)) {
      assert.equal(P[name].artifact_hash, G.artifact_hashes[name], name);
      assert.equal(HX.pkg.compute_hash(P[name]), G.artifact_hashes[name], name);
    }
    assert.equal(G.artifact_hashes.initial, HX.data.python_build.initial_artifact_hash);
    assert.equal(G.artifact_hashes.refined, HX.data.python_build.refined_artifact_hash);
    assert.deepEqual(Array.from(K.TERMINAL_STATUSES), G.terminal_statuses);
  });

  test("random walks: every KernelResult (checkpoint incl. diagnostics, events incl. digests, delta, edge) or error matches Python, with frozen inputs", () => {
    const G = golden("kernel");
    const P = packages();
    let steps = 0, oks = 0;
    for (const file of G.walk_files) {
      for (const [wi, w] of golden(file).walks.entries()) {
        const pkg = P[w.pkg];
        const label0 = `${file}#${wi} (${w.pkg})`;
        const s = w.start;
        const start = run(() => (s.kind === "initial"
          ? K.initial_checkpoint(pkg, s.tenant_id, s.run_id, deep_freeze(plain(s.task_input)))
          : K.new_checkpoint(deep_freeze(plain(s.fields)))));
        same(start, w.start_result, label0 + " start");
        if (w.start_result.ok === undefined) continue;
        assert.deepEqual(plain(start.ok), w.start_result.ok, label0 + " start checkpoint");
        let cp = deep_freeze(start.ok);
        for (const [si, st] of w.steps.entries()) {
          const label = `${label0} step ${si} @${cp.state_id}`;
          steps++;
          const o = run(() => K.new_observation(deep_freeze(plain(st.obs))));
          let got = o;
          if (o.ok !== undefined) {
            const obs = deep_freeze(o.ok);
            const before = HX.canonical.digest(cp);
            got = run(() => K.advance(cp, obs, pkg));
            assert.equal(HX.canonical.digest(cp), before, label + ": input checkpoint changed");
          }
          same(got, st.result, label);
          if (got.ok !== undefined && st.result.ok !== undefined) {
            assert.deepEqual(result_dump(got.ok), st.result.ok, label + " result");
            assert.equal(K.checkpoint_digest(got.ok.checkpoint), HX.canonical.digest(st.result.ok.checkpoint), label);
            cp = deep_freeze(got.ok.checkpoint);
            oks++;
          }
        }
      }
    }
    assert.equal(steps, G.total_steps);
    assert.ok(steps >= 1500 && oks >= 800, `${steps} steps, ${oks} results`);
  });

  test("fill_template, resolve_path and select_edge vectors match Python", () => {
    const G = golden("kernel");
    const P = packages();
    const VALUES = deep_freeze(plain({
      s: "text", i: 42, f: 2.5, neg: -3, b: false, t: true, n: null, l: [1, "a"], d: { k: "v" }, e: "", big: 1e15,
      small: 1e-7, huge: 1.5e-300, uni: "é😀", _x: "u", X9: 9 }));
    for (const v of G.fill_template) {
      const got = run(() => K.fill_template(deep_freeze(plain(v.template)), VALUES));
      same(got, v.result, "fill " + JSON.stringify(v.template));
      if (v.result.ok !== undefined) assert.deepEqual(plain(got.ok), v.result.ok, "fill " + JSON.stringify(v.template));
    }
    for (const v of G.resolve_path) {
      const got = run(() => K.resolve_path(v.task_input, v.path));
      assert.equal(got.exc, v.result.exc, "resolve " + v.path);
      if (v.result.exc === "KernelError") same(got, v.result, "resolve " + v.path);
      if (v.result.ok !== undefined) assert.deepEqual(plain(got.ok), v.result.ok, "resolve " + JSON.stringify(v.path));
    }
    for (const v of G.select_edge) {
      const got = run(() => K.select_edge(P[v.pkg], v.state, deep_freeze(plain(v.variables))));
      assert.equal(got.exc, v.result.exc, "select " + v.pkg + "/" + v.state);
      if (v.result.ok !== undefined) assert.deepEqual(plain(got.ok), v.result.ok, `select ${v.pkg}/${v.state} ${JSON.stringify(v.variables)}`);
    }
    assert.ok(G.fill_template.length >= 300 && G.resolve_path.length >= 50 && G.select_edge.length >= 500);
  });

  test("model shapes: every default present; extra='forbid'; Literal kind/status; digests are canonical", () => {
    const cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: "h", state_id: "S", variables: {} });
    assert.deepEqual(Object.keys(cp), ["record_schema", "tenant_id", "run_id", "artifact_hash", "state_id", "revision",
      "variables", "budget", "status", "outcome", "assurance", "evidence_refs"]);
    assert.deepEqual(cp.budget, { steps: 0, tool_calls: 0, model_calls: 0, tokens: 0, output_repairs: 0 });
    assert.deepEqual(Object.keys(cp.assurance), ["entered_fallback", "fallback_reason", "missing_evidence",
      "policy_violations", "unresolved_effects", "verification_scope", "diagnostics"]);
    const obs = K.new_observation({ run_id: "r", state_id: "S", revision: 0, kind: "tool", usage: { tokens: "5" } });
    assert.deepEqual(Object.keys(obs), ["record_schema", "run_id", "state_id", "revision", "kind", "outputs", "actor",
      "receipt_ref", "usage", "engine", "failure"]);
    assert.equal(obs.usage.tokens, 5);
    assert.equal(Object.getPrototypeOf(obs.usage), Object.prototype);
    assert.throws(() => K.new_observation({ run_id: "r", state_id: "S", revision: 0, kind: "robot" }), K.ValidationError);
    assert.throws(() => K.new_observation({ run_id: "r", state_id: "S", revision: 0, kind: "tool", approved: true }), K.ValidationError);
    assert.throws(() => K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: "h", state_id: "S", variables: {}, status: "DONE" }), K.ValidationError);
    assert.equal(K.checkpoint_digest(cp), HX.canonical.digest(cp));
    assert.equal(K.RunCheckpoint.digest(cp), K.checkpoint_digest(cp));
    const e = new K.KernelError("X_CODE", "msg", { a: 1 });
    assert.equal(e.code, "X_CODE");
    assert.equal(e.message, "msg");
    assert.deepEqual(e.detail, { a: 1 });
    assert.equal(String(e), "X_CODE: msg");
    assert.ok(e instanceof HX.HXError);
  });

  test("Python kernel tests (A06, A07, A09, A10, identity, templates, nested init_from) hold in JS", () => {
    const P = packages();
    const obs = (cp, kind, outputs) => K.new_observation({ run_id: cp.run_id, state_id: cp.state_id, revision: cp.revision, kind, outputs });
    const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
    /* A06 */
    let cp = K.initial_checkpoint(P.judge, "t", "r", {});
    assert.equal(code(() => K.advance(cp, obs(cp, "judge", { label: "definitely" }), P.judge)), "INVALID_JUDGE_LABEL");
    assert.equal(code(() => K.advance(cp, obs(cp, "judge", { label: "ok", approved: true }), P.judge)), "UNEXPECTED_OUTPUT_KEYS");
    let r = K.advance(cp, obs(cp, "judge", { label: "abstain" }), P.judge);
    assert.equal(r.checkpoint.state_id, "FALLBACK");
    assert.ok(!("approved" in r.checkpoint.variables));
    /* A07 */
    cp = K.initial_checkpoint(P.falsy, "t", "r", {});
    r = K.advance(cp, obs(cp, "model", { flag: false, count: 0, note: "" }), P.falsy);
    assert.equal(r.checkpoint.state_id, "A");
    assert.deepEqual(r.checkpoint.variables, { flag: false, count: 0, note: "" });
    assert.ok(["OUTPUT_TYPE", "OUTPUT_SCHEMA"].includes(code(() => K.advance(cp, obs(cp, "model", { flag: 0, count: 0, note: "" }), P.falsy))));
    assert.ok(code(() => K.advance(cp, obs(cp, "model", { flag: "false", count: 0, note: "" }), P.falsy)));
    /* A09 */
    cp = K.initial_checkpoint(P.falsy_ghost, "t", "r", {});
    r = K.advance(cp, obs(cp, "model", { flag: true, count: 1, note: "n" }), P.falsy_ghost);
    assert.equal(r.checkpoint.status, "FAILED");
    assert.equal(r.checkpoint.assurance.diagnostics.at(-1).code, "GUARD_EVALUATION_ERROR");
    assert.equal(r.checkpoint.state_id, "M");
    /* A10 repair bound */
    const pkg = P.initial;
    for (const [count, state, expected] of [[0, "REPAIR_DRAFT", 1], [1, "REPAIR_DRAFT", 2], [2, "END_UNVERIFIED", 2]]) {
      cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT",
        variables: { draft: {}, required_fields: [], policy_version: "v", repair_count: count } });
      r = K.advance(cp, obs(cp, "tool", { status: "repairable", issues: [], draft_digest: "d" }), pkg);
      assert.equal(r.checkpoint.state_id, state);
      assert.equal(r.checkpoint.variables.repair_count, expected);
    }
    cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT",
      variables: { draft: {}, required_fields: [], policy_version: "v", repair_count: 0 },
      budget: { steps: pkg.execution_policy.budgets.max_steps } });
    r = K.advance(cp, obs(cp, "tool", { status: "pass", issues: [], draft_digest: "d" }), pkg);
    assert.equal(r.checkpoint.status, "FAILED");
    assert.equal(r.checkpoint.assurance.diagnostics.at(-1).code, "BUDGET_EXHAUSTED");
    assert.equal(r.checkpoint.budget.steps, cp.budget.steps + 1);
    /* identity */
    cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT", variables: {} });
    const stale = K.new_observation({ run_id: "r", state_id: "VALIDATE_DRAFT", revision: 7, kind: "tool", outputs: {} });
    assert.equal(code(() => K.advance(cp, stale, pkg)), "OBSERVATION_IDENTITY");
    /* A05 templates */
    assert.equal(code(() => K.fill_template({ draft_id: "${erp_draft_id}" }, {})), "MISSING_INPUT_BINDING");
    assert.equal(code(() => K.fill_template({ q: "id=${missing}" }, { other: 1 })), "MISSING_INPUT_BINDING");
    assert.deepEqual(K.fill_template({ x: "${v}" }, { v: false }), { x: false });
    /* nested init_from */
    assert.deepEqual(K.resolve_path({ a: { b: { c: 3 } } }, "task.input.a.b.c"), [true, 3]);
    assert.deepEqual(K.resolve_path({ "a/b": { c: 3 } }, "/a~1b/c"), [true, 3]);
    assert.deepEqual(K.resolve_path({ a: {} }, "task.input.a.b"), [false, null]);
  });

  test("advance never aliases its inputs: results can be mutated without touching the checkpoint, observation or package", () => {
    const P = packages();
    const pkg = P.verified;
    let cp = K.initial_checkpoint(pkg, "t", "r", {});
    const o1 = K.new_observation({ run_id: "r", state_id: "U", revision: 0, kind: "user", outputs: { out: "v" } });
    const r1 = K.advance(deep_freeze(cp), deep_freeze(o1), pkg);
    r1.delta.out = "mutated";
    r1.edge.to = "mutated";
    r1.checkpoint.variables.out = "changed";
    assert.equal(o1.outputs.out, "v");
    cp = K.new_checkpoint(plain(K.advance(cp, o1, pkg).checkpoint));
    const adm = { terminal_admission: { evidence_valid: true, receipts: ["ev_1"], unresolved_effects: [] } };
    const o2 = K.new_observation({ run_id: "r", state_id: "V", revision: 1, kind: "end", engine: adm });
    const before = HX.canonical.digest(cp);
    const r2 = K.advance(deep_freeze(cp), deep_freeze(o2), pkg);
    assert.equal(r2.checkpoint.status, "COMPLETED");
    r2.checkpoint.outcome.outputs.out = "x";
    r2.checkpoint.evidence_refs.push("y");
    r2.checkpoint.outcome.evidence_receipts.push("z");
    assert.equal(HX.canonical.digest(cp), before);
    assert.deepEqual(plain(o2.engine), adm);
  });
})();
