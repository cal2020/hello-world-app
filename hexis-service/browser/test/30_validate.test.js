/* Parity of HX.validate (artifacts/validate.py) and HX.diff (artifacts/diff.py) with the Python reference
 * (golden/validate_conformance.json, validate_random_a.json, validate_random_b.json from gen_validate.py). */
(function () {
  const plain = (x) => JSON.parse(JSON.stringify(x));
  /* codes Python emits while iterating a set: their relative order is arbitrary per Python process */
  const NONDET = new Set(["DUPLICATE_VARIABLE", "DUPLICATE_TERMINAL", "WRITE_OWNERSHIP", "NO_ROUTE_TO_STOP"]);

  let BASE = null;
  function base() {
    if (!BASE) BASE = plain(HX.compile.compile_procurement().package);
    return BASE;
  }

  function walk(d, path) {
    for (const k of path) d = d[k < 0 && Array.isArray(d) ? d.length + k : k];
    return d;
  }
  const idx = (parent, k) => (Array.isArray(parent) && k < 0 ? parent.length + k : k);
  /** The same edit operations as gen_validate.apply_ops. */
  function apply_ops(d, ops) {
    for (const op of ops) {
      const [kind, path] = op;
      const parent = () => walk(d, path.slice(0, -1));
      const last = path[path.length - 1];
      if (kind === "set") { const p = parent(); p[idx(p, last)] = plain(op[2]); }
      else if (kind === "del") { const p = parent(); if (Array.isArray(p)) p.splice(idx(p, last), 1); else delete p[last]; }
      else if (kind === "ins") parent().splice(last, 0, plain(op[2]));
      else if (kind === "app") walk(d, path).push(plain(op[2]));
      else if (kind === "appcopy") walk(d, op[2]).push(plain(walk(d, path)));
      else if (kind === "setcopy") { const dst = op[2]; walk(d, dst.slice(0, -1))[dst[dst.length - 1]] = plain(walk(d, path)); }
      else if (kind === "perm") { const old = walk(d, path); parent()[last] = op[2].map((i) => old[i]); }
      else if (kind === "order") { const old = walk(d, path); const o = {}; for (const k of op[2]) o[k] = old[k]; parent()[last] = o; }
      else if (kind === "chain") {
        const states = d.machine.states;
        states[op[1]].transitions[0].to = "C0";
        for (let i = 0; i < op[2]; i++) {
          states["C" + i] = { id: "C" + i, action: { kind: "model", prompt: "p", reads: [], writes: [] },
            transitions: [{ if: "", to: i + 1 < op[2] ? "C" + (i + 1) : op[3] }] };
        }
      }
      else if (kind === "strrep") { const p = parent(); p[last] = p[last].split(op[2]).join(op[3]); }
      else throw new Error("unknown op " + kind);
    }
    return d;
  }

  function exc_name(e) {
    if (e instanceof HX.guards.GuardError) return "GuardError";
    if (e instanceof HX.pkg.PackageError || e instanceof HX.efsm.EfsmError || e instanceof HX.catalog.CatalogError) return "ValidationError";
    if (e instanceof HX.HXError) return e.code;
    throw e;
  }

  /** Sort runs of consecutive same-code findings whose order Python leaves to set iteration. */
  function canon_order(fs) {
    const out = [];
    for (let i = 0; i < fs.length;) {
      let j = i + 1;
      if (NONDET.has(fs[i].code)) while (j < fs.length && fs[j].code === fs[i].code && (fs[i].code !== "WRITE_OWNERSHIP" || fs[j].state === fs[i].state)) j++;
      out.push(...fs.slice(i, j).map((f) => JSON.stringify(f)).sort().map((s) => JSON.parse(s)));
      i = j;
    }
    return out;
  }
  /** Messages the port does not reproduce word for word (documented): guard syntax errors, CATALOG_SCHEMA text. */
  function relax(f) {
    if (f.code === "CATALOG_SCHEMA") return Object.assign({}, f, { message: f.message.split(" invalid: ")[0] });
    if (f.message && f.message.indexOf("guard syntax error") >= 0) return Object.assign({}, f, { message: "<syntax>" });
    return f;
  }

  function build(c) {
    const d = apply_ops(plain(base()), c.ops);
    if (c.mode === "reseal") { d.artifact_hash = ""; return HX.pkg.sealed(d); }
    return HX.pkg.normalize_package(d);
  }
  let CATALOG = null;
  const catalog = () => CATALOG || (CATALOG = HX.catalog.load_catalog(HX.data.tool_catalog));

  function check_case(c, variants, where) {
    let pkg;
    if (c.load_error) {
      assert.throws(() => build(c), (e) => exc_name(e) === "ValidationError", where + ": must be rejected like pydantic");
      return;
    }
    pkg = build(c);
    assert.equal(pkg.artifact_hash, c.hash, where + ": artifact_hash");
    let text = HX.data.skill_md;
    for (const [a, b] of c.skill_edits || []) text = text.split(a).join(b);
    const dp = HX.pkg.DeploymentPolicy.model_validate(apply_ops(plain(HX.fixture.deployment_policy()), c.policy_ops || []));
    const cat = c.catalog_ops ? HX.catalog.load_catalog(apply_ops(plain(catalog()), c.catalog_ops)) : catalog();
    c.variants.forEach((vi, k) => {
      const v = variants[vi];
      const want = c.runs[k];
      const w = where + " variant " + vi;
      let rep;
      if (c.js_deviation) {
        assert.throws(() => HX.validate.validate_package(pkg, cat, v.profile, {}), (e) => exc_name(e) === c.js_deviation, w);
        assert.ok(!want.exc, w + ": documented deviation: Python accepts");
        return;
      }
      try {
        rep = HX.validate.validate_package(pkg, cat, v.profile, { skill_text: v.skill ? text : null, deployment_policy: v.policy ? dp : null });
      } catch (e) {
        assert.ok(want.exc, w + ": unexpected " + (e && e.stack));
        assert.equal(exc_name(e), want.exc, w + ": exception class");
        return;
      }
      assert.ok(!want.exc, w + ": Python raised " + want.exc);
      const rj = rep.to_json();
      assert.equal(rj.passed, want.passed, w + ": passed");
      assert.equal(rep.passed, want.passed, w);
      assert.deepEqual([...rep.codes()].sort(), want.codes, w + ": codes");
      const got = plain(rj.findings);
      const tuple = (f) => [f.code, f.severity, f.state, f.edge, f.variable, f.clause];
      const g1 = canon_order(got), w1 = canon_order(want.findings);
      assert.deepEqual(g1.map(tuple), w1.map(tuple), w + ": ordered (code, severity, state, edge, variable, clause)");
      assert.deepEqual(g1.map(relax), w1.map(relax), w + ": findings");
      assert.deepEqual(plain(rj.analyses), want.analyses, w + ": analyses");
      /* digest comparable unless a relaxed message or a set-iteration order differs (golden keys are sorted) */
      const exact = HX.canonical.canonical_text(got) === HX.canonical.canonical_text(want.findings) && !want.float_ints;
      if (exact) assert.equal(rj.report_digest, want.digest, w + ": report_digest");
    });
    if (c.diff) {
      const cmpdiff = (fn, want, label) => {
        if (want.exc) { assert.throws(fn, (e) => exc_name(e) === want.exc, label); return; }
        assert.deepEqual(plain(fn()), want, label);
      };
      cmpdiff(() => HX.diff.package_diff(base(), pkg, catalog()), c.diff, where + ": package_diff");
      cmpdiff(() => HX.diff.package_diff(pkg, base(), null), c.diff_rev, where + ": package_diff reversed");
    }
  }

  test("validate: base package equals Python's compiled package", () => {
    const g = golden("validate_conformance");
    assert.equal(base().artifact_hash, g.base_hash);
    assert.equal(HX.validate.VALIDATOR_VERSION, g.validator_version);
  });

  test("documented deviation #6: integral-float counter init relies on strict_loads", () => {
    const d = plain(base());
    let counter = null;
    for (const st of Object.values(d.machine.states)) for (const t of st.transitions) if (t.inc) counter = counter || t.inc;
    assert.ok(counter, "the procurement package has a loop counter");
    const v = d.machine.variables.find((x) => x.name === counter);
    const codes = (init) => {
      v.init = init;
      const r = HX.validate.validate_package(HX.pkg.sealed(HX.pkg.normalize_package(plain(d))), HX.data.tool_catalog);
      return r.findings.map((f) => f.code);
    };
    /* Python: init 0.0 -> COUNTER_INIT. JSON.parse cannot tell 0.0 from 0, so such a dump passes in JS ... */
    assert.ok(codes(JSON.parse("0.0")).indexOf("COUNTER_INIT") < 0);
    assert.ok(codes(0.5).indexOf("COUNTER_INIT") >= 0);
    /* ... which is why every package/draft must go through strict_loads, which refuses the literal */
    assert.throws(() => HX.canonical.strict_loads('{"init": 0.0}'), HX.canonical.CanonicalError);
    assert.throws(() => HX.canonical.strict_loads(JSON.stringify(plain(d)).replace('"init":0.5', '"init":0.0')),
      HX.canonical.CanonicalError);
  });

  test("documented deviation #7: counterexamples at or above 2^53 are reported as digit strings (report stays digestible)", () => {
    const d = plain(base());
    const sid = Object.keys(d.machine.states).find((s) => d.machine.states[s].transitions.length >= 2);
    d.machine.variables.push({ name: "x", type: "integer", init: 0, init_from: null });
    d.contracts.variables.x = { owner: "engine", schema: { type: "integer" } };
    const tr = d.machine.states[sid].transitions;
    for (const [a, b, want] of [["x >= 1e16", "x == 1e16", "10000000000000000"], ["x > 1e16", "x > 2e16", "20000000000000004"]]) {
      tr[0]["if"] = a; tr[1]["if"] = b;
      /* Python: COUNTEREXAMPLE {'x': 10000000000000000} / {'x': 20000000000000001} (guards.md #6), GUARDS_OVERLAP */
      const r = HX.validate.validate_package(HX.pkg.sealed(HX.pkg.normalize_package(plain(d))), HX.data.tool_catalog);
      assert.equal(r.passed, false);
      const f = r.findings.find((x) => x.code === "GUARDS_OVERLAP" && x.state === sid);
      assert.ok(f, a + " / " + b);
      assert.deepEqual(plain(f.detail), { counterexample: { x: want } });
      const an = r.analyses.find((x) => x.state === sid);
      assert.equal(an.status, "COUNTEREXAMPLE");
      assert.deepEqual(plain(an.counterexample), { x: want });
      const j = r.to_json(); /* would throw CanonicalError with the raw number */
      assert.match(j.report_digest, /^sha256:[0-9a-f]{64}$/);
    }
    /* guards.md #6 consumers: the raw counterexample (equal to Python's value here) cannot be canonicalized */
    const raw = HX.guards.analyze_disjoint(["x >= 1e16", "x == 1e16"], { x: "integer" });
    assert.equal(raw.status, "COUNTEREXAMPLE");
    assert.equal(raw.counterexample.x, 1e16);
    assert.throws(() => HX.canonical.canonical_text({ counterexample: raw.counterexample }), HX.canonical.CanonicalError);
    assert.deepEqual(plain(HX.validate._digestible_counterexample({ a: 2 ** 53 - 1, b: 1.5, c: "s", d: true, e: 2 ** 60 })),
      { a: 2 ** 53 - 1, b: 1.5, c: "s", d: true, e: "1152921504606846976" });
  });

  test("validate: conformance mutations (test_static_admission, test_review_admission_validator) match Python", () => {
    const g = golden("validate_conformance");
    for (const c of g.cases) check_case(c, g.variants, c.name);
  });

  for (const part of ["a", "b"]) {
    test(`validate: seeded random mutations (${part}) match Python, with package_diff`, () => {
      const g = golden("validate_random_" + part);
      assert.ok(g.cases.length >= 200);
      for (const c of g.cases) check_case(c, g.variants, c.name);
    });
  }

  test("validate: helper functions match Python", () => {
    const h = golden("validate_conformance").helpers;
    const V = HX.validate;
    for (const [g, c, want] of h.edge_bound) {
      let got;
      try { got = V.edge_bound(g, c); } catch (e) { got = { exc: exc_name(e) }; }
      assert.deepEqual(got, want, `edge_bound(${g}, ${c})`);
    }
    for (const [g, want] of h.requires_approved) assert.equal(V._requires_approved(g, "approval_decision"), want, g);
    for (const [x, want] of h.template_vars) assert.deepEqual([...V.template_vars(x)].sort(HX.util.cmp_codepoints), want, JSON.stringify(x));
    const pkg = base();
    for (const [s, want] of h.selector_problem) assert.equal(V.selector_problem(s, pkg, catalog()), want, s);
    for (const [a, b, want] of h.policy_widening) {
      assert.deepEqual(V.policy_widening_findings(HX.pkg.ExecutionPolicy.model_validate(a), HX.pkg.ExecutionPolicy.model_validate(b)), want);
    }
    assert.deepEqual(plain(V.derived_ordering(pkg)), h.derived_ordering);
    assert.deepEqual(plain(V.successors(pkg.machine)), h.successors);
    for (const s of Object.keys(h.reachable)) {
      assert.deepEqual([...V.reachable(pkg.machine, s)].sort(HX.util.cmp_codepoints), h.reachable[s], s);
    }
    for (const [req, full] of h.check_ordering) assert.deepEqual(V.check_ordering(pkg, req), full, req.id);
  });

  test("validate: check_ordering with a restricted state set", () => {
    const h = golden("validate_conformance").helpers;
    const pkg = base();
    const sids = Object.keys(pkg.machine.states);
    for (const [req, , part] of h.check_ordering) {
      const restricted = req.id.startsWith("x") ? sids.filter((_, i) => i % 2 === 0) : ["READ_INTAKE", "LOOKUP_SUPPLIER"];
      assert.deepEqual(HX.validate.check_ordering(pkg, req, restricted), part, req.id);
    }
  });

  test("validate: Finding.to_json drops None, {} and '' but keeps edge 0; report API", () => {
    const F = HX.validate.Finding;
    assert.deepEqual(new F("X", "m", { edge: 0, state: "", detail: {} }).to_json(), { code: "X", message: "m", severity: "error", edge: 0 });
    assert.deepEqual(new F("Y", "m", "warning", { variable: "v", detail: { a: 1 } }).to_json(),
      { code: "Y", message: "m", severity: "warning", variable: "v", detail: { a: 1 } });
    const r = new HX.validate.ValidationReport("sandbox", "h", [new F("A", "a"), new F("B", "b", "warning"), new F("A", "c")], []);
    assert.equal(r.passed, false);
    assert.deepEqual(r.errors().map((f) => f.message), ["a", "c"]);
    assert.deepEqual([...r.codes()], ["A"]);
    const rj = r.to_json();
    assert.deepEqual(Object.keys(rj), ["validator", "profile", "artifact_hash", "passed", "findings", "analyses", "report_digest"]);
  });
})();
