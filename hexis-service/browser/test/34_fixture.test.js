/* Parity of HX.fixture with demo/procurement_fixture.py (golden/fixture.json). */
(function () {
  const FX = HX.fixture;
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const G = () => golden("fixture");

  test("constants: CAPABILITIES, TASK_INPUT_SCHEMA, DRAFT_SCHEMA, prompts and VARIABLES equal Python", () => {
    const g = G();
    for (const k of ["CAPABILITIES", "TASK_INPUT_SCHEMA", "DRAFT_SCHEMA", "EXTRACT_PROMPT", "REPAIR_PROMPT", "VARIABLES"]) {
      assert.deepEqual(plain(FX[k]), g[k], k);
    }
    assert.deepEqual(FX.TASK_INPUT_SCHEMA, HX.fixture.deployment_policy().task_input_schema);
  });

  test("deployment_policy(environment): DeploymentPolicy dump and digest equal Python", () => {
    const g = G();
    for (const env of Object.keys(g.deployment_policy)) {
      const dp = FX.deployment_policy(env);
      assert.deepEqual(plain(dp), g.deployment_policy[env].dump, env);
      assert.equal(HX.pkg.DeploymentPolicy.digest(dp), g.deployment_policy[env].digest, env);
      assert.equal(HX.canonical.digest(dp), g.deployment_policy[env].digest, `${env} plain digest`);
      assert.equal(HX.canonical.digest(dp.task_input_schema), g.deployment_policy[env].task_input_schema_digest);
      assert.deepEqual(Object.keys(dp), ["environment", "execution_policy", "task_input_schema", "profile"]);
    }
    assert.deepEqual(plain(FX.deployment_policy()), g.deployment_policy_default);
    let err;
    try { FX.deployment_policy(null); } catch (e) { err = e; }
    assert.ok(err instanceof HX.pkg.PackageError);
    assert.deepEqual(err.errors.map((e) => [e.type, e.loc]), g.deployment_policy_none);
    const a = FX.deployment_policy(), b = FX.deployment_policy();
    a.task_input_schema.properties.supplier_ref.pattern = "x";
    assert.notEqual(b.task_input_schema.properties.supplier_ref.pattern, "x", "fresh copies");
    assert.notEqual(FX.TASK_INPUT_SCHEMA.properties.supplier_ref.pattern, "x");
  });

  test("machine_dict(defect) and contracts_dict(): raw dicts, key order and normalized canonical forms equal Python", () => {
    const g = G();
    for (const flag of [false, true]) {
      const want = g.machine_dict[String(flag)];
      for (const raw of [FX.machine_dict(flag), FX.machine_dict({ defect: flag })]) {
        assert.deepEqual(plain(raw), want.raw);
        assert.deepEqual(Object.keys(raw.states), want.state_order);
        assert.deepEqual(raw.variables.map((v) => v.name), want.variable_order);
        const m = HX.efsm.load_machine(raw);
        assert.equal(HX.efsm.pyd.canonical_text(HX.efsm.MACHINE_TYPE, m), want.canonical);
        assert.equal(HX.efsm.machine_digest(m), want.digest);
      }
    }
    const cd = FX.contracts_dict();
    assert.deepEqual(plain(cd), g.contracts_dict);
    for (const k of Object.keys(g.contracts_key_orders)) assert.deepEqual(Object.keys(cd[k]), g.contracts_key_orders[k], k);
    assert.equal(HX.pkg.Contracts.canonical_text(cd), g.contracts_canonical);
    const a = FX.machine_dict(), b = FX.machine_dict();
    a.states.READ_INTAKE.clause = "changed";
    a.variables[0].name = "changed";
    assert.equal(b.states.READ_INTAKE.clause, "S1.1", "fresh copies");
    assert.equal(FX.machine_dict().variables[0].name, "supplier_ref");
  });

  test("FixtureCompilerModel: model_id, settings and draft() per diagnostics equal Python", () => {
    const g = G().compiler_model;
    const model = new FX.FixtureCompilerModel();
    assert.equal(model.model_id, g.model_id);
    assert.equal(FX.FixtureCompilerModel.model_id, g.model_id);
    assert.deepEqual(model.settings, g.settings);
    for (const d of g.drafts) {
      const out = model.draft({ clauses: [] }, d.diagnostics, 1);
      assert.deepEqual(plain(out), d.draft, JSON.stringify(d.diagnostics));
      assert.equal(out.machine.states.REPAIR_DRAFT.transitions[0].to === "REQUEST_APPROVAL", d.defect);
    }
    assert.equal(g.bad_diagnostic, "AttributeError");
    assert.throws(() => model.draft({}, ["not a dict"], 1), (e) => e instanceof HX.HXError && e.code === "AttributeError");
    assert.throws(() => model.draft({}, null, 1), (e) => e instanceof HX.HXError && e.code === "TypeError");
  });

  /** Where the REPAIR_DRAFT edge goes, or {exc, message} (Python class name as HXError code). */
  function repairEdge(fn) {
    let out;
    try { out = fn(); } catch (e) {
      assert.ok(e instanceof HX.HXError, `native ${e && e.name}: ${e && e.message}`);
      return { exc: e.code, message: e.message };
    }
    const m = out.machine || out;
    return { to: m.states.REPAIR_DRAFT.transitions[0].to };
  }

  test("Python truthiness and iteration: machine_dict(x), machine_dict({defect: x}) and draft() diagnostics", () => {
    const g = G();
    for (const c of g.machine_dict_truthiness.positional) {
      assert.deepEqual(repairEdge(() => FX.machine_dict(c.arg)), c.result, `machine_dict(${JSON.stringify(c.arg)})`);
    }
    for (const c of g.machine_dict_truthiness.keyword) {
      assert.deepEqual(repairEdge(() => FX.machine_dict(c.kwargs)), c.result, `machine_dict(**${JSON.stringify(c.kwargs)})`);
    }
    const model = new FX.FixtureCompilerModel();
    for (const c of g.compiler_model.diagnostics_iteration) {
      assert.deepEqual(repairEdge(() => model.draft({}, c.diagnostics, 1)), c.result, `draft({}, ${JSON.stringify(c.diagnostics)}, 1)`);
    }
    /* the verifier's cases */
    assert.equal(FX.machine_dict({ defect: [] }).states.REPAIR_DRAFT.transitions[0].to, "VALIDATE_DRAFT");
    assert.equal(FX.machine_dict([1]).states.REPAIR_DRAFT.transitions[0].to, "REQUEST_APPROVAL");
    assert.equal(model.draft({}, {}, 1).machine.states.REPAIR_DRAFT.transitions[0].to, "REQUEST_APPROVAL");
  });
})();
