/* Parity of HX.compile (compiler/compile.py) with the Python reference (golden/compile.json from gen_compile.py). */
(function () {
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const G = () => golden("compile");

  function walk(d, path) {
    for (const k of path) d = d[k < 0 && Array.isArray(d) ? d.length + k : k];
    return d;
  }
  /** gen_validate.apply_ops */
  function apply_ops(d, ops) {
    for (const op of ops) {
      const [kind, path] = op;
      const parent = () => walk(d, path.slice(0, -1));
      const last = path[path.length - 1];
      if (kind === "set") parent()[last] = plain(op[2]);
      else if (kind === "del") { const p = parent(); if (Array.isArray(p)) p.splice(last, 1); else delete p[last]; }
      else if (kind === "ins") parent().splice(last, 0, plain(op[2]));
      else if (kind === "app") walk(d, path).push(plain(op[2]));
      else if (kind === "perm") { const old = walk(d, path); parent()[last] = op[2].map((i) => old[i]); }
      else if (kind === "order") { const old = walk(d, path); const o = {}; for (const k of op[2]) o[k] = old[k]; parent()[last] = o; }
      else if (kind === "strrep") { const p = parent(); p[last] = p[last].split(op[2]).join(op[3]); }
      else throw new Error("unknown op " + kind);
    }
    return d;
  }

  /** gen_compile.ScriptModel */
  class ScriptModel {
    constructor(spec) {
      this.spec = spec;
      this.model_id = spec.model_id !== undefined ? spec.model_id : "test:script";
      this.settings = plain(spec.settings || {});
      if ("prompt_template_sha256" in spec) this.prompt_template_sha256 = spec.prompt_template_sha256;
      if ("prompt_template" in spec) this.prompt_template = spec.prompt_template;
      this.calls = [];
    }
    draft(ctx, diags, attempt) {
      this.calls.push({ attempt, diagnostics: plain(diags) });
      const steps = this.spec.steps;
      const step = steps[Math.min(attempt, steps.length) - 1];
      if ("raw" in step) return plain(step.raw);
      const base = step.base || "defect";
      let m, c;
      if (base === "fixture") {
        const out = new HX.fixture.FixtureCompilerModel().draft(ctx, diags, attempt);
        m = out.machine; c = out.contracts;
      } else {
        m = HX.fixture.machine_dict(base === "defect");
        c = plain(HX.fixture.contracts_dict());
      }
      apply_ops(m, step.machine_ops || []);
      apply_ops(c, step.contracts_ops || []);
      if (step.contracts_fn) {
        const bad = new Set(diags.filter((d) => d.code === "ORDERING_VIOLATION").map((d) => d.detail.requirement));
        if (step.contracts_fn === "drop_violated") c.ordering = c.ordering.filter((o) => !bad.has(o.id));
        else for (const o of c.ordering) if (bad.has(o.id)) o.requires = [o.before];
      }
      return { machine: m, contracts: c };
    }
  }

  /** DRAFT_SCHEMA messages that are pydantic ValidationError texts are not reproduced word for word. */
  function relax(x) {
    if (Array.isArray(x)) return x.map(relax);
    if (x && typeof x === "object") {
      const o = {};
      for (const k of Object.keys(x)) o[k] = relax(x[k]);
      if (o.code === "DRAFT_SCHEMA" && typeof o.message === "string" && /validation errors? for /.test(o.message)) o.message = "<pydantic>";
      return o;
    }
    return x;
  }
  function relax_js(x, want) {
    /* replace JS DRAFT_SCHEMA messages wherever Python's are relaxed */
    if (Array.isArray(x)) return x.map((v, i) => relax_js(v, want && want[i]));
    if (x && typeof x === "object") {
      const o = {};
      for (const k of Object.keys(x)) o[k] = relax_js(x[k], want && want[k]);
      if (o.code === "DRAFT_SCHEMA" && want && want.message === "<pydantic>") o.message = "<pydantic>";
      return o;
    }
    return x;
  }

  test("compile: constants, context, prompts_digest and coverage_markdown equal Python", () => {
    const g = G();
    for (const k of Object.keys(g.constants)) assert.deepEqual(plain(HX.compile[k]), g.constants[k], k);
    const src = HX.compile.skill_source();
    const cat = HX.catalog.load_catalog(HX.data.tool_catalog);
    const ctx = HX.compile.build_context(src, HX.clauses.index_clauses(src.text), cat, HX.fixture.deployment_policy());
    assert.deepEqual(plain(ctx), g.context);
    assert.equal(HX.canonical.digest(ctx), g.context_digest);
    assert.equal(HX.compile.prompts_digest(ctx, new HX.fixture.FixtureCompilerModel()), g.prompts_digest.fixture);
    assert.equal(HX.compile.prompts_digest(ctx, { model_id: "m", settings: {}, prompt_template: "compile_v1",
      prompt_template_sha256: "sha256:abc" }), g.prompts_digest.template);
    assert.equal(HX.compile.prompts_digest(ctx, { prompt_template_sha256: "x" }), g.prompts_digest.template_no_name);
    assert.equal(HX.compile.coverage_markdown([
      { clause: "S1", critical: true, text: "a|b " + "x".repeat(100), classification: "c", states: ["A", "B"] },
      { clause: "S2", critical: false, text: "\u{1F600}".repeat(90), classification: "d", states: [] },
      { clause: "S3", critical: false, text: "\u{1F600}".repeat(91) + "|", classification: "d", states: ["X"] }]), g.markdown);
  });

  test("compile: compile_procurement() reproduces Python's fixture run (artifact hash, package, attempts, coverage)", () => {
    const g = G().fixture;
    const res = HX.compile.compile_procurement();
    assert.equal(res.package.artifact_hash, HX.data.python_build.initial_artifact_hash);
    assert.equal(res.package.artifact_hash, g.result.artifact_hash);
    assert.deepEqual(plain(res.package), g.package);
    assert.deepEqual(Object.keys(res.package.machine.states), g.state_order);
    assert.equal(HX.efsm.machine_digest(res.package.machine), g.machine_digest);
    assert.deepEqual(plain(HX.pkg.hash_payload(res.package)), plain(HX.pkg.hash_payload(g.package)));
    assert.deepEqual(res.attempts.map((a) => a.status), ["invalid", "valid"]);
    assert.deepEqual(plain(res.attempts), g.result.attempts);
    assert.deepEqual(plain(res.coverage), g.result.coverage);
    assert.deepEqual(res.review_required, g.result.review_required);
    assert.deepEqual(plain(res.to_json()), g.result);
    assert.equal(HX.compile.coverage_markdown(res.coverage), g.coverage_markdown);
    assert.ok(HX.validate.validate_package(res.package, HX.data.tool_catalog, "production",
      { skill_text: HX.data.skill_md, deployment_policy: HX.fixture.deployment_policy() }).passed);
  });

  test("compile: scripted compiler models (malformed drafts, repair, requirement monotonicity) match Python", () => {
    const cat = HX.catalog.load_catalog(HX.data.tool_catalog);
    for (const s of G().scripts) {
      const model = new ScriptModel(s.spec);
      const src = s.source ? s.source : HX.compile.skill_source();
      const dp = HX.pkg.DeploymentPolicy.model_validate(apply_ops(plain(HX.fixture.deployment_policy()), s.policy_ops));
      let res;
      try {
        res = HX.compile.compile_skill(src, cat, dp, model, s.max_attempts);
      } catch (e) {
        assert.ok(s.exc, s.name + ": unexpected " + (e && e.stack));
        assert.ok(e instanceof HX.HXError, s.name);
        assert.equal(e.code, s.exc, s.name);
        assert.deepEqual(relax_js(plain(model.calls), relax(s.calls)), relax(s.calls), s.name + ": calls");
        continue;
      }
      assert.ok(!s.exc, s.name + ": Python raised " + s.exc);
      const want = relax(s.result);
      assert.deepEqual(relax_js(plain(res.to_json()), want), want, s.name + ": result");
      const wc = relax(s.calls);
      assert.deepEqual(relax_js(plain(model.calls), wc), wc, s.name + ": diagnostics fed to the model");
      assert.equal(res.report !== null, s.has_report, s.name);
      if (s.package) assert.deepEqual(plain(res.package), s.package, s.name + ": package");
      else assert.equal(res.package, null, s.name);
    }
  });

  test("compile: normalize_machine matches Python and is idempotent", () => {
    for (const v of G().normalize) {
      const m = HX.efsm.load_machine(apply_ops(HX.fixture.machine_dict(v.defect), v.ops));
      const n = HX.compile.normalize_machine(m);
      assert.deepEqual(plain(n), v.normalized, JSON.stringify(v.ops));
      assert.deepEqual(Object.keys(n.states), v.state_order);
      assert.deepEqual(n.variables.map((x) => x.name), v.variable_order);
      assert.equal(HX.util.deep_equal(plain(HX.compile.normalize_machine(n)), plain(n)), v.idempotent);
    }
  });

  test("compile: requirement-monotonicity helpers", () => {
    const C = HX.compile;
    const o = { id: "o", requires: ["a", "b"], before: "x", invalidated_by: ["v"], clause: "c" };
    assert.equal(C._at_least_as_strong("ordering:o", o, Object.assign({}, o, { requires: ["a"] })), true);
    assert.equal(C._at_least_as_strong("ordering:o", o, Object.assign({}, o, { requires: [] })), false);
    assert.equal(C._at_least_as_strong("ordering:o", o, Object.assign({}, o, { invalidated_by: [] })), false);
    assert.equal(C._at_least_as_strong("ordering:o", o, Object.assign({}, o, { requires: ["c"] })), false);
    const i = { type: "approval", approves_state: "P", response_schema: { a: 1 }, required_role: "" };
    assert.equal(C._at_least_as_strong("interaction:R", i, Object.assign({}, i, { required_role: "r" })), true);
    assert.equal(C._at_least_as_strong("interaction:R", Object.assign({}, i, { required_role: "r" }), i), false);
    assert.equal(C._at_least_as_strong("interaction:R", i, Object.assign({}, i, { response_schema: { a: true } })), true);
    const e = { claim: "c", verifier_tool: "t", subject_vars: ["a"] };
    assert.equal(C._at_least_as_strong("evidence:T:c", e, Object.assign({}, e, { subject_vars: ["a", "b"] })), true);
    assert.equal(C._at_least_as_strong("other:x", e, e), false);
    const prev = { "ordering:o": o }, cur = {};
    const r = C._requirement_regressions(prev, cur, new Set(["o"]));
    assert.deepEqual(r.map((f) => f.to_json()), [{ code: "REQUIREMENT_DROPPED", message: "repair removed requirement ordering:o (named by a previous diagnostic)",
      severity: "error", detail: { requirement: "ordering:o" } }]);
    assert.deepEqual(Object.keys(C._advance_baseline(prev, { "ordering:p": o, "ordering:q": o }, new Set(["ordering:q"]))), ["ordering:o", "ordering:p"]);
  });
})();
