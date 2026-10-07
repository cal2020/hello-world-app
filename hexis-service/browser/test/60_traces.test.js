/* Parity of HX.traces with traces/model.py (golden/traces.json + traces_mut_<n>.json from gen_traces.py).
 * Also defines the shared golden helpers (globalThis.TRACES_GOLDEN) used by 62_normalize and 64_replay tests. */
(function () {
  const T = HX.traces;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  /* ---------------------------------------------------------------- shared helpers */
  let G = null, LINES = null, PKGS = null, VECTORS = null;
  const H = (globalThis.TRACES_GOLDEN = {
    main() {
      if (!G) {
        G = golden("traces");
        LINES = {};
        for (const k of Object.keys(G.bases)) LINES[k] = G.bases[k].jsonl.split("\n").slice(0, -1);
      }
      return G;
    },
    packages() {
      if (PKGS) return PKGS;
      const g = H.main();
      PKGS = {};
      for (const k of Object.keys(g.packages)) PKGS[k] = H.deep_freeze(HX.pkg.normalize_package(g.packages[k]));
      return PKGS;
    },
    vectors() {
      if (VECTORS) return VECTORS;
      const g = H.main();
      VECTORS = g.curated.slice();
      for (const f of g.mutation_files) VECTORS = VECTORS.concat(golden(f).vectors);
      return VECTORS;
    },
    decode(enc) {
      H.main();
      const lines = LINES[enc.base];
      return enc.lines.map((x) => (typeof x === "number" ? lines[x] : x)).join("\n") + enc.end;
    },
    /** Load a vector like the generator: from_jsonl, then the in-memory seal override. */
    load(v) {
      const [t, errs] = T.from_jsonl(H.decode(v.text));
      if (v.set_seal) {
        T._set_seal(t, v.set_seal);
        return [t, T.integrity_errors(t)];
      }
      return [t, errs];
    },
    exc_name(e) {
      if (!(e instanceof HX.HXError)) return "JS:" + (e && e.name) + ": " + (e && e.message);
      if (e.constructor === HX.HXError) return e.code;
      return e.constructor.name;
    },
    run(fn) {
      try {
        return { ok: fn() };
      } catch (e) {
        const out = { exc: H.exc_name(e) };
        if (typeof e.code === "string" && e.constructor !== HX.HXError) out.code = e.code;
        out.message = e.message;
        return out;
      }
    },
    same_exc(got, want, label) {
      assert.ok(got.exc !== undefined, label + ": JS returned a value, Python raised " + JSON.stringify(want));
      assert.equal(got.exc, want.exc, label + ": " + JSON.stringify(got));
      if (want.code !== undefined && want.exc === "KernelError") assert.equal(got.code, want.code, label + " code");
    },
    check_pack(actual, g, label) {
      if (Object.prototype.hasOwnProperty.call(g, "v")) {
        const ok = HX.util.deep_equal(plain(actual), g.v);
        assert.ok(ok, label + "\nJS:     " + JSON.stringify(actual).slice(0, 3000) + "\nPython: " + JSON.stringify(g.v).slice(0, 3000));
      } else {
        assert.equal(HX.canonical.digest(plain(actual)), g.d, label + " (digest; JS value " + JSON.stringify(actual).slice(0, 1500) + ")");
      }
    },
    deep_freeze(v) {
      if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const k of Object.keys(v)) H.deep_freeze(v[k]);
      }
      return v;
    },
  });

  /* ---------------------------------------------------------------- tests */
  test("traces golden: packages normalize and hash exactly like Python", () => {
    const g = H.main();
    const P = H.packages();
    for (const k of Object.keys(g.package_hashes)) {
      assert.equal(P[k].artifact_hash, g.package_hashes[k], k);
      assert.equal(HX.pkg.compute_hash(P[k]), g.package_hashes[k], k + " recomputed");
    }
    assert.equal(T.TRACE_EXT, g.versions.trace_ext);
  });

  test("traces: base traces (real runs, reference traces, hand-built) round-trip byte-identically", () => {
    const g = H.main();
    for (const k of Object.keys(g.bases)) {
      const text = g.bases[k].jsonl;
      const [t, errs] = T.from_jsonl(text);
      assert.deepEqual(errs, [], k);
      assert.equal(T.to_jsonl(t), text, k + " to_jsonl");
      const s = T.seal(t);
      assert.equal(T.to_jsonl(s), text, k + " reseal is idempotent");
      assert.deepEqual(T.integrity_errors(s), [], k + " resealed");
    }
  });

  test("traces: every vector - from_jsonl, integrity errors, dump, seal, digests, to_jsonl bytes", () => {
    let n = 0;
    for (const v of H.vectors()) {
      const label = v.name + (v.note ? " [" + v.note + "]" : "");
      if (v.js_deviation) continue;
      const r = H.run(() => H.load(v));
      if (v.load.exc !== undefined) {
        H.same_exc(r, v.load, label + " from_jsonl");
        n++;
        continue;
      }
      assert.ok(r.ok, label + ": JS raised " + JSON.stringify(r));
      const [t, errs] = r.ok;
      assert.deepEqual(errs, v.errors, label + " integrity errors");
      H.check_pack(T.model_dump(t), v.dump, label + " dump");
      assert.deepEqual(T.get_seal(t), v.seal, label + " seal");
      for (const [k, fn] of [["records_digest", T.records_digest], ["header_digest", T.header_digest]]) {
        const got = H.run(() => fn(t));
        if (v[k].exc) H.same_exc(got, v[k], label + " " + k);
        else assert.equal(got.ok, v[k].ok, label + " " + k);
      }
      const sha = H.run(() => HX.canonical.sha256_hex(T.to_jsonl(t)));
      if (v.jsonl_sha.exc) H.same_exc(sha, v.jsonl_sha, label + " to_jsonl");
      else assert.equal(sha.ok, v.jsonl_sha.ok, label + " to_jsonl bytes");
      for (const x of Object.keys(v.integrity_expected)) {
        assert.deepEqual(T.integrity_errors(t, x), v.integrity_expected[x], label + " integrity_errors(" + JSON.stringify(x) + ")");
      }
      n++;
    }
    assert.ok(n > 600, "vector count " + n);
  });

  test("traces deviation: integral float literals are refused (Python keeps 1.0 as a float)", () => {
    const vs = H.vectors().filter((v) => v.js_deviation);
    assert.ok(vs.length >= 1);
    for (const v of vs) {
      assert.ok(v.python_load.ok, "Python loads it");
      const r = H.run(() => H.load(v));
      assert.equal(r.exc, "CanonicalError", v.name);
    }
  });

  test("traces: the seal is private (not serialized) and travels only through seal/from_jsonl/model_copy", () => {
    const g = H.main();
    const [t] = T.from_jsonl(g.bases.happy.jsonl);
    assert.deepEqual(Object.keys(t), T.TRACE_FIELDS.slice());
    assert.equal(JSON.stringify(t).indexOf("header_digest"), -1);
    assert.equal(Object.keys(T.get_seal(t)).sort().join(","), "header_digest,records_digest");
    /* any copy other than model_copy is unsealed and rejected */
    const c = HX.util.deep_clone(t);
    assert.deepEqual(T.integrity_errors(c), ["no integrity block (unsealed trace)"]);
    assert.equal(HX.replay.replay_structural(H.packages().initial, c).status, "REJECTED");
    /* model_copy keeps the seal, so an in-memory deletion is caught (C29) */
    const m = T.model_copy(t, { deep: true });
    assert.deepEqual(T.integrity_errors(m), []);
    m.records.splice(4, 1);
    assert.ok(T.integrity_errors(m).some((e) => e.indexOf("records_digest mismatch") >= 0));
    assert.equal(HX.replay.replay_structural(H.packages().initial, m).status, "REJECTED");
    /* a new_trace is unsealed; seal() seals it */
    const u = T.new_trace(T.model_dump(t));
    assert.deepEqual(T.integrity_errors(u), ["no integrity block (unsealed trace)"]);
    assert.deepEqual(T.integrity_errors(T.seal(u)), []);
    /* validation errors */
    assert.throws(() => T.new_record({ step: 1, bogus: 1 }), T.ValidationError);
    assert.throws(() => T.new_trace({ trace_id: "x", verdict: "maybe" }), T.ValidationError);
    assert.deepEqual(plain(T.new_record({ step: "3" })), { step: 3, state: "", clause: "", action: {}, output: {}, vars: {}, meta: {} });
  });

  test("traces: py_json_dumps matches Python json.dumps(sort_keys=True, ensure_ascii=False)", () => {
    const d = T.py_json_dumps;
    assert.equal(d({ b: [1, 2.5, null, true], a: {}, c: [], "é": " \x7f\x1f\"\\\t" }),
      '{"a": {}, "b": [1, 2.5, null, true], "c": [], "é": " \x7f\\u001f\\"\\\\\\t"}');
    assert.equal(d(1e-7), "1e-07");
    assert.equal(d(0.1), "0.1");
    assert.throws(() => d({ x: NaN }), HX.canonical.CanonicalError);
  });

  const svc_ready = HX.service && HX.env && typeof HX.env.build_env === "function";
  const EXPORT_NAME = "traces: export_run_trace of a JS run is sealed and replays (full parity: wave 4)";
  if (!svc_ready) skip(EXPORT_NAME, "HX.service / HX.env not loaded yet (ported in parallel); wave 4 verifies export_run_trace parity");
  else test(EXPORT_NAME, () => {
    const E = HX.env;
    const env = E.build_env({ clock: new E.ManualClock(1790000000.25) });
    const pkg = HX.compile.compile_procurement().package;
    assert.equal(E.admit_initial(env, pkg).status, "ADMITTED");
    const alice = env.principal("user:alice");
    const h = env.service.start_run(pkg.artifact_hash, E.TASK, alice);
    const r = env.service.run_until_blocked(h.run_id, alice);
    const ix = r.interaction;
    env.service.resume_interaction(h.run_id, ix.interaction_id,
      { approval_decision: "approved", scope_digest: ix.scope_digest }, env.principal("user:bob"));
    env.service.run_until_blocked(h.run_id, alice);
    const t = T.export_run_trace(env.service, h.run_id, alice, "accepted");
    assert.deepEqual(T.integrity_errors(t), []);
    assert.equal(HX.replay.replay(pkg, t, "structural").status, "PASS");
    assert.equal(HX.replay.replay(pkg, t, "recorded").status, "PASS");
    const [t2, errs] = T.from_jsonl(T.to_jsonl(t));
    assert.deepEqual(errs, []);
    assert.equal(T.to_jsonl(t2), T.to_jsonl(t));
  });
})();
