/* HEXIS Runtime Lab: Learn from traces (#learn).
   The protected archive, trace-driven update proposals and their gates, admission with a compare-and-swap on the
   expected parent, the A18 race, the A17 shortcut refusal and the held-out evaluation. Every status, digest, gate
   and count shown is computed by the engine in this page (HX.traces, HX.normalize, HX.replay, HX.update,
   HX.registry, HX.reference, HX.eval); the UI only reads the results back.

   Lab state (specs/ui-round2.md "Shared lab state"):
     reads   HXUI.lab.env (built with HXUI.lab_env() on first show), HXUI.lab.runs (titles of workbench runs),
             HXUI.lab.packages.initial (the compiled package; its skill id).
     writes  HXUI.lab.archive   [{trace_id, records_digest}] of the stored protected archive (lab:changed "archive")
             HXUI.lab.packages.refined   the candidate admitted here (lab:changed "packages")
             HXUI.lab.runs      the two seeded runs, when this section seeds the archive (lab:changed "runs")
   The stored archive (env.store.archive) is the only authority on what is enrolled; the section re-reads it after
   every call. When the store changes identity (Reset lab, a tour mirroring its own env), the section starts over.

   HXUI.learn exposes {state(), refresh()} for the tour and the tests. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline ln-nw" }, String(t));
  /** a trace id or other long identifier in mono that may wrap */
  const tid = (t) => h("code", { class: "hx-inline ln-wrap" }, String(t));

  /* every namespace the section reaches (enroll, propose, admit and the seeded runs call into all of these) */
  const NEEDS = ["traces", "normalize", "replay", "update", "registry", "reference", "env", "service", "store", "compile",
    "catalog", "pkg", "validate", "diff", "canonical", "fixture", "policy", "kernel", "broker", "fakes", "approvals",
    "jsonschema", "guards", "efsm", "clauses"];
  const EVAL_NEEDS = ["eval", "metrics"];
  const ENVIRONMENT = "sandbox";
  const ADMIN = "user:dana";
  const LAB_EPOCH = 1790000000.25;
  const FINISHED = ["COMPLETED", "FAILED", "CANCELLED"];

  const ABOUT = [
    "Enroll completed runs into the protected archive, or see why a run is not eligible.",
    "Propose an update from the missing-documents trace and read every gate, the diff and the admission against the expected parent.",
    "Race two updates for the same parent, and watch a shortcut trace get rejected while the active version stays the same.",
    "Evaluate the initial and the trace-refined machines on held-out tasks.",
  ];

  /* the development traces the proposal panel offers, each with the aligner its Python test pairs it with */
  const TRACES = [
    { id: "missing-docs", label: "Missing documents, then supplied", aligner: "FixtureAligner", make: "missing_docs_trace", ref: "Python test A18",
      why: "Documents are missing; the requester supplies them once and the run continues. The parent machine cannot represent that, so the aligner proposes a bounded input request." },
    { id: "missing-docs-breaking", label: "Missing documents, breaking aligner", aligner: "BreakingAligner", make: "missing_docs_trace", ref: "Python test A14",
      why: "The same trace, but the aligner also reroutes the registry-conflict path. The protected-replay gate must catch it." },
    { id: "shortcut", label: "Shortcut: repair, then approve without validating", aligner: "ShortcutAligner", make: "shortcut_trace", ref: "Python test A17",
      why: "The trace skips re-validation after a repair. It violates an ordering requirement, so it is excluded before any candidate is built." },
    { id: "forbidden-write", label: "ERP write without approval", aligner: "FixtureAligner", make: "forbidden_write_trace", ref: "Python test A15",
      why: "The answer was right, but the ERP write happened without approval. The trace is excluded and belongs in the negative corpus." },
  ];

  const GATES = [
    { key: "policy_non_widening", label: "Policy non-widening" },
    { key: "static_validation", label: "Static validation" },
    { key: "new_trace_replay", label: "New-trace replay" },
    { key: "protected_replay", label: "Protected replay" },
    { key: "negative_corpus", label: "Negative corpus" },
  ];

  const STATUS_TONE = { CANDIDATE: "ok", ADMITTED: "ok", NO_CHANGE: "neutral", EXCLUDED: "warn", REJECTED: "crit", CONFLICT: "warn" };
  const STATUS_ICON = { CANDIDATE: "check", ADMITTED: "check", EXCLUDED: "stop", REJECTED: "cross", CONFLICT: "alert" };
  /* the one chip rule (HXUI.status_chip): engine status values read as words, the value itself in the tooltip */
  const status_chip = (s, id) => {
    const c = HXUI.status_chip ? HXUI.status_chip(s, STATUS_TONE[s] || "neutral", { icon: STATUS_ICON[s] }) : HXUI.chip(s, STATUS_TONE[s] || "neutral", { icon: STATUS_ICON[s] });
    if (id) c.id = id;
    c.dataset.status = s;
    return c;
  };
  /* replay statuses (PASS, DIVERGED, ...) follow the same rule */
  const replay_chip = (s) => (HXUI.status_chip ? HXUI.status_chip(s, s === "PASS" ? "ok" : "crit") : HXUI.chip(s, s === "PASS" ? "ok" : "crit"));

  /** The guided demo's step 6a, when it ran in this lab's env: {proposal, admission, refined_hash, parent_hash}.
      The tour publishes it on HXUI.lab.log (source "tour"); it belongs to this env when its refined machine is
      admitted in this store. */
  function tour_learn(env) {
    const log = Array.isArray(HXUI.lab.log) ? HXUI.lab.log : [];
    let e = null;
    for (let i = log.length - 1; i >= 0; i--) if (log[i] && log[i].source === "tour" && log[i].kind === "learn" && log[i].step === "6a") { e = log[i]; break; }
    if (!e || !env || !e.refined_hash) return null;
    try { if (!HX.registry.is_admitted_in(env.store, e.refined_hash, ENVIRONMENT)) return null; } catch (err) { return null; }
    return e;
  }

  /* ---------------------------------------------------------------- small helpers */
  function with_id(el, id) { el.id = id; return el; }
  function short(hash, n) {
    const s = String(hash || "");
    return s.length > (n || 19) ? s.slice(0, n || 19) + "…" : s;
  }
  function ms_text(ms) { return ms < 1 ? "under 1 ms" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function err_of(e) {
    const is_hx = globalThis.HX && HX.HXError && e instanceof HX.HXError;
    /* HX.HXError's message is "CODE: msg"; the chip already shows the code, so the text is the bare msg */
    return { code: is_hx ? String(e.code || e.name || "HXError") : (e && e.name) || "Error",
      message: is_hx && e.msg !== undefined ? String(e.msg) : String((e && e.message) || e) };
  }
  /** run fn after the browser has painted the "working" state (engine calls are synchronous) */
  function after_paint(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(fn, 0));
    else setTimeout(fn, 16);
  }
  /** "A → B → C" as a mono chain that may wrap between states */
  function chain(path, cls) {
    const kids = [];
    (path || []).forEach((s, i) => {
      if (i) kids.push(h("span", { class: "ln-chain-arrow", "aria-hidden": "true" }, "→"), h("span", { class: "hx-visually-hidden" }, " then "));
      kids.push(h("code", { class: "ln-chain-state" }, String(s)));
    });
    return h("span", { class: ["ln-chain", cls] }, kids);
  }
  function dl(rows, cls) {
    return h("dl", { class: ["ln-facts", cls] }, rows.filter(Boolean).map(([k, v]) =>
      h("div", { class: "ln-fact" }, h("dt", { class: "hx-label" }, k), h("dd", null, v))));
  }
  function error_notice(title, e, fix) {
    const er = err_of(e);
    return HXUI.notice("crit", title, h("div", { class: "hx-stack-tight" },
      h("p", null, HXUI.chip(er.code, "crit", { mono: true }), " ", er.message),
      fix ? h("p", null, fix) : null));
  }

  /* ---------------------------------------------------------------- engine access */
  let base_pkg = null; /* the compiled initial package, when the lab has none yet */

  function initial_package() {
    const lab = HXUI.lab;
    if (lab.packages && lab.packages.initial && lab.packages.initial.machine) return lab.packages.initial;
    /* only a package the Compile section validated (as 30_run.js compiled_package() does) */
    if (lab.compile && lab.compile.status === "validated" && lab.compile.package && lab.compile.package.machine) return lab.compile.package;
    if (!base_pkg) {
      const r = HX.compile.compile_procurement();
      if (!r || !r.package) throw new HX.HXError("COMPILE_FAILED", "The compiler returned no package (status " + (r ? r.status : "none") + ").");
      base_pkg = r.package;
    }
    return base_pkg;
  }

  /** the shared lab env; built like the Run workbench builds it when that file is not in this build */
  function get_env() {
    const lab = HXUI.lab;
    if (lab.env) return lab.env;
    if (typeof HXUI.lab_env === "function") return HXUI.lab_env();
    let n = 0;
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(LAB_EPOCH), ids: HX.env.make_seq_ids(1), timer: () => 0.125 * n++ });
    const pkg = initial_package();
    const adm = HX.env.admit_initial(env, pkg);
    if (!adm || adm.status !== "ADMITTED") throw new HX.HXError("ADMISSION_FAILED", "The initial package was not admitted (" + (adm ? adm.status : "no result") + ").");
    lab.env = env;
    lab.packages.initial = pkg;
    HXUI.lab_changed("env");
    return env;
  }

  function skill_id() { return initial_package().machine.skill_id; }

  function tenants(env) {
    const out = [];
    const doc = env.policy && env.policy.doc ? env.policy.doc : HX.data.policy;
    for (const p of Object.keys(doc.principals || {})) {
      const t = doc.principals[p].tenant_id;
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  function all_runs(env) {
    const out = [];
    for (const t of tenants(env)) {
      let ids = [];
      try { ids = env.store.list_runs(t); } catch (e) { ids = []; }
      for (const id of ids) {
        const r = env.store.get_run(t, id);
        if (!r) continue;
        let outcome = null;
        try { const cp = env.store.latest_checkpoint(t, id); outcome = cp ? cp.outcome : null; } catch (e) { outcome = null; }
        out.push(Object.assign({}, r, { outcome }));
      }
    }
    return out;
  }

  /** {hash, version, pkg, kind} of the active version, read from the store now */
  function active(env) {
    const a = env.store.get_active(ENVIRONMENT, skill_id());
    if (!a) return null;
    const pkg = env.service.package(a[0]);
    const init = initial_package().artifact_hash;
    return { hash: a[0], version: a[1], pkg, kind: a[0] === init ? "initial" : "refined" };
  }

  function archive(env) {
    const a = env.store.archive(skill_id());
    return a || { version: null, protected: [], negative: [] };
  }

  const trace_cache = new Map(); /* trace_id + records digest -> parsed stored trace */
  /** the stored archive's traces, parsed from the bodies the store holds (never the caller's copies) */
  function stored_traces(env, entries) {
    return (entries || []).map((e) => {
      const key = e.trace_id + "@" + e.records_digest;
      if (trace_cache.has(key)) return trace_cache.get(key);
      const body = env.store.trace_body(e.trace_id);
      if (body === null || body === undefined) throw new HX.HXError("TRACE_MISSING", "The store has no body for " + e.trace_id + ".");
      const [t, errs] = HX.traces.from_jsonl(body);
      if (errs && errs.length) throw new HX.HXError("TRACE_INTEGRITY", e.trace_id + ": " + errs[0]);
      trace_cache.set(key, t);
      return t;
    });
  }

  function archive_sets(env) {
    const a = archive(env);
    return { manifest: a, protected: stored_traces(env, a.protected), negative: stored_traces(env, a.negative) };
  }

  function make_aligner(name) {
    const R = HX.reference;
    if (name === "VariantAligner") return new VariantAligner();
    return new R[name]();
  }

  /** A18's second aligner: the fixture refinement with a different prompt, so the candidate hash differs. */
  class VariantAligner {
    constructor() { this.inner = new HX.reference.FixtureAligner(); this.model_id = this.inner.model_id; }
    propose(ctx) {
      return this.inner.propose(ctx).map((o) => (o.op === "add_state"
        ? Object.assign({}, o, { state: Object.assign({}, o.state, { action: Object.assign({}, o.state.action, { prompt: "Please re-send ids." }) }) })
        : o));
    }
  }

  function skill_text() { return HX.env.skill_source().text; }

  /* ---------------------------------------------------------------- section state */
  function fresh_state() {
    return {
      store: null,          /* the env.store this state belongs to */
      init: "idle",         /* idle | running | done | error */
      init_error: null,
      origin: null,         /* {mode: "seeded" | "workbench" | "existing", runs: [...], result} */
      enroll: null,         /* {rows, at} last "Enroll completed runs" */
      choice: "missing-docs",
      proposal: null,       /* {opt, prop, dev, parent_hash, ms, error} */
      admission: null,      /* {result, before, after, candidate_hash, error} */
      race: null,           /* {rows, rebased, before, after, error | note} */
      shortcut: null,       /* {p_sc, gates, cand, before, after, ms, error} */
      evaluation: null,     /* {result, ms, error} */
      busy: {},
    };
  }
  let S = fresh_state();
  let P = null; /* rendered parts */

  function sync_store() {
    const env = HXUI.lab.env;
    if (S.store && env && env.store !== S.store) {
      const choice = S.choice;
      S = fresh_state();
      S.choice = choice;
    }
  }

  function publish_archive(env) {
    try {
      const a = archive(env);
      HXUI.lab.archive = (a.protected || []).map((e) => ({ trace_id: e.trace_id, records_digest: e.records_digest }));
      HXUI.lab_changed("archive");
    } catch (e) { /* nothing stored yet */ }
  }

  /* ---------------------------------------------------------------- engine operations */
  /** Enroll every finished run that is not in the archive yet, one run per enroll_protected call, so one
      ineligible run never blocks the others. In-flight runs are listed with the reason they are skipped. */
  function enroll_finished(env) {
    const a = archive(env);
    const enrolled = new Set((a.protected || []).map((e) => e.trace_id));
    const dana = env.principal(ADMIN);
    const rows = [];
    for (const r of all_runs(env)) {
      const tid = "trace:" + r.run_id;
      if (enrolled.has(tid)) continue;
      const row = { run_id: r.run_id, status: r.status, terminal: r.outcome ? r.outcome.terminal : null, title: run_title(r.run_id) };
      if (FINISHED.indexOf(r.status) < 0) {
        row.result = "SKIPPED";
        row.reasons = ["The run is still " + r.status + ". Finish or cancel it in the Run workbench, then enroll it."];
        rows.push(row);
        continue;
      }
      try {
        const t = HX.traces.export_run_trace(env.service, r.run_id, env.principal(r.principal), "accepted");
        const res = HX.registry.enroll_protected(env.store, skill_id(), [t], { actor: dana, environment: ENVIRONMENT, now: env.clock() });
        row.result = res.status;
        row.reasons = res.reasons || [];
        row.version = res.archive_version;
        row.trace_id = t.trace_id;
      } catch (e) {
        const er = err_of(e);
        row.result = "ERROR";
        row.reasons = [er.code + ": " + er.message];
      }
      rows.push(row);
    }
    return rows;
  }

  function run_title(run_id) {
    const m = (HXUI.lab.runs || []).find((x) => x && x.run_id === run_id);
    return m ? m.title : null;
  }

  /** The demo's seed: a verified clean intake (approved by user:bob) and a registry-conflict run, both enrolled. */
  function seed(env) {
    const pkg = initial_package();
    const alice = env.principal("user:alice"), bob = env.principal("user:bob");
    const hash = active(env) ? active(env).hash : pkg.artifact_hash;
    const h1 = env.service.start_run(hash, HX.env.task(), alice);
    let r1 = env.service.run_until_blocked(h1.run_id, alice);
    if (r1.status === "WAITING_FOR_APPROVAL" && r1.interaction) {
      env.service.resume_interaction(h1.run_id, r1.interaction.interaction_id,
        { approval_decision: "approved", scope_digest: r1.interaction.scope_digest }, bob);
      r1 = env.service.run_until_blocked(h1.run_id, alice);
    }
    const h2 = env.service.start_run(hash, HX.env.task({ supplier_ref: "SUP-55555" }), alice);
    const r2 = env.service.run_until_blocked(h2.run_id, alice);
    const runs = [
      { run_id: h1.run_id, scenario: "clean", title: "Clean intake (seeded by Learn)", res: r1 },
      { run_id: h2.run_id, scenario: "registry-conflict", title: "Registry conflict (seeded by Learn)", res: r2 },
    ];
    for (const r of runs) {
      HXUI.lab.runs.push({ run_id: r.run_id, tenant_id: "acme", scenario: r.scenario, title: r.title, initiator: alice.id,
        artifact_hash: hash, machine: hash === pkg.artifact_hash ? "initial" : "refined" });
    }
    const traces = runs.map((r) => HX.traces.export_run_trace(env.service, r.run_id, alice, "accepted"));
    const res = HX.registry.enroll_protected(env.store, skill_id(), traces, { actor: env.principal(ADMIN), environment: ENVIRONMENT, now: env.clock() });
    HXUI.lab_changed("runs");
    return { runs: runs.map((r) => ({ run_id: r.run_id, title: r.title, status: r.res.status,
      terminal: r.res.checkpoint && r.res.checkpoint.outcome ? r.res.checkpoint.outcome.terminal : null })), result: res };
  }

  function do_propose(opt_id) {
    const env = get_env();
    const opt = TRACES.find((t) => t.id === opt_id) || TRACES[0];
    const t0 = performance.now();
    const act = active(env);
    const sets = archive_sets(env);
    const dev = HX.reference[opt.make]();
    const prop = HX.update.propose_update(act.pkg, dev, sets.protected, sets.negative, env.catalog, make_aligner(opt.aligner), skill_text());
    return { opt, prop, dev, parent_hash: act.hash, parent_kind: act.kind, ms: performance.now() - t0 };
  }

  function do_admit(p) {
    if (!p || !p.prop || !p.prop.candidate) throw new HX.HXError("NO_CANDIDATE", "There is no candidate to admit. Propose an update with the missing-documents trace first.");
    const env = get_env();
    const before = env.store.get_active(ENVIRONMENT, skill_id());
    const sets = archive_sets(env);
    const protected_ = sets.protected.some((t) => t.trace_id === p.dev.trace_id) ? sets.protected : sets.protected.concat([p.dev]);
    const res = HX.registry.admit(env.store, p.prop.candidate, env.catalog, { expected_parent_hash: p.parent_hash,
      approver: env.principal(ADMIN), environment: ENVIRONMENT, deployment_policy: HX.fixture.deployment_policy(),
      protected: protected_, negative: sets.negative, now: env.clock(), skill_text: skill_text() });
    const after = env.store.get_active(ENVIRONMENT, skill_id());
    if (res.status === "ADMITTED") {
      HXUI.lab.packages.refined = p.prop.candidate;
      HXUI.lab_changed("packages");
    }
    return { result: res, before, after, candidate_hash: p.prop.candidate.artifact_hash, parent_hash: p.parent_hash };
  }

  /** A18: two proposals from the same parent, admitted one after the other against that parent. */
  function do_race() {
    const env = get_env();
    const act = active(env);
    const sets = archive_sets(env);
    const R = HX.reference;
    const dev = R.missing_docs_trace();
    const before = env.store.get_active(ENVIRONMENT, skill_id());
    const p1 = HX.update.propose_update(act.pkg, dev, sets.protected, sets.negative, env.catalog, new R.FixtureAligner(), skill_text());
    const p2 = HX.update.propose_update(act.pkg, dev, sets.protected, sets.negative, env.catalog, new VariantAligner(), skill_text());
    if (p1.status !== "CANDIDATE" || p2.status !== "CANDIDATE") {
      return { note: { p1: p1.status, p2: p2.status }, before, after: before, parent_hash: act.hash };
    }
    const protected_ = sets.protected.some((t) => t.trace_id === dev.trace_id) ? sets.protected : sets.protected.concat([dev]);
    const kw = () => ({ expected_parent_hash: act.hash, approver: env.principal(ADMIN), environment: ENVIRONMENT,
      deployment_policy: HX.fixture.deployment_policy(), protected: protected_, negative: sets.negative, now: env.clock(), skill_text: skill_text() });
    const r1 = HX.registry.admit(env.store, p1.candidate, env.catalog, kw());
    const r2 = HX.registry.admit(env.store, p2.candidate, env.catalog, kw());
    const after = env.store.get_active(ENVIRONMENT, skill_id());
    const winner = r1.status === "ADMITTED" ? p1 : r2.status === "ADMITTED" ? p2 : null;
    let rebased = null;
    if (winner) {
      HXUI.lab.packages.refined = winner.candidate;
      HXUI.lab_changed("packages");
      /* the loser rebases: rerun all gates against the new parent */
      const sets2 = archive_sets(env);
      rebased = HX.update.propose_update(winner.candidate, dev, sets2.protected, sets2.negative, env.catalog, new VariantAligner(), skill_text());
    }
    return {
      parent_hash: act.hash, before, after, rebased,
      rows: [
        { id: "first", label: "Fixture aligner", prop: p1, res: r1 },
        { id: "second", label: "Variant aligner (different prompt)", prop: p2, res: r2 },
      ],
    };
  }

  /** A17 against the active version: eligibility, then the hand-built shortcut candidate through every gate. */
  function do_shortcut() {
    const env = get_env();
    const t0 = performance.now();
    const R = HX.reference;
    const before = env.store.get_active(ENVIRONMENT, skill_id());
    const act = active(env);
    const sets = archive_sets(env);
    const sc = R.shortcut_trace();
    const p_sc = HX.update.propose_update(act.pkg, sc, sets.protected, sets.negative, env.catalog, new R.ShortcutAligner(), skill_text());
    const cand = HX.update.apply_ops(act.pkg, new R.ShortcutAligner().propose({}));
    const gates = HX.update.evaluate_candidate(act.pkg, cand, sc, sets.protected, sets.negative.concat([sc]), env.catalog, skill_text());
    const after = env.store.get_active(ENVIRONMENT, skill_id());
    return { p_sc, cand, gates, sc, before, after, parent_hash: act.hash, parent_kind: act.kind, ms: performance.now() - t0 };
  }

  function do_eval() {
    const t0 = performance.now();
    const result = HX.eval.run_eval();
    return { result, ms: performance.now() - t0, tasks: result.arms.initial_compiled.rows.length };
  }

  /* ---------------------------------------------------------------- the at-rest sequence */
  function init_sequence() {
    if (S.init === "running" || S.init === "done") return;
    S.init = "running";
    paint_all();
    const steps = [
      () => {
        const env = get_env();
        S.store = env.store;
        const a = archive(env);
        if ((a.protected || []).length) { S.origin = { mode: "existing" }; return; }
        const finished = all_runs(env).filter((r) => FINISHED.indexOf(r.status) >= 0);
        if (finished.length) {
          const rows = enroll_finished(env);
          S.origin = { mode: "workbench", rows };
          S.enroll = { rows };
          if ((archive(env).protected || []).length) return;
        }
        const sd = seed(env);
        S.origin = Object.assign({ mode: S.origin && S.origin.mode === "workbench" ? "workbench-then-seeded" : "seeded" }, sd);
      },
      () => { publish_archive(get_env()); propose_now(true); },
      () => { shortcut_now(true); },
      () => { if (!HXUI.engine_missing(EVAL_NEEDS).length) eval_now(true); },
    ];
    const mine = S; /* a Reset lab or a new env mid-sequence starts a new sequence; this one stops */
    const next = () => {
      if (S !== mine) return;
      const fn = steps.shift();
      if (!fn) { S.init = "done"; paint_all(); return; }
      try { fn(); } catch (e) {
        S.init = "error";
        S.init_error = e;
        paint_all();
        return;
      }
      paint_all();
      after_paint(next);
    };
    after_paint(next);
  }

  function propose_now(quiet) {
    try {
      S.proposal = do_propose(S.choice);
    } catch (e) {
      S.proposal = { error: e, opt: TRACES.find((t) => t.id === S.choice) };
    }
    if (S.proposal) S.proposal.by_user = !quiet;
    if (!quiet && S.proposal && S.proposal.prop) HXUI.announce("Proposal " + HXUI.status_words(S.proposal.prop.status) + ".");
  }

  function shortcut_now(quiet) {
    try { S.shortcut = do_shortcut(); } catch (e) { S.shortcut = { error: e }; }
    if (!quiet && S.shortcut.p_sc) HXUI.announce("Shortcut trace " + S.shortcut.p_sc.status + ". Active version unchanged.");
  }

  function eval_now(quiet) {
    try { S.evaluation = do_eval(); } catch (e) { S.evaluation = { error: e }; }
    if (!quiet && S.evaluation.result) HXUI.announce("Evaluation finished in " + ms_text(S.evaluation.ms) + ".");
  }

  /** run a user action: mark busy, let the button state paint, call the engine, repaint */
  function act(name, fn, paint) {
    if (S.busy[name]) return;
    sync_store();
    const mine = S; /* a Reset lab between the click and the call replaces S: the queued call is dropped */
    mine.busy[name] = true;
    paint();
    after_paint(() => {
      if (S !== mine) { mine.busy[name] = false; return; }
      try { fn(); } finally {
        mine.busy[name] = false;
        paint_all();
      }
    });
  }

  /* ---------------------------------------------------------------- rendering */
  function render(el) {
    const root = h("div", { class: "ln", id: "ln", dataset: { init: S.init } });
    const summary = h("dl", { class: "ln-summary", id: "ln-summary", "aria-label": "Learn from traces at a glance" });
    const body = h("div", { class: "ln-body hx-ruled" });
    P = { root, summary, body, panels: {} };
    P.panels.archive = archive_panel();
    P.panels.propose = propose_panel();
    P.panels.admit = admit_panel();
    P.panels.shortcut = shortcut_panel();
    P.panels.evaluate = evaluate_panel();
    body.append(P.panels.archive.el, P.panels.propose.el, P.panels.admit.el, P.panels.shortcut.el, P.panels.evaluate.el);
    root.append(summary, body);
    el.replaceChildren(root);
    paint_all();
  }

  let cur_panel = null; /* the panel being painted: candidate_graph() registers its view there */
  const open_graphs = new Set(); /* ids of graph disclosures the viewer opened: a repaint keeps them open */

  function paint_all() {
    if (!P || !P.root.isConnected) return;
    P.root.dataset.init = S.init;
    const env = HXUI.lab.env;
    try {
      const a = env ? active(env) : null;
      P.root.dataset.active = a ? a.hash : "";
    } catch (e) { P.root.dataset.active = ""; }
    paint_summary();
    for (const k of Object.keys(P.panels)) {
      /* every paint replaces the panel body, so the graph views drawn into the old body go first */
      for (const v of P.panels[k].views || []) { try { v.destroy(); } catch (e) { /* already gone */ } }
      P.panels[k].views = [];
      cur_panel = P.panels[k];
      try { P.panels[k].paint(); } catch (e) {
        P.panels[k].body.replaceChildren(error_notice("This panel could not be shown", e, "Reset the lab to start again."));
      }
    }
  }

  function panel(id, title, lead, controls) {
    const meta = h("div", { class: "hx-panel-meta", id: "ln-" + id + "-meta" });
    const body = h("div", { class: "ln-panel-body", id: "ln-" + id + "-body" });
    const el = h("section", { class: "hx-panel ln-panel", id: "ln-panel-" + id, "aria-labelledby": "ln-" + id + "-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "ln-" + id + "-title" }, title), meta),
      lead ? h("p", { class: "hx-panel-lead" }, HXUI.rich(lead)) : null,
      controls || null, body);
    return { el, meta, body };
  }

  function pending(text) {
    /* not a live region: HXUI.announce reports the outcome once the call returns */
    return h("p", { class: "ln-pending" }, h("span", { class: "ln-spinner", "aria-hidden": "true" }), text);
  }

  /* ---- summary strip */
  function sum_item(id, label, value, note) {
    return h("div", { class: "ln-sum-item", id: "ln-sum-" + id },
      h("dt", { class: "hx-label" }, label),
      h("dd", { class: "ln-sum-value" }, value, note ? h("span", { class: "ln-sum-note" }, note) : null));
  }

  function paint_summary() {
    const env = HXUI.lab.env;
    if (!env || S.init === "idle") {
      P.summary.replaceChildren(sum_item("active", "Active version", h("span", { class: "hx-faint" }, "Preparing the lab…")));
      return;
    }
    let a = null, ar = null;
    try { a = active(env); ar = archive(env); } catch (e) { a = null; }
    const prop = S.proposal && S.proposal.prop;
    /* after the guided demo, its proposal is the last one made in this lab, until the viewer proposes here */
    const tl = !(S.proposal && S.proposal.by_user) ? tour_learn(env) : null;
    const ev = !HXUI.engine_missing(EVAL_NEEDS).length && S.evaluation && S.evaluation.result;
    const items = [
      sum_item("active", "Active version",
        a ? [h("span", { class: "hx-mono", title: a.hash }, short(a.hash, 19)), HXUI.chip(a.kind, a.kind === "refined" ? "accent" : "neutral")] : h("span", { class: "hx-faint" }, "none"),
        a ? "archive v" + a.version + " · " + ENVIRONMENT : null),
      sum_item("archive", "Protected archive",
        ar ? h("span", { class: "hx-num", dataset: { count: (ar.protected || []).length } }, String((ar.protected || []).length)) : "–",
        ar ? "traces · " + plural((ar.negative || []).length, "negative") : null),
      tl ? sum_item("proposal", "Last proposal", [status_chip(tl.proposal, "ln-sum-proposal-status"), tl.admission ? status_chip(tl.admission) : null],
        "from the guided demo, missing documents")
        : sum_item("proposal", "Last proposal",
          prop ? status_chip(prop.status, "ln-sum-proposal-status") : h("span", { class: "hx-faint" }, S.proposal && S.proposal.error ? "error" : "not run yet"),
          prop ? (TRACES.find((t) => t.id === S.proposal.opt.id) || {}).label + (S.proposal.parent_kind === "refined" ? ", against the refined machine" : "") : null),
      sum_item("eval", "Business success",
        ev ? [h("span", { class: "hx-num" }, HX.eval.fmt2(ev.arms.initial_compiled.summary.business_success)),
          h("span", { class: "ln-arrow", "aria-hidden": "true" }, "→"), h("span", { class: "hx-visually-hidden" }, " initial, then refined "),
          h("span", { class: "hx-num" }, HX.eval.fmt2(ev.arms.trace_refined.summary.business_success))]
          : h("span", { class: "hx-faint" }, HXUI.engine_missing(EVAL_NEEDS).length ? "not in this build" : "not run yet"),
        ev ? eval_note(ev) : null),
    ];
    P.summary.replaceChildren(...items);
  }

  /** the summary's eval note: the whole-set pair is labelled as such, next to the strictly held-out pair */
  function eval_note(ev) {
    const a0 = ev.arms.initial_compiled, a1 = ev.arms.trace_refined;
    const n = a0.summary.tasks, ov = Object.keys(ev.dev_overlap || {}).length;
    const whole = "initial → refined, all " + plural(n, "task");
    if (!ov) return whole + ", all held out";
    return [whole + " (" + ov + " overlap" + (ov === 1 ? "s" : "") + " the dev trace)", h("br"),
      h("span", { id: "ln-sum-heldout" }, "strictly held out (" + a0.strictly_heldout_summary.tasks + "): " +
        HX.eval.fmt2(a0.strictly_heldout_summary.business_success) + " → " + HX.eval.fmt2(a1.strictly_heldout_summary.business_success))];
  }

  /* ---- protected archive */
  function archive_panel() {
    const enroll = HXUI.button("Enroll completed runs", { id: "ln-enroll", icon: "check", on_click: () => act("enroll", () => {
      const env = get_env();
      S.store = env.store;
      try {
        const rows = enroll_finished(env);
        S.enroll = { rows };
        publish_archive(env);
        const ok = rows.filter((r) => r.result === "ADMITTED").length;
        HXUI.announce(rows.length ? plural(ok, "run") + " enrolled, " + (rows.length - ok) + " not." : "Nothing new to enroll.");
      } catch (e) { S.enroll = { error: e }; }
    }, paint_all) });
    const reason = h("p", { class: "hx-reason", id: "ln-enroll-reason" });
    const controls = h("div", { class: "hx-action-row" }, enroll, reason);
    const p = panel("archive", "Protected archive", ["Enrolled traces are the regression suite every later admission must replay. ", { code: ADMIN },
      " enrolls finished runs with ", { code: "export_run_trace" }, " and ", { code: "enroll_protected" }, "; a run that is not eligible is refused with the reason."], controls);
    p.paint = () => {
      const env = HXUI.lab.env;
      if (S.init === "idle" || (S.init === "running" && !S.origin)) { p.body.replaceChildren(pending("Preparing the archive in this page…")); HXUI.set_disabled(enroll, true, "The archive is being prepared."); return; }
      if (S.init === "error" && !S.origin) {
        p.body.replaceChildren(error_notice("The archive could not be prepared", S.init_error, "Reset the lab, then open this section again."));
        HXUI.set_disabled(enroll, true, "The archive could not be prepared.");
        return;
      }
      const ar = archive(env);
      const prot = stored_traces(env, ar.protected);
      const neg = stored_traces(env, ar.negative);
      p.meta.replaceChildren(HXUI.chip("archive v" + ar.version, "neutral", { mono: true }), HXUI.chip(plural(prot.length, "protected trace"), prot.length ? "ok" : "neutral"));
      /* what can be enrolled now */
      const enrolled = new Set((ar.protected || []).map((e) => e.trace_id));
      const runs = all_runs(env).filter((r) => !enrolled.has("trace:" + r.run_id));
      const ready = runs.filter((r) => FINISHED.indexOf(r.status) >= 0);
      if (S.busy.enroll) HXUI.set_disabled(enroll, true, "Enrolling…");
      else if (!ready.length) {
        const why = runs.length ? "The runs not in the archive are still in progress. Finish them in the Run workbench first."
          : "Every finished run in this lab is enrolled. Finish another run in the Run workbench to enroll it.";
        HXUI.set_disabled(enroll, true, why);
      } else HXUI.set_disabled(enroll, false);
      reason.replaceChildren(HXUI.icon("info"), h("span", null, ready.length
        ? plural(ready.length, "finished run") + " not enrolled yet" + (runs.length > ready.length ? ", " + (runs.length - ready.length) + " still in progress." : ".")
        : runs.length ? plural(runs.length, "run") + " still in progress; finish " + (runs.length === 1 ? "it" : "them") + " in the Run workbench to enroll."
          : "Every finished run in this lab is enrolled."));

      const parts = [origin_note()];
      parts.push(HXUI.table({
        caption: "Protected traces in the stored archive", caption_hidden: true, class: "ln-archive-table",
        columns: [
          { key: "trace_id", label: "Trace", render: (t) => h("span", { class: "hx-mono ln-wrap" }, t.trace_id) },
          { key: "outcome", label: "Outcome", nowrap: true, fold: true, fold_label: "ends", render: (t) => trace_terminal(t) },
          { key: "records", label: "Records", align: "right", fold: true, fold_label: "records", render: (t) => h("span", { class: "hx-num" }, String(t.records.length)) },
          { key: "verdict", label: "Verdict", fold: true, render: (t) => t.verdict },
          { key: "digest", label: "Records digest", render: (t, i) => HXUI.digest(HX.traces.records_digest(t), { short: 15, label: "records digest of " + t.trace_id, id: "ln-arch-digest-" + i }),
            /* the folded line gets its own working copy button with a stable id (a clone would have neither) */
            fold: (t, i) => HXUI.digest(HX.traces.records_digest(t), { short: 15, label: "records digest of " + t.trace_id, id: "ln-arch-digest-fold-" + i }) },
        ],
        rows: prot, empty: "No protected traces yet.",
        row_attrs: (t) => ({ dataset: { trace: t.trace_id } }),
      }));
      if (neg.length) {
        parts.push(h("p", { class: "ln-sub" }, "Negative corpus"),
          h("ul", { class: "ln-chips", role: "list" }, neg.map((t) => h("li", null, HXUI.chip(t.trace_id, "warn", { mono: true })))));
      }
      if (S.enroll) parts.push(enroll_result());
      p.body.replaceChildren(...parts);
      p.body.dataset.count = String(prot.length);
    };
    return p;
  }

  function trace_terminal(t) {
    const last = t.records.length ? t.records[t.records.length - 1] : null;
    const term = last && last.action && last.action.terminal;
    return term ? code(term) : h("span", { class: "hx-faint" }, "no terminal");
  }

  function origin_note() {
    const o = S.origin;
    if (!o) return null;
    if (o.mode === "existing") {
      return h("p", { class: "ln-origin" }, "This lab already had an archive, so the section uses it as it is.");
    }
    const seeded = o.mode === "seeded" || o.mode === "workbench-then-seeded";
    if (seeded) {
      return h("div", { class: "ln-origin", id: "ln-origin", dataset: { mode: "seeded" } },
        h("p", null, o.mode === "seeded" ? "The Run workbench has no finished runs yet, so this section seeded the archive the way the demo does: "
          : "No workbench run was eligible, so this section seeded the archive the way the demo does: ",
        "a clean intake approved by ", code("user:bob"), " and a registry-conflict run, both started by ", code("user:alice"),
        " and enrolled by ", code(ADMIN), "."),
        h("ul", { class: "ln-origin-runs", role: "list" }, (o.runs || []).map((r) => h("li", null,
          code(r.run_id), " ", r.title.replace(" (seeded by Learn)", ""), " ", r.terminal ? HXUI.chip(r.terminal, r.terminal === "END_VERIFIED_DRAFT" ? "ok" : "warn", { mono: true }) : HXUI.chip(r.status, "neutral")))),
        h("p", { class: "ln-origin-result" }, "Enrollment: ", status_chip(o.result.status), o.result.archive_version ? " archive v" + o.result.archive_version : null,
          (o.result.reasons || []).length ? " · " + o.result.reasons.join("; ") : null));
    }
    return h("p", { class: "ln-origin", dataset: { mode: "workbench" } }, "The archive holds the finished runs from the Run workbench, enrolled when this section opened.");
  }

  function enroll_result() {
    if (S.enroll.error) return error_notice("Enrollment failed", S.enroll.error, "Reset the lab and try again.");
    const rows = S.enroll.rows || [];
    if (!rows.length) return h("p", { class: "ln-note", id: "ln-enroll-result" }, "Nothing new to enroll: every finished run is in the archive.");
    const chip = (r) => r.result === "SKIPPED" ? HXUI.chip("Skipped", "neutral") : r.result === "ERROR" ? HXUI.chip("Error", "crit", { icon: "stop" }) : status_chip(r.result);
    return h("div", { class: "ln-enroll-result", id: "ln-enroll-result" },
      h("p", { class: "ln-sub" }, "Last enrollment"),
      HXUI.table({
        caption: "Result of the last enrollment", caption_hidden: true,
        columns: [
          /* like the archive table: the run id never breaks, and Reason and Outcome fold under it on narrow screens */
          { key: "run_id", label: "Run", nowrap: true, render: (r) => h("code", { class: "hx-mono ln-nobreak" }, r.run_id) },
          { key: "result", label: "Result", nowrap: true, render: chip },
          { key: "why", label: "Reason", fold: true, render: (r) => r.result === "ADMITTED" ? "Enrolled as archive v" + r.version + "." : plain_lists((r.reasons || []).join(" ")) },
          { key: "terminal", label: "Outcome", fold: (r) => (r.terminal ? code(r.terminal) : null), fold_label: "ends",
            render: (r) => r.terminal ? code(r.terminal) : h("span", { class: "hx-faint" }, "not finished") },
        ],
        rows, row_attrs: (r) => ({ dataset: { run: r.run_id, result: r.result } }),
      }));
  }

  /* ---- propose */
  function propose_panel() {
    const sel = HXUI.select("ln-trace", TRACES.map((t) => ({ value: t.id, label: t.label + " (" + t.ref + ")" })), { value: S.choice, on_change: (v) => {
      S.choice = v;
      paint_choice();
    } });
    const field = HXUI.field("Development trace", sel, { hint: "" });
    const btn = HXUI.button("Propose update", { id: "ln-propose", variant: "primary", icon: "play", on_click: () => act("propose", () => propose_now(false), paint_all) });
    const form = h("form", { class: "ln-form", id: "ln-propose-form", on: { submit: (e) => { e.preventDefault(); btn.click(); } } },
      h("div", { class: "ln-form-row" }, field, h("div", { class: "ln-form-act" }, btn)));
    /* the trace's explanation is the select's hint, so it stays next to the select it describes */
    function paint_choice() {
      const opt = TRACES.find((t) => t.id === S.choice) || TRACES[0];
      field.hx.set_hint(opt.why + " Aligner: " + opt.aligner + "; parent: the active version.");
    }
    const p = panel("propose", "Propose an update", ["Pick a development trace. ", { code: "propose_update" },
      " checks that the trace is intact and eligible, asks the aligner for operations, builds a candidate and runs it through every gate against the stored archive. Nothing is admitted here."], form);
    p.paint = () => {
      paint_choice();
      HXUI.set_disabled(btn, S.busy.propose || S.init !== "done" && !S.proposal, S.busy.propose ? "Proposing…" : "The archive is being prepared.");
      const r = S.proposal;
      if (S.busy.propose) { p.body.replaceChildren(pending("Proposing in this page…")); return; }
      if (!r) { p.meta.replaceChildren(); p.body.replaceChildren(pending("Waiting for the archive…")); return; }
      if (r.error) {
        p.meta.replaceChildren(HXUI.chip("Error", "crit", { icon: "stop" }));
        p.body.replaceChildren(error_notice("The proposal failed", r.error, "A failed proposal never yields a candidate. Pick another trace or reset the lab."));
        return;
      }
      p.meta.replaceChildren(HXUI.chip("in " + ms_text(r.ms), "neutral"));
      const tl = !r.by_user ? tour_learn(HXUI.lab.env) : null;
      p.body.replaceChildren(...[tl ? h("p", { class: "ln-tour-note", id: "ln-tour-note" }, "The guided demo proposed the refined machine from this trace (",
        status_chip(tl.proposal), ") and admitted it (", status_chip(tl.admission), "). The proposal below runs again against that now-active refined machine, so it reports its own result.") : null,
      proposal_view(r)].filter(Boolean));
    };
    return p;
  }

  const VERDICT = {
    CANDIDATE: "Every gate passed. The candidate can be admitted against its parent.",
    NO_CHANGE: "The parent already represents this trace, so there is nothing to learn from it.",
    REJECTED: "Every candidate attempt failed a gate. The parent machine and the archive are unchanged.",
    EXCLUDED: "The trace itself was refused before any candidate was built. It belongs in the negative corpus, never in the protected archive.",
  };

  function proposal_view(r) {
    const prop = r.prop;
    const env = HXUI.lab.env;
    /* where the proposal stands against the store now: its candidate is active (admitted), its parent is
       still active (admissible), or the pointer moved elsewhere (stale: admitting it ends in CONFLICT) */
    let now = "parent";
    try {
      const a = active(env).hash;
      if (prop.candidate && a === prop.candidate.artifact_hash) now = "admitted";
      else if (a !== r.parent_hash) now = "stale";
    } catch (e) { now = "parent"; }
    const n_att = prop.attempts.length;
    const head = h("div", { class: "ln-result-head", id: "ln-proposal", dataset: { status: prop.status, trace: r.dev.trace_id, now } },
      status_chip(prop.status, "ln-proposal-status"),
      now === "admitted" ? with_id(HXUI.chip("Admitted · now active", "ok", { icon: "check" }), "ln-proposal-admitted") : null,
      h("p", { class: "ln-verdict" }, now === "admitted" ? "Every gate passed, and admission made this candidate the active version." : VERDICT[prop.status] || ""),
      n_att ? h("span", { class: "ln-sum-note", id: "ln-proposal-attempts" }, plural(n_att, "attempt")) : null);
    const facts = dl([
      ["Trace", h("span", { class: "hx-mono ln-wrap" }, prop.trace_id)],
      ["Parent", [HXUI.digest(r.parent_hash, { short: 19, label: "parent hash", id: "ln-proposal-parent" }), " ", HXUI.chip(r.parent_kind, "neutral")]],
      prop.candidate ? ["Candidate", HXUI.digest(prop.candidate.artifact_hash, { short: 19, label: "candidate hash", id: "ln-proposal-candidate" })] : null,
    ]);
    const parts = [head, facts];
    if (now === "stale") parts.push(HXUI.notice("warn", "The active version changed after this proposal", "Its parent is no longer active, so admitting it now ends in CONFLICT. Propose again to rerun the gates against the new parent."));
    if (prop.status === "EXCLUDED") {
      parts.push(h("div", { class: "ln-block" }, h("p", { class: "ln-sub" }, "Why the trace was excluded"),
        h("ul", { class: "ln-list", id: "ln-proposal-diagnostics" }, prop.diagnostics.map((d) => h("li", null, h("span", { class: "hx-mono ln-wrap" }, String(d))))),
        prop.negative_additions.length ? h("p", { class: "ln-note", id: "ln-proposal-negative" }, "Would be added to the negative corpus (this section does not store it): ", prop.negative_additions.map((t) => tid(t))) : null));
      return h("div", { class: "ln-result" }, parts);
    }
    if (prop.status === "NO_CHANGE") {
      const rep = (prop.gates.new_trace_replay || {}).report || {};
      parts.push(h("div", { class: "ln-block", id: "ln-nochange" }, h("p", { class: "ln-sub" }, "Replay against the parent"),
        h("p", null, rep.status ? replay_chip(rep.status) : null, " ",
          "The parent already walks this trace. No candidate was built, so no other gate ran."),
        Array.isArray(rep.path) && rep.path.length ? h("div", { class: "ln-path" }, h("span", { class: "hx-label" }, "Parent path "), chain(rep.path)) : null));
      return h("div", { class: "ln-result" }, parts);
    }
    if (prop.gates && Object.keys(prop.gates).length) parts.push(gates_table(prop.gates, "ln-gates"));
    if (prop.status === "CANDIDATE") {
      parts.push(diff_view(prop.diff), candidate_graph(prop.candidate, { highlight: prop.diff.states_added || [] }, "ln-prop-graph",
        "Show the candidate machine", "Candidate machine, new states highlighted"));
    }
    if (prop.status === "REJECTED") {
      parts.push(attempts_view(prop.attempts));
      /* the engine's own diagnostics, minus the line that only repeats the verdict above */
      const diag = (prop.diagnostics || []).map(String).filter((d) => !/^all candidate attempts failed/i.test(d));
      if (diag.length) parts.push(h("div", { class: "ln-block", id: "ln-proposal-engine" }, h("p", { class: "ln-sub" }, "Engine diagnostics"),
        h("ul", { class: "ln-list" }, diag.map((d) => h("li", null, h("span", { class: "hx-mono ln-wrap" }, d))))));
    }
    if (prop.requires_review && prop.requires_review.length) parts.push(HXUI.notice("warn", "Needs review", prop.requires_review.join("; ")));
    return h("div", { class: "ln-result" }, parts);
  }

  /** the engine mirrors Python's messages, which print lists of names as ['a', 'b']: show them as a, b */
  const plain_lists = (msg) => HXUI.plain_lists(msg);

  function gate_detail(key, g) {
    if (!g) return h("span", { class: "hx-faint" }, "not run");
    if (key === "policy_non_widening") return g.findings.length ? g.findings.join("; ") : "No capability, approval or budget is widened.";
    if (key === "static_validation") {
      if (!g.findings.length) return "validate_package found no errors.";
      return h("div", { class: "ln-findings" }, g.findings.map((f) => h("div", { class: "ln-finding" },
        HXUI.chip(f.code, "crit", { mono: true }), " ", h("span", null, plain_lists(f.message)),
        f.detail && Array.isArray(f.detail.path) ? h("div", { class: "ln-path" }, h("span", { class: "hx-label" }, "Counterexample "), chain(f.detail.path)) : null)));
    }
    if (key === "new_trace_replay") {
      const rep = g.report || {};
      /* the Result column already says passed or failed: a failure names the replay status, a pass needs no chip */
      return [rep.status && rep.status !== "PASS" ? [replay_chip(rep.status), " "] : null,
        rep.status === "PASS" ? "The candidate represents the trace: " + plural((rep.path || []).length, "state") + " on its path." : plain_lists(rep.detail || "")];
    }
    if (key === "protected_replay") {
      return h("div", null, h("span", null, plural(g.count, "protected trace") + " replayed, " + plural(g.failures.length, "failure") + "."),
        g.failures.map((f) => h("div", { class: "ln-finding" }, tid(f.trace_id), " ", replay_chip(f.status), " ",
          f.divergence && f.divergence.reason ? f.divergence.reason : f.detail,
          f.divergence && Array.isArray(f.divergence.path) && f.divergence.path.length ? h("div", { class: "ln-path" }, h("span", { class: "hx-label" }, "Candidate path "), chain(f.divergence.path)) : null)));
    }
    if (key === "negative_corpus") {
      return g.now_representable.length
        ? h("span", null, "Now representable: ", g.now_representable.map((t) => tid(t)))
        : plural(g.count, "negative trace") + "; none becomes representable.";
    }
    return "";
  }

  function gates_chip(gates) {
    return HXUI.chip(gates.passed ? "All gates passed" : "Gates failed", gates.passed ? "ok" : "crit", { icon: gates.passed ? "check" : "cross" });
  }

  /** the gate table; with no_title the caller shows the heading and gates_chip() in its own row */
  function gates_table(gates, id, no_title) {
    const rows = GATES.map((g) => ({ key: g.key, label: g.label, gate: gates[g.key] }));
    const wrap = h("div", { class: "ln-block", id, dataset: { passed: String(!!gates.passed) } },
      no_title ? null : h("div", { class: "ln-sub-row" }, h("p", { class: "ln-sub" }, "Gates"), gates_chip(gates)),
      HXUI.table({
        caption: "Gate results", caption_hidden: true, class: "ln-gates-table",
        columns: [
          { key: "label", label: "Gate", nowrap: true },
          { key: "result", label: "Result", nowrap: true, render: (r) => !r.gate ? HXUI.chip("Not run", "neutral")
            : r.gate.passed ? HXUI.chip("Passed", "ok", { icon: "check" }) : HXUI.chip("Failed", "crit", { icon: "cross" }) },
          { key: "detail", label: "Detail", fold: true, render: (r) => gate_detail(r.key, r.gate) },
        ],
        rows, row_attrs: (r) => ({ dataset: { gate: r.key, passed: r.gate ? String(!!r.gate.passed) : "" } }),
      }));
    return wrap;
  }

  function diff_view(diff) {
    const list = (xs, tone) => xs && xs.length ? h("span", { class: "ln-chips" }, xs.map((x) => HXUI.chip(String(x), tone || "neutral", { mono: true }))) : h("span", { class: "hx-faint" }, "none");
    const edges = [];
    for (const e of diff.edges_changed || []) {
      for (const a of e.added || []) edges.push(h("li", null, chain([e.state, a.to]), a["if"] ? [" if ", h("code", { class: "hx-inline" }, a["if"])] : " otherwise"));
      for (const a of e.removed || []) edges.push(h("li", null, h("span", { class: "ln-removed" }, "removed "), chain([e.state, a.to])));
    }
    const effects = diff.newly_reachable_effects || [];
    return h("div", { class: "ln-block", id: "ln-diff" },
      h("p", { class: "ln-sub" }, "What changes"),
      dl([
        ["States added", list(diff.states_added, "accent")],
        diff.states_removed && diff.states_removed.length ? ["States removed", list(diff.states_removed, "crit")] : null,
        ["Edges added", edges.length ? h("ul", { class: "ln-list ln-edges" }, edges) : h("span", { class: "hx-faint" }, "none")],
        ["Variables added", list(diff.variables && diff.variables.added)],
        ["Contracts changed", list(diff.contracts_changed)],
        ["Clauses affected", list(diff.affected_clauses)],
        ["New reachable effects", effects.length ? list(effects, "warn") : HXUI.chip("none", "ok", { icon: "check" })],
      ], "ln-facts--wide"));
  }

  function attempts_view(attempts) {
    return h("div", { class: "ln-block" }, h("p", { class: "ln-sub" }, "Attempts"),
      HXUI.table({
        caption: "Candidate attempts", caption_hidden: true,
        columns: [
          { key: "attempt", label: "#", align: "right", render: (a) => h("span", { class: "hx-num" }, String(a.attempt)) },
          { key: "mode", label: "Mode", nowrap: true, render: (a) => a.restrictive ? "restrictive" : "normal" },
          { key: "ops", label: "Operations", align: "right", render: (a) => h("span", { class: "hx-num" }, String((a.operations || []).length)) },
          { key: "failed", label: "Failed gates", render: (a) => a.op_errors && a.op_errors.length ? a.op_errors.join("; ")
            : a.gates ? Object.keys(a.gates).filter((k) => !a.gates[k]).map((k) => (GATES.find((g) => g.key === k) || { label: k }).label).join(", ") || "none" : "" },
        ],
        rows: attempts,
      }));
  }

  /** the transitions a state path takes in a machine, as graph view.update() visits: [{from, to, edge}] */
  function path_edges(machine, path) {
    const raw = machine && machine.states;
    const st = (id) => Array.isArray(raw) ? raw.find((x) => x && x.id === id) : raw ? raw[id] : null;
    const out = [];
    for (let i = 0; i + 1 < (path || []).length; i++) {
      const s = st(path[i]);
      const k = s && Array.isArray(s.transitions) ? s.transitions.findIndex((t) => t && t.to === path[i + 1]) : -1;
      out.push({ from: path[i], to: path[i + 1], edge: k >= 0 ? k : null });
    }
    return out;
  }

  /** A disclosure that draws the machine the first time it opens (the graph measures its container).
      mark: {highlight: [state ids]} or {path: [state ids]} (drawn as numbered steps, the run treatment).
      The view registers with the panel being painted, which destroys it on its next paint; a disclosure the
      viewer opened opens again after a repaint. */
  function candidate_graph(pkg, mark, id, summary, title) {
    if (!HXUI.graph || typeof HXUI.graph.create !== "function") return null;
    const box = h("div", { class: "ln-graph" });
    const det = h("details", { class: "ln-details", id },
      h("summary", { class: "ln-summary-line", id: id + "-toggle" }, summary), box);
    const owner = cur_panel;
    let view = null;
    det.addEventListener("toggle", () => {
      if (det.open) open_graphs.add(id); else open_graphs.delete(id);
      if (!det.open || view || !det.isConnected) return;
      try {
        view = HXUI.graph.create(box, pkg.machine, { title, interactions: pkg.contracts ? pkg.contracts.interactions : undefined });
        if (owner) (owner.views = owner.views || []).push(view);
        if (mark && Array.isArray(mark.path) && mark.path.length > 1) {
          view.update({ current: mark.path[mark.path.length - 1], visited: path_edges(pkg.machine, mark.path) });
        } else view.highlight((mark && mark.highlight) || []);
      } catch (e) { box.replaceChildren(error_notice("The graph could not be drawn", e)); }
    });
    if (open_graphs.has(id)) det.open = true;
    return det;
  }

  /* ---- admit */
  function admit_panel() {
    const admit = HXUI.button("Admit as " + ADMIN, { id: "ln-admit", variant: "primary", icon: "check", on_click: () => act("admit", () => {
      const r = S.proposal;
      try {
        S.admission = do_admit(r);
        HXUI.announce("Admission " + S.admission.result.status + ".");
        if (S.admission.result.status === "ADMITTED") shortcut_now(true);
      } catch (e) { S.admission = { error: e }; }
      publish_archive(get_env());
    }, paint_all) });
    const race = HXUI.button("Race two updates", { id: "ln-race", icon: "arrow", on_click: () => act("race", () => {
      try {
        S.race = do_race();
        if (S.race.rows) { HXUI.announce("Race: " + S.race.rows.map((x) => x.res.status).join(" and ") + "."); shortcut_now(true); }
      } catch (e) { S.race = { error: e }; }
      publish_archive(get_env());
    }, paint_all) });
    const admit_reason = h("p", { class: "hx-reason", id: "ln-admit-reason" });
    const race_reason = h("p", { class: "hx-reason", id: "ln-race-reason" });
    const controls = h("div", { class: "ln-admit-controls" },
      h("div", { class: "hx-action-row" }, admit, admit_reason),
      h("div", { class: "hx-action-row" }, race, race_reason));
    const pointer = h("div", { class: "ln-pointer-box", id: "ln-pointer" });
    const p = panel("admit", "Admit against the expected parent", ["Admission re-validates the candidate, replays the archive itself and moves the active pointer only if it still names the expected parent (a compare-and-swap). ",
      "Race two updates replays Python test A18: two refinements of the same parent are admitted one after the other, and the second must rebase."], controls);
    p.el.insertBefore(pointer, p.body);
    p.paint = () => {
      const env = HXUI.lab.env;
      const r = S.proposal;
      let a = null;
      try { a = env ? active(env) : null; } catch (e) { a = null; }
      pointer.replaceChildren(a ? h("p", { class: "ln-pointer" }, h("span", { class: "hx-label" }, "Active pointer now "),
        HXUI.digest(a.hash, { short: 19, label: "active version hash", id: "ln-active-hash" }), " ", HXUI.chip(a.kind, a.kind === "refined" ? "accent" : "neutral"),
        h("span", { class: "ln-sum-note" }, " archive v" + a.version)) : null);
      /* admit */
      let why = null;
      if (S.busy.admit) why = "Admitting…";
      else if (!r || !r.prop) why = "Propose an update first.";
      else if (r.prop.status !== "CANDIDATE") why = "The last proposal is " + r.prop.status + ", so there is no candidate to admit. Propose with the missing-documents trace.";
      else if (a && a.hash === r.prop.candidate.artifact_hash) why = "This candidate is the active version already.";
      HXUI.set_disabled(admit, !!why, why);
      admit_reason.replaceChildren(HXUI.icon("info"), h("span", null, why && !S.busy.admit ? why
        : r && r.prop && r.prop.candidate ? ["Expected parent ", h("span", { class: "hx-mono" }, short(r.parent_hash, 19)), "; the candidate and every archive trace are checked again."] : ""));
      /* race */
      let rwhy = null;
      if (S.busy.race) rwhy = "Racing…";
      else if ((r && r.prop && r.opt.id === "missing-docs" && r.prop.status === "NO_CHANGE" && a && a.hash === r.parent_hash)
        || (a && a.kind === "refined")) {
        /* the only refinement this lab admits comes from the missing-documents trace (Admit, a race or the
           Run workbench's refined machine), so a refined active version already represents it */
        rwhy = "The active version already represents the missing-documents trace, so both proposals would be NO_CHANGE. Reset the lab to race from the initial machine.";
      }
      HXUI.set_disabled(race, !!rwhy, rwhy);
      race_reason.replaceChildren(HXUI.icon("info"), h("span", null, rwhy && !S.busy.race ? rwhy : "Proposes from the active version twice (fixture and variant aligner) and admits both against it."));

      const parts = [];
      if (S.busy.admit || S.busy.race) parts.push(pending(S.busy.admit ? "Admitting in this page…" : "Racing two admissions in this page…"));
      if (S.admission) parts.push(admission_view(S.admission));
      if (S.race) parts.push(race_view(S.race));
      if (!parts.length) parts.push(h("p", { class: "ln-note" }, "Nothing admitted from this section yet."));
      p.meta.replaceChildren();
      p.body.replaceChildren(...parts);
    };
    return p;
  }

  function pointer_change(before, after, id) {
    const same = before && after && before[0] === after[0] && before[1] === after[1];
    const cell = (x, which) => x ? [HXUI.digest(x[0], { short: 19, label: which + " version hash", id: id + "-" + which }), h("span", { class: "ln-sum-note" }, " v" + x[1])] : h("span", { class: "hx-faint" }, "none");
    return h("div", { class: "ln-move", id, dataset: { moved: String(!same) } },
      h("div", { class: "ln-move-cell" }, h("span", { class: "hx-label" }, "Before"), h("span", { class: "ln-move-val" }, cell(before, "before"))),
      h("span", { class: "ln-move-arrow", "aria-hidden": "true" }, "→"),
      h("div", { class: "ln-move-cell" }, h("span", { class: "hx-label" }, "After"), h("span", { class: "ln-move-val" }, cell(after, "after"))),
      HXUI.chip(same ? "Pointer unchanged" : "Pointer moved", same ? "neutral" : "accent"));
  }

  function admission_view(x) {
    if (x.error) return error_notice("Admission failed", x.error, "Propose again and admit the new candidate.");
    const res = x.result;
    const rec = res.record || {};
    return h("div", { class: "ln-result", id: "ln-admission", dataset: { status: res.status } },
      h("p", { class: "ln-sub" }, "Admission"),
      h("div", { class: "ln-result-head" }, status_chip(res.status, "ln-admission-status"),
        res.status === "CONFLICT" ? h("p", { class: "ln-verdict", title: (res.reasons || []).join(" ") || null }, CONFLICT_TEXT)
          : h("p", { class: "ln-verdict" }, res.status === "ADMITTED" ? "The candidate is the new active version, and the archive now includes its originating trace."
            : "Admission refused the candidate. Nothing changed.")),
      dl([
        ["Candidate", HXUI.digest(x.candidate_hash, { short: 19, label: "candidate hash", id: "ln-admission-candidate" })],
        ["Expected parent", HXUI.digest(x.parent_hash, { short: 19, label: "expected parent hash", id: "ln-admission-parent" })],
        res.archive_version ? ["Archive version", h("span", { class: "hx-num" }, "v" + res.archive_version)] : null,
        rec.key_id ? ["Signed with", [code(rec.key_id), " ", HXUI.chip("demo key", "info")]] : null,
        rec.signature ? ["Signature", HXUI.digest(rec.signature, { short: 22, label: "admission signature", id: "ln-admission-signature" })] : null,
        rec.admitted_at ? ["Admitted at", h("span", { class: "hx-mono" }, rec.admitted_at)] : null,
      ]),
      res.reasons && res.reasons.length && res.status !== "CONFLICT" ? h("ul", { class: "ln-list" }, res.reasons.map((s) => h("li", null, h("span", { class: "ln-wrap" }, s)))) : null,
      pointer_change(x.before, x.after, "ln-admission-pointer"));
  }

  /** CONFLICT in plain words; the engine's reason (two full hashes) stays in the tooltip, and the
      Before / After box below shows both versions */
  const CONFLICT_TEXT = "The active version is no longer the expected parent, so nothing changed: rebase onto the new parent and rerun all gates. Before and After below show both versions.";
  function conflict_copy(res) {
    return h("span", { class: "ln-conflict", title: (res.reasons || []).join(" ") || null },
      "The active version is no longer the expected parent: rebase onto the new parent and rerun all gates.");
  }

  function race_view(x) {
    if (x.error) return error_notice("The race failed", x.error, "Reset the lab, then race from the initial machine.");
    if (x.note) {
      return h("div", { class: "ln-result", id: "ln-race-result", dataset: { status: "none" } },
        HXUI.notice("neutral", "Nothing to race", "Both proposals from the active version are " + x.note.p1 + ", so neither has a candidate. Reset the lab to race from the initial machine."));
    }
    return h("div", { class: "ln-result", id: "ln-race-result", dataset: { status: x.rows.map((r) => r.res.status).join(" ") } },
      h("p", { class: "ln-sub" }, "Race: two candidates, one parent"),
      HXUI.table({
        caption: "Racing admissions", caption_hidden: true, class: "ln-race-table",
        columns: [
          { key: "label", label: "Proposal", render: (r) => r.label },
          { key: "cand", label: "Candidate", fold_label: "candidate", render: (r) => HXUI.digest(r.prop.candidate.artifact_hash, { short: 15, label: "candidate hash", id: "ln-race-cand-" + r.id }),
            fold: (r) => HXUI.digest(r.prop.candidate.artifact_hash, { short: 15, label: "candidate hash", id: "ln-race-cand-fold-" + r.id }) },
          { key: "status", label: "Admission", nowrap: true, render: (r) => status_chip(r.res.status) },
          { key: "why", label: "Detail", fold: true, render: (r) => r.res.status === "ADMITTED" ? "Active, archive v" + r.res.archive_version + "."
            : r.res.status === "CONFLICT" ? conflict_copy(r.res) : h("span", { class: "ln-wrap" }, (r.res.reasons || []).join(" ")) },
        ],
        rows: x.rows, row_attrs: (r) => ({ dataset: { race: r.id, status: r.res.status } }),
      }),
      x.rebased ? h("p", { class: "ln-note", id: "ln-race-rebase", dataset: { status: x.rebased.status } }, "The loser rebases: the same proposal against the new parent is ",
        status_chip(x.rebased.status), x.rebased.status === "NO_CHANGE" ? ", because the winner already represents the trace." : ".") : null,
      pointer_change(x.before, x.after, "ln-race-pointer"));
  }

  /* ---- shortcut */
  function shortcut_panel() {
    const btn = HXUI.button("Check the shortcut again", { id: "ln-sc-run", icon: "reset", on_click: () => act("shortcut", () => shortcut_now(false), paint_all) });
    const p = panel("shortcut", "Refuse a shortcut", ["The shortcut trace repairs a draft and goes straight to approval. Its eligibility check excludes it. The candidate an unconstrained aligner would build from it adds the edge ",
      chain(["REPAIR_DRAFT", "REQUEST_APPROVAL"]), " and is then run through every gate anyway, with the trace in the negative corpus. It is never submitted for admission."],
    h("div", { class: "hx-action-row" }, btn));
    p.paint = () => {
      HXUI.set_disabled(btn, !!S.busy.shortcut || S.init !== "done" && !S.shortcut, S.busy.shortcut ? "Checking…" : "The archive is being prepared.");
      const x = S.shortcut;
      if (S.busy.shortcut) { p.body.replaceChildren(pending("Checking in this page…")); return; }
      if (!x) { p.meta.replaceChildren(); p.body.replaceChildren(pending("Waiting for the archive…")); return; }
      if (x.error) { p.meta.replaceChildren(HXUI.chip("Error", "crit")); p.body.replaceChildren(error_notice("The shortcut check failed", x.error, "Reset the lab and open this section again.")); return; }
      p.meta.replaceChildren(HXUI.chip("in " + ms_text(x.ms), "neutral"));
      const same = x.before && x.after && x.before[0] === x.after[0] && x.before[1] === x.after[1];
      const viol = (x.gates.static_validation.findings || []).filter((f) => f.code === "ORDERING_VIOLATION");
      const path_states = [];
      for (const f of viol) for (const s of (f.detail && f.detail.path) || []) if (path_states.indexOf(s) < 0) path_states.push(s);
      const first = viol.find((f) => f.detail && Array.isArray(f.detail.path));
      const path = first ? first.detail.path : [];
      p.body.replaceChildren(h("div", { class: "ln-result", id: "ln-shortcut", dataset: { eligibility: x.p_sc.status, passed: String(!!x.gates.passed), unchanged: String(same) } },
        h("div", { class: "ln-steps" },
          h("div", { class: "ln-step" }, h("p", { class: "ln-sub" }, "1 · Trace eligibility"),
            h("div", { class: "ln-result-head" }, status_chip(x.p_sc.status, "ln-sc-eligibility"), h("span", { class: "hx-mono ln-wrap" }, x.sc.trace_id)),
            h("ul", { class: "ln-list" }, x.p_sc.diagnostics.map((d) => h("li", null, h("span", { class: "hx-mono ln-wrap" }, String(d)))))),
          h("div", { class: "ln-step" }, h("p", { class: "ln-sub" }, "2 · Active version"),
            h("div", { class: "ln-result-head" }, HXUI.chip(same ? "Unchanged" : "Changed", same ? "ok" : "crit", { icon: same ? "check" : "alert", class: "ln-sc-unchanged" }),
              HXUI.digest(x.after ? x.after[0] : "", { short: 19, label: "active version hash", id: "ln-sc-active" }),
              HXUI.chip(x.parent_kind, x.parent_kind === "refined" ? "accent" : "neutral"),
              x.after ? h("span", { class: "ln-sum-note" }, "archive v" + x.after[1]) : null),
            h("p", { class: "ln-why" }, same ? "The store's active pointer reads the same before and after this check." : "The active pointer moved during this check."))),
        h("div", { class: "ln-block" },
          h("div", { class: "ln-sub-row" }, h("p", { class: "ln-sub" }, "3 · The shortcut candidate, run through every gate anyway"), gates_chip(x.gates)),
          h("p", { class: "ln-why" }, "With ", tid(x.sc.trace_id), " in the negative corpus.")),
        gates_table(x.gates, "ln-sc-gates", true),
        candidate_graph(x.cand, path.length > 1 ? { path } : { highlight: path_states }, "ln-sc-graph", "Show the shortcut candidate",
          path.length > 1 ? "Shortcut candidate, counterexample drawn as numbered steps" : "Shortcut candidate, counterexample states highlighted")));
    };
    return p;
  }

  /* ---- evaluate */
  const METRIC_LABELS = {
    tasks: "Tasks", business_success: "Business success", procedural_conformance: "Procedural conformance", terminal_honesty: "Terminal honesty",
    duplicate_writes: "Duplicate writes", fallback_rate: "Fallback rate", failure_fallback_rate: "Failure fallback rate",
    human_interactions: "Human interactions", mean_steps: "Mean steps", model_calls: "Model calls",
  };
  const METRICS = ["business_success", "procedural_conformance", "terminal_honesty", "duplicate_writes", "fallback_rate",
    "failure_fallback_rate", "human_interactions", "mean_steps", "model_calls"];
  const HELDOUT_METRICS = ["business_success", "procedural_conformance", "terminal_honesty", "human_interactions"];

  function fmt_metric(k, v) {
    if (v === undefined || v === null) return "–";
    return HX.eval.RATIO_METRICS.indexOf(k) >= 0 ? HX.eval.fmt2(v) : String(v);
  }

  function evaluate_panel() {
    const btn = HXUI.button("Run evaluation again", { id: "ln-eval-run", icon: "play", on_click: () => act("eval", () => eval_now(false), paint_all) });
    const p = panel("evaluate", "Evaluate on held-out tasks", [{ code: "run_eval" }, " builds its own environment, admits the initial machine and the machine refined from the missing-documents trace, and runs every held-out task on both. Approvals come from ",
      { code: "user:bob" }, ". It does not touch this lab's archive."], h("div", { class: "hx-action-row" }, btn));
    p.paint = () => {
      const missing = HXUI.engine_missing(EVAL_NEEDS);
      btn.hidden = !!missing.length;
      if (missing.length) {
        HXUI.set_disabled(btn, true, "The evaluation module is not in this build.");
        p.body.replaceChildren(HXUI.unavailable(missing, { compact: true }));
        p.body.dataset.state = "unavailable";
        return;
      }
      HXUI.set_disabled(btn, !!S.busy.eval || S.init !== "done" && !S.evaluation, S.busy.eval ? "Evaluating…" : "Waiting for the other panels.");
      const x = S.evaluation;
      if (S.busy.eval || !x) { p.meta.replaceChildren(); p.body.replaceChildren(pending(S.busy.eval ? "Running the initial and the refined machine on the held-out tasks in this page…" : "Queued after the proposal and the shortcut check…")); p.body.dataset.state = "pending"; return; }
      if (x.error) { p.body.replaceChildren(error_notice("The evaluation failed", x.error, "Reload the page to try again.")); p.body.dataset.state = "error"; return; }
      p.body.dataset.state = "done";
      const n_arms = Object.keys(x.result.arms || {}).length;
      const mode = String(x.result.mode || "").split(/[\s(]/)[0];
      p.meta.replaceChildren(HXUI.chip(n_arms + " × " + x.tasks + " tasks", "neutral"),
        mode ? with_id(HXUI.chip(mode.charAt(0).toUpperCase() + mode.slice(1) + " mode", "info", { title: x.result.mode }), "ln-eval-mode") : null);
      p.body.replaceChildren(eval_view(x));
    };
    return p;
  }

  function eval_view(x) {
    const res = x.result;
    const a0 = res.arms.initial_compiled, a1 = res.arms.trace_refined;
    const pb = HX.data && HX.data.python_build;
    const parity = (hash, want) => want ? (hash === want ? HXUI.chip("equals Python build", "ok", { icon: "check" }) : HXUI.chip("differs from Python build", "crit", { icon: "cross" })) : null;
    const delta = (k) => {
      const v0 = a0.summary[k], v1 = a1.summary[k];
      if (typeof v0 !== "number" || typeof v1 !== "number" || v0 === v1) return h("span", { class: "hx-faint" }, "same");
      return h("span", { class: "hx-num" }, (v1 > v0 ? "+" : "−") + fmt_metric(k, Math.abs(v1 - v0)));
    };
    const metric_table = (metrics, s0, s1, caption, id) => HXUI.table({
      caption, caption_hidden: true, class: "ln-metrics-table",
      columns: [
        { key: "k", label: "Metric", render: (k) => h("span", { class: "ln-metric" }, h("span", null, METRIC_LABELS[k] || k), h("code", { class: "ln-key" }, k)) },
        { key: "a", label: "Initial", align: "right", nowrap: true, render: (k) => h("span", { class: "hx-num" }, fmt_metric(k, s0[k])) },
        { key: "b", label: "Refined", align: "right", nowrap: true, render: (k) => h("span", { class: "hx-num" }, fmt_metric(k, s1[k])) },
        id === "ln-eval-summary" ? { key: "d", label: "Change", align: "right", nowrap: true, fold: true, fold_label: "change", render: delta } : null,
      ].filter(Boolean),
      rows: metrics, row_attrs: (k) => ({ dataset: { metric: k } }),
    });
    const ov = res.dev_overlap || {};
    const by_task = a1.rows.reduce((m, r) => { m[r.task] = r; return m; }, {});
    const outcome = (r) => h("span", { class: "ln-outcome" }, r.terminal ? code(r.terminal) : h("span", { class: "hx-faint" }, "none"),
      HXUI.chip(r.business_success ? "success" : "miss", r.business_success ? "ok" : "crit", { icon: r.business_success ? "check" : "cross" }),
      r.human_interactions ? h("span", { class: "ln-sum-note" }, plural(r.human_interactions, "interaction")) : null);
    const held = a0.strictly_heldout_summary;
    return h("div", { class: "ln-result", id: "ln-eval", dataset: { tasks: String(x.tasks) } },
      h("p", { class: "ln-timing", id: "ln-eval-timing" }, "Ran " + Object.keys(res.arms).length + " × " + x.tasks + " tasks in " + ms_text(x.ms) + " in this page. Deterministic fixtures: a rerun gives the same numbers."),
      dl([
        ["Initial", [HXUI.digest(res.artifacts.initial, { short: 19, label: "initial artifact hash", id: "ln-eval-initial" }), " ", parity(res.artifacts.initial, pb && pb.initial_artifact_hash)]],
        ["Trace-refined", [HXUI.digest(res.artifacts.refined, { short: 19, label: "refined artifact hash", id: "ln-eval-refined" }), " ", parity(res.artifacts.refined, pb && pb.refined_artifact_hash)]],
        ["Task set", HXUI.digest(res.task_set_digest, { short: 19, label: "task set digest", id: "ln-eval-taskset" })],
      ]),
      h("div", { class: "ln-block", id: "ln-eval-summary" }, h("p", { class: "ln-sub" }, "All " + x.tasks + " tasks"),
        metric_table(METRICS, a0.summary, a1.summary, "Summary over all tasks", "ln-eval-summary")),
      Object.keys(ov).length ? h("div", { class: "ln-block", id: "ln-eval-heldout" },
        h("p", { class: "ln-sub" }, "Strictly held out (" + plural(held.tasks, "task") + ")"),
        h("p", { class: "ln-note" }, "Excludes " + plural(Object.keys(ov).length, "task") + " that shares the supplier or the supplied documents with the development trace, so it is not held out: ",
          Object.keys(ov).map((k) => code(k)), "."),
        metric_table(HELDOUT_METRICS, held, a1.strictly_heldout_summary, "Summary over strictly held-out tasks", "ln-eval-heldout-table")) : null,
      h("div", { class: "ln-block", id: "ln-eval-tasks" }, h("p", { class: "ln-sub" }, "Per task"),
        HXUI.table({
          caption: "Per-task results", caption_hidden: true, class: "ln-tasks-table",
          columns: [
            { key: "task", label: "Task", nowrap: true, render: (r) => h("span", { class: "hx-mono" }, r.task) },
            { key: "expected", label: "Expected", nowrap: true, fold: true, fold_label: "expects", render: (r) => r.expected },
            { key: "initial", label: "Initial", fold: true, fold_label: "initial", render: outcome },
            { key: "refined", label: "Trace-refined", fold: true, fold_label: "refined", render: (r) => by_task[r.task] ? outcome(by_task[r.task]) : "–" },
            { key: "overlap", label: "Dev overlap", fold: true, fold_label: "dev overlap", render: (r) => ov[r.task]
              ? h("span", { title: HXUI.plain_lists(ov[r.task].join("; ")) }, HXUI.chip("overlaps", "warn", { icon: "alert" }), h("span", { class: "hx-visually-hidden" }, ": " + HXUI.plain_lists(ov[r.task].join("; "))))
              : h("span", { class: "hx-faint" }, "no") },
          ],
          rows: a0.rows, row_attrs: (r) => ({ dataset: { task: r.task, overlap: ov[r.task] ? "yes" : "no" } }),
        })),
      not_run_view(res));
  }

  const NOT_RUN_LABELS = { direct_skill_prompting_react: "Direct prompting baseline (skill prompt + ReAct)" };
  /** the arms the engine reports as not run (result.not_run, else HX.eval.NOT_RUN), each with the engine's reason */
  function not_run_view(res) {
    const nr = res.not_run || HX.eval.NOT_RUN || {};
    const keys = Object.keys(nr);
    if (!keys.length) return null;
    return h("div", { class: "ln-notrun", id: "ln-eval-notrun" }, HXUI.chip("Not run", "neutral"),
      h("div", { class: "ln-notrun-body" }, keys.map((k) => h("p", { dataset: { arm: k } },
        h("span", { title: "Engine: " + nr[k] }, NOT_RUN_LABELS[k] || k), ": not run, because it needs a live model and this page has none.")),
        h("p", null, "These numbers describe deterministic fixture behavior, not model quality.")));
  }

  /* ---------------------------------------------------------------- wiring */
  HXUI.bus.on("lab:changed", (p) => {
    if (!P || !p || p.what === "archive") return;
    const env = HXUI.lab.env;
    if (S.store && env && env.store !== S.store) {
      sync_store();
      if (P.root.isConnected && !P.root.closest("[hidden]")) init_sequence();
    } else if (S.init === "done" && S.shortcut && !S.shortcut.error && env) {
      /* another section moved the active pointer (the Run workbench can admit the refined machine): recheck */
      try { if (active(env).hash !== S.shortcut.parent_hash) shortcut_now(true); } catch (e) { /* no active version */ }
    }
    /* hidden: on_show repaints; a step in the Run workbench must not rebuild this whole section each time */
    if (!P.root.isConnected || P.root.closest("[hidden]")) return;
    paint_all();
  });
  /* the guided demo published its proposal and admission (step 6a) or its shortcut (6b): show them */
  HXUI.bus.on("tour:learn", () => { if (P && P.root.isConnected && !P.root.closest("[hidden]")) paint_all(); });
  HXUI.bus.on("lab:reset", () => {
    S = fresh_state();
    base_pkg = null;
    trace_cache.clear();
    if (P && P.root.isConnected) {
      paint_all();
      if (!P.root.closest("[hidden]")) init_sequence();
    }
  });

  HXUI.learn = {
    state: () => S,
    refresh: paint_all,
    traces: TRACES.map((t) => t.id),
  };

  HXUI.register_section({
    id: "learn",
    title: "Learn from traces",
    nav: "Learn",
    summary: "Refine the machine from a trace and let the gates decide",
    needs: NEEDS,
    about: ABOUT,
    mount(el) { render(el); },
    on_show() { sync_store(); if (S.init === "idle") init_sequence(); else paint_all(); },
  });
})();
