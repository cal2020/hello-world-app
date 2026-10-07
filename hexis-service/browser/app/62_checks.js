/* HEXIS Runtime Lab: the Self-test's check catalog. No DOM here except reading #hx-embed, so the same file also
   loads in Node next to the engine (the catalog is plain data plus functions that call HX.*).

   Three groups:
     parity      the Python build's anchors (initial and refined artifact hashes, tool catalog digest), recomputed.
     golden      vectors sampled from the Python reference's golden files (golden/selftest.json, embedded in the page
                 as #hx-embed "selftest"): canonical JSON, guards, kernel steps and walks, runtime transcripts, demo.
     acceptance  A01 to A32, mirroring the Python tests in tests/ (named like them), each against a fresh engine
                 environment and asserting what the Python test asserts.

   API (HXUI.checks):
     GROUPS                        [{id, title, lead}]
     list()                        [{key, id, group, name, needs: ["kernel", ...], embed: bool, python}]
     context()                     a run context: caches the compiled package across checks; ctx.close() frees the
                                   path-backed stores the runtime transcripts used
     run(key, ctx)                 {status: "pass" | "fail" | "skip", ms, note, message, error_code}
                                   never throws: an engine error is a failure with its code and message
     embed()                       the parsed golden sample, or null when the page has none
     missing(check)                the HX namespaces this build lacks for that check */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const HX_ = () => globalThis.HX || {};

  /* ------------------------------------------------------------------ embed */
  let embed_cache;
  function embed() {
    if (embed_cache !== undefined) return embed_cache;
    embed_cache = null;
    try {
      if (globalThis.HX_SELFTEST_EMBED) embed_cache = globalThis.HX_SELFTEST_EMBED; /* Node harness */
      else if (typeof document !== "undefined") {
        const el = document.getElementById("hx-embed");
        const all = el ? JSON.parse(el.textContent || "{}") : {};
        embed_cache = all && all.selftest ? all.selftest : null;
      }
    } catch (e) { embed_cache = null; }
    return embed_cache;
  }

  /* ------------------------------------------------------------------ assertions */
  class CheckFailure extends Error {
    constructor(message) { super(message); this.name = "CheckFailure"; }
  }
  function short(v) {
    if (v === undefined) return "nothing";
    let s;
    try { s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (x instanceof Set ? Array.from(x) : x)); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > 140 ? s.slice(0, 137) + "…" : s;
  }
  const A = {
    ok(v, msg) { if (!v) throw new CheckFailure(msg || "expected a true value"); },
    eq(got, want, msg) {
      if (got !== want) throw new CheckFailure((msg ? msg + ": " : "") + "expected " + short(want) + ", got " + short(got));
    },
    deep(got, want, msg) {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) throw new CheckFailure((msg ? msg + ": " : "") + "expected " + short(want) + ", got " + short(got));
    },
    /** canonical equality (key order ignored), with the first differing path in the message */
    same(got, want, msg) {
      const C = HX.canonical;
      if (C.canonical_text(got) === C.canonical_text(want)) return;
      throw new CheckFailure((msg ? msg + ": " : "") + (first_diff(got, want, "") || "values differ"));
    },
    /** fn must throw; pred(err) must hold. Returns the error. */
    throws(fn, pred, msg) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      if (!err) throw new CheckFailure((msg ? msg + ": " : "") + "expected an error, none was raised");
      if (pred && !pred(err)) throw new CheckFailure((msg ? msg + ": " : "") + "unexpected error " + describe(err));
      return err;
    },
    code(fn) {
      try { fn(); } catch (e) { return e && e.code !== undefined ? e.code : String(e); }
      return null;
    },
  };
  function describe(e) {
    if (!e) return String(e);
    const code = e.code !== undefined ? e.code + ": " : "";
    const m = e.msg !== undefined ? e.msg : e.message;
    return code + (m === undefined ? String(e) : m);
  }
  function first_diff(a, b, path) {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
      for (const k of keys) {
        const d = first_diff(a[k], b[k], path + "." + k);
        if (d) return d;
      }
      return null;
    }
    return (path || "value") + ": expected " + short(b) + ", got " + short(a);
  }
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  /* ------------------------------------------------------------------ fixtures (tests/conftest.py) */
  const TENANT = "acme";
  const SKILL = "supplier-onboarding-draft";

  function compiled(ctx) {
    if (!ctx.compiled) {
      const res = HX.compile.compile_procurement();
      A.eq(res.status, "validated", "compile_procurement status");
      ctx.compiled = res;
    }
    return ctx.compiled;
  }
  /** conftest ``pkg``: a deep copy of the compiled package */
  const pkg_of = (ctx) => clone(compiled(ctx).package);
  const catalog_of = () => HX.env.load_catalog();
  const skill_text = () => HX.env.skill_source().text;

  /** conftest ``env``: a fresh path-backed environment (like Python's tmp_path) with the package admitted.
      ManualClock() starts at Python's default 1790000000.0; ids are sequential, the timer counts 0.125 s steps. */
  function make_env(ctx, pkg) {
    ctx.n_env = (ctx.n_env || 0) + 1;
    const dir = "/hx-selftest/" + ctx.stamp + "/" + ctx.n_env;
    ctx.paths.push(dir);
    let n = 0;
    const clock = new HX.env.ManualClock();
    const env = HX.env.build_env(dir, { clock, ids: HX.env.make_seq_ids(1), timer: () => 0.125 * ++n });
    const adm = HX.env.admit_initial(env, pkg);
    A.eq(adm.status, "ADMITTED", "admit_initial");
    return { env, clock };
  }
  function run_to_approval(env, pkg, task, who) {
    const p = env.principal(who || "user:alice");
    const h = env.service.start_run(pkg.artifact_hash, task || HX.env.task(), p);
    const res = env.service.run_until_blocked(h.run_id, p);
    return [h.run_id, res];
  }
  function approve(env, run_id, ix, who) {
    return env.service.resume_interaction(run_id, ix.interaction_id,
      { approval_decision: "approved", scope_digest: ix.scope_digest }, env.principal(who || "user:bob"));
  }
  function step_until_state(env, run_id, state, who) {
    const p = env.principal(who || "user:alice");
    for (let i = 0; i < 50; i++) {
      const cp = env.service._cp(p.tenant_id, run_id);
      if (cp.state_id === state || cp.status !== "RUNNING") return cp;
      env.service.advance_run(run_id, p);
    }
    throw new CheckFailure("state " + state + " not reached in 50 steps");
  }
  const writes = (env) => env.erp.count(TENANT);

  /** conftest ``mutate``: apply fn(machine, contracts) to copies and reseal */
  function mutate(pkg, fn) {
    const d = clone(pkg);
    fn(d.machine, d.contracts);
    d.artifact_hash = "";
    return HX.pkg.sealed(d);
  }
  function validate(pkg, catalog, text) {
    return HX.validate.validate_package(pkg, catalog, "production", { skill_text: text === undefined ? skill_text() : text });
  }

  /** conftest ``mini_package`` (kernel-level tests bypass compile) */
  function mini_package(ctx, states, variables, var_contracts, terminals, term_contracts, initial) {
    const base = compiled(ctx).package;
    const md = { format: "efsm-v1", skill_id: "mini", initial, fallback: "FALLBACK", max_steps: 20, states, variables, terminals };
    const cd = { variables: var_contracts, terminals: term_contracts, task_input_schema: { type: "object" } };
    return HX.pkg.sealed({ machine: md, source_manifest: clone(base.source_manifest), compiler_manifest: clone(base.compiler_manifest),
      contracts: cd, execution_policy: clone(HX.fixture.deployment_policy().execution_policy) });
  }
  const END = (t) => ({ id: t, action: { kind: "end", terminal: t }, transitions: [] });
  function judge_pkg(ctx) {
    const states = {
      J: { id: "J", action: { kind: "judge", prompt: "ok?", reads: ["x"], writes: ["label"], labels: ["ok", "bad", "abstain"] },
        transitions: [{ if: "label == 'ok'", to: "OK" }, { if: "", to: "FALLBACK" }] },
      OK: END("END_OK"), FALLBACK: END("END_REVIEW"),
    };
    return mini_package(ctx, states, [{ name: "x", type: "string", init: "v" }, { name: "label", type: "string" }],
      { x: { owner: "task", schema: { type: "string" } }, label: { owner: "model", schema: { enum: ["ok", "bad", "abstain"] } } },
      [{ id: "END_OK", kind: "unverified" }, { id: "END_REVIEW", kind: "fallback" }],
      { END_OK: { category: "unverified" }, END_REVIEW: { category: "fallback" } }, "J");
  }
  function falsy_pkg(ctx, guard) {
    const states = {
      M: { id: "M", action: { kind: "model", prompt: "p", reads: [], writes: ["flag", "count", "note"] },
        transitions: [{ if: guard || "flag == False and count == 0 and empty(note)", to: "A" }, { if: "", to: "FALLBACK" }] },
      A: END("END_A"), FALLBACK: END("END_REVIEW"),
    };
    return mini_package(ctx, states, [{ name: "flag", type: "boolean" }, { name: "count", type: "integer" },
      { name: "note", type: "string" }, { name: "ghost", type: "string" }],
    { flag: { owner: "model", schema: { type: "boolean" } }, count: { owner: "model", schema: { type: "integer" } },
      note: { owner: "model", schema: { type: "string" } }, ghost: { owner: "model", schema: { type: "string" } } },
    [{ id: "END_A", kind: "unverified" }, { id: "END_REVIEW", kind: "fallback" }],
    { END_A: { category: "unverified" }, END_REVIEW: { category: "fallback" } }, "M");
  }
  /** when the golden sample is embedded, the JS-built test package must be Python's conftest package byte for byte */
  function same_as_python(p, name) {
    const g = embed();
    if (g && g.kernel && g.kernel.artifact_hashes[name]) A.eq(p.artifact_hash, g.kernel.artifact_hashes[name], "the " + name + " test package equals Python's");
  }
  const obs = (cp, kind, outputs) => HX.kernel.new_observation({ run_id: cp.run_id, state_id: cp.state_id, revision: cp.revision, kind, outputs });

  /** replay_update ``archive``: protected traces from real runs (verified path with a repair; registry conflict) */
  function archive(env, pkg) {
    const alice = env.principal("user:alice");
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.service.run_until_blocked(run_id, alice);
    const h = env.service.start_run(pkg.artifact_hash, HX.env.task({ supplier_ref: "SUP-55555" }), alice);
    env.service.run_until_blocked(h.run_id, alice);
    return [HX.traces.export_run_trace(env.service, run_id, alice, "accepted"),
      HX.traces.export_run_trace(env.service, h.run_id, alice, "accepted")];
  }
  function admit_kw(env, protected_, archive_manifest) {
    return { approver: env.principal("user:dana"), environment: "sandbox", archive_manifest, protected: protected_,
      deployment_policy: HX.fixture.deployment_policy(), now: env.clock(), skill_text: skill_text() };
  }

  /* ------------------------------------------------------------------ catalog */
  const CHECKS = [];
  const BY_KEY = new Map();
  /** def(group, key, id, name, needs, fn, {embed, python}) */
  function def(group, key, id, name, needs, fn, opts) {
    const o = opts || {};
    const c = { key, id, group, name, needs: needs.slice(), embed: !!o.embed, python: o.python || "", fn };
    CHECKS.push(c);
    BY_KEY.set(key, c);
  }

  const N_COMPILE = ["compile", "data", "canonical", "jsonschema", "guards", "efsm", "pkg", "catalog", "clauses", "fixture", "validate"];
  const N_RUN = ["env", "service", "kernel", "broker", "store", "policy", "approvals", "fakes", "registry", "diff"].concat(N_COMPILE);
  const N_LEARN = ["traces", "normalize", "replay", "update", "reference"].concat(N_RUN);

  /* ---- parity anchors ------------------------------------------------------------------------------------ */
  def("parity", "p-initial", "P1", "Initial artifact hash equals the Python build", N_COMPILE, (ctx) => {
    const h = compiled(ctx).package.artifact_hash;
    A.eq(h, HX.data.python_build.initial_artifact_hash, "artifact hash");
    return h.slice(0, 19) + "…";
  }, { python: "python_build.initial_artifact_hash" });
  def("parity", "p-refined", "P2", "Refined artifact hash equals the Python build", ["update", "reference", "traces", "normalize", "replay"].concat(N_COMPILE), (ctx) => {
    const R = HX.reference;
    const prop = HX.update.propose_update(pkg_of(ctx), R.missing_docs_trace(), [], [], catalog_of(), new R.FixtureAligner(), skill_text());
    A.eq(prop.status, "CANDIDATE", "proposal status");
    A.eq(prop.candidate.artifact_hash, HX.data.python_build.refined_artifact_hash, "refined artifact hash");
    return prop.candidate.artifact_hash.slice(0, 19) + "…";
  }, { python: "python_build.refined_artifact_hash" });
  def("parity", "p-catalog", "P3", "Tool catalog digest equals the Python build", ["catalog", "data", "canonical", "jsonschema"], () => {
    const d = HX.catalog.digest(HX.catalog.load_catalog(HX.data.tool_catalog));
    A.eq(d, HX.data.python_build.catalog_digest, "catalog digest");
    return d.slice(0, 19) + "…";
  }, { python: "python_build.catalog_digest" });

  /* ---- golden vectors -------------------------------------------------------------------------------------- */
  const G = () => embed();
  const count = (n, what) => n + " " + what;

  def("golden", "g-canonical", "G1", "Canonical text and digests of JSON values", ["canonical"], () => {
    const v = G().canonical.canonical;
    for (const c of v) {
      A.eq(HX.canonical.canonical_text(c.value), c.canonical, "canonical text of " + short(c.value));
      A.eq(HX.canonical.digest(c.value), c.digest, "digest of " + short(c.value));
    }
    return count(v.length, "values");
  }, { embed: true, python: "canonical.py" });
  def("golden", "g-floats", "G2", "Float formatting equals Python's repr", ["canonical"], () => {
    const v = G().canonical.floats;
    for (const c of v) A.eq(HX.canonical.py_float_repr(c.value), c.repr, "repr");
    return count(v.length, "floats");
  }, { embed: true, python: "repr(float)" });
  def("golden", "g-loads", "G3", "strict_loads accepts and rejects like Python", ["canonical"], () => {
    const v = G().canonical.loads;
    for (const c of v) {
      let got = null, err = null;
      try { got = HX.canonical.strict_loads(c.text); } catch (e) { err = e; }
      if (c.js === "accept") {
        A.ok(!err, "should accept " + short(c.text) + (err ? " (" + describe(err) + ")" : ""));
        A.deep(got, c.value, "value of " + short(c.text));
      } else A.ok(err instanceof HX.canonical.CanonicalError, "should reject " + short(c.text) + (c.note ? " (" + c.note + ")" : ""));
    }
    return count(v.length, "texts");
  }, { embed: true, python: "canonical.strict_loads" });
  def("golden", "g-sha", "G4", "SHA-256 and HMAC-SHA256 equal Python's hashlib", ["canonical"], () => {
    const g = G().canonical;
    for (const c of g.sha256) A.eq(HX.canonical.sha256_hex(c.text), c.sha256, "sha256 of " + short(c.text));
    for (const c of g.hmac) A.eq(HX.canonical.hmac_sha256_hex(c.key, c.message), c.hmac, "hmac of " + short(c.message));
    return count(g.sha256.length + g.hmac.length, "digests");
  }, { embed: true, python: "hashlib / hmac" });

  def("golden", "g-parse", "G5", "Guard parser verdicts and error messages", ["guards"], () => {
    const v = G().guards.parse;
    const SYN = "guard syntax error: ";
    for (const c of v) {
      let err = null;
      try { HX.guards.parse(c.e); } catch (e) { err = e; }
      if (err && !(err instanceof HX.guards.GuardError)) throw new CheckFailure(short(c.e) + ": raised " + describe(err));
      if (c.r === "ok") {
        A.ok(!err, short(c.e) + ": Python accepts, JS rejects (" + (err && err.message) + ")");
        A.deep(Array.from(HX.guards.vars_of(c.e)), c.vars, "variables of " + short(c.e));
      } else {
        A.ok(err, short(c.e) + ": Python rejects (" + c.m + "), JS accepts");
        if (c.m.startsWith(SYN)) A.ok(err.message.startsWith(SYN), short(c.e) + ": expected a syntax error, got " + short(err.message));
        else A.eq(err.message, c.m, "message for " + short(c.e));
      }
    }
    return count(v.length, "guards");
  }, { embed: true, python: "guards.parse" });

  function dec_env(env) {
    const out = {};
    for (const k of Object.keys(env)) {
      Object.defineProperty(out, k, { value: env[k] && env[k].$unknown === true ? HX.guards.UNKNOWN : env[k], enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  def("golden", "g-typecheck", "G6", "Guard type checking in four type environments", ["guards"], () => {
    const g = G().guards;
    let n = 0;
    for (const c of g.semantics) {
      for (const name of Object.keys(c.tc)) {
        const got = HX.guards.typecheck(c.e, g.type_envs[name]);
        A.ok(c.tc[name].some((o) => JSON.stringify(o) === JSON.stringify(got)), short(c.e) + " [" + name + "]: " + short(got) + " is not Python's " + short(c.tc[name][0]));
        n++;
      }
    }
    return count(n, "results");
  }, { embed: true, python: "guards.typecheck" });
  def("golden", "g-evaluate", "G7", "Guard evaluation, two- and three-valued, in eight environments", ["guards"], () => {
    const g = G().guards;
    const envs = {};
    for (const k of Object.keys(g.value_envs)) envs[k] = dec_env(g.value_envs[k]);
    const val = (fn) => { try { return fn(); } catch (e) { return e instanceof HX.guards.GuardError ? { error: e.message } : { crash: String(e) }; } };
    let n = 0;
    for (const c of g.semantics) {
      for (const name of Object.keys(envs)) {
        A.deep(val(() => HX.guards.evaluate(c.e, envs[name])), c.ev[name], "evaluate " + short(c.e) + " [" + name + "]");
        A.deep(val(() => HX.guards.evaluate3(c.e, envs[name])), c.ev3[name], "evaluate3 " + short(c.e) + " [" + name + "]");
        n += 2;
      }
    }
    return count(n, "results");
  }, { embed: true, python: "guards.evaluate / evaluate3" });
  def("golden", "g-disjoint", "G8", "Guard disjointness analysis: status, edges and counterexamples", ["guards"], () => {
    const v = G().guards.disjoint;
    const SYN = "unparseable guard: guard syntax error: ";
    for (const c of v) {
      const an = HX.guards.analyze_disjoint(c.guards, c.types);
      const label = short(c.guards);
      /* documented deviations are conservative: the port may say UNKNOWN where it cannot represent a value */
      if (an.status === "UNKNOWN" && /JavaScript port|supported by the JavaScript/.test(an.detail)) continue;
      A.eq(an.status, c.status, label + " status");
      A.deep(an.edges, c.edges, label + " edges");
      if (c.detail.startsWith(SYN)) A.ok(an.detail.startsWith(SYN), label + ": detail " + short(an.detail));
      else A.eq(an.detail, c.detail, label + " detail");
      if (an.status === "COUNTEREXAMPLE") {
        for (const i of an.edges) A.eq(HX.guards.evaluate(c.guards[i], an.counterexample), true, label + ": the counterexample makes guard " + i + " true");
        A.deep(an.counterexample, c.counterexample, label + " counterexample");
      }
    }
    return count(v.length, "guard sets");
  }, { embed: true, python: "guards.analyze_disjoint" });

  function kernel_packages(ctx) {
    if (!ctx.kpkgs) {
      const g = G().kernel;
      ctx.kpkgs = {};
      for (const n of Object.keys(g.packages)) ctx.kpkgs[n] = HX.pkg.normalize_package(g.packages[n]);
    }
    return ctx.kpkgs;
  }
  function k_run(fn) {
    const K = HX.kernel;
    try { return { ok: fn() }; } catch (e) {
      if (e instanceof K.KernelError) { const d = plain(e.detail); delete d.errors; return { exc: "KernelError", code: e.code, message: e.message, detail: d }; }
      if (e instanceof K.ValidationError) return { exc: "ValidationError" };
      if (e instanceof HX.canonical.CanonicalError) return { exc: "CanonicalError", message: e.message };
      if (e instanceof HX.HXError) return { exc: e.code, message: e.message };
      throw e;
    }
  }
  function k_same(got, want, label) {
    if (want.exc === undefined) { A.ok(got.exc === undefined, label + ": JS raised " + short(got)); return; }
    A.eq(got.exc, want.exc, label + " error class");
    if (want.exc === "KernelError") {
      A.eq(got.code, want.code, label + " error code");
      A.same(got.detail, want.detail, label + " error detail");
    }
  }
  def("golden", "g-kpkgs", "G9", "Kernel test packages hash exactly like Python", ["kernel", "pkg", "efsm", "canonical"], (ctx) => {
    const g = G().kernel;
    const P = kernel_packages(ctx);
    for (const n of Object.keys(P)) {
      A.eq(P[n].artifact_hash, g.artifact_hashes[n], n + " stored hash");
      A.eq(HX.pkg.compute_hash(P[n]), g.artifact_hashes[n], n + " recomputed hash");
    }
    A.eq(g.artifact_hashes.initial, HX.data.python_build.initial_artifact_hash, "initial package");
    return count(Object.keys(P).length, "packages");
  }, { embed: true, python: "MachinePackage.compute_hash" });
  def("golden", "g-kvectors", "G10", "Edge selection, templates and init paths", ["kernel", "pkg", "efsm", "canonical", "guards"], (ctx) => {
    const g = G().kernel;
    const K = HX.kernel;
    const P = kernel_packages(ctx);
    const VALUES = { s: "text", i: 42, f: 2.5, neg: -3, b: false, t: true, n: null, l: [1, "a"], d: { k: "v" }, e: "", big: 1e15,
      small: 1e-7, huge: 1.5e-300, uni: "é😀", _x: "u", X9: 9 };
    for (const v of g.fill_template) {
      const got = k_run(() => K.fill_template(clone(v.template), clone(VALUES)));
      k_same(got, v.result, "fill_template " + short(v.template));
      if (v.result.ok !== undefined) A.same(plain(got.ok), v.result.ok, "fill_template " + short(v.template));
    }
    for (const v of g.resolve_path) {
      const got = k_run(() => K.resolve_path(clone(v.task_input), v.path));
      A.eq(got.exc, v.result.exc, "resolve_path " + short(v.path));
      if (v.result.ok !== undefined) A.same(plain(got.ok), v.result.ok, "resolve_path " + short(v.path));
    }
    for (const v of g.select_edge) {
      const got = k_run(() => K.select_edge(P[v.pkg], v.state, clone(v.variables)));
      A.eq(got.exc, v.result.exc, "select_edge " + v.pkg + "/" + v.state);
      if (v.result.ok !== undefined) A.same(plain(got.ok), v.result.ok, "select_edge " + v.pkg + "/" + v.state);
    }
    return count(g.fill_template.length + g.resolve_path.length + g.select_edge.length, "vectors");
  }, { embed: true, python: "kernel.fill_template / resolve_path / select_edge" });
  def("golden", "g-kwalks", "G11", "Kernel random walks: every step's checkpoint, events and delta", ["kernel", "pkg", "efsm", "canonical", "guards", "jsonschema"], (ctx) => {
    const g = G().kernel;
    const K = HX.kernel;
    const P = kernel_packages(ctx);
    let steps = 0;
    g.walks.forEach((w, wi) => {
      const label0 = "walk " + (wi + 1) + " (" + w.pkg + ")";
      const s = w.start;
      const start = k_run(() => (s.kind === "initial" ? K.initial_checkpoint(P[w.pkg], s.tenant_id, s.run_id, clone(s.task_input)) : K.new_checkpoint(clone(s.fields))));
      k_same(start, w.start_result, label0 + " start");
      if (w.start_result.ok === undefined) return;
      A.same(plain(start.ok), w.start_result.ok, label0 + " start checkpoint");
      let cp = start.ok;
      w.steps.forEach((st, si) => {
        const label = label0 + " step " + si + " at " + cp.state_id;
        steps++;
        const o = k_run(() => K.new_observation(clone(st.obs)));
        let got = o;
        if (o.ok !== undefined) got = k_run(() => K.advance(cp, o.ok, P[w.pkg]));
        k_same(got, st.result, label);
        if (got.ok !== undefined && st.result.ok !== undefined) {
          A.same(plain({ checkpoint: got.ok.checkpoint, events: got.ok.events, delta: got.ok.delta, edge: got.ok.edge }), st.result.ok, label);
          cp = got.ok.checkpoint;
        }
      });
    });
    return count(g.walks.length, "walks") + ", " + count(steps, "steps");
  }, { embed: true, python: "kernel.advance" });

  /* runtime transcripts (golden/gen_runtime.py's do() for the operations these scenarios use) */
  function rt_enc_error(e) {
    if (e instanceof HX.service.RunError) return { error: "RunError", code: e.code, message: e.message };
    if (e instanceof HX.broker.SimulatedCrash) return { error: "SimulatedCrash", code: e.point };
    if (e instanceof HX.store.ConflictError) return { error: "ConflictError", code: e.message.split(":")[0], message: e.message };
    if (e instanceof HX.HXError) return { error: e.code };
    throw e;
  }
  const rt_step = (r) => ({ status: r.status, detail: r.detail, checkpoint: r.checkpoint, interaction: r.interaction });
  function rt_snap(rt, run) {
    const e = rt.env;
    const out = { erp: e.erp._rows.map((r) => [r.tenant_id, r.draft_id, r.supplier_ref, r.draft_digest, r.idempotency_key, r.args_digest, r.payload, r.version]),
      erp_calls: e.erp.calls.map((c) => c.slice()), erp_faults: e.erp.faults.slice(), armed: Array.from(e.faults.armed).sort(),
      policy_version: e.policy.version, active: e.store.get_active("sandbox", SKILL), archive: e.store.archive(SKILL) };
    if (run !== null && run !== undefined && hasOwn(rt.runs, run)) {
      const rid = rt.runs[run];
      if (e.store.get_run(TENANT, rid) !== null) {
        out.inspect = e.service.inspect_run(rid, e.principal("user:alice"));
        out.checkpoints = e.store.checkpoints(TENANT, rid).map((c) => HX.canonical.digest(c));
      }
    }
    return plain(out);
  }
  function rt_op(ctx, rt, op) {
    const e = rt.env;
    const svc = e ? e.service : null;
    const p = (who) => rt.env.principal(who);
    const rid = (name) => { if (!hasOwn(rt.runs, name)) throw new HX.HXError("KeyError", name); return rt.runs[name]; };
    switch (op.op) {
      case "env": {
        ctx.n_env = (ctx.n_env || 0) + 1;
        const dir = "/hx-selftest/" + ctx.stamp + "/rt-" + ctx.n_env + "/" + op.dir;
        ctx.paths.push(dir);
        rt.env = HX.env.build_env(dir, { clock: rt.clock, timer: rt.timer, ids: rt.ids });
        const a = HX.env.admit_initial(rt.env, compiled(ctx).package);
        return [{ status: a.status, artifact_hash: a.artifact_hash, reasons: a.reasons, record: a.record, archive_version: a.archive_version }, null, true];
      }
      case "restart": rt.env = e.restart(); return [null, null, true];
      case "start": {
        const h = svc.start_run(compiled(ctx).package.artifact_hash, HX.env.task(op.task), p(op.as || "user:alice"), op.request_id || "");
        rt.runs[op.run] = h.run_id;
        return [{ run_id: h.run_id, tenant_id: h.tenant_id, artifact_hash: h.artifact_hash, status: h.status, revision: h.revision }, op.run, true];
      }
      case "run": {
        const r = svc.run_until_blocked(rid(op.run), p(op.as || "user:alice"));
        if (r.interaction) rt.ix[op.run] = r.interaction;
        return [rt_step(r), op.run, true];
      }
      case "approve": {
        if (!hasOwn(rt.ix, op.run)) throw new HX.HXError("KeyError", op.run);
        const ix = rt.ix[op.run];
        const scope = (op.scope || "ok") === "ok" ? ix.scope_digest : op.scope;
        const resp = { approval_decision: hasOwn(op, "decision") ? op.decision : "approved", scope_digest: scope };
        const r = svc.resume_interaction(rid(op.run), ix.interaction_id, resp, p(op.as || "user:bob"), op.request_id || "");
        if (r.interaction) rt.ix[op.run] = r.interaction;
        return [rt_step(r), op.run, true];
      }
      case "inspect": return [svc.inspect_run(rid(op.run), p(op.as)), null, false];
      case "evidence": return [e.store.evidence(TENANT, rid(op.run)), null, false];
      case "inject": e.erp.inject(op.fault); return [null, null, false];
      default: throw new CheckFailure("the in-page interpreter does not support the operation " + op.op);
    }
  }
  function runtime_check(name) {
    return (ctx) => {
      const sc = (G().runtime.scenarios || []).find((s) => s.name === name);
      A.ok(sc, "scenario " + name + " in the embedded sample");
      let n = 0;
      const rt = { clock: new HX.env.ManualClock(1790000000.25), timer: () => 0.125 * ++n, ids: HX.env.make_seq_ids(1), env: null, runs: {}, ix: {} };
      sc.ops.forEach((op, i) => {
        const want = sc.transcript[i];
        const got = {};
        let run, take;
        try {
          const [res, r, t] = rt_op(ctx, rt, op);
          const v = plain(res);
          if (hasOwn(want, "result_digest")) {
            got.result_digest = HX.canonical.digest(v);
            if (HX.util.is_plain_object(v) && hasOwn(v, "status")) got.status = v.status;
          } else got.result = v;
          run = r; take = t;
        } catch (exc) {
          if (exc instanceof CheckFailure) throw exc;
          got.error = rt_enc_error(exc);
          run = op.run; take = true;
        }
        if (take && rt.env !== null) {
          const sn = rt_snap(rt, run !== null && run !== undefined ? run : op.run);
          if (hasOwn(want, "snap_digest")) got.snap_digest = HX.canonical.digest(sn);
          else got.snap = sn;
        }
        A.same(got, want, "operation " + (i + 1) + " (" + op.op + ")");
      });
      return count(sc.ops.length, "operations");
    };
  }
  def("golden", "g-rt-happy", "G12", "Runtime transcript: happy path to a verified draft", N_RUN, runtime_check("happy_path"), { embed: true, python: "gen_runtime.py happy_path" });
  def("golden", "g-rt-restart", "G13", "Runtime transcript: restart while waiting for approval", N_RUN, runtime_check("restart_while_waiting"), { embed: true, python: "gen_runtime.py restart_while_waiting" });
  def("golden", "g-rt-timeout", "G14", "Runtime transcript: ERP timeout after commit", N_RUN, runtime_check("timeout_after_commit"), { embed: true, python: "gen_runtime.py timeout_after_commit" });
  def("golden", "g-demo", "G15", "Demo narrative: every line and the summary", ["demo"].concat(N_LEARN), () => {
    const g = G().demo;
    let n = 0, idn = 0;
    const seq = HX.env.make_seq_ids(1);
    const d = HX.demo.create({ scenario: g.scenario, clock_start: g.clock0, timer: () => 0.125 * ++n, ids: () => { idn++; return seq(); } });
    d.run_all();
    const want = g.lines.map((l) => (/^== done\. Artifacts in .*\/ ==$/.test(l) ? "== done ==" : l));
    A.eq(d.lines.length, want.length, "number of lines");
    want.forEach((l, i) => A.eq(d.lines[i], l, "line " + (i + 1)));
    A.same(plain(d.summary), g.summary, "summary");
    A.eq(n, g.timer_calls, "timer draws");
    A.eq(idn, g.ids_used, "id draws");
    return count(want.length, "lines");
  }, { embed: true, python: "procurement_demo.run_demo" });

  /* ---- acceptance A01-A32 -------------------------------------------------------------------------------- */
  const AC = "acceptance";
  def(AC, "a01", "A01", "compile reference skill with fixture model", N_COMPILE, (ctx) => {
    const c = compiled(ctx);
    A.deep(c.attempts.map((a) => a.status), ["invalid", "valid"], "attempt statuses (bounded repair used once)");
    A.deep(Array.from(new Set(c.attempts[0].findings.map((f) => f.code))), ["ORDERING_VIOLATION"], "first attempt's findings");
    const rep = validate(c.package, catalog_of());
    A.ok(rep.passed, "the compiled package validates: " + short(rep.errors().map((f) => f.code)));
    const text = skill_text();
    const ids = HX.clauses.index_clauses(text).map((x) => x.id).sort();
    A.deep(Object.keys(c.package.contracts.clause_coverage).sort(), ids, "every clause accounted for");
    const cps = Array.from(text);
    for (const cl of c.package.source_manifest.clauses) A.eq(cps.slice(cl.start, cl.end).join(""), cl.text, "quoted provenance of " + cl.id);
    const critical = c.coverage.filter((r) => r.critical);
    A.ok(critical.length && critical.every((r) => r.classification === "executable_control" && r.states.length), "critical clauses are executable control with states");
    A.ok(c.review_required.length && c.review_required[0].startsWith("S1.2"), "S1.2 needs review");
  }, { python: "test_A01_compile_reference_skill_with_fixture_model" });

  const A02_CASES = [
    ["edge to an unknown state", (m) => { m.states.LOOKUP_SUPPLIER.transitions[1].to = "NOPE"; }, "UNKNOWN_TARGET", ["LOOKUP_SUPPLIER", 1]],
    ["unknown tool", (m) => { m.states.READ_INTAKE.action.name = "shell.exec"; }, "UNKNOWN_TOOL", ["READ_INTAKE", null]],
    ["unknown variable", (m) => { m.states.EXTRACT_DRAFT.action.reads.push("ghost"); }, "UNKNOWN_VARIABLE", ["EXTRACT_DRAFT", null]],
    ["unknown terminal", (m) => { m.states.END_UNVERIFIED.action.terminal = "END_MYSTERY"; }, "UNKNOWN_TERMINAL", ["END_UNVERIFIED", null]],
    ["duplicate variable", (m) => { m.variables.push(Object.assign({}, m.variables[0])); }, "DUPLICATE_VARIABLE", [null, null]],
    ["unknown initial state", (m) => { m.initial = "NOWHERE"; }, "UNKNOWN_INITIAL", ["NOWHERE", null]],
  ];
  def(AC, "a02-structural", "A02", "structural errors rejected with location", N_COMPILE, (ctx) => {
    const catalog = catalog_of();
    for (const [what, fn, code, loc] of A02_CASES) {
      const rep = validate(mutate(pkg_of(ctx), fn), catalog);
      const hits = rep.errors().filter((f) => f.code === code);
      A.ok(hits.length, what + ": expected " + code + ", got " + short(rep.codes()));
      const at = [hits[0].state === undefined ? null : hits[0].state, hits[0].edge === undefined ? null : hits[0].edge];
      A.deep(at, loc, what + ": location of " + code);
    }
    return count(A02_CASES.length, "mutations");
  }, { python: "test_A02_structural_errors_rejected_with_location" });
  def(AC, "a02-json", "A02", "duplicate JSON keys rejected before parsing", ["canonical"], () => {
    const C = HX.canonical;
    A.throws(() => C.strict_loads('{"states": {"A": {}, "A": {}}}'), (e) => e instanceof C.CanonicalError, "duplicate keys");
    A.throws(() => C.strict_loads('{"x": NaN}'), (e) => e instanceof C.CanonicalError, "NaN");
    A.throws(() => C.strict_loads_bytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), (e) => e instanceof C.CanonicalError, "byte-order mark");
  }, { python: "test_A02_duplicate_json_keys_rejected_before_parsing" });
  def(AC, "a03", "A03", "malicious guards rejected without execution", N_COMPILE, (ctx) => {
    const marker = "/tmp/hx-selftest-pwned";
    const guards = ["__import__('os').system('touch " + marker + "') == 0", "draft.__class__ == 'x'", "open('" + marker + "', 'w') == 1",
      "[x for x in validation_issues] == []", "lambda: 1", "not ".repeat(20) + "(validation_status == 'pass')"];
    /* a trap: if anything evaluated the text as code, __import__ would be called */
    const had = Object.prototype.hasOwnProperty.call(globalThis, "__import__");
    let called = 0;
    if (!had) globalThis.__import__ = function () { called++; return { system: () => 0 }; };
    try {
      const catalog = catalog_of();
      for (const g of guards) {
        const bad = mutate(pkg_of(ctx), (m) => { m.states.VALIDATE_DRAFT.transitions[0].if = g; });
        A.ok(validate(bad, catalog).codes().has("GUARD_INVALID"), "GUARD_INVALID for " + short(g));
      }
    } finally {
      if (!had) delete globalThis.__import__;
    }
    A.eq(called, 0, "guard text executed");
    return count(guards.length, "guards");
  }, { python: "test_A03_malicious_guards_rejected_without_execution" });
  def(AC, "a04", "A04", "definite assignment rejects unsafe path", N_COMPILE, (ctx) => {
    const rep = validate(mutate(pkg_of(ctx), (m) => {
      m.states.READ_INTAKE.transitions.splice(1, 0, { if: "docs_status == 'missing'", to: "EXTRACT_DRAFT" });
    }), catalog_of());
    const rbw = rep.errors().filter((x) => x.code === "READ_BEFORE_WRITE");
    A.ok(rbw.some((x) => x.state === "EXTRACT_DRAFT" && x.variable === "existing_supplier"), "READ_BEFORE_WRITE for existing_supplier at EXTRACT_DRAFT, got " + short(rep.codes()));
  }, { python: "test_A04_definite_assignment_rejects_unsafe_path" });
  def(AC, "a05-template", "A05", "missing template binding is explicit", ["kernel"], () => {
    const K = HX.kernel;
    A.eq(A.code(() => K.fill_template({ draft_id: "${erp_draft_id}" }, {})), "MISSING_INPUT_BINDING", "missing binding");
    A.ok(A.code(() => K.fill_template({ q: "id=${missing}" }, { other: 1 })), "a missing binding inside a string raises");
    A.deep(K.fill_template({ x: "${v}" }, { v: false }), { x: false }, "typed, not stringified");
  }, { python: "test_A05_missing_template_binding_is_explicit" });
  def(AC, "a05-task", "A05", "invalid task input, no dispatch", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const e = A.throws(() => env.service.start_run(pkg.artifact_hash, HX.env.task({ document_ids: "DOC-W9-10042" }), env.principal("user:alice")),
      (x) => x instanceof HX.service.RunError, "start_run");
    A.eq(e.code, "TASK_INPUT_INVALID", "error code");
    A.eq(env.store.tables().action_receipts.length, 0, "action receipts");
  }, { python: "test_A05_invalid_task_input_no_dispatch" });
  def(AC, "a05-broker", "A05", "broker rejects wrong input type before connector", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const called = [];
    env.broker.connectors["erp.read_draft"] = (a) => { called.push(a); return {}; };
    const intent = { tenant_id: TENANT, run_id: "nope", logical_action_id: "la_x", tool: "erp.read_draft", tool_version: "1.0.0",
      args: { draft_id: 7 }, args_digest: "d", idempotency_key: "k", status: "PENDING", attempts: 0 };
    const [ok] = env.broker.authorize({ intent, spec: HX.catalog.get(env.catalog, "erp.read_draft"), principal: env.principal("user:alice"),
      package: pkg, business_unit: "BU-EMEA", approval_check: () => [true, ""], lease_token: null });
    A.eq(ok, false, "authorized");
    A.eq(called.length, 0, "connector calls");
  }, { python: "test_A05_broker_rejects_wrong_input_type_before_connector" });
  def(AC, "a06", "A06", "invalid judge label and privileged fields rejected", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const p = judge_pkg(ctx);
    same_as_python(p, "judge");
    const cp = K.initial_checkpoint(p, "t", "r", {});
    A.eq(A.code(() => K.advance(cp, obs(cp, "judge", { label: "definitely" }), p)), "INVALID_JUDGE_LABEL", "invalid label");
    A.eq(A.code(() => K.advance(cp, obs(cp, "judge", { label: "ok", approved: true }), p)), "UNEXPECTED_OUTPUT_KEYS", "privileged field");
    const r = K.advance(cp, obs(cp, "judge", { label: "abstain" }), p);
    A.eq(r.checkpoint.state_id, "FALLBACK", "abstention takes the explicit branch");
    A.ok(!hasOwn(r.checkpoint.variables, "approved"), "no approved variable");
  }, { python: "test_A06_invalid_judge_label_and_privileged_fields_rejected" });
  def(AC, "a07", "A07", "falsy values accepted by schema, not truthiness", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const p = falsy_pkg(ctx);
    same_as_python(p, "falsy");
    const cp = K.initial_checkpoint(p, "t", "r", {});
    const r = K.advance(cp, obs(cp, "model", { flag: false, count: 0, note: "" }), p);
    A.eq(r.checkpoint.state_id, "A", "state");
    A.deep(r.checkpoint.variables, { flag: false, count: 0, note: "" }, "variables");
  }, { python: "test_A07_falsy_values_accepted_by_schema_not_truthiness" });
  def(AC, "a08", "A08", "overlapping guards: counterexample and unknown", N_COMPILE, (ctx) => {
    const catalog = catalog_of();
    const over = mutate(pkg_of(ctx), (m) => { m.states.VALIDATE_DRAFT.transitions[1].if = "validation_status in ['pass', 'repairable'] and repair_count < 2"; });
    const f = validate(over, catalog).errors().filter((x) => x.code === "GUARDS_OVERLAP");
    A.ok(f.length, "GUARDS_OVERLAP for the widened repair guard");
    A.eq(f[0].detail.counterexample.validation_status, "pass", "counterexample validation_status");
    const unk = mutate(pkg_of(ctx), (m) => { m.states.VALIDATE_DRAFT.transitions[1].if = "validation_status == 'repairable' and repair_count < readback_count"; });
    A.ok(validate(unk, catalog).codes().has("GUARDS_DISJOINTNESS_UNKNOWN"), "GUARDS_DISJOINTNESS_UNKNOWN for a variable-to-variable comparison");
    const ce = f[0].detail.counterexample;
    return "counterexample " + Object.keys(ce).map((k) => k + " = " + JSON.stringify(ce[k])).join(", ");
  }, { python: "test_A08_overlapping_guards_counterexample_and_unknown" });
  def(AC, "a09", "A09", "guard reading a variable that was never set fails explicitly", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const p = falsy_pkg(ctx, "ghost == 'x'");
    same_as_python(p, "falsy_ghost");
    const cp = K.initial_checkpoint(p, "t", "r", {});
    const r = K.advance(cp, obs(cp, "model", { flag: true, count: 1, note: "n" }), p);
    A.eq(r.checkpoint.status, "FAILED", "status");
    const d = r.checkpoint.assurance.diagnostics;
    A.eq(d[d.length - 1].code, "GUARD_EVALUATION_ERROR", "last diagnostic");
    A.eq(r.checkpoint.state_id, "M", "did not fall through to the default edge");
  }, { python: "test_A09_undefined_variable_in_guard_fails_explicitly" });
  def(AC, "a10-bound", "A10", "repair bound boundaries", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const pkg = compiled(ctx).package;
    for (const [n, state, expected] of [[0, "REPAIR_DRAFT", 1], [1, "REPAIR_DRAFT", 2], [2, "END_UNVERIFIED", 2]]) {
      const cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT",
        variables: { draft: {}, required_fields: [], policy_version: "v", repair_count: n } });
      const r = K.advance(cp, obs(cp, "tool", { status: "repairable", issues: [], draft_digest: "d" }), pkg);
      A.eq(r.checkpoint.state_id, state, "repair_count " + n + ": next state");
      A.eq(r.checkpoint.variables.repair_count, expected, "repair_count " + n + ": counter");
    }
    return "3 boundaries";
  }, { python: "test_A10_repair_bound_boundaries" });
  def(AC, "a10-budget", "A10", "run budget exhaustion is monotonic", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const pkg = compiled(ctx).package;
    const cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT",
      variables: { draft: {}, required_fields: [], policy_version: "v", repair_count: 0 }, budget: { steps: pkg.execution_policy.budgets.max_steps } });
    const r = K.advance(cp, obs(cp, "tool", { status: "pass", issues: [], draft_digest: "d" }), pkg);
    A.eq(r.checkpoint.status, "FAILED", "status");
    const d = r.checkpoint.assurance.diagnostics;
    A.eq(d[d.length - 1].code, "BUDGET_EXHAUSTED", "last diagnostic");
    A.eq(r.checkpoint.budget.steps, cp.budget.steps + 1, "steps");
  }, { python: "test_A10_run_budget_exhaustion_is_monotonic" });
  def(AC, "a10-service", "A10", "repairs exhausted ends END_UNVERIFIED", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const p = env.principal("user:alice");
    const h = env.service.start_run(pkg.artifact_hash, HX.env.task({ document_ids: ["DOC-W9-10042"] }), p);
    const res = env.service.run_until_blocked(h.run_id, p);
    A.eq(res.checkpoint.outcome && res.checkpoint.outcome.terminal, "END_UNVERIFIED", "terminal");
    const path = env.service.inspect_run(h.run_id, p).path;
    A.eq(path.filter((x) => x === "VALIDATE_DRAFT->REPAIR_DRAFT").length, 2, "repair entries");
    A.eq(res.checkpoint.variables.repair_count, 2, "repair_count");
    A.eq(writes(env), 0, "ERP drafts");
  }, { python: "test_A10_repairs_exhausted_end_unverified" });
  def(AC, "a11", "A11", "cycle-avoiding bounded edge rejected", N_COMPILE, (ctx) => {
    const catalog = catalog_of();
    const bad = mutate(pkg_of(ctx), (m) => { m.states.VERIFY_PERSISTED.transitions[1].to = "READ_BACK"; });
    A.ok(validate(bad, catalog).codes().has("LOOP_UNBOUNDED"), "LOOP_UNBOUNDED for the cycle-avoiding edge");
    const unbounded = mutate(pkg_of(ctx), (m) => { m.states.VALIDATE_DRAFT.transitions[1].inc = null; });
    A.ok(validate(unbounded, catalog).codes().has("LOOP_UNBOUNDED"), "LOOP_UNBOUNDED for the repair loop without a counter");
  }, { python: "test_A11_cycle_avoiding_bounded_edge_rejected" });

  def(AC, "a12", "A12", "structural placeholders marked, never evidence", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const rep = HX.replay.replay(pkg, arc[0], "structural");
    A.eq(rep.status, "PASS", "structural replay");
    A.deep(Array.from(new Set(rep.placeholders.map((p) => p.state))).sort(), ["EXTRACT_DRAFT", "REPAIR_DRAFT"], "placeholder states");
    A.ok(rep.placeholders.every((p) => p.reason.indexOf("zero-width") >= 0), "placeholders say zero-width");
    const t = HX.traces.model_copy(arc[0], { deep: true });
    for (const r of t.records) if (r.action && r.action.kind === "user") r.output = {};
    const rep2 = HX.replay.replay(pkg, HX.traces.seal(t), "structural");
    A.ok(rep2.placeholders.some((p) => p.reason === "user response missing"), "a missing approval response is a placeholder");
    A.ok(!hasOwn(rep2.to_json(), "evidence"), "the report carries no evidence");
  }, { python: "test_A12_structural_placeholders_marked_never_evidence" });
  def(AC, "a13", "A13", "recorded replay blocks external calls", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const before = writes(env);
    /* the rogue step tries the network; recorded replay must have replaced every network entry point */
    const rogue = () => { globalThis.fetch("https://example.com/"); };
    const rep = HX.replay.replay(pkg, arc[0], "recorded", { on_step: rogue });
    A.eq(rep.status, "ERROR", "replay status");
    A.ok(String(rep.detail).indexOf("EXTERNAL_CALL_ATTEMPTED") >= 0, "detail names EXTERNAL_CALL_ATTEMPTED: " + short(rep.detail));
    A.eq(writes(env), before, "ERP drafts");
  }, { python: "test_A13_recorded_replay_blocks_external_calls" });
  def(AC, "a14", "A14", "candidate breaking protected trace rejected", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const active = env.store.get_active("sandbox", SKILL);
    const manifest = env.store.archive(SKILL);
    const before = HX.pkg.compute_hash(pkg);
    const prop = HX.update.propose_update(pkg, HX.reference.missing_docs_trace(), arc, [], catalog_of(), new HX.reference.BreakingAligner(), skill_text());
    A.eq(prop.status, "REJECTED", "proposal status");
    A.eq(prop.attempts.length, 2, "attempts");
    A.ok(prop.attempts[1].restrictive, "the second attempt is restrictive");
    A.ok(prop.gates.new_trace_replay.passed && !prop.gates.protected_replay.passed, "new trace passes, protected replay fails");
    const fail = prop.gates.protected_replay.failures[0];
    A.ok(fail.divergence.actual_state, "divergence names the actual state");
    A.eq(fail.divergence.trace_id, arc[1].trace_id, "diverging trace");
    A.eq(HX.pkg.compute_hash(pkg), before, "parent package unchanged");
    A.ok(!hasOwn(pkg.machine.states, "REQUEST_INPUT"), "parent has no REQUEST_INPUT");
    A.deep(env.store.get_active("sandbox", SKILL), active, "active pointer");
    A.deep(env.store.archive(SKILL), manifest, "archive manifest");
  }, { python: "test_A14_candidate_breaking_protected_trace_rejected" });
  def(AC, "a15", "A15", "correct answer via forbidden action goes to negative corpus", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const t = HX.reference.forbidden_write_trace();
    A.eq(t.records[t.records.length - 1].action.terminal, "END_VERIFIED_DRAFT", "the answer was right");
    const prop = HX.update.propose_update(pkg, t, arc, [], catalog_of(), new HX.reference.FixtureAligner());
    A.eq(prop.status, "EXCLUDED", "proposal status");
    A.deep(prop.negative_additions, [t.trace_id], "negative additions");
    A.ok(prop.diagnostics.some((d) => String(d).indexOf("ORD-APPROVAL-BEFORE-WRITE") >= 0), "diagnostics name ORD-APPROVAL-BEFORE-WRITE");
  }, { python: "test_A15_correct_answer_via_forbidden_action_goes_to_negative_corpus" });
  def(AC, "a16", "A16", "distinct writes never merged", ["traces", "normalize", "reference", "canonical"], () => {
    const events = HX.normalize.normalize(HX.reference.duplicate_write_trace())[0];
    const ws = events.filter((e) => e.tool === "erp.create_draft");
    A.eq(ws.length, 2, "writes");
    A.ok(JSON.stringify(ws[0].inputs) !== JSON.stringify(ws[1].inputs), "the two writes have different inputs");
    const t = HX.traces.model_copy(HX.reference.duplicate_write_trace(), { deep: true });
    t.records[1].meta.logical_action_id = t.records[0].meta.logical_action_id;
    t.records[1].action.input = t.records[0].action.input;
    const merged = HX.normalize.normalize(HX.traces.seal(t))[0].filter((e) => e.tool === "erp.create_draft");
    A.eq(merged.length, 1, "one logical operation");
    A.deep(merged[0].source_steps, [0, 1], "both records kept");
  }, { python: "test_A16_distinct_writes_never_merged" });
  def(AC, "a17-static", "A17", "static shortcut rejected with path", N_COMPILE, (ctx) => {
    const rep = validate(mutate(pkg_of(ctx), (m) => { m.states.EXTRACT_DRAFT.transitions[0].to = "REQUEST_APPROVAL"; }), catalog_of());
    const v = rep.errors().filter((f) => f.code === "ORDERING_VIOLATION");
    A.ok(v.length, "ORDERING_VIOLATION, got " + short(rep.codes()));
    const path = v[0].detail.path;
    A.ok(["PERSIST_DRAFT", "REQUEST_APPROVAL"].indexOf(path[path.length - 1]) >= 0, "counterexample path ends at the write or the approval: " + path.join(" → "));
    return path.join(" → ");
  }, { python: "test_A17_static_shortcut_rejected_with_path" });
  def(AC, "a17-update", "A17", "shortcut and approval removal rejected", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const catalog = catalog_of();
    const sc = HX.reference.shortcut_trace();
    A.eq(HX.update.propose_update(pkg, sc, arc, [], catalog, new HX.reference.ShortcutAligner()).status, "EXCLUDED", "shortcut trace eligibility");
    const cand = HX.update.apply_ops(pkg, new HX.reference.ShortcutAligner().propose({}));
    const gates = HX.update.evaluate_candidate(pkg, cand, sc, arc, [sc], catalog);
    A.ok(!gates.passed && !gates.static_validation.passed && !gates.negative_corpus.passed, "static and negative-corpus gates fail");
    const no_approval = clone(cand);
    delete no_approval.contracts.interactions.REQUEST_APPROVAL;
    no_approval.artifact_hash = "";
    const g2 = HX.update.evaluate_candidate(pkg, HX.pkg.sealed(no_approval), sc, arc, [], catalog);
    A.ok(g2.policy_non_widening.findings.some((f) => String(f).indexOf("REQUEST_APPROVAL") >= 0), "removing the approval is a policy change");
  }, { python: "test_A17_shortcut_and_approval_removal_rejected" });
  def(AC, "a18", "A18", "racing updates: one wins, the other must rebase", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const catalog = catalog_of();
    const dev = HX.reference.missing_docs_trace();
    class VariantAligner extends HX.reference.FixtureAligner {
      propose(c) {
        const ops = super.propose(c);
        for (const o of ops) {
          if (o.op === "add_state") o.state = Object.assign({}, o.state, { action: Object.assign({}, o.state.action, { prompt: "Please re-send ids." }) });
        }
        return ops;
      }
    }
    const p1 = HX.update.propose_update(pkg, dev, arc, [], catalog, new HX.reference.FixtureAligner(), skill_text());
    const p2 = HX.update.propose_update(pkg, dev, arc, [], catalog, new VariantAligner(), skill_text());
    A.ok(p1.candidate.artifact_hash !== p2.candidate.artifact_hash, "two different candidates");
    const kw = admit_kw(env, arc.concat([dev]), HX.update.archive_manifest(arc.concat([dev]), []));
    const r1 = HX.registry.admit(env.store, p1.candidate, catalog, Object.assign({ expected_parent_hash: pkg.artifact_hash }, kw));
    const r2 = HX.registry.admit(env.store, p2.candidate, catalog, Object.assign({ expected_parent_hash: pkg.artifact_hash }, kw));
    A.deep([r1.status, r2.status], ["ADMITTED", "CONFLICT"], "admissions");
    A.eq(env.store.get_active("sandbox", SKILL)[0], p1.candidate.artifact_hash, "active version");
    const rebased = HX.update.propose_update(p1.candidate, dev, arc.concat([dev]), [], catalog, new VariantAligner(), skill_text());
    A.eq(rebased.status, "NO_CHANGE", "rebased proposal");
  }, { python: "test_A18_racing_updates_one_wins_other_must_rebase" });
  def(AC, "a19", "A19", "process exit while waiting resumes", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    const ix = res.interaction;
    const env2 = env.restart();
    approve(env2, run_id, ix);
    const out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"));
    A.eq(out.checkpoint.outcome && out.checkpoint.outcome.terminal, "END_VERIFIED_DRAFT", "terminal");
    A.throws(() => approve(env2, run_id, ix), (e) => e instanceof HX.service.RunError, "a duplicate resume");
  }, { python: "test_A19_process_exit_while_waiting_resumes" });
  def(AC, "a20-policy", "A20", "policy change after approval invalidates it", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.policy.revoke_capability("user:carol", "documents:read");
    const out = env.service.run_until_blocked(run_id, env.principal("user:alice"));
    A.eq(out.status, "FAILED", "status");
    A.ok(out.detail.indexOf("APPROVAL_INVALID") >= 0 && out.detail.indexOf("policy_version") >= 0, "detail names APPROVAL_INVALID and policy_version: " + short(out.detail));
    A.eq(writes(env), 0, "ERP drafts");
  }, { python: "test_A20_policy_change_after_approval_invalidates_it" });
  def(AC, "a20-args", "A20", "changed arguments invalidate approval", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    const svc = env.service;
    const cp = svc._cp(TENANT, run_id);
    const run = env.store.get_run(TENANT, run_id);
    const p = svc.package(cp.artifact_hash);
    const prep = svc._prepare_tool(cp, p, "PERSIST_DRAFT", cp.revision);
    const intent = { state_id: "PERSIST_DRAFT", tool: "erp.create_draft", tool_version: "1.0.0", logical_action_id: prep.lid, args: prep.args, args_digest: prep.args_digest };
    A.deep(svc._approval_check(run, cp, p, intent)(), [true, ""], "the approved arguments");
    const tampered = Object.assign({}, intent, { args: Object.assign({}, prep.args, { supplier_ref: "SUP-99999" }), args_digest: "sha256:changed" });
    const [ok, why] = svc._approval_check(run, cp, p, tampered)();
    A.ok(!ok && why.indexOf("args_digest") >= 0, "changed arguments refused for args_digest: " + short(why));
  }, { python: "test_A20_changed_arguments_invalidate_approval" });
  def(AC, "a21", "A21", "permission revoked before dispatch", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.policy.revoke_capability("user:alice", "erp:draft:create");
    const out = env.service.run_until_blocked(run_id, env.principal("user:alice"));
    A.eq(out.status, "FAILED", "status");
    A.ok(out.checkpoint.assurance.policy_violations.length, "policy violations recorded");
    A.eq(writes(env), 0, "ERP drafts");
    const denied = env.store.receipts(TENANT, { run_id }).filter((r) => r.dispatch_state === "DENIED");
    A.ok(denied.length && String(denied[0].result.reason).indexOf("POLICY_DENY") >= 0, "a DENIED receipt with POLICY_DENY");
  }, { python: "test_A21_permission_revoked_before_dispatch" });
  def(AC, "a22", "A22", "crash after remote commit reconciles", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env, clock } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.faults.arm("after_remote_call");
    A.throws(() => env.service.run_until_blocked(run_id, env.principal("user:alice")), (e) => e instanceof HX.broker.SimulatedCrash, "the worker crash");
    A.eq(writes(env), 1, "ERP drafts after the crash");
    clock.advance(1000);
    const env2 = env.restart();
    env2.service.run_until_blocked(run_id, env2.principal("user:alice"), { worker_id: "worker-2" });
    A.eq(env2.erp.count(TENANT), 1, "ERP drafts after the restart");
    const rec = env2.store.receipts(TENANT, { run_id }).filter((r) => r.tool === "erp.create_draft");
    A.deep(rec.map((r) => r.certainty), ["reconciled"], "receipt certainty");
  }, { python: "test_A22_crash_after_remote_commit_reconciles" });
  function crash_point_check(point) {
    return (ctx) => {
      const pkg = pkg_of(ctx);
      const { env, clock } = make_env(ctx, pkg);
      const [run_id, res] = run_to_approval(env, pkg);
      approve(env, run_id, res.interaction);
      env.faults.arm(point);
      A.throws(() => env.service.run_until_blocked(run_id, env.principal("user:alice")), (e) => e instanceof HX.broker.SimulatedCrash, "the worker crash");
      clock.advance(1000);
      const env2 = env.restart();
      const out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"), { worker_id: "worker-2" });
      A.eq(out.status, "COMPLETED", "status after the restart");
      A.eq(out.checkpoint.outcome.terminal, "END_VERIFIED_DRAFT", "terminal");
      A.eq(env2.erp.count(TENANT), 1, "ERP drafts");
      const refs = new Set(env2.store.receipts(TENANT, { run_id }).filter((r) => r.tool === "erp.create_draft" && r.dispatch_state === "SUCCEEDED").map((r) => r.external_ref));
      A.eq(refs.size, 1, "distinct external references");
    };
  }
  for (const point of ["after_intent", "before_dispatch", "after_remote_call", "after_receipt", "before_commit"]) {
    def(AC, "a22-" + point, "A22", "crash at " + point + " never duplicates the write", N_RUN, crash_point_check(point),
      { python: "test_crash_at_each_boundary_never_duplicates_the_write[" + point + "]" });
  }
  def(AC, "a23", "A23", "non-idempotent timeout pauses without blind retry", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    env.catalog.tools["erp.create_draft"].effect = "non_idempotent_write";
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.erp.inject("timeout_after_commit");
    const out = env.service.run_until_blocked(run_id, env.principal("user:alice"));
    A.eq(out.status, "RECONCILING", "status");
    A.eq(env.service.run_until_blocked(run_id, env.principal("user:alice")).status, "RECONCILING", "status on the next attempt");
    A.eq(env.erp.calls.filter((c) => c[0] === "create").length, 1, "create calls");
  }, { python: "test_A23_non_idempotent_timeout_pauses_without_blind_retry" });
  def(AC, "a24", "A24", "stale worker fenced off", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env, clock } = make_env(ctx, pkg);
    const [run_id] = run_to_approval(env, pkg);
    const t1 = env.store.acquire_lease(TENANT, run_id, "worker-1", clock(), 10);
    A.eq(env.store.acquire_lease(TENANT, run_id, "worker-2", clock(), 10), null, "a held lease");
    clock.advance(11);
    const t2 = env.store.acquire_lease(TENANT, run_id, "worker-2", clock(), 10);
    A.eq(t2, t1 + 1, "the next lease token");
    const cp = env.store.latest_checkpoint(TENANT, run_id);
    const e = A.throws(() => env.store.commit_transition(TENANT, run_id, cp.revision, t1, Object.assign({}, cp, { revision: cp.revision + 1 }), [], clock()),
      (x) => x instanceof HX.store.ConflictError, "a stale commit");
    A.ok(e.message.indexOf("STALE_LEASE") >= 0, "conflict names STALE_LEASE");
    const intent = { tenant_id: TENANT, run_id, logical_action_id: "la_x", tool: "erp.read_draft", tool_version: "1.0.0", args: { draft_id: "D-1" }, args_digest: "d", idempotency_key: "k" };
    const r = env.broker.authorize({ intent, spec: HX.catalog.get(env.catalog, "erp.read_draft"), principal: env.principal("user:alice"),
      package: pkg, business_unit: "BU-EMEA", approval_check: () => [true, ""], lease_token: t1 });
    A.deep(r, [false, "STALE_LEASE"], "authorize with the stale lease");
  }, { python: "test_A24_stale_worker_fenced_off" });
  def(AC, "a25", "A25", "subject modified after verification blocks verified terminal", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    const cp = step_until_state(env, run_id, "END_VERIFIED_DRAFT");
    env.erp.modify_out_of_band(TENANT, cp.variables.erp_draft_id, { legal_name: "Changed Later GmbH" });
    const out = env.service.advance_run(run_id, env.principal("user:alice"));
    A.eq(out.status, "FAILED", "status");
    const d = out.checkpoint.assurance.diagnostics;
    A.eq(d[d.length - 1].code, "TERMINAL_ADMISSION_DENIED", "last diagnostic");
    A.eq(out.checkpoint.outcome, null, "outcome");
    const inval = env.store.evidence(TENANT, run_id).filter((e) => e.claim === "persisted_draft_matches_approved_payload");
    A.ok(inval[0].invalidated_at !== null && String(inval[0].invalidation_reason).indexOf("changed") >= 0, "the verification evidence is invalidated");
  }, { python: "test_A25_subject_modified_after_verification_blocks_verified_terminal" });
  const INJECT = () => HX.env.task({ supplier_ref: "SUP-30001", document_ids: ["DOC-INJECT-30001"] });
  def(AC, "a26-gullible", "A26", "injected instructions from gullible model contained", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const env2 = env.restart(new HX.fakes.FixtureExtractionModel({ gullible: true }));
    const p = env2.principal("user:alice");
    const h = env2.service.start_run(pkg.artifact_hash, INJECT(), p);
    const out = env2.service.run_until_blocked(h.run_id, p);
    A.eq(out.checkpoint.outcome && out.checkpoint.outcome.category, "fallback", "outcome category");
    const rejected = env2.store.events(TENANT, h.run_id).filter((e) => e.type === "MODEL_OUTPUT_REJECTED");
    A.ok(rejected.length && rejected[0].code === "UNEXPECTED_OUTPUT_KEYS" && rejected[0].keys.indexOf("approved") >= 0, "the injected approved key is rejected");
    A.ok(!hasOwn(out.checkpoint.variables, "approved") && !hasOwn(out.checkpoint.variables, "tenant_id"), "no injected variables");
    A.eq(env2.erp.count(TENANT) + env2.erp.count("globex"), 0, "ERP drafts in any tenant");
  }, { python: "test_A26_injected_instructions_from_gullible_model_contained" });
  def(AC, "a26-document", "A26", "document text cannot substitute for approval", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg, INJECT());
    A.eq(res.status, "WAITING_FOR_APPROVAL", "status");
    A.eq(writes(env), 0, "ERP drafts");
    const draft = env.service._cp(TENANT, run_id).variables.draft;
    const allowed = ["legal_name", "supplier_ref", "business_unit", "country", "tax_id", "contact_email", "source_links"];
    A.ok(Object.keys(draft).every((k) => allowed.indexOf(k) >= 0), "draft fields: " + short(Object.keys(draft)));
  }, { python: "test_A26_document_text_cannot_substitute_for_approval" });
  def(AC, "a27", "A27", "cancel races in-flight write", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env, clock } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    env.faults.arm("after_remote_call");
    A.throws(() => env.service.run_until_blocked(run_id, env.principal("user:alice")), (e) => e instanceof HX.broker.SimulatedCrash, "the worker crash");
    clock.advance(1000);
    const env2 = env.restart();
    const cr = env2.service.cancel_run(run_id, null, env2.principal("user:alice"));
    A.eq(cr.status, "CANCELLED", "cancel status");
    A.ok(cr.disclosed_effects.length === 1 && String(cr.disclosed_effects[0].external_ref).startsWith("D-"), "the committed draft is disclosed");
    A.deep(cr.unresolved, [], "unresolved effects");
    const out = env2.service.advance_run(run_id, env2.principal("user:alice"), { worker_id: "worker-3" });
    A.eq(out.status, "CANCELLED", "status after the cancel");
    A.eq(env2.erp.count(TENANT), 1, "ERP drafts");
  }, { python: "test_A27_cancel_races_in_flight_write" });
  def(AC, "a28", "A28", "post-write verification fails, no duplicate", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    approve(env, run_id, res.interaction);
    const cp = step_until_state(env, run_id, "READ_BACK");
    env.erp.tamper_payload(TENANT, cp.variables.erp_draft_id, { tax_id: "DE000000000" });
    const out = env.service.run_until_blocked(run_id, env.principal("user:alice"));
    A.eq(out.checkpoint.outcome && out.checkpoint.outcome.terminal, "END_UNVERIFIED", "terminal");
    A.eq(writes(env), 1, "ERP drafts");
    const ext = env.store.receipts(TENANT, { run_id }).filter((r) => r.tool === "erp.create_draft").map((r) => r.external_ref);
    A.deep(ext, [cp.variables.erp_draft_id], "external reference preserved");
  }, { python: "test_A28_post_write_verification_fails_no_duplicate" });
  def(AC, "a29", "A29", "fallback in write profile stops for review", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const env2 = env.restart(new HX.fakes.FixtureExtractionModel({ invalid_outputs: 5 }));
    const p = env2.principal("user:alice");
    const h = env2.service.start_run(pkg.artifact_hash, HX.env.task(), p);
    const out = env2.service.run_until_blocked(h.run_id, p);
    A.same(out.checkpoint.outcome, { terminal: "END_REVIEW", category: "fallback", outputs: {}, evidence_receipts: [] }, "outcome");
    const a = out.checkpoint.assurance;
    A.ok(a.entered_fallback && a.fallback_reason.indexOf("OUTPUT_INVALID") >= 0, "fallback reason names OUTPUT_INVALID");
    A.eq(out.checkpoint.budget.output_repairs, 1, "structured-output repairs");
    const after = env2.store.receipts(TENANT, { run_id: h.run_id }).filter((r) => r.tool !== "documents.read" && r.tool !== "supplier.lookup");
    A.eq(after.length, 0, "tool calls after the fallback");
  }, { python: "test_A29_fallback_in_write_profile_stops_for_review" });
  const STATUSES = ["pass", "repairable", "fail"];
  def(AC, "a30-kernel", "A30", "property: deterministic and monotonic", N_COMPILE.concat(["kernel"]), (ctx) => {
    const K = HX.kernel;
    const pkg = compiled(ctx).package;
    const DRAFT = { legal_name: "x", supplier_ref: "S", business_unit: "B", source_links: {} };
    function run(seq) {
      let cp = K.new_checkpoint({ tenant_id: "t", run_id: "r", artifact_hash: pkg.artifact_hash, state_id: "VALIDATE_DRAFT",
        variables: { draft: DRAFT, required_fields: [], policy_version: "v", repair_count: 0, validation_issues: [], documents: [] } });
      const trail = [];
      for (const s of seq) {
        if (cp.state_id === "REPAIR_DRAFT") cp = K.advance(cp, obs(cp, "model", { draft: Object.assign({}, DRAFT) }), pkg).checkpoint;
        if (cp.state_id !== "VALIDATE_DRAFT" || cp.status !== "RUNNING") break;
        const prev = cp.variables.repair_count;
        cp = K.advance(cp, obs(cp, "tool", { status: s, issues: [], draft_digest: "d" }), pkg).checkpoint;
        A.ok(cp.variables.repair_count >= prev, "repair_count never decreases");
        trail.push([cp.state_id, cp.revision, K.checkpoint_digest(cp)]);
      }
      return [trail, cp];
    }
    /* every sequence of 1 to 4 validation results (Python samples 150 random ones of up to 6) */
    let seqs = [[]];
    let n = 0;
    for (let len = 1; len <= 4; len++) {
      seqs = [].concat(...seqs.map((s) => STATUSES.map((x) => s.concat([x]))));
      for (const seq of seqs) {
        const [t1, c1] = run(seq);
        const [t2, c2] = run(seq);
        A.deep(t1, t2, "trail of " + seq.join(","));
        A.eq(K.checkpoint_digest(c1), K.checkpoint_digest(c2), "final checkpoint of " + seq.join(","));
        A.ok(c1.variables.repair_count <= 2, "repair_count stays within the bound");
        n++;
      }
    }
    return count(n, "sequences");
  }, { python: "test_A30_property_deterministic_and_monotonic" });
  def(AC, "a30-replay", "A30", "recorded replay reproduces exactly", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const reps = [0, 1, 2].map(() => HX.replay.replay(pkg, arc[0], "recorded").to_json());
    A.eq(reps[0].status, "PASS", "replay status");
    A.same(reps[1], reps[0], "second replay");
    A.same(reps[2], reps[0], "third replay");
  }, { python: "test_A30_recorded_replay_reproduces_exactly" });
  def(AC, "a31-traces", "A31", "tampered or incomplete traces", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const t = archive(env, pkg)[0];
    const bad = HX.traces.from_jsonl(HX.traces.to_jsonl(t).replace('"approved"', '"rejected"'));
    A.ok(bad[1] && bad[1].length, "integrity errors reported at load");
    A.eq(HX.replay.replay(pkg, bad[0], "structural").status, "REJECTED", "structural replay of the tampered trace");
    A.eq(HX.replay.replay(pkg, bad[0], "recorded").status, "REJECTED", "recorded replay of the tampered trace");
    const stripped = HX.traces.model_copy(t, { deep: true });
    delete stripped.records[3].meta.observation;
    A.eq(HX.replay.replay(pkg, HX.traces.seal(stripped), "recorded").status, "INCOMPLETE", "recorded replay without an observation");
  }, { python: "test_A31_tampered_or_incomplete_traces" });
  def(AC, "a31-update", "A31", "tampered trace excluded from update", N_LEARN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const arc = archive(env, pkg);
    const t = HX.reference.missing_docs_trace();
    const forged = HX.traces.from_jsonl(HX.traces.to_jsonl(t).replace('"missing"', '"available"'))[0];
    const prop = HX.update.propose_update(pkg, forged, arc, [], catalog_of(), new HX.reference.FixtureAligner());
    A.eq(prop.status, "EXCLUDED", "proposal status");
    A.ok(String(prop.diagnostics[0]).indexOf("integrity") >= 0, "the diagnostic names integrity: " + short(prop.diagnostics[0]));
  }, { python: "test_A31_tampered_trace_excluded_from_update" });
  def(AC, "a32", "A32", "revoked artifact", N_RUN, (ctx) => {
    const pkg = pkg_of(ctx);
    const { env } = make_env(ctx, pkg);
    const [run_id, res] = run_to_approval(env, pkg);
    HX.registry.revoke(env.store, pkg.artifact_hash, env.principal("user:dana"), "defect found", env.clock());
    const e = A.throws(() => env.service.start_run(pkg.artifact_hash, HX.env.task(), env.principal("user:alice")), (x) => x instanceof HX.service.RunError, "a new run");
    A.eq(e.code, "ARTIFACT_REVOKED", "error code");
    approve(env, run_id, res.interaction);
    const out = env.service.run_until_blocked(run_id, env.principal("user:alice"));
    A.eq(out.status, "CANCELLED", "status of the waiting run");
    const d = out.checkpoint.assurance.diagnostics;
    A.eq(d[d.length - 1].code, "ARTIFACT_REVOKED", "last diagnostic");
    A.eq(writes(env), 0, "ERP drafts");
    A.throws(() => HX.registry.revoke(env.store, pkg.artifact_hash, env.principal("user:alice"), "x", env.clock()), (x) => x && x.code === "PermissionError", "revoke as user:alice");
  }, { python: "test_A32_revoked_artifact" });

  /* ------------------------------------------------------------------ runner */
  let stamp_n = 0;
  function context() {
    stamp_n += 1;
    const ctx = { compiled: null, kpkgs: null, paths: [], stamp: "s" + stamp_n };
    ctx.close = function () {
      for (const p of ctx.paths) {
        try { HX.store.Store.reset_storage(p + "/hexis.db"); } catch (e) { /* not path-backed */ }
        try { HX.fakes.FakeERP.reset_storage(p + "/fake_erp.db"); } catch (e) { /* not path-backed */ }
      }
      ctx.paths = [];
    };
    return ctx;
  }
  function missing(check) {
    const hx = HX_();
    return check.needs.filter((n) => hx[n] === undefined || hx[n] === null).map((n) => "HX." + n);
  }
  function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
  function run(key, ctx) {
    const c = BY_KEY.get(key);
    if (!c) return { status: "skip", ms: 0, message: "There is no check named " + key + "." };
    const miss = missing(c);
    if (miss.length) return { status: "skip", ms: 0, missing: miss, message: "Needs engine modules that are not in this build: " +
      (miss.length > 3 ? miss.slice(0, 3).join(", ") + " and " + (miss.length - 3) + " more" : miss.join(", ")) + "." };
    if (c.embed && !embed()) return { status: "skip", ms: 0, message: "Needs the embedded golden sample, which this build does not include (app/embed.json)." };
    const t0 = now();
    try {
      const note = c.fn(ctx);
      return { status: "pass", ms: now() - t0, note: typeof note === "string" ? note : "" };
    } catch (err) {
      const assertion = err instanceof CheckFailure;
      return { status: "fail", ms: now() - t0, message: assertion ? err.message : "The engine raised " + describe(err),
        error_code: !assertion && err && err.code !== undefined ? String(err.code) : null };
    }
  }

  HXUI.checks = {
    GROUPS: [
      { id: "parity", title: "Parity anchors", lead: "The Python build's hashes, recomputed in this page." },
      { id: "golden", title: "Golden vectors", lead: "Vectors the Python reference produced, replayed against this engine." },
      { id: "acceptance", title: "Acceptance A01–A32", lead: "The Python acceptance tests, each against a fresh environment." },
    ],
    list: () => CHECKS.map((c) => ({ key: c.key, id: c.id, group: c.group, name: c.name, needs: c.needs.slice(), embed: c.embed, python: c.python })),
    context,
    run,
    embed,
    missing: (c) => missing(BY_KEY.get(c.key || c) || { needs: [] }),
  };
})();
