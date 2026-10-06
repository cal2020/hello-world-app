/* Parity of HX.pkg (artifacts/package.py) and HX.catalog (tools/catalog.py)
 * (golden/models_pkg.json, golden/models_catalog.json). */
(function () {
  const P = HX.pkg;
  const C = HX.catalog;
  const parse = (t) => HX.canonical.strict_loads(t);
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const sha = (s) => HX.canonical.sha256_hex(s);
  const errKey = (e) => e[0] + "\u0000" + JSON.stringify(e[1]);
  const sortErrs = (list) => list.map((e) => [e[0], e[1]]).sort((a, b) => (errKey(a) < errKey(b) ? -1 : errKey(a) > errKey(b) ? 1 : 0));
  const jsErrs = (err) => sortErrs(err.errors.map((e) => [e.type, e.loc]));
  /** First path where the key ORDER of two JSON trees differs, or null. */
  function orderDiff(a, b, path) {
    path = path || "$";
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return path;
      for (let i = 0; i < a.length; i++) { const d = orderDiff(a[i], b[i], path + "[" + i + "]"); if (d) return d; }
      return null;
    }
    if (a !== null && typeof a === "object") {
      if (b === null || typeof b !== "object") return path;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.join("\u0001") !== kb.join("\u0001")) return path + ": " + JSON.stringify(ka) + " vs " + JSON.stringify(kb);
      for (const k of ka) { const d = orderDiff(a[k], b[k], path + "." + k); if (d) return d; }
    }
    return null;
  }

  /** Replay the generator's mutation ops (Python dict/list semantics). */
  function applyOps(doc, ops) {
    for (const op of ops) {
      const path = op[1];
      let parent = doc;
      for (const k of path.slice(0, -1)) parent = parent[k];
      const key = path[path.length - 1];
      if (op[0] === "set") {
        if (Array.isArray(parent)) parent[key] = op[2];
        else Object.defineProperty(parent, key, { value: op[2], enumerable: true, writable: true, configurable: true });
      } else if (op[0] === "del") {
        delete parent[key];
      } else if (op[0] === "pop") {
        parent.splice(key, 1);
      } else {
        throw new Error("unknown op " + op[0]);
      }
    }
    return doc;
  }

  function attempt(fn) {
    try { return { out: fn() }; } catch (err) { return { err }; }
  }

  function checkPackage(name, input, c) {
    const { out, err } = attempt(() => P.normalize_package(input));
    if (c.py === "ok") {
      assert.ok(!err, `${name}: should accept: ${err && err.message}`);
      assert.equal(sha(P.MachinePackage.canonical_text(out)), c.canonical_sha, `${name}: canonical dump`);
      assert.equal(P.compute_hash(out), c.compute_hash, `${name}: compute_hash`);
      assert.equal(P.verify_hash(out), c.verify_hash, `${name}: verify_hash`);
      if (c.sealed_hash) assert.equal(P.sealed(out).artifact_hash, c.sealed_hash, `${name}: sealed`);
    } else {
      assert.ok(err instanceof P.PackageError, `${name}: should reject: ${err ? err.message : "accepted"}`);
      if (c.py === "error") assert.deepEqual(jsErrs(err), sortErrs(c.errors), `${name}: errors`);
    }
    return out;
  }

  test("anchors: JS compute_hash of the Python-built initial and refined packages equals their artifact_hash", () => {
    const G = golden("models_pkg");
    for (const which of ["initial", "refined"]) {
      const a = G.anchors[which];
      const pkg = P.normalize_package(parse(a.dump_json));
      assert.equal(P.compute_hash(pkg), a.artifact_hash, which);
      assert.equal(a.compute_hash, a.artifact_hash);
      assert.equal(P.verify_hash(pkg), true);
      assert.equal(sha(P.MachinePackage.canonical_text(pkg)), a.canonical_sha, which);
      assert.equal(sha(HX.canonical.canonical_text(P.hash_payload(pkg))), a.hash_payload_sha, which);
      assert.deepEqual(Object.keys(P.hash_payload(pkg)), P.HASHED_FIELDS);
      assert.deepEqual(plain(pkg), JSON.parse(a.dump_json), which);
      assert.equal(orderDiff(plain(pkg), JSON.parse(a.dump_json)), null, `${which}: key order`);
    }
    assert.equal(G.anchors.initial.artifact_hash, HX.data.python_build.initial_artifact_hash);
    assert.equal(G.anchors.refined.artifact_hash, HX.data.python_build.refined_artifact_hash);
  });

  test("package mutations: accept/reject, pydantic errors, canonical dump and hashes match Python", () => {
    const G = golden("models_pkg");
    let ok = 0;
    for (const c of G.mutations) {
      const doc = applyOps(parse(G.base[c.base]), c.ops);
      if (checkPackage(c.name, doc, c)) ok++;
    }
    for (const c of G.targeted) if (checkPackage(c.name, parse(c.input_json), c)) ok++;
    assert.ok(ok >= 60, `only ${ok} accepted`);
  });

  test("float-typed fields: integral max_spend_usd, thresholds and judge error_rate hash exactly like Python", () => {
    const G = golden("models_pkg");
    assert.ok(G.float_packages.length >= 4);
    for (const c of G.float_packages) {
      const sealed = P.sealed(parse(c.input_json));
      assert.equal(sealed.artifact_hash, c.sealed_hash, c.name);
      assert.equal(P.verify_hash(sealed), true);
      assert.equal(sha(P.MachinePackage.canonical_text(sealed)), c.canonical_sha, c.name);
      assert.equal(HX.efsm.machine_digest(sealed.machine), c.machine_digest, c.name);
    }
  });

  test("sealed() returns a sealed copy; verify_hash detects tampering; unsealed packages do not verify", () => {
    const base = parse(golden("models_pkg").base.initial);
    const s = P.sealed(base);
    assert.notEqual(s, base);
    assert.equal(P.verify_hash(s), true);
    const t = P.normalize_package(s);
    t.machine.max_steps = 39;
    assert.equal(P.verify_hash(t), false);
    t.artifact_hash = "";
    assert.equal(P.verify_hash(t), false);
    assert.equal(P.verify_hash(P.sealed(t)), true);
  });

  test("admission signatures: sign_admission / verify_admission agree with Python", () => {
    const G = golden("models_pkg");
    for (const a of G.admission) {
      const signed = P.sign_admission(a.record, a.key);
      assert.equal(signed.signature, a.signature);
      assert.equal(P.verify_admission(signed, a.key), a.verify);
      assert.equal(P.verify_admission(signed, a.key + "x"), a.verify_wrong_key);
      assert.equal(P.verify_admission(Object.assign({}, signed, { key_id: "other" }), a.key), a.verify_tampered);
      assert.equal(P.verify_admission(a.record, a.key), a.verify_unsigned);
      assert.equal(P.verify_admission(signed, HX.util.utf8(a.key)), a.verify, "bytes key");
    }
    const b = G.admission_binary;
    const key = new Uint8Array(b.key_hex.match(/../g).map((h) => parseInt(h, 16)));
    assert.equal(P.sign_admission(b.record, key).signature, b.signature);
    assert.equal(P.verify_admission(P.sign_admission(b.record, key), key), b.verify);
    /* deviation: Python's hmac.compare_digest raises TypeError on a non-ASCII signature; JS reports invalid */
    assert.equal(G.admission_nonascii_signature, "TypeError");
    assert.equal(P.verify_admission(Object.assign({}, b.record, { signature: "hmac-sha256:\u00e9" }), "k"), false);
    assert.throws(() => P.sign_admission({ artifact_hash: "h" }, "k"), P.PackageError);
  });

  test("sub-models (Contracts, ExecutionPolicy, AdmissionRecord, VariableContract, DeploymentPolicy) match pydantic", () => {
    for (const c of golden("models_pkg").sub_models) {
      const { out, err } = attempt(() => P[c.model].model_validate(parse(c.input_json)));
      if (c.py === "ok") {
        assert.ok(!err, `${c.model}: ${err && err.message}`);
        assert.equal(P[c.model].canonical_text(out), c.canonical, c.model);
        assert.deepEqual(plain(out), JSON.parse(c.dump_json), c.model);
        assert.equal(orderDiff(plain(out), JSON.parse(c.dump_json)), null, `${c.model}: key order`);
      } else {
        assert.ok(err instanceof P.PackageError, c.model);
        assert.deepEqual(jsErrs(err), sortErrs(c.errors), c.model);
      }
    }
    for (const c of golden("models_pkg").package_digest_of) assert.equal(P.package_digest_of(c.value), c.digest);
  });

  test("catalog anchor: digest(load_catalog(HX.data.tool_catalog)) equals the Python build digest", () => {
    const G = golden("models_catalog");
    const cat = C.load_catalog(HX.data.tool_catalog);
    assert.equal(C.digest(cat), HX.data.python_build.catalog_digest);
    assert.equal(C.digest(cat), G.anchor.digest);
    assert.equal(C.digest(HX.data.tool_catalog), G.anchor.digest, "digest normalizes raw catalogs");
    assert.deepEqual(plain(C.load_catalog(parse(G.raw_json))), JSON.parse(G.anchor.dump_json));
    assert.equal(orderDiff(plain(C.load_catalog(parse(G.raw_json))), JSON.parse(G.anchor.dump_json)), null, "catalog key order");
    assert.deepEqual(C.check_schemas(cat), G.anchor.check_schemas);
    assert.equal(Object.getPrototypeOf(cat.tools), null);
    assert.equal(C.get(cat, "constructor"), null);
    assert.equal(C.get(cat, "erp.create_draft").effect, "reconciliable_write");
    assert.equal(C.is_write(C.get(cat, "erp.create_draft")), true);
    assert.equal(C.is_write(C.get(cat, "erp.read_draft")), false);
    assert.deepEqual(C.validate_against({ type: "string" }, 1), HX.jsonschema.validate_against({ type: "string" }, 1));
  });

  test("catalog mutations and invalid schemas: accept/reject, digest, get, is_write, check_schemas match Python", () => {
    const G = golden("models_catalog");
    const cases = G.mutations.map((c) => [c, applyOps(parse(G.raw_json), c.ops)])
      .concat(G.schemas.map((c) => [c, applyOps(parse(G.raw_json), c.ops)]));
    let ok = 0, stricter = 0;
    for (const [c, doc] of cases) {
      const { out, err } = attempt(() => C.load_catalog(doc));
      if (c.py === "ok") {
        assert.ok(!err, `${c.name}: ${err && err.message}`);
        assert.equal(C.digest(out), c.digest, c.name);
        const js = C.check_schemas(out);
        const jsNames = js.map((e) => e.split(" invalid:")[0]);
        /* never more lenient than python-jsonschema; stricter only for keywords outside the supported subset
           or regex dialect (documented in 15_jsonschema / deviations/models.md) */
        for (const n of c.check_schemas) assert.ok(jsNames.indexOf(n) >= 0, `${c.name}: JS misses invalid ${n}`);
        for (const e of js) {
          const n = e.split(" invalid:")[0];
          if (c.check_schemas.indexOf(n) < 0) {
            assert.ok(/unsupported keyword|regular expression/.test(e), `${c.name}: JS-only finding ${e}`);
            stricter++;
          }
        }
        assert.deepEqual(jsNames.filter((n) => c.check_schemas.indexOf(n) >= 0), c.check_schemas, `${c.name}: order`);
        for (const n of Object.keys(c.get)) assert.deepEqual(plain(C.get(out, n)), c.get[n], `${c.name} get ${n}`);
        for (const n of Object.keys(c.is_write)) assert.equal(C.is_write(out.tools[n]), c.is_write[n], c.name);
        ok++;
      } else {
        assert.ok(err instanceof C.CatalogError, `${c.name}: should reject`);
        assert.deepEqual(jsErrs(err), sortErrs(c.errors), `${c.name}: errors`);
      }
    }
    assert.ok(ok >= 40, `only ${ok} accepted catalogs`);
    const bad = G.schemas.filter((c) => !c.js_stricter), strict = G.schemas.filter((c) => c.js_stricter);
    assert.ok(bad.length >= 35 && bad.every((c) => c.check_schemas.length > 0));
    assert.ok(strict.length >= 5 && strict.every((c) => c.check_schemas.length === 0));
    for (const c of strict) {
      const js = C.check_schemas(C.load_catalog(applyOps(parse(G.raw_json), c.ops))).map((e) => e.split(" invalid:")[0]);
      assert.deepEqual(js, c.js_stricter, c.name);
    }
    assert.ok(stricter >= strict.length);
  });

  test("Python re acceptance: py_regex_check agrees with CPython 3.12 re.compile (accept/reject and exception class)", () => {
    const G = golden("models_regex");
    assert.ok(G.patterns.length >= 10000);
    let accepted = 0, stricter = 0;
    for (const [p, kind, mayBeStricter] of G.patterns) {
      const r = C.py_regex_check(p);
      const label = JSON.stringify(p.length > 80 ? p.slice(0, 80) + "..." : p);
      if (kind !== null) {
        assert.ok(r !== null, `${label}: Python raises ${kind}, the port accepts`);
        if (!mayBeStricter) assert.equal(r.kind, kind, `${label}: exception class (${r.message})`);
      } else if (r !== null) {
        assert.ok(mayBeStricter, `${label}: Python accepts, the port says ${r.kind}: ${r.message}`);
        stricter++;
      } else {
        accepted++;
      }
    }
    assert.ok(accepted >= 3000, `only ${accepted} accepted`);
    assert.ok(stricter > 0 && stricter <= 400);
    /* the documented stricter classes */
    assert.equal(C.py_regex_check("\\N{DIGIT ONE}").kind, "error");
    assert.equal(C.py_regex_check("(?P<é>a)").kind, "error");
    assert.equal(C.py_regex_check("(".repeat(C.PY_RE_MAX_NESTING) + ")".repeat(C.PY_RE_MAX_NESTING)), null);
    assert.equal(C.py_regex_check("(".repeat(C.PY_RE_MAX_NESTING + 1) + ")".repeat(C.PY_RE_MAX_NESTING + 1)).kind, "RecursionError");
    assert.equal(C.py_regex_check("((((".repeat(5000)).kind, "RecursionError", "deep nesting never overflows the JS stack");
    assert.equal(C.py_regex_check("(?(1)".repeat(5000)).kind, "RecursionError");
  });

  test("check_schemas is never more lenient than python-jsonschema: every pattern as pattern and patternProperties key", () => {
    const G = golden("models_regex");
    let both = 0;
    for (const [p, kind, mayBeStricter] of G.patterns) {
      const cat = { catalog_id: "c", version: "1", tools: { t: { name: "t", version: "1", effect: "read", capability: "x",
        input_schema: { type: "string", pattern: p }, output_schema: { type: "object", patternProperties: { [p]: {} } } } } };
      const names = C.check_schemas(cat).map((e) => e.split(" invalid:")[0]);
      const label = JSON.stringify(p.length > 80 ? p.slice(0, 80) + "..." : p);
      if (kind !== null) {
        assert.deepEqual(names, ["t.input_schema", "t.output_schema"], `${label}: Python rejects (${kind})`);
      } else if (names.length) {
        /* JS-only (stricter): the JS engine cannot compile it (u flag), or a documented stricter class */
        for (const e of C.check_schemas(cat)) assert.match(e, /regular expression/, label);
        assert.deepEqual(names, ["t.input_schema", "t.output_schema"], label);
        let js = true;
        try { new RegExp(p, "u"); } catch (e) { js = false; }
        assert.ok(!js || mayBeStricter, `${label}: JS-only rejection of a pattern both engines accept: ${C.check_schemas(cat)}`);
      } else {
        both++;
      }
    }
    assert.ok(both >= 1000, `only ${both} patterns accepted by both`);
  });

  test("check_schemas on random Draft 2020-12 schemas: never more lenient than Python, JS-only findings documented", () => {
    const G = golden("models_regex");
    let pyInvalid = 0, same = 0, jsOnly = 0;
    for (const [inText, outText, invalid] of G.schemas) {
      const cat = { catalog_id: "c", version: "1", tools: { t: { name: "t", version: "1", effect: "read", capability: "x",
        input_schema: parse(inText), output_schema: parse(outText) } } };
      const errs = C.check_schemas(cat);
      const names = errs.map((e) => e.split(" invalid:")[0]);
      for (const n of invalid) assert.ok(names.indexOf(n) >= 0, `${inText} / ${outText}: JS misses invalid ${n}`);
      assert.deepEqual(names.filter((n) => invalid.indexOf(n) >= 0), invalid, "order");
      for (const e of errs) {
        if (invalid.indexOf(e.split(" invalid:")[0]) >= 0) continue;
        const msgs = e.replace(/^t\.(in|out)put_schema invalid: /, "").split("; ");
        for (const m of msgs) assert.match(m, /unsupported keyword|regular expression/, `${inText} / ${outText}: undocumented JS-only finding ${m}`);
        jsOnly++;
      }
      if (invalid.length) pyInvalid++;
      if (names.length === invalid.length) same++;
    }
    assert.ok(G.schemas.length >= 2000 && pyInvalid >= 500 && same >= 1500, `${pyInvalid} ${same} ${jsOnly}`);
    /* $id: "$" in the metaschema pattern also matches before a final newline (re.search) */
    const one = (s) => C.check_schemas({ catalog_id: "c", version: "1", tools: { t: { name: "t", version: "1", effect: "read",
      capability: "x", input_schema: s, output_schema: {} } } });
    assert.deepEqual(one({ type: "string", $id: "abc#\n" }), []);
    assert.deepEqual(one({ $id: "abc\n" }), []);
    assert.equal(one({ $id: "a#\n\n" }).length, 1);
    assert.equal(one({ $id: "a#b" }).length, 1);
  });

  test("float fields beyond 2^53 (max_spend_usd \"1e16\", thresholds, judge error_rate): hashes equal Python", () => {
    const G = golden("models_pkg");
    assert.ok(G.float_big.length >= 6);
    for (const c of G.float_big) {
      const doc = parse(c.input_json);
      const n = P.normalize_package(doc);
      assert.equal(P.compute_hash(doc), c.compute_hash, c.name);
      assert.equal(P.verify_hash(doc), c.verify_hash, c.name);
      const s = P.sealed(doc);
      assert.equal(s.artifact_hash, c.sealed_hash, c.name);
      assert.equal(P.verify_hash(s), c.sealed_verify, c.name);
      assert.equal(sha(P.MachinePackage.canonical_text(n)), c.canonical_sha, c.name);
      assert.equal(HX.efsm.machine_digest(n.machine), c.machine_digest, c.name);
      assert.equal(P.ExecutionPolicy.digest(n.execution_policy), c.policy_digest, c.name);
    }
    for (const c of G.float_big_models) {
      const handle = c.model === "ModelResponse" ? HX.fakes.ModelResponse : P[c.model];
      assert.equal(handle.canonical_text(c.input), c.canonical, `${c.model} ${JSON.stringify(c.input)}`);
      assert.equal(handle.digest(c.input), c.digest, `${c.model} ${JSON.stringify(c.input)}`);
    }
    /* the verifier's case: Budgets.digest({max_spend_usd: "1e16"}) */
    assert.equal(P.Budgets.digest({ max_spend_usd: "1e16" }),
      "sha256:b3c29c92cc6bffd6f1827c0754fe808a89df0ab3d5b9155067ef89392b9f5151");
    /* typed checking still rejects what Python cannot hash */
    const b = P.Budgets.model_validate({});
    b.max_spend_usd = Infinity;
    assert.throws(() => HX.efsm.pyd.canonical_text({ k: "model", m: P.MODELS.Budgets }, b), HX.canonical.CanonicalError);
    b.max_spend_usd = null;
    b.max_steps = 2 ** 60;
    assert.throws(() => HX.efsm.pyd.canonical_text({ k: "model", m: P.MODELS.Budgets }, b), HX.canonical.CanonicalError);
  });

  test("inputs are never mutated: deep-frozen packages, machines, records and catalogs", () => {
    const freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
    const raw = freeze(parse(golden("models_pkg").base.initial));
    const sealed = P.sealed(raw);
    assert.equal(P.verify_hash(raw), true);
    assert.equal(P.compute_hash(raw), sealed.artifact_hash);
    P.hash_payload(raw);
    freeze(sealed);
    assert.equal(P.verify_hash(sealed), true);
    const m = HX.efsm.load_machine(raw.machine);
    m.states.READ_INTAKE.clause = "mutable output";
    HX.efsm.to_json(raw.machine);
    HX.efsm.machine_digest(raw.machine);
    const judge = freeze({ format: "efsm-v1", skill_id: "s", initial: "J", states: { J: { id: "J",
      action: { kind: "judge", question: "q", reads: ["a"], writes: ["b"], labels: ["x", "abstain"] } } } });
    assert.equal(HX.efsm.load_machine(judge).states.J.action.abstain, "abstain");
    const rec = freeze({ artifact_hash: "h", environment: "e", approver: "a", admitted_at: "t",
      validation_report_digest: "v", replay_archive_digest: "r", key_id: "k" });
    assert.equal(P.verify_admission(P.sign_admission(rec, "key"), "key"), true);
    const cat = freeze(JSON.parse(JSON.stringify(HX.data.tool_catalog)));
    assert.deepEqual(C.check_schemas(cat), []);
    assert.equal(C.digest(cat), HX.data.python_build.catalog_digest);
    C.load_catalog(cat).tools["documents.read"].description = "mutable output";
  });

  test("documented deviations: integer-like keys in typed maps are rejected", () => {
    const doc = parse(golden("models_pkg").base.initial);
    doc.contracts.clause_coverage["7"] = { classification: "non_material", justification: "x" };
    assert.throws(() => P.normalize_package(doc), (e) => e instanceof P.PackageError &&
      e.errors.length === 1 && e.errors[0].type === "dict_key_integer_like");
    const cat = JSON.parse(JSON.stringify(HX.data.tool_catalog));
    cat.tools["42"] = cat.tools["erp.read_draft"];
    assert.throws(() => C.load_catalog(cat), C.CatalogError);
  });

  test("documented deviation: error order with integer-like input keys (same entries, integer-like keys first)", () => {
    const c = golden("models_pkg").error_order;
    let err;
    try { P.ExecutionPolicy.model_validate(parse(c.input_json)); } catch (e) { err = e; }
    assert.ok(err instanceof P.PackageError);
    const got = err.errors.map((e) => [e.type, e.loc]);
    assert.deepEqual(sortErrs(got), sortErrs(c.errors_in_order), "same entries");
    assert.deepEqual(c.errors_in_order.map((e) => e[1][1]), ["1e3", "7", "b"], "Python: insertion order");
    assert.deepEqual(got.map((e) => e[1][1]), ["7", "1e3", "b"], "JS: integer-like key first");
  });
})();
