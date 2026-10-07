/* Parity for HX.update (traces/update.py) against golden/update*.json from golden/gen_update.py.
 * Shared helpers for 69_integration.test.js and 70_reference.test.js live on globalThis.UPD. */
(function () {
  const U = (globalThis.UPD = globalThis.UPD || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const loads = (s) => HX.canonical.strict_loads(s);
  U.plain = plain;
  U.loads = loads;

  /** Golden JSON is written with sorted keys: compare canonical texts (array order still matters). Strings carrying
   *  CPython parser texts (guard syntax errors, deviations/guards.md) and pydantic's rendering of a ValidationError
   *  inside "candidate construction failed: ..." (deviations/update.md #1) are compared up to their stable prefix. */
  function relax(v) {
    if (typeof v === "string") {
      let s = v.replace(/guard syntax error: [\s\S]*$/, "guard syntax error: <text>");
      if (/^candidate construction failed: /.test(s) && U._vexc.test(s)) s = "candidate construction failed: <ValidationError>";
      return s;
    }
    if (Array.isArray(v)) return v.map(relax);
    if (v !== null && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = relax(v[k]);
      return o;
    }
    return v;
  }
  /* Python: "N validation error(s) for Model"; JS: the EfsmError/PackageError texts. */
  U._vexc = /validation errors? for |EFSM_INVALID|PACKAGE_INVALID|dict keys must be str|Machine|Contracts|Lineage|Input should/;
  U.relax = relax;

  U.same = function same(got, want, label) {
    const g = HX.canonical.canonical_text(relax(plain(got))), w = HX.canonical.canonical_text(relax(plain(want)));
    if (g !== w) {
      const d = globalThis.RT_RUNTIME.first_diff(relax(plain(got)), relax(plain(want)), "");
      assert.fail(label + ": " + d);
    }
  };

  /** Python exception class name of a JS error. */
  U.exc_class = function exc_class(e) {
    if (U.is_validation(e)) return "ValidationError";
    if (e instanceof HX.HXError) return e.code;
    throw e;
  };
  U.is_validation = (e) => HX.update._is_validation_error(e);

  let CACHE = null;
  U.fixtures = function fixtures() {
    if (CACHE) return CACHE;
    const g = golden("update");
    const initial = HX.compile.compile_procurement().package;
    const ref = HX.reference;
    const missing = ref.missing_docs_trace();
    const refined = HX.update.apply_ops(initial, ref.REQUEST_INPUT_OPS.map((o) => Object.assign({}, o)), [missing.trace_id]);
    const prot = g.protected_jsonl.map((t) => {
      const [tr, errs] = HX.traces.from_jsonl(t);
      assert.deepEqual(errs, []);
      return tr;
    });
    const traces = { missing, shortcut: ref.shortcut_trace(), forbidden: ref.forbidden_write_trace(),
      duplicate: ref.duplicate_write_trace(), main: prot[0], conflict: prot[1] };
    const sc = traces.shortcut;
    const archives = { empty: [[], []], protected: [prot, []], protected_dev: [prot.concat([missing]), []],
      negative: [[], [sc]], protected_dev_negative: [prot.concat([missing]), [sc]] };
    CACHE = { g, initial, refined, parents: { initial, refined }, prot, traces, archives, catalog: HX.env.load_catalog(),
      skill_text: HX.env.skill_source().text };
    return CACHE;
  };

  class VariantAligner extends HX.reference.FixtureAligner {
    propose(ctx) {
      const ops = super.propose(ctx);
      for (const o of ops) {
        if (o.op === "add_state") {
          o.state = Object.assign({}, o.state, { action: Object.assign({}, o.state.action, { prompt: "Please re-send ids." }) });
        }
      }
      return ops;
    }
  }
  class ScriptAligner {
    constructor(texts) { this.texts = texts; this.model_id = "script:aligner/1"; }
    propose(ctx) { return loads(this.texts[Math.min(ctx.attempt, this.texts.length) - 1]); }
  }
  U.ScriptAligner = ScriptAligner;
  U.ALIGNERS = { fixture: HX.reference.FixtureAligner, shortcut: HX.reference.ShortcutAligner,
    breaking: HX.reference.BreakingAligner, mismatch: HX.reference.MismatchAligner, variant: VariantAligner };
  U.fake_context = (parent) => ({ events: [{ kind: "user", outputs: { document_ids: [] } }],
    machine: HX.efsm.to_json(parent.machine) });

  /* ------------------------------------------------------------------------------------------------------------ */
  test("update: anchor 1 - the fixture refinement of the initial package is Python's, byte for byte", () => {
    const F = U.fixtures();
    assert.equal(F.initial.artifact_hash, F.g.initial_hash);
    assert.equal(F.initial.artifact_hash, HX.data.python_build.initial_artifact_hash);
    const prop = HX.update.propose_update(F.initial, F.traces.missing, [], [], F.catalog, new HX.reference.FixtureAligner(),
      F.skill_text);
    assert.equal(prop.status, "CANDIDATE");
    assert.equal(prop.candidate.artifact_hash, HX.data.python_build.refined_artifact_hash);
    assert.equal(prop.candidate.artifact_hash, F.g.refined_hash);
    U.same(prop.to_json(), F.g.anchor1.result, "anchor1 to_json");
    /* the whole candidate dump, including the machine's state order and the lineage */
    assert.equal(JSON.stringify(plain(prop.candidate)), JSON.stringify(loads(F.g.anchor1.candidate_json)));
    assert.equal(JSON.stringify(plain(F.refined)), JSON.stringify(loads(F.g.refined_json)));
    assert.deepEqual(Object.keys(prop.candidate.machine.states), Object.keys(loads(F.g.refined_json).machine.states));
  });

  test("aligner context: dropped is shared across attempts like Python", () => {
    const F = U.fixtures();
    const lens = [];
    const aligner = { propose(ctx) { lens.push(ctx.dropped.length); ctx.dropped.push({ x: 1 }); return [{ op: "bogus" }]; } };
    const p = HX.update.propose_update(F.initial, F.traces.missing, [], [], F.catalog, aligner, F.skill_text);
    /* Python (the same aligner): lengths [1, 2], status REJECTED */
    assert.deepEqual(lens, [1, 2]);
    assert.equal(p.status, "REJECTED");
  });

  test("documented deviation #6: integer-like names are refused (state ids, variables, clause ids)", () => {
    const F = U.fixtures();
    const code = (fn) => { try { fn(); } catch (e) { return U.exc_class(e) === "ValidationError" ? "ValidationError" : e.code || e.name; } return null; };
    const add_var = { op: "add_variable", rationale: "r", variable: { name: "7", type: "string", init: true, init_from: null },
      contract: { owner: "tool", schema: { type: "integer" } } };
    const set_cov = { op: "set_coverage", rationale: "r", clause: "7",
      coverage: { classification: "executable_control", justification: "j" } };
    /* Python: both build a sealed candidate */
    for (const op of [add_var, set_cov]) {
      assert.throws(() => HX.update.apply_ops(F.initial, [op], ["tid"]), (e) => e instanceof HX.HXError && /integer-like|Integer-like/.test(e.message), op.op);
    }
    const cand = JSON.parse(JSON.stringify(F.initial));
    cand.contracts.clause_coverage = Object.assign({ 0: { classification: "executable_control", justification: "j" } },
      cand.contracts.clause_coverage);
    assert.ok(code(() => HX.update.policy_widening(F.initial, cand)) !== null, "policy_widening refuses");
  });

  test("update: MAX_ATTEMPTS, UpdateProposal shape", () => {
    const F = U.fixtures();
    assert.equal(HX.update.MAX_ATTEMPTS, F.g.max_attempts);
    const p = new HX.update.UpdateProposal("REJECTED", "h", "t");
    assert.deepEqual(plain(p.to_json()), { status: "REJECTED", parent_hash: "h", trace_id: "t", candidate_hash: null,
      diff: {}, gates: {}, attempts: [], diagnostics: [], negative_additions: [], requires_review: [] });
    assert.deepEqual(plain(p), plain(p.to_json()));
  });

  function propose_vector(F, v) {
    const parent = F.parents[v.parent];
    const [prot, neg] = F.archives[v.archive];
    const al = v.scripted ? new ScriptAligner(v.scripts) : new U.ALIGNERS[v.aligner]();
    const st = v.scripted ? F.skill_text : (v.skill_text ? F.skill_text : null);
    let got;
    try {
      got = HX.update.propose_update(parent, F.traces[v.trace], prot, neg, F.catalog, al, st).to_json();
    } catch (e) {
      got = { error: U.exc_class(e), message: e.message };
    }
    const label = (v.scripted ? "scripted " : "") + [v.parent, v.trace, v.aligner, v.archive].join("/");
    if (hasOwn(v.result, "error")) {
      assert.equal(got.error, v.result.error, label);
      return;
    }
    U.same(got, v.result, label);
  }

  test("update: propose_update grid (every reference/protected trace x aligner x parent x archive)", () => {
    const F = U.fixtures();
    let n = 0;
    for (let i = 1; i <= F.g.files; i++) {
      for (const v of golden("update_propose_" + i).vectors) {
        if (v.scripted) continue;
        propose_vector(F, v);
        n++;
      }
    }
    assert.equal(n, 240);
  });

  test("update: propose_update with scripted aligners over random operation lists", () => {
    const F = U.fixtures();
    let n = 0;
    for (let i = 1; i <= F.g.files; i++) {
      for (const v of golden("update_propose_" + i).vectors) {
        if (!v.scripted) continue;
        propose_vector(F, v);
        n++;
      }
    }
    assert.ok(n >= 200, String(n));
  });

  test("update: _validate_ops and apply_ops vectors (every op kind, bad indices, unknown states, Python errors)", () => {
    const F = U.fixtures();
    const events = {};
    for (const k of ["missing", "duplicate", "shortcut"]) events[k] = HX.normalize.normalize(F.traces[k])[0];
    let n = 0, msg_exact = 0;
    for (const v of golden("update_apply").apply) {
      const label = v.kind + " #" + n + " " + v.ops_json.slice(0, 160);
      const parent = F.parents[v.parent];
      /* _validate_ops */
      let gv;
      try {
        gv = { errors: HX.update._validate_ops(parent, loads(v.ops_json), events[v.trace], F.catalog) };
      } catch (e) {
        gv = { error: U.exc_class(e), message: e.message };
      }
      if (hasOwn(v.validate, "error")) {
        assert.equal(gv.error, v.validate.error, "validate " + label + " " + gv.message + " vs " + v.validate.message);
        assert.equal(gv.message, v.validate.message, "validate message " + label);
      } else {
        assert.deepEqual(gv, v.validate, "validate " + label);
      }
      /* apply_ops */
      const ops = loads(v.ops_json);
      let ga;
      try {
        const cand = HX.update.apply_ops(parent, ops, v.trace_ids);
        ga = { hash: cand.artifact_hash, lineage: plain(cand.lineage), states: Object.keys(cand.machine.states),
          widening: HX.update.policy_widening(parent, cand) };
      } catch (e) {
        ga = { error: U.exc_class(e), message: e.message };
      }
      if (hasOwn(v.apply, "error")) {
        assert.equal(ga.error, v.apply.error, "apply " + label + ": JS " + JSON.stringify(ga).slice(0, 300) + " vs " + v.apply.message);
        if (ga.error !== "ValidationError") {
          assert.equal(ga.message, v.apply.message, "apply message " + label);
          msg_exact++;
        }
      } else {
        U.same(ga, v.apply, "apply " + label);
        /* the operations' own objects are inserted by reference, exactly as in Python */
        assert.equal(HX.canonical.canonical_text(plain(ops)), HX.canonical.canonical_text(loads(v.ops_after_json)), "ops after " + label);
      }
      n++;
    }
    assert.ok(n >= 385 && msg_exact > 100, n + " " + msg_exact);
  });

  test("update: policy_widening over random mutations of execution policy and contracts (+ X10)", () => {
    const F = U.fixtures();
    let n = 0, nonempty = 0;
    for (const v of F.g.widening) {
      const parent = F.parents[v.parent];
      const cand = HX.traces._clone(HX.pkg.to_json(parent));
      const changed = loads(v.contracts_json);
      for (const k of Object.keys(changed)) cand.contracts[k] = changed[k];
      cand.execution_policy = loads(v.policy_json);
      const got = HX.update.policy_widening(parent, cand);
      assert.deepEqual(got, v.findings, "widening #" + n + " " + v.contracts_json.slice(0, 200) + " " + v.policy_json);
      if (got.length) nonempty++;
      n++;
    }
    assert.ok(n >= 260 && nonempty > 150, n + " " + nonempty);
  });

  function eval_cands(F) {
    const sc_ops = new HX.reference.ShortcutAligner().propose({});
    const sc_cand = HX.update.apply_ops(F.refined, sc_ops);
    const na = HX.traces._clone(HX.pkg.to_json(sc_cand));
    delete na.contracts.interactions.REQUEST_APPROVAL;
    na.artifact_hash = "";
    return { shortcut_on_refined: [F.refined, sc_cand], no_approval: [F.initial, HX.pkg.sealed(na)],
      breaking: [F.initial, HX.update.apply_ops(F.initial, new HX.reference.BreakingAligner().propose({}))],
      refined: [F.initial, F.refined],
      shortcut_on_initial: [F.initial, HX.update.apply_ops(F.initial, new HX.reference.ShortcutAligner().propose({}))] };
  }

  test("update: evaluate_candidate gates (shortcut, approval removal, breaking, refined; every archive)", () => {
    const F = U.fixtures();
    const C = eval_cands(F);
    for (const v of F.g.evaluate) {
      const [parent, cand] = C[v.cand];
      const [prot, neg] = F.archives[v.archive];
      const got = HX.update.evaluate_candidate(parent, cand, F.traces[v.trace], prot, neg, F.catalog,
        v.skill_text ? F.skill_text : null);
      U.same(got, v.gates, [v.cand, v.trace, v.archive, v.skill_text].join("/"));
    }
    assert.equal(F.g.evaluate.length, 70);
  });

  test("update: anchor 3 - the demo's step 6b (shortcut excluded; gates with ORDERING_VIOLATION path)", () => {
    const F = U.fixtures();
    const sc = F.traces.shortcut;
    const prot = F.prot.concat([F.traces.missing]);
    const prop = HX.update.propose_update(F.refined, sc, prot, [], F.catalog, new HX.reference.ShortcutAligner(), F.skill_text);
    assert.equal(prop.status, "EXCLUDED");
    U.same(prop.to_json(), F.g.demo_6b.proposal, "6b proposal");
    const cand = HX.update.apply_ops(F.refined, new HX.reference.ShortcutAligner().propose({}));
    const gates = HX.update.evaluate_candidate(F.refined, cand, sc, prot, [sc], F.catalog, F.skill_text);
    U.same(gates, F.g.demo_6b.gates, "6b gates");
    const viol = gates.static_validation.findings.filter((f) => f.code === "ORDERING_VIOLATION");
    assert.ok(viol.length && viol[0].detail.path.length > 1);
    assert.deepEqual(gates.negative_corpus.now_representable, [sc.trace_id]);
    assert.equal(gates.passed, false);
  });

  test("update: archive_manifest / manifest_digest", () => {
    const F = U.fixtures();
    const by_id = {};
    for (const t of Object.values(F.traces)) by_id[t.trace_id] = t;
    for (const v of F.g.manifests) {
      const prot = v.protected.map((id) => by_id[id]), neg = v.negative.map((id) => by_id[id]);
      assert.deepEqual(plain(HX.update.archive_manifest(prot, neg)), v.manifest);
      assert.equal(HX.update.manifest_digest(prot, neg), v.digest);
      /* the registry uses the same manifest */
      assert.equal(HX.canonical.digest(HX.registry._manifest_of(prot, neg)), v.digest);
    }
  });

  test("update: never mutates the parent; candidate built on deep copies", () => {
    const F = U.fixtures();
    const before = HX.canonical.canonical_text(plain(F.initial));
    HX.update.propose_update(F.initial, F.traces.missing, F.prot, [], F.catalog, new HX.reference.BreakingAligner(), F.skill_text);
    HX.update.apply_ops(F.initial, new HX.reference.BreakingAligner().propose({}));
    assert.equal(HX.canonical.canonical_text(plain(F.initial)), before);
    /* an unsealed copy of a trace is refused (the seal does not survive a plain copy) */
    const copy = HX.traces._clone(F.traces.missing);
    const p = HX.update.propose_update(F.initial, copy, [], [], F.catalog, new HX.reference.FixtureAligner());
    assert.equal(p.status, "EXCLUDED");
    assert.ok(p.diagnostics[0].startsWith("trace integrity: "));
  });

  test("update: documented deviations (deviations/update.md)", () => {
    const F = U.fixtures();
    /* #2 a non-str dict key never becomes a JS string key: ValidationError, as pydantic refuses it */
    for (const ops of [
      [{ op: "set_coverage", clause: 7, coverage: { classification: "non_material", justification: "j" } }],
      [{ op: "add_state", rationale: "x", state: { id: true, action: { kind: "user" } } }],
      [{ op: "add_variable", rationale: "x", variable: { name: 1.5 }, contract: { owner: "engine" } }]]) {
      assert.throws(() => HX.update.apply_ops(F.initial, ops), (e) => U.is_validation(e));
    }
    /* #3 repr() of an operation dict with an integer-like key: KEY_ORDER_UNKNOWN instead of a reordered text */
    const ev = HX.normalize.normalize(F.traces.missing)[0];
    assert.throws(() => HX.update._validate_ops(F.initial, loads('[{"op": "match", "state": "NOPE", "event_index": 0, "7": 1}]'),
      ev, F.catalog), (e) => e.code === "KEY_ORDER_UNKNOWN");
    assert.deepEqual(HX.update._validate_ops(F.initial, loads('[{"op": "ignore", "event_index": 0, "7": 1}]'), ev, F.catalog),
      ["ignore of event 0 has no reason"]);
    /* #4 a native JS error inside apply_ops (not a Python exception) escapes propose_update */
    const bad = { model_id: "x", propose: () => [{ op: "add_variable", rationale: "r", variable: { name: "v" }, contract: {} }] };
    const saved = HX.pkg.Contracts.model_validate;
    try {
      HX.pkg.Contracts.model_validate = () => { throw new RangeError("boom"); };
      assert.throws(() => HX.update.propose_update(F.initial, F.traces.missing, [], [], F.catalog, bad), RangeError);
    } finally {
      HX.pkg.Contracts.model_validate = saved;
    }
  });
})();
