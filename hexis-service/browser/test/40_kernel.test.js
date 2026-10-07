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

  test("schema checks use python-jsonschema's exact multipleOf (verdicts; TASK_INPUT_INVALID / OUTPUT_SCHEMA results)", () => {
    const M = golden("kernel").multiple_of;
    let n = 0;
    for (const c of M.cases) {
      const errs = K._schema_errors(c.schema, c.value);
      assert.equal(errs.length === 0, c.valid, "multipleOf " + JSON.stringify(c.schema) + " / " + c.value + ": " + JSON.stringify(errs));
      n++;
    }
    assert.ok(n > 2000, "cases " + n);
    /* the plain HX.jsonschema subset is looser (documented in deviations/kernel.md) */
    assert.deepEqual(HX.catalog.validate_against({ multipleOf: 0.1 }, 0.3), []);
    assert.equal(K._schema_errors({ multipleOf: 0.1 }, 0.3).length, 1);
    const pkg = deep_freeze(HX.pkg.normalize_package(M.package));
    const cp = deep_freeze(K.initial_checkpoint(pkg, "t", "r", {}));
    for (const k of M.kernel) {
      same(run(() => K.initial_checkpoint(pkg, "t", "r", deep_freeze({ amount: k.amount }))), k.initial, "initial " + k.amount);
      if (k.initial.ok) assert.deepEqual(plain(K.initial_checkpoint(pkg, "t", "r", { amount: k.amount })), k.initial.ok);
      const obs = deep_freeze(K.new_observation({ run_id: "r", state_id: "U", revision: 0, kind: "user", outputs: { amount: k.amount } }));
      const got = run(() => result_dump(K.advance(cp, obs, pkg)));
      same(got, k.advance, "advance " + k.amount);
      if (k.advance.ok) assert.deepEqual(got.ok, k.advance.ok, "advance result " + k.amount);
    }
  });

  test("documented deviations (deviations/kernel.md) are conservative", () => {
    const P = packages();
    const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
    /* 1. integral floats cannot reach the kernel through intake: strict_loads refuses them, so the field-scope
          check never misses a 1 -> 1.0 change (Python: FIELD_SCOPE_VIOLATION) */
    assert.throws(() => HX.canonical.strict_loads('{"a": "y", "locked": 1.0, "gone": null}'), HX.canonical.CanonicalError);
    let cp = K.initial_checkpoint(P.scoped, "t", "r", {});
    const o = (doc) => K.new_observation({ run_id: "r", state_id: "R", revision: 0, kind: "model", outputs: { doc } });
    assert.equal(code(() => K.advance(cp, o({ a: "y", locked: true, gone: null }), P.scoped)), "FIELD_SCOPE_VIOLATION");
    assert.equal(K.advance(cp, o({ a: "y", locked: 1, gone: null }), P.scoped).checkpoint.variables.doc.a, "y");
    /* 2. values Python accepts in Any fields but cannot hash (lone surrogates, unsafe integers) are rejected when the
          observation / checkpoint is constructed */
    assert.throws(() => K.new_observation({ run_id: "r", state_id: "R", revision: 0, kind: "model", outputs: { doc: "\ud800" } }),
      K.ValidationError);
    assert.throws(() => K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: "h", state_id: "S",
      variables: { n: 2 ** 60 } }), K.ValidationError);
    /* 3. integer-like output keys iterate first in JS: with two failing outputs the first error can name the other
          key (both reject) */
    const dump = plain(golden("kernel").packages.owner_mix);
    dump.machine.states.T.action.writes = ["t", "7"];
    const p7 = HX.pkg.normalize_package(dump);
    cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: p7.artifact_hash, state_id: "T", variables: {} });
    const bad = K.new_observation({ run_id: "r", state_id: "T", revision: 0, kind: "model", outputs: { t: "x", 7: 1 } });
    /* Python (outputs in order t, 7): WRITE_OWNERSHIP for 't'; JS iterates '7' first: WRITE_OWNERSHIP for '7' */
    assert.throws(() => K.advance(cp, bad, p7), (e) => e.code === "WRITE_OWNERSHIP" && e.detail.variable === "7");
    /* 4. engine counters: int() of a Unicode-digit or huge numeric string is a ValueError in JS */
    assert.equal(K._py_int(" 12 "), 12);
    assert.equal(K._py_int("1_000"), 1000);
    assert.equal(K._py_int(2.9), 2);
    assert.equal(K._py_int(true), 1);
    assert.throws(() => K._py_int("\u0663"), (e) => e.code === "ValueError");
    assert.throws(() => K._py_int("9".repeat(20)), (e) => e.code === "ValueError");
    assert.throws(() => K._py_int(null), (e) => e.code === "TypeError");
    /* 5. schema regexes have Python's meaning (`$` before a final newline); a regex outside the translated
          subset makes the schema check fail closed */
    const ti = { supplier_ref: "SUP-123\n", business_unit: "BU-NA", document_ids: [], required_fields: [], policy_version: "v" };
    assert.equal(code(() => K.initial_checkpoint(P.initial, "acme", "r", ti)), null);
    assert.deepEqual(K._schema_errors({ not: { pattern: "(?i)drop" } }, "x").length, 1);
    assert.deepEqual(K._schema_errors({ type: "object", patternProperties: { "\\1": {} } }, {}).length, 1);
    /* 7. list(dict) of terminal_admission receipts / missing / unresolved_effects: insertion order is lost for
          integer-like keys, so such a dict (2+ keys) raises KEY_ORDER_UNKNOWN instead of a reordered list */
    assert.deepEqual(K._py_list({ z: 1, y: 2 }), ["z", "y"]);
    assert.deepEqual(K._py_list({ 7: 1 }), ["7"]);
    assert.throws(() => K._py_list({ z: 1, 7: 2 }), (e) => e.code === "KEY_ORDER_UNKNOWN");
    {
      const vp = P.verified;
      const st = Object.keys(vp.machine.states).find((s) => vp.machine.states[s].action.kind === "end" &&
        (vp.contracts.terminals[vp.machine.states[s].action.terminal] || {}).category !== "verified");
      assert.ok(st, "unverified end state");
      {
        const vars = {};
        const term = HX.efsm.terminal(vp.machine, vp.machine.states[st].action.terminal);
        for (const o of term ? term.output : []) vars[o] = "v";
        const c0 = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: vp.artifact_hash, state_id: st, variables: vars });
        const ob = (receipts) => K.new_observation({ run_id: "r", state_id: st, revision: 0, kind: "end",
          engine: { terminal_admission: { evidence_valid: true, receipts } } });
        assert.throws(() => K.advance(c0, ob({ z: 1, 7: 2 }), vp), (e) => e.code === "KEY_ORDER_UNKNOWN");
        assert.deepEqual(plain(K.advance(c0, ob({ z: 1, y: 2 }), vp).checkpoint.evidence_refs), ["z", "y"]);
      }
    }
    /* 8. schema keywords outside HX.jsonschema's subset fail closed (python-jsonschema accepts these values) */
    for (const kw of [{ propertyNames: { maxLength: 3 } }, { minProperties: 0 }, { prefixItems: [] }, { contains: {} },
      { dependentRequired: {} }, { $defs: {} }, { if: {}, then: {} }, { unevaluatedProperties: true }]) {
      const errs = K._schema_errors(Object.assign({ type: "object" }, kw), {});
      assert.ok(errs.length >= 1 && errs.every((m) => /unsupported schema keyword/.test(m)), JSON.stringify(kw) + ": " + JSON.stringify(errs));
    }
    /* 2b. values beyond HX.canonical's limits are refused at construction (Python accepts the checkpoint) */
    let deep = "x";
    for (let i = 0; i < 70; i++) deep = [deep];
    assert.throws(() => K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: "h", state_id: "S",
      variables: { zz: deep } }), (e) => e instanceof K.ValidationError && e.errors[0].type === "json_invalid");
    assert.throws(() => K.new_observation({ run_id: "r", state_id: "R", revision: 0, kind: "model",
      outputs: { doc: { big: "a".repeat(1048577) } } }), (e) => e instanceof K.ValidationError && e.errors[0].type === "json_invalid");
    /* 6. fill_template interpolates floats with Python's repr and never stringifies bools/null/containers */
    assert.equal(K.fill_template("v=${f}", { f: 1e-7 }), "v=1e-07");
    assert.equal(code(() => K.fill_template("v=${b}", { b: true })), "TEMPLATE_TYPE");
  });

  test("schema regexes have Python re.search semantics (Unicode \\d \\w \\s \\b, `$` before a final newline); others fail closed", () => {
    const G = golden("kernel_regex");
    /* the embedded CPython class tables are Python's */
    for (const k of ["d", "s", "w"]) assert.equal(K._PY_RE_TABLES[k], G.tables[k], "table " + k);
    let same_n = 0, closed = 0;
    for (const v of G.regex) {
      const src = K._py_regex_to_js(v.p);
      const label = JSON.stringify(v.p) + " / " + JSON.stringify(v.s);
      if (v.r !== true && v.r !== false) { assert.equal(src, null, "Python refuses " + label); continue; }
      if (src === null) { closed++; continue; }
      assert.equal(new RegExp(src, "u").test(v.s), v.r, label + " -> " + src);
      assert.equal(K._py_re_search(v.p, v.s), v.r, label);
      same_n++;
    }
    assert.ok(same_n > 4500 && closed < same_n / 10, "translated " + same_n + ", fail-closed " + closed);
    let sv = 0, sc = 0;
    for (const v of G.schemas) {
      const errs = K._schema_errors(v.schema, v.value);
      const label = JSON.stringify(v.schema) + " / " + JSON.stringify(v.value) + ": " + JSON.stringify(errs);
      if (v.valid === true || v.valid === false) {
        if (errs.length === 1 && /^<root>: unsupported pattern/.test(errs[0])) { assert.equal(v.valid !== null, true); sc++; continue; }
        assert.equal(errs.length === 0, v.valid, label);
        sv++;
      } else {
        assert.ok(errs.length > 0, "Python raises " + v.valid + ", JS must reject: " + label);
      }
    }
    assert.ok(sv > 1000 && sc < sv / 10, "schema verdicts " + sv + ", fail-closed " + sc);
    /* kernel results (TASK_INPUT_INVALID / OUTPUT_SCHEMA) with Python's verdicts */
    const pkg = deep_freeze(HX.pkg.normalize_package(G.kernel.package));
    const cp = deep_freeze(K.initial_checkpoint(pkg, "t", "r", {}));
    for (const c of G.kernel.cases) {
      if ("task_input" in c) {
        const got = run(() => plain(K.initial_checkpoint(pkg, "t", "r", deep_freeze(plain(c.task_input)))));
        same(got, c.result, "initial " + JSON.stringify(c.task_input));
        if (c.result.ok) assert.deepEqual(got.ok, c.result.ok);
      } else {
        const obs = deep_freeze(K.new_observation({ run_id: "r", state_id: "U", revision: 0, kind: "model", outputs: { code: c.code } }));
        const got = run(() => result_dump(K.advance(cp, obs, pkg)));
        same(got, c.result, "advance " + JSON.stringify(c.code));
        if (c.result.ok) assert.deepEqual(got.ok, c.result.ok);
      }
    }
  });

  test("int() of counters strips exactly CPython's whitespace (not U+001C..U+001F or U+FEFF)", () => {
    const G = golden("kernel_regex").int;
    const acc = new Map(G.accepted.map(([f, c, v]) => [f + ":" + c, v]));
    const UNI_DIGIT = (c) => /\p{Nd}/u.test(String.fromCodePoint(c)) && !(c >= 0x30 && c <= 0x39);
    let n = 0;
    for (const c of G.cps) {
      const ch = String.fromCodePoint(c);
      [ch + "8", "8" + ch, ch].forEach((s, f) => {
        const want = acc.get(f + ":" + c);
        let got;
        try { got = K._py_int(s); } catch (e) { got = e.code; }
        if (want === undefined) assert.equal(got, "ValueError", "Python refuses " + JSON.stringify(s) + ", JS gave " + got);
        else if (got === "ValueError") assert.ok(UNI_DIGIT(c), "only Unicode digits may be refused: " + JSON.stringify(s));
        else assert.equal(got, want, JSON.stringify(s));
        n++;
      });
    }
    assert.ok(n > 36000);
  });

  test("budget and inc counters beyond 2^53: Python's exact result, or KernelError BUDGET_OVERFLOW / COUNTER_OVERFLOW", () => {
    const G = golden("kernel_followups");
    const pkg = deep_freeze(HX.pkg.normalize_package(plain(golden("kernel").packages[G.package])));
    const SAFE = Number.MAX_SAFE_INTEGER;
    let unsafe = 0, exact = 0, raised = 0;
    for (const c of G.budget) {
      const label = JSON.stringify([c.state, c.budget, c.usage, c.variables, c.failure]);
      const budget = {};
      for (const k of Object.keys(c.budget)) budget[k] = Number(c.budget[k]);
      const got = run(() => {
        const cp = deep_freeze(K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash,
          state_id: c.state, variables: plain(c.variables), budget }));
        const f = { run_id: "r", state_id: c.state, revision: 0, kind: c.kind, outputs: plain(c.outputs),
          usage: plain(c.usage), engine: plain(c.engine) };
        if (c.failure !== null) f.failure = c.failure;
        return result_dump(K.advance(cp, deep_freeze(K.new_observation(f)), pkg));
      });
      const want = c.result;
      if (want.ok && want.ok.unsafe) {
        /* Python returns a checkpoint holding an integer JS cannot represent: the port fails closed */
        unsafe++;
        const code = want.ok.unsafe_variables.length ? "COUNTER_OVERFLOW" : "BUDGET_OVERFLOW";
        assert.equal(got.exc, "KernelError", label + ": " + JSON.stringify(got));
        assert.equal(got.code, code, label);
        if (code === "BUDGET_OVERFLOW") assert.deepEqual(plain(got.detail).fields, want.ok.unsafe_budget, label);
        else assert.deepEqual([got.detail.variable], want.ok.unsafe_variables, label);
        for (const k of Object.keys(want.ok.budget)) {
          if (want.ok.unsafe_budget.indexOf(k) < 0) assert.ok(Math.abs(Number(want.ok.budget[k])) <= SAFE, label);
        }
        continue;
      }
      same(got, want, label);
      if (want.ok) { assert.deepEqual(got.ok, want.ok, label); exact++; } else raised++;
      /* every value JS returns is hashable */
      if (got.ok) HX.canonical.digest(got.ok.checkpoint);
    }
    assert.ok(unsafe >= 40 && exact >= 60 && raised >= 30, [unsafe, exact, raised].join(" "));
  });

  test("terminal admission: KEY_ORDER_UNKNOWN only where Python returns a list built from an integer-keyed dict", () => {
    const G = golden("kernel_followups");
    const pkg = deep_freeze(HX.pkg.normalize_package(plain(golden("kernel").packages[G.admission_package])));
    const INTLIKE = /^(?:0|[1-9][0-9]*)$/;
    const reordered = (xs) => Array.isArray(xs) && xs.length > 1 && xs.some((k) => INTLIKE.test(k)) &&
      JSON.stringify(xs) !== JSON.stringify(Object.keys(Object.fromEntries(xs.map((k) => [k, 1]))));
    let same_n = 0, refused = 0;
    for (const c of G.admission) {
      const label = c.state + " " + JSON.stringify(c.admission);
      let got;
      try {
        got = run(() => {
          const cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: c.state,
            variables: { out: "v", extra: 3 } });
          const obs = K.new_observation({ run_id: "r", state_id: c.state, revision: 0, kind: "end",
            engine: { terminal_admission: plain(c.admission) } });
          return result_dump(K.advance(deep_freeze(cp), deep_freeze(obs), pkg));
        });
      } catch (e) {
        if (!(e instanceof HX.HXError && e.code === "KEY_ORDER_UNKNOWN")) throw e;
        got = { exc: "KEY_ORDER_UNKNOWN" };
      }
      if (got.exc === "KEY_ORDER_UNKNOWN") {
        /* Python returned a list whose order (dict insertion order) JS cannot recover */
        assert.ok(c.result.ok, label + ": Python raised " + JSON.stringify(c.result));
        const cpd = c.result.ok.checkpoint;
        assert.ok([cpd.assurance.unresolved_effects, cpd.assurance.missing_evidence, cpd.evidence_refs].some(reordered),
          label + ": no reordered list in Python's result");
        refused++;
        continue;
      }
      same(got, c.result, label);
      if (c.result.ok) assert.deepEqual(got.ok, c.result.ok, label);
      same_n++;
    }
    assert.ok(refused > 50 && same_n > 500, refused + " " + same_n);
  });

  test("judge action with empty writes: IndexError like Python's delta[writes[0]]", () => {
    const G = golden("kernel_regex").judge_empty_writes;
    assert.equal(G.package_build.exc, "ValidationError"); /* Python's package model refuses it */
    const pkg = plain(packages().judge); /* emptied after validation, as the generator does */
    pkg.machine.states.J.action.writes = [];
    const obs = K.new_observation({ run_id: "r", state_id: "J", revision: 0, kind: "judge", outputs: {} });
    same(run(() => K.validate_declared_outputs(pkg, "J", obs, {})), G.validate, "validate_declared_outputs");
    assert.equal(G.validate.exc, "IndexError");
  });
})();
