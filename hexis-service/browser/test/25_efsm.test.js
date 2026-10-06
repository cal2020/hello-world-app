/* Parity of HX.efsm (and the pydantic emulation HX.efsm.pyd) with artifacts/efsm.py
 * (golden/models_efsm.json, golden/models_coerce.json). */
(function () {
  const E = HX.efsm;
  const parse = (t) => HX.canonical.strict_loads(t);
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const errKey = (e) => e[0] + "\u0000" + JSON.stringify(e[1]);
  const sortErrs = (list) => list.map((e) => [e[0], e[1]]).sort((a, b) => (errKey(a) < errKey(b) ? -1 : errKey(a) > errKey(b) ? 1 : 0));

  /** Recursively compare key order of two JSON trees; returns the first differing path or null. */
  function orderDiff(a, b, path) {
    path = path || "$";
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return path + " (array)";
      for (let i = 0; i < a.length; i++) { const d = orderDiff(a[i], b[i], path + "[" + i + "]"); if (d) return d; }
      return null;
    }
    if (a !== null && typeof a === "object") {
      if (b === null || typeof b !== "object") return path + " (object)";
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.join("\u0001") !== kb.join("\u0001")) return path + ": " + JSON.stringify(ka) + " vs " + JSON.stringify(kb);
      for (const k of ka) { const d = orderDiff(a[k], b[k], path + "." + k); if (d) return d; }
    }
    return null;
  }

  function run(c) {
    const input = parse(c.input_json);
    try {
      return { out: c.name === "Machine.model_validate without format" ? E.Machine.model_validate(input) : E.load_machine(input) };
    } catch (err) {
      return { err };
    }
  }

  test("load_machine accepts/rejects exactly like pydantic; canonical text, dump and key order match", () => {
    const G = golden("models_efsm");
    let ok = 0;
    for (const c of G.cases) {
      const { out, err } = run(c);
      if (c.py === "ok") {
        assert.ok(!err, `${c.name}: should accept: ${err && err.message}`);
        assert.equal(E.pyd.canonical_text(E.MACHINE_TYPE, out), c.canonical, `${c.name}: canonical text`);
        const py = JSON.parse(c.dump_json);
        assert.deepEqual(plain(out), py, `${c.name}: dump`);
        assert.equal(orderDiff(plain(out), py), null, `${c.name}: key order`);
        ok++;
      } else {
        assert.ok(err instanceof E.EfsmError, `${c.name}: should reject (${c.py}) but ${err ? err.message : "accepted"}`);
        if (c.py === "error") {
          assert.deepEqual(sortErrs(err.errors.map((e) => [e.type, e.loc])), sortErrs(c.errors), `${c.name}: error types/locs`);
        } else if (c.exc === "TypeError") {
          assert.ok(err.errors.some((e) => e.type === "python_type_error"), `${c.name}: TypeError in validator`);
        } else {
          assert.equal(c.exc, "ValueError");
          assert.deepEqual(err.errors.map((e) => e.loc), [["format"]], c.name);
        }
      }
    }
    assert.ok(ok >= 150, `only ${ok} accepted cases`);
    assert.ok(G.cases.length >= 300);
  });

  test("helpers: ordered_transitions, var, var_types, terminal match the model methods", () => {
    for (const c of golden("models_efsm").cases) {
      if (c.py !== "ok" || !c.ordered) continue;
      const { out } = run(c);
      for (const sid of Object.keys(c.ordered)) {
        assert.deepEqual(E.ordered_transitions(out.states[sid]).map((t) => t.to), c.ordered[sid], `${c.name} ${sid}`);
        assert.ok(E.ordered_transitions(out.states[sid]).every((t) => out.states[sid].transitions.indexOf(t) >= 0));
      }
      assert.deepEqual(Object.entries(E.var_types(out)), c.var_types, c.name);
      for (const n of Object.keys(c.vars)) assert.deepEqual(plain(E.var(out, n)), c.vars[n], `${c.name} var ${n}`);
      for (const t of Object.keys(c.terminals)) assert.deepEqual(plain(E.terminal(out, t)), c.terminals[t], `${c.name} terminal ${t}`);
      assert.deepEqual(plain(E.to_json(out)), plain(out));
      assert.notEqual(E.to_json(out), out, "to_json returns a fresh object");
    }
  });

  test("normalized machines: null-prototype maps are safe for any key; re-normalization is idempotent", () => {
    const c = golden("models_efsm").cases.find((x) => x.name === "states proto names");
    const m = run(c).out;
    assert.equal(Object.getPrototypeOf(m.states), null);
    assert.ok("__proto__" in m.states && "constructor" in m.states);
    assert.ok(!("toString" in m.states) && m.states.toString === undefined);
    assert.deepEqual(Object.keys(m.states), ["__proto__", "constructor"]);
    assert.equal(Object.getPrototypeOf(E.var_types(m)), null);
    const again = E.load_machine(m);
    assert.equal(E.pyd.canonical_text(E.MACHINE_TYPE, again), E.pyd.canonical_text(E.MACHINE_TYPE, m));
    assert.equal(E.machine_digest(m), "sha256:" + HX.canonical.sha256_hex(c.canonical));
  });

  test("documented deviations: integer-like map keys, unsafe ints, non-finite floats, pydantic's odd int strings", () => {
    const G = golden("models_efsm");
    const expected = {
      "integer-like state id": "dict_key_integer_like", "integer-like binds key": "dict_key_integer_like",
      "integer-like tool input key": "dict_key_integer_like", "unsafe int": "int_unsafe", "unsafe int string": "int_unsafe",
      "inf float string": "finite_number", "nan float string": "finite_number", "overflow float string": "finite_number",
      "pydantic odd int string": "int_parsing", "pydantic odd int string 2": "int_parsing",
    };
    assert.deepEqual(G.deviations.map((d) => d.name).sort(), Object.keys(expected).sort());
    for (const d of G.deviations) {
      let err;
      try { E.load_machine(JSON.parse(d.input_json)); } catch (e) { err = e; }
      assert.ok(err instanceof E.EfsmError, d.name);
      assert.deepEqual(err.errors.map((e) => e.type), [expected[d.name]], d.name);
    }
    /* JS-only inputs Python cannot express are rejected too */
    for (const bad of [{ format: "efsm-v1", skill_id: "\ud800", initial: "A" }, { format: "efsm-v1", skill_id: "s", initial: undefined },
      { format: "efsm-v1", skill_id: "s", initial: "A", variables: [{ name: "v", init: NaN }] }]) {
      assert.throws(() => E.load_machine(bad), E.EfsmError);
    }
  });

  test("lax coercions agree with pydantic-core (int/float/bool), deviations only where documented", () => {
    const G = golden("models_coerce");
    const dev = { int: {}, float: {}, bool: {} };
    for (const kind of ["int", "float", "bool"]) {
      for (const c of G[kind]) {
        const r = E.pyd.validate_type({ k: kind }, c.input);
        const label = `${kind} ${JSON.stringify(c.input)}`;
        if (c.py === "ok" && !c.deviation) {
          assert.deepEqual(r.errors, [], `${label}: should accept`);
          if (kind === "float") assert.equal(HX.canonical.py_float_repr(r.value), c.value, label);
          else assert.equal(r.value, c.value, label);
        } else if (c.py === "ok") {
          assert.ok(r.errors.length, `${label}: deviation ${c.deviation} should be rejected`);
          dev[kind][c.deviation] = (dev[kind][c.deviation] || 0) + 1;
        } else {
          assert.ok(r.errors.length, `${label}: should reject (${c.type})`);
          assert.equal(r.errors[0].type, c.type, label);
        }
      }
    }
    assert.deepEqual(Object.keys(dev.bool), []);
    assert.deepEqual(Object.keys(dev.float).sort(), ["nonfinite"]);
    assert.ok(Object.keys(dev.int).every((k) => k === "quirk" || k === "unsafe"));
    assert.ok(G.int.length + G.float.length + G.bool.length > 3000);
  });

  test("model-aware canonical text: integral float fields keep Python's float repr", () => {
    const m = E.load_machine({ format: "efsm-v1", skill_id: "s", initial: "J",
      states: { J: { id: "J", action: { kind: "judge", prompt: "p", reads: ["a"], writes: ["b"], labels: ["abstain"], error_rate: 1 } } },
      thresholds: { acc_thr: 1, loop_margin: "2", holdout_ratio: true },
      variables: [{ name: "a", init: 1 }] });
    const text = E.pyd.canonical_text(E.MACHINE_TYPE, m);
    assert.ok(text.includes('"error_rate":1.0'));
    assert.ok(text.includes('"acc_thr":1.0') && text.includes('"loop_margin":2.0') && text.includes('"holdout_ratio":1.0'));
    assert.ok(text.includes('"init":1,'), "Any fields keep integers");
    assert.ok(HX.canonical.canonical_text(m).includes('"error_rate":0') === false);
  });
})();
