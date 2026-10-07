/* Port of hexis_service/demo/procurement_demo.py::run_demo: the offline procurement narrative (brief §14), stepwise.
 * FIXTURE MODE throughout: fake model, fake connectors, simulated identities. It demonstrates control, evidence,
 * human interaction and recovery behavior of this software -- not live model quality or real ERP semantics.
 *
 * Python runs the whole narrative in one call, prints ``say()`` lines and writes files under ``out_dir``. This port
 * returns the same information as data, one step at a time (the step boundaries are Python's ``== N. ...`` headings):
 *
 *   const d = HX.demo.create({scenario = "full", clock_start = 1790000000.25, ids, timer})
 *   d.steps        [{id: "1", title}, {id: "2", title}, ..., {id: "6b", title}]   (always 7 steps)
 *   d.next()       runs the next step -> {id, title, lines, facts, artifacts}; throws when done
 *   d.run_all()    runs the remaining steps and returns the summary dict (Python's return value)
 *   d.done, d.summary (null until done), d.cursor (index of the next step), d.results (step results so far),
 *   d.lines (every say line so far), d.artifacts (every file so far), d.ctx (live engine objects, see below)
 *   HX.demo.run_demo({scenario, clock_start, ids, timer, say}) -> {summary, lines, artifacts}   (one call)
 *   HX.demo.SCENARIOS = ["full", "timeout-after-commit"] (the CLI's choices; any other name runs without a fault)
 *
 * ``lines`` are Python's say() texts (one entry per say call; a static-gate entry contains "\n"). The heading line of
 * a step is its first line; step "4" has no heading when the scenario injects no fault (Python prints none), but it
 * still approves and runs, as in Python. The final ``== done. Artifacts in <out>/ ==`` line is ``== done ==``.
 * ``artifacts`` maps each file Python writes (relative path, e.g. ``initial_package.json``,
 * ``traces/trace_run_<id>.jsonl``, ``coverage.md``) to its content: JSON files as parsed values (snapshots taken when
 * written), ``.jsonl`` and ``.md`` files as exact text. Python's ``state/`` directory (SQLite files) has no
 * counterpart: the JS store and fake ERP are in memory.
 *
 * ``ctx``: {scenario, clock, env (replaced by the restarted Env in step 3), comp, pkg, adm, alice, run_ids: {main,
 * conflict, refined}, ix, protected, negative, dev, prop, refined, adm2, enr, sc, p_sc, cand, gates, active_before,
 * active_after, summary}. Treat it as read-only.
 *
 * Determinism: ``ids`` defaults to ``HX.env.make_seq_ids(1)`` (Python uses random uuid4; the goldens patch it the same
 * way), ``clock_start`` to 1790000000.25 (Python's ManualClock() starts at 1790000000.0; see deviations/demo.md).
 * ``timer`` (latency metrics only) defaults to the engine's real monotonic timer.
 */
(function (HX) {
  "use strict";
  const demo = (HX.demo = HX.demo || {});

  demo.SCENARIOS = Object.freeze(["full", "timeout-after-commit"]);
  demo.FAULT_SCENARIOS = demo.SCENARIOS;
  demo.CLOCK_START = 1790000000.25;

  const STEPS = [
    ["1", "Compile the supplier-onboarding skill (fixture compiler model)"],
    ["2", "Run a clean intake: extraction, validation (one bounded repair), pause for approval"],
    ["3", "Restart the worker process; resume from persisted state with an authenticated approval"],
    ["4", "Fault injected: the fake ERP commits, then the call times out"],
    ["5", "Final evidence-linked execution record"],
    ["6a", "Trace-driven refinement: documents missing → request input once"],
    ["6b", "Proposed shortcut: repair → approval without re-validation"],
  ];
  const NO_FAULT_TITLE_4 = "Approve and resume (no fault injected)";

  const repr = (v) => HX.kernel._py_repr(v);
  const str = (v) => HX.broker._py_str(v);
  const truthy = (v) => HX.broker._truthy(v);
  const json_copy = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  /** Python dict.get(k, default) on a JSON object. */
  const get = (d, k, dflt) => (hasOwn(d, k) ? d[k] : dflt);

  /** ``str(exc)`` for the exceptions the narrative catches. */
  function exc_str(e) {
    if (HX.service && e instanceof HX.service.RunError) return e.code + ": " + e.message;
    if (e instanceof HX.HXError) return e.msg !== undefined ? String(e.msg) : e.message;
    return String(e && e.message !== undefined ? e.message : e);
  }

  /** Python ``except Exception``: HX errors except the BaseException-like SimulatedCrash; native JS errors are bugs
   *  and propagate. */
  function is_py_exception(e) {
    if (!(e instanceof HX.HXError)) return false;
    if (HX.broker && HX.broker.SimulatedCrash && e instanceof HX.broker.SimulatedCrash) return false;
    return true;
  }

  function approve(env, run_id, ix, who) {
    return env.service.resume_interaction(run_id, ix.interaction_id,
      { approval_decision: "approved", scope_digest: ix.scope_digest }, env.principal(who || "user:bob"));
  }

  class Demo {
    constructor(opts) {
      const o = opts || {};
      const scenario = o.scenario === undefined || o.scenario === null ? "full" : String(o.scenario);
      this.scenario = scenario;
      this.fault = demo.FAULT_SCENARIOS.indexOf(scenario) >= 0;
      this.steps = STEPS.map(([id, title]) => ({ id, title: id === "4" && !this.fault ? NO_FAULT_TITLE_4 : title }));
      this.cursor = 0;
      this.results = [];
      this.lines = [];
      this.artifacts = {};
      this.summary = null;
      const clock = new HX.env.ManualClock(o.clock_start === undefined ? demo.CLOCK_START : o.clock_start);
      this.ctx = {
        scenario, clock, ids: o.ids || HX.env.make_seq_ids(1), timer: o.timer || null,
        summary: { mode: "fixture", scenario, steps: {} }, run_ids: {}, protected: [], negative: [],
      };
      this._say_hook = typeof o.say === "function" ? o.say : null;
      this._cur = null;
    }

    get done() { return this.cursor >= this.steps.length; }

    _say(line) {
      this._cur.lines.push(line);
      this.lines.push(line);
      if (this._say_hook) this._say_hook(line);
    }

    _w(name, data) {
      const v = typeof data === "string" ? data : json_copy(data);
      this._cur.artifacts[name] = v;
      this.artifacts[name] = v;
    }

    next() {
      if (this.done) throw new HX.HXError("StopIteration", "the demo has already finished");
      const step = this.steps[this.cursor];
      const res = { id: step.id, title: step.title, lines: [], facts: {}, artifacts: {} };
      this._cur = res;
      STEP_FNS[this.cursor].call(this, this.ctx, res.facts);
      this._cur = null;
      this.cursor++;
      this.results.push(res);
      return res;
    }

    run_all() {
      while (!this.done) this.next();
      return this.summary;
    }
  }
  demo.Demo = Demo;

  demo.create = function create(opts) { return new Demo(opts); };

  /** Python's ``run_demo`` in one call (no files): {summary, lines, artifacts, steps}. */
  demo.run_demo = function run_demo(opts) {
    const d = new Demo(opts);
    const summary = d.run_all();
    return { summary, lines: d.lines.slice(), artifacts: d.artifacts, steps: d.results };
  };

  /* ------------------------------------------------------------------------------------------------------------ */
  /* the steps (procurement_demo.run_demo, split at its headings)                                                 */
  /* ------------------------------------------------------------------------------------------------------------ */

  function step1(c, facts) {
    // 1. Compile
    this._say("== 1. Compile the supplier-onboarding skill (fixture compiler model) ==");
    const comp = HX.env.compile_procurement();
    c.comp = comp;
    for (const a of comp.attempts) {
      const codes = Array.from(new Set(a.findings.map((f) => f.code))).sort(HX.util.cmp_codepoints);
      this._say("   attempt " + str(a.attempt) + ": " + str(a.status) + " " + (codes.length ? repr(codes) : ""));
    }
    const pkg = comp.package;
    c.pkg = pkg;
    this._w("initial_package.json", HX.pkg.to_json(pkg));
    this._w("machine.initial.json", pkg.machine);
    this._w("compile_report.json", comp.to_json());
    this._w("coverage.md", "# Clause coverage (initial compile)\n\n" + HX.compile.coverage_markdown(comp.coverage) + "\n");
    this._say("   artifact " + pkg.artifact_hash.slice(0, 23) + "… ; clauses needing review: " + repr(comp.review_required));
    c.summary.steps.compile = { status: comp.status, attempts: comp.attempts.length, artifact_hash: pkg.artifact_hash,
      review_required: comp.review_required };

    const kw = { clock: c.clock, ids: c.ids };
    if (c.timer) kw.timer = c.timer;
    c.env = HX.env.build_env(null, kw);
    const adm = HX.env.admit_initial(c.env, pkg);
    c.adm = adm;
    this._say("   admission by user:dana: " + adm.status + " (archive v" + str(adm.archive_version) + ")");
    Object.assign(facts, { compile_status: comp.status, attempts: comp.attempts.map((a) => ({ attempt: a.attempt,
      status: a.status, codes: Array.from(new Set(a.findings.map((f) => f.code))).sort(HX.util.cmp_codepoints) })),
    artifact_hash: pkg.artifact_hash, review_required: comp.review_required.slice(), admission: adm.status,
    archive_version: adm.archive_version });
  }

  function step2(c, facts) {
    // 2. Clean intake through extraction/validation, pause for approval
    this._say("== 2. Run a clean intake: extraction, validation (one bounded repair), pause for approval ==");
    const env = c.env;
    c.alice = env.principal("user:alice");
    const h = env.service.start_run(c.pkg.artifact_hash, HX.env.task(), c.alice, "demo-run-1");
    c.run_ids.main = h.run_id;
    const res = env.service.run_until_blocked(h.run_id, c.alice);
    const ix = res.interaction;
    c.ix = ix;
    this._say("   run " + h.run_id + ": " + res.status + "; approval scope " + ix.scope_digest.slice(0, 23) + "… binds " +
      str(ix.scope.tool) + " args " + ix.scope.args_digest.slice(0, 19) + "…");
    Object.assign(facts, { run_id: h.run_id, status: res.status, interaction_id: ix.interaction_id,
      scope_digest: ix.scope_digest, tool: ix.scope.tool, args_digest: ix.scope.args_digest });
  }

  function step3(c, facts) {
    // 3. Restart the worker, resume on authenticated approval
    this._say("== 3. Restart the worker process; resume from persisted state with an authenticated approval ==");
    c.env = c.env.restart();
    const env = c.env;
    let self_refusal = null;
    try {
      env.service.resume_interaction(c.run_ids.main, c.ix.interaction_id,
        { approval_decision: "approved", scope_digest: c.ix.scope_digest }, c.alice);
    } catch (exc) {
      if (!is_py_exception(exc)) throw exc;
      self_refusal = exc_str(exc);
      this._say("   initiator self-approval refused: " + self_refusal);
    }
    // user:alice lacks the approver role, so the refusal above does not isolate separation of duties.
    // Show the SoD rule on its own: an approver-role holder (user:bob) acting as initiator is still refused.
    const sod = env.policy.can_approve(env.principal("user:bob"), "user:bob", "acme", "");
    this._say("   separation of duties in isolation (approver user:bob as initiator): " + sod.outcome + " " + repr(sod.reasons));
    c.summary.steps.self_approval = { refused: self_refusal !== null, detail: self_refusal,
      sod_isolated: { outcome: sod.outcome, reasons: sod.reasons } };
    Object.assign(facts, { restarted: true, self_approval_refused: self_refusal !== null, detail: self_refusal,
      sod_outcome: sod.outcome, sod_reasons: sod.reasons.slice() });
  }

  function step4(c, facts) {
    // 4. Timeout after the ERP commits
    const env = c.env;
    if (this.fault) {
      env.erp.inject("timeout_after_commit");
      this._say("== 4. Fault injected: the fake ERP commits, then the call times out ==");
    }
    approve(env, c.run_ids.main, c.ix);
    const res = env.service.run_until_blocked(c.run_ids.main, c.alice);
    c.res_main = res;
    const rep = env.service.inspect_run(c.run_ids.main, c.alice);
    c.rep_main = rep;
    const recon = rep.events.filter((e) => e.type === "EFFECT_UNKNOWN" || e.type === "RECONCILED");
    c.recon = recon;
    for (const e of recon) this._say("   " + e.type + ": " + str(get(e, "status", "")) + " " + str(get(e, "reason", "")));
    this._say("   ERP drafts for tenant acme: " + env.erp.count("acme") + " (no duplicate; the retry reuses the intent's " +
      "idempotency key, with business reference + draft digest as the fake ERP's fallback match)");
    Object.assign(facts, { fault_injected: this.fault, status: res.status, erp_drafts: env.erp.count("acme"),
      reconciliation_events: recon.map((e) => e.type) });
  }

  function step5(c, facts) {
    // 5. Evidence-linked record
    const env = c.env;
    const res = c.res_main;
    const rep = c.rep_main;
    const h_run = c.run_ids.main;
    this._say("== 5. Final evidence-linked execution record ==");
    const outcome = res.checkpoint.outcome;
    this._say("   status " + res.status + "; outcome " + (truthy(outcome) ? str(outcome.terminal) : "None"));
    this._say("   verification scope: " + str(res.checkpoint.assurance.verification_scope));
    const record = {};
    for (const k of ["run", "outcome", "assurance", "path", "action_intents", "action_receipts", "evidence"]) {
      if (!hasOwn(rep, k)) throw HX.broker._pyerr("KeyError", repr(k));
      record[k] = rep[k];
    }
    this._w("execution_record.json", record);
    c.summary.steps.run = { run_id: h_run, status: res.status, outcome: json_copy(outcome),
      erp_drafts: env.erp.count("acme"), reconciliation_events: c.recon.map((e) => e.type) };

    // Seed the protected archive with run traces (verified path + registry-conflict review path)
    const t_main = HX.traces.export_run_trace(env.service, h_run, c.alice, "accepted");
    const h2 = env.service.start_run(c.pkg.artifact_hash, HX.env.task({ supplier_ref: "SUP-55555" }), c.alice);
    c.run_ids.conflict = h2.run_id;
    const r2 = env.service.run_until_blocked(h2.run_id, c.alice);
    const t_conflict = HX.traces.export_run_trace(env.service, h2.run_id, c.alice, "accepted");
    this._say("   second run (registry conflict) ended " + str(r2.checkpoint.outcome.terminal) + " (" +
      str(r2.checkpoint.outcome.category) + ")");
    c.protected = [t_main, t_conflict];
    c.negative = [];
    for (const t of c.protected) this._w("traces/" + t.trace_id.split(":").join("_") + ".jsonl", HX.traces.to_jsonl(t));
    const enr = HX.registry.enroll_protected(env.store, c.pkg.machine.skill_id, c.protected,
      { actor: env.principal("user:dana"), environment: "sandbox", now: c.clock() });
    c.enr = enr;
    this._say("   enrolled " + c.protected.length + " run traces into the stored protected archive: " + enr.status +
      " (archive v" + str(enr.archive_version) + "); every later admission must replay them");
    Object.assign(facts, { status: res.status, terminal: truthy(outcome) ? outcome.terminal : null,
      verification_scope: res.checkpoint.assurance.verification_scope, conflict_run_id: h2.run_id,
      conflict_terminal: r2.checkpoint.outcome.terminal, conflict_category: r2.checkpoint.outcome.category,
      protected_trace_ids: c.protected.map((t) => t.trace_id), enrollment: enr.status,
      archive_version: enr.archive_version });
  }

  function step6a(c, facts) {
    // 6a. Accept a legitimate trace-driven refinement
    const env = c.env;
    const R = HX.reference;
    const skill_text = HX.env.skill_source().text;
    this._say("== 6a. Trace-driven refinement: documents missing → request input once ==");
    const dev = R.missing_docs_trace();
    c.dev = dev;
    this._w("traces/dev_missing_docs.jsonl", HX.traces.to_jsonl(dev));
    const prop = HX.update.propose_update(c.pkg, dev, c.protected, c.negative, env.catalog, new R.FixtureAligner(), skill_text);
    c.prop = prop;
    const passed = {};
    for (const k of Object.keys(prop.gates)) {
      const v = prop.gates[k];
      if (HX.util.is_plain_object(v)) passed[k] = HX.broker._item(v, "passed");
    }
    this._say("   proposal: " + prop.status + "; gates: " + repr(passed));
    this._w("update_proposal.missing_docs.json", prop.to_json());
    const refined = prop.candidate;
    c.refined = refined;
    if (refined === null) throw HX.broker._pyerr("AttributeError", "'NoneType' object has no attribute 'artifact_hash'");
    const adm2 = HX.registry.admit(env.store, refined, env.catalog, { expected_parent_hash: c.pkg.artifact_hash,
      approver: env.principal("user:dana"), environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(),
      protected: c.protected.concat([dev]), negative: c.negative, now: c.clock(), skill_text });
    c.adm2 = adm2;
    this._say("   admission (CAS on parent " + c.pkg.artifact_hash.slice(7, 19) + "): " + adm2.status);
    this._w("refined_package.json", HX.pkg.to_json(refined));
    this._w("machine.refined.json", refined.machine);
    this._w("update_diff.json", prop.diff);
    c.protected = c.protected.concat([dev]);
    // exercise the refined machine live on the new situation
    const alice = c.alice;
    const h3 = env.service.start_run(refined.artifact_hash, HX.env.task({ supplier_ref: "SUP-40002",
      document_ids: ["DOC-LATE-MISSING"] }), alice);
    c.run_ids.refined = h3.run_id;
    let r3 = env.service.run_until_blocked(h3.run_id, alice);
    const first_status = r3.status;
    this._say("   refined machine, missing documents: " + r3.status);
    r3 = env.service.resume_interaction(h3.run_id, r3.interaction.interaction_id, { document_ids: ["DOC-LATE-40002"] }, alice);
    r3 = env.service.run_until_blocked(h3.run_id, alice);
    r3 = approve(env, h3.run_id, r3.interaction);
    r3 = env.service.run_until_blocked(h3.run_id, alice);
    this._say("   after input + approval: " + r3.status + " " + str(r3.checkpoint.outcome.terminal));
    c.summary.steps.refine = { proposal: prop.status, admission: adm2.status, refined_hash: refined.artifact_hash,
      refined_run: json_copy(r3.checkpoint.outcome) };
    Object.assign(facts, { proposal: prop.status, gates: passed, admission: adm2.status, parent_hash: c.pkg.artifact_hash,
      refined_hash: refined.artifact_hash, refined_run_id: h3.run_id, refined_first_status: first_status,
      refined_status: r3.status, refined_terminal: r3.checkpoint.outcome.terminal });
  }

  function step6b(c, facts) {
    // 6b. Reject a shortcut that skips validation
    const env = c.env;
    const R = HX.reference;
    const skill_text = HX.env.skill_source().text;
    const refined = c.refined;
    this._say("== 6b. Proposed shortcut: repair → approval without re-validation ==");
    const active_before = env.store.get_active("sandbox", refined.machine.skill_id);
    c.active_before = active_before;
    const sc = R.shortcut_trace();
    c.sc = sc;
    const p_sc = HX.update.propose_update(refined, sc, c.protected, c.negative, env.catalog, new R.ShortcutAligner(), skill_text);
    c.p_sc = p_sc;
    this._say("   trace eligibility: " + p_sc.status + " - " + repr(p_sc.diagnostics));
    c.negative = c.negative.concat([sc]);
    const cand = HX.update.apply_ops(refined, new R.ShortcutAligner().propose({}));
    c.cand = cand;
    const gates = HX.update.evaluate_candidate(refined, cand, sc, c.protected, c.negative, env.catalog, skill_text);
    c.gates = gates;
    const viol = gates.static_validation.findings.filter((f) => f.code === "ORDERING_VIOLATION");
    for (const f of viol) {
      this._say("   static gate: " + str(f.message) + "\n      counterexample path: " + f.detail.path.join(" → "));
    }
    this._say("   negative-corpus gate passed: " + str(gates.negative_corpus.passed) + " (now representable: " +
      repr(gates.negative_corpus.now_representable) + ")");
    const active_after = env.store.get_active("sandbox", refined.machine.skill_id);
    c.active_after = active_after;
    const unchanged = HX.util.deep_equal(active_before, active_after);
    this._say("   active version unchanged: " + str(unchanged) + " (" + active_after[0].slice(0, 23) + "…, archive v" +
      str(active_after[1]) + "); the candidate was rejected by the gates above and never submitted for admission");
    this._w("shortcut_rejection.json", { eligibility: p_sc.to_json(), candidate_gates: gates, active_before,
      active_after });
    c.summary.steps.shortcut = { eligibility: p_sc.status, static_gate_passed: gates.static_validation.passed,
      negative_gate_passed: gates.negative_corpus.passed, active_unchanged: unchanged };
    this._w("summary.json", c.summary);
    this._say("== done ==");
    this.summary = c.summary;
    Object.assign(facts, { eligibility: p_sc.status, diagnostics: json_copy(p_sc.diagnostics),
      static_gate_passed: gates.static_validation.passed, violations: viol.map((f) => ({ message: f.message,
        path: f.detail.path.slice() })), negative_gate_passed: gates.negative_corpus.passed,
      now_representable: json_copy(gates.negative_corpus.now_representable), active_before: json_copy(active_before),
      active_after: json_copy(active_after), active_unchanged: unchanged });
  }

  const STEP_FNS = [step1, step2, step3, step4, step5, step6a, step6b];
})(globalThis.HX = globalThis.HX || {});
