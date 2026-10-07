/* HEXIS Runtime Lab: Run workbench (#run).
   Pick a scenario, start a run in the shared lab environment and drive it one engine call at a time: Step
   (advance_run), Run until blocked, Restart worker (env.restart), Cancel (cancel_run), Advance clock, approve or
   reject (resume_interaction), answer input requests, arm crash points and ERP faults, revoke a capability, and
   modify or tamper with the persisted ERP draft exactly as the A25 / A28 tests do. Every status, digest and table
   is read back from the engine after each call; nothing is computed by the UI.

   Lab state (specs/ui-round2.md "Shared lab state"):
     HXUI.lab_env()       builds HXUI.lab.env once (ManualClock 1790000000.25, HX.env.make_seq_ids(1), a counter timer
                          0.125*n), compiles the procurement skill and admits it (HX.env.admit_initial). It is
                          registered here unless app/05_ui.js provides it. Emits lab:changed {what: "env"}.
     HXUI.lab.env         replaced by Restart worker (env.restart() keeps the store, ERP, policy, clock and ids).
     HXUI.lab.packages.initial / .refined   the initial package (set here); refined comes from Learn (or any
                          package that is the active, admitted version in HXUI.lab.env.store).
     HXUI.lab.runs        [{run_id, tenant_id, scenario, title, initiator, artifact_hash, machine}] for runs started here.
     HXUI.lab.selected_run   the run on screen (run id).
   The section reads HXUI.lab.env afresh on every render, so a guided tour can mirror its own env into the lab. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  /* short identifiers (state ids, tools, principals, codes) never break inside; long text uses wrap_id() */
  const code = (t) => h("code", { class: "hx-inline rn-nw" }, t);
  /** a long identifier as plain mono text that may wrap after "_", "-", "/", ":" or "." (never mid-word) */
  function wrap_id(t, cls) {
    const parts = String(t === null || t === undefined ? "" : t).split(/(?<=[_\-/:.])/);
    const kids = [];
    parts.forEach((p, i) => { if (i) kids.push(h("wbr")); kids.push(p); });
    return h("span", { class: ["hx-mono rn-wrapid", cls] }, kids);
  }
  /** "A → B" as one unit that never breaks */
  const move = (a, b) => h("span", { class: "rn-nw rn-move" }, code(a), h("span", { class: "rn-arrow", "aria-hidden": "true" }, " → "),
    h("span", { class: "hx-visually-hidden" }, " to "), code(b));

  /* every namespace the run path reaches: compile_procurement, registry.admit and admit_initial also call jsonschema,
     guards, efsm, pkg, clauses, validate, diff and fixture */
  const NEEDS = ["env", "service", "kernel", "broker", "store", "policy", "approvals", "fakes", "compile", "registry", "canonical", "catalog", "metrics",
    "jsonschema", "guards", "efsm", "pkg", "clauses", "validate", "diff", "fixture"];
  const LAB_EPOCH = 1790000000.25;
  const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
  const APPROVERS = ["user:bob", "user:alice", "user:carol", "user:mallory", "user:dana"];
  const ERP_FAULTS = ["timeout_after_commit", "timeout_before_commit", "read_unavailable"];
  const FAULT_HELP = {
    after_intent: "The worker dies right after it records the intent, before any dispatch.",
    before_dispatch: "The worker dies after authorization, just before the connector is called.",
    after_remote_call: "The connector commits, then the worker dies before it records a receipt.",
    after_receipt: "The worker dies after the receipt, before the kernel commits the step.",
    before_commit: "The worker dies just before the checkpoint commit.",
    timeout_after_commit: "The fake ERP commits the draft, then the call times out (the effect is unknown).",
    timeout_before_commit: "The fake ERP call times out before anything is committed.",
    read_unavailable: "The next ERP read returns unavailable.",
  };

  const ABOUT = [
    "Pick a scenario (clean intake, missing documents, registry conflict, repairs exhausted, prompt injection, or your own task JSON) and step through it on the live state graph.",
    "Approve or reject as any identity, tamper with the approval scope, revoke a capability, restart the worker, and inject ERP faults such as a timeout after commit.",
    "Inspect the timeline, variables, ledger, evidence and latency metrics, then read the outcome with its assurance.",
  ];

  /* ---------------------------------------------------------------- shared lab environment */
  let base_cache = null; /* the compiled initial package used before any env exists (graph at rest) */

  function compiled_package() {
    const lab = HXUI.lab;
    if (lab.packages && lab.packages.initial && lab.packages.initial.machine) return lab.packages.initial;
    const c = lab.compile;
    if (c && c.status === "validated" && c.package && c.package.machine) return c.package;
    if (!base_cache) {
      const r = HX.compile.compile_procurement();
      if (!r || !r.package) throw new Error("The compiler returned no package (status " + (r ? r.status : "none") + ").");
      base_cache = r.package;
    }
    return base_cache;
  }

  function lab_env_impl() {
    const lab = HXUI.lab;
    if (lab.env) return lab.env;
    let n = 0;
    const timer = () => 0.125 * n++;
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(LAB_EPOCH), ids: HX.env.make_seq_ids(1), timer });
    const pkg = compiled_package();
    const adm = HX.env.admit_initial(env, pkg);
    if (!adm || adm.status !== "ADMITTED") {
      throw new HX.HXError("ADMISSION_FAILED", "The initial package was not admitted (" + (adm ? adm.status + ": " + (adm.reasons || []).join("; ") : "no result") + ").");
    }
    lab.env = env;
    lab.packages.initial = pkg;
    HXUI.lab_changed("env");
    return env;
  }
  if (typeof HXUI.lab_env !== "function") HXUI.lab_env = lab_env_impl;

  /* ---------------------------------------------------------------- engine reads */
  const env_now = () => HXUI.lab.env || null;

  function tenants(env) {
    const doc = env ? env.policy.doc : HX.data.policy;
    const out = [];
    for (const p of Object.keys(doc.principals || {})) {
      const t = doc.principals[p].tenant_id;
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  function find_run(env, run_id) {
    if (!env || typeof run_id !== "string" || !run_id) return null;
    for (const t of tenants(env)) {
      try { const r = env.store.get_run(t, run_id); if (r) return r; } catch (e) { /* not this tenant */ }
    }
    return null;
  }

  function all_runs(env) {
    if (!env) return [];
    const out = [];
    for (const t of tenants(env)) {
      let ids = [];
      try { ids = env.store.list_runs(t); } catch (e) { ids = []; }
      for (const id of ids) { const r = env.store.get_run(t, id); if (r) out.push(r); }
    }
    return out;
  }

  function meta_of(run_id) {
    return (HXUI.lab.runs || []).find((r) => r && r.run_id === run_id) || null;
  }

  /** While the guided demo narrates its own runs in the lab env, the workbench must not move them: any change
      would desynchronise the narration. Returns the reason, or "" when the controls are free. */
  const TOUR_LOCK = "The guided demo is narrating this run. End the demo or let it finish first.";
  function tour_lock(snap) {
    const T = HXUI.tour;
    if (!T || typeof T.active !== "function" || !T.active()) return "";
    const st = typeof T.status === "function" ? T.status() : "";
    if (st !== "running" && st !== "ready") return "";
    let demo_env = null;
    try { const d = T.demo(); demo_env = d && d.ctx ? d.ctx.env : null; } catch (e) { demo_env = null; }
    const env = snap ? snap.env : env_now();
    const run_id = snap && snap.run ? snap.run.run_id : HXUI.lab.selected_run;
    const m = run_id ? meta_of(run_id) : null;
    return (m && m.scenario === "tour") || (demo_env && env === demo_env) ? TOUR_LOCK : "";
  }

  function initial_hash() {
    const p = HXUI.lab.packages && HXUI.lab.packages.initial;
    return p && p.artifact_hash ? p.artifact_hash : null;
  }

  /** The refined package when it is admitted in the lab env: HXUI.lab.packages.refined, or the active version. */
  function refined_package(env) {
    if (!env) return null;
    const lab = HXUI.lab;
    const admitted = (hash) => { try { return HX.registry.is_admitted_in(env.store, hash, "sandbox"); } catch (e) { return false; } };
    const cand = lab.packages && lab.packages.refined;
    if (cand && cand.artifact_hash && admitted(cand.artifact_hash)) {
      try { return env.service.package(cand.artifact_hash); } catch (e) { /* not stored here */ }
    }
    const init = initial_hash();
    try {
      const skill = (lab.packages.initial || compiled_package()).machine.skill_id;
      const act = env.store.get_active("sandbox", skill);
      if (act && act[0] && act[0] !== init && admitted(act[0])) return env.service.package(act[0]);
    } catch (e) { /* no active pointer */ }
    return null;
  }

  function package_of(env, hash) {
    if (env) { try { return env.service.package(hash); } catch (e) { /* fall through */ } }
    const p = compiled_package();
    return p.artifact_hash === hash ? p : null;
  }

  /** Everything the screen shows about the selected run, read from the engine now. */
  function snapshot() {
    const env = env_now();
    const run = env ? find_run(env, HXUI.lab.selected_run) : null;
    if (!run) return { env, run: null };
    const principal = env.principal(run.principal);
    const ins = env.service.inspect_run(run.run_id, principal);
    const checkpoints = env.store.checkpoints(run.tenant_id, run.run_id);
    let metrics = null, metrics_error = null;
    if (HX.metrics) { try { metrics = HX.metrics.collect(env.store, run.tenant_id, { run_id: run.run_id }); } catch (e) { metrics_error = e; } }
    const cp = ins.checkpoint;
    const ix = run.status === "WAITING_FOR_APPROVAL" || run.status === "WAITING_FOR_INPUT"
      ? env.store.interaction_for_revision(run.tenant_id, run.run_id, cp.revision) : null;
    return { env, run, principal, ins, cp, checkpoints, metrics, metrics_error, ix, pkg: package_of(env, run.artifact_hash) };
  }

  /* ---------------------------------------------------------------- state */
  function fresh_state() {
    return {
      scenario: "clean", machine: "initial", initiator: "user:alice", custom_text: null,
      crash: null, results: {}, last_status: null, view: null, view_hash: null, human_key: null,
    };
  }
  let S = fresh_state();
  let P = null; /* the mounted parts */

  /* ---------------------------------------------------------------- formatting */
  function reduced_motion() {
    try { return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return true; }
  }
  const F = () => HXUI.run_format;
  function iso(t) {
    try { return new Date(Number(t) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"); } catch (e) { return String(t); }
  }
  const STATUS_TONE = { RUNNING: "accent", WAITING_FOR_APPROVAL: "warn", WAITING_FOR_INPUT: "warn", RECONCILING: "warn",
    COMPLETED: "ok", FAILED: "crit", CANCELLED: "neutral", CANCEL_REQUESTED: "warn" };
  const STATUS_TEXT = { RUNNING: "Running", WAITING_FOR_APPROVAL: "Waiting for approval", WAITING_FOR_INPUT: "Waiting for input",
    RECONCILING: "Reconciling", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled" };
  const CATEGORY_TONE = { verified: "ok", unverified: "warn", fallback: "crit" };
  function status_chip(status, opts) {
    return HXUI.chip(STATUS_TEXT[status] || status, STATUS_TONE[status] || "neutral", Object.assign({ title: status }, opts || {}));
  }
  /** A run's status as the reader should take it: a COMPLETED run carries its outcome category's tone and name
      ("Completed · fallback"), so a review or unverified ending never reads as a success. */
  function run_tone(status, outcome) {
    if (status === "COMPLETED" && outcome) return CATEGORY_TONE[outcome.category] || "neutral";
    return STATUS_TONE[status] || "neutral";
  }
  function run_chip(status, outcome, opts) {
    const text = status === "COMPLETED" && outcome ? "Completed · " + outcome.category : STATUS_TEXT[status] || status;
    const tone = run_tone(status, outcome);
    const icon = status === "COMPLETED" ? (tone === "ok" ? "check" : "alert") : status === "FAILED" ? "stop" : undefined;
    return HXUI.chip(text, tone, Object.assign({ title: status + (outcome ? " · " + outcome.terminal : ""), icon }, opts || {}));
  }
  /** the RUN_STOPPED event that ended a FAILED run, if any */
  function stop_event(events) {
    const ev = (events || []).filter((e) => e.type === "RUN_STOPPED");
    return ev.length ? ev[ev.length - 1] : null;
  }
  /** the run's last TRANSITION event (the edge that reached where it is now) */
  function last_transition(events) {
    const ev = (events || []).filter((e) => e.type === "TRANSITION");
    return ev.length ? ev[ev.length - 1] : null;
  }

  /* ---------------------------------------------------------------- results and errors */
  const HINTS = {
    SCOPE_MISMATCH: "The approval named a different scope digest. Clear \"Tamper with the scope digest\" and approve again.",
    RESPONSE_INVALID: "The answer does not match the interaction's response schema.",
    ALREADY_ANSWERED: "This interaction already has an answer; a second one is never applied.",
    INTERACTION_EXPIRED: "The approval expired. Step the run to record the expiry; it then ends unverified.",
    INTERACTION_CLOSED: "The interaction is no longer open. Step the run to see where it went.",
    LEASE_HELD: "Another worker holds this run's lease. Advance the clock past the lease, or restart the worker.",
    TASK_INPUT_INVALID: "Fix the task so it matches the package's task schema, then start again.",
    ARTIFACT_NOT_ADMITTED: "Only admitted packages can run. Admit it first.",
    ARTIFACT_REVOKED: "This package was revoked and cannot start new runs.",
    RUN_FINISHED: "The run has finished; start a new one.",
    RUN_CANCELLED: "Cancellation was requested; the run no longer accepts answers.",
    REVISION_CONFLICT: "The run moved on in the meantime. Read it again and retry.",
    CANONICAL: "Fix the JSON text; the strict parser rejects it.",
  };

  function principal_doc(env, pid) {
    const doc = env ? env.policy.doc : HX.data.policy;
    return (doc.principals || {})[pid] || null;
  }

  /** Principals who may approve this interaction: the required role, the run's tenant, not the initiator. */
  function eligible_approvers(env, run, ix) {
    if (!env || !run) return [];
    const role = ix && ix.scope ? ix.scope.required_role : null;
    const doc = env.policy.doc.principals || {};
    return Object.keys(doc).filter((p) => p !== run.principal && doc[p].tenant_id === run.tenant_id &&
      (!role || (doc[p].roles || []).indexOf(role) >= 0));
  }

  /** The fix for an error, built from the call's context: which area acted, as whom, on which run. */
  function hint_for(c, ctx) {
    const x = ctx || {};
    const env = env_now();
    const run = x.run || null;
    const who = x.who || null;
    if (c === "NOT_FOUND" && run && who) {
      const d = principal_doc(env, who);
      if (d && d.tenant_id !== run.tenant_id) {
        return who + " belongs to " + d.tenant_id + ", so this " + run.tenant_id + " run does not exist for them. Answer as someone in " + run.tenant_id + ".";
      }
      return "The run or interaction is not visible to " + who + ". Pick the run again from Runs in this lab.";
    }
    if (c === "NOT_AUTHORIZED") {
      if (x.kind === "input" && run) {
        return "Only the requester (" + run.principal + ") or an approver may answer input requests" + (who ? "; " + who + " is neither" : "") + ". Answer as " + run.principal + ".";
      }
      if (x.kind === "approval" && run) {
        const ok = eligible_approvers(env, run, x.ix);
        const role = x.ix && x.ix.scope ? x.ix.scope.required_role : "the approver role";
        const why = who === run.principal ? who + " started this run and cannot approve it (separation of duties)."
          : who + " lacks the " + role + " role in " + run.tenant_id + ".";
        return why + (ok.length ? " Approve as " + ok.join(" or ") + "." : " Nobody in " + run.tenant_id + " holds " + role + " now; Reset lab restores the policy.");
      }
      return "This identity lacks the capability for the call. Pick another principal.";
    }
    if (c === "TASK_INPUT_INVALID" && x.custom) return "Fix the task JSON above, or press Reset to example.";
    return HINTS[c] || "";
  }

  function error_notice(err, ctx) {
    const is_hx = globalThis.HX && err instanceof HX.HXError;
    const c = is_hx ? err.code : "Error";
    /* the code is the notice's title already: show the engine's message without its "CODE: " prefix */
    const msg = is_hx && typeof err.msg === "string" && err.msg ? err.msg : String((err && err.message) || err);
    const hint = is_hx ? hint_for(c, ctx) : (ctx && ctx.plain ? "" : "This is not an engine error; reload the page if it repeats.");
    return { tone: "crit", error: true, code: c, title: c, body: [h("p", { class: "rn-err-msg" }, msg), hint ? h("p", { class: "rn-err-fix" }, hint) : null] };
  }

  function set_result(area, res) { S.results[area] = res; }

  /** A UI precondition that is not met (no run, no draft): shown like an error, without the "reload" hint. */
  class Precondition extends Error {}

  /** call(area, fn, ctx): run one engine call; HXError -> inline code + message (with a fix built from ctx);
      SimulatedCrash -> crash state. */
  function call(area, fn, ctx) {
    /* an answer's result stays only until the next action elsewhere: it describes a step that is now history */
    if (area !== "human") S.results.human = null;
    /* "Started run_…" is news only until the run is driven: the summary and the drive result carry it on */
    if (area !== "start" && S.results.start && S.results.start.code === "STARTED") S.results.start = null;
    let changed = false;
    try {
      const lock = area === "start" || area === "drive" || area === "human" || area === "faults" || area === "erp" || area === "policy" ? tour_lock(null) : "";
      if (lock) throw new Precondition(lock);
      const out = fn();
      if (out) set_result(area, out);
      /* a human answer moved the run on: the previous drive result describes a state that is gone */
      if (area === "human") S.results.drive = null;
      changed = true;
    } catch (err) {
      if (HX.broker && typeof HX.broker.is_crash === "function" && HX.broker.is_crash(err)) {
        S.crash = { point: err.point || String(err.message || ""), run_id: HXUI.lab.selected_run, env: HXUI.lab.env };
        set_result(area, { tone: "crit", code: "SIMULATED_CRASH", title: "Worker crashed at " + S.crash.point,
          body: [h("p", null, "The armed fault point fired, as a process death would. Nothing after it ran: the store keeps exactly what was committed before the crash."),
            h("p", null, "Restart the worker to recover from the stored state.")], crash: true });
        HXUI.announce("Worker crashed at " + S.crash.point + ".");
      } else {
        const c = Object.assign({ plain: err instanceof Precondition }, typeof ctx === "function" ? ctx() : ctx || {});
        set_result(area, error_notice(err, c));
        HXUI.announce("Error " + (err && err.code ? err.code : "") + ": " + String((err && err.message) || err));
      }
      changed = true; /* a crash or a refused call may still have committed state (an intent, an expiry) */
    }
    /* other sections (the guided demo, Learn) read the same env: tell them, which also repaints this section */
    if (changed) HXUI.lab_changed("runs");
    refresh(); /* a no-op when the lab:changed listener has just painted */
  }

  function result_view(area) {
    const r = S.results[area];
    const box = P && P.results[area];
    if (!box) return;
    if (!r) { box.replaceChildren(); box.hidden = true; box.removeAttribute("data-code"); return; }
    box.hidden = false;
    box.dataset.code = r.code || "OK";
    box.dataset.tone = r.tone;
    const body = [].concat(r.body || []);
    if (r.crash) body.push(h("div", { class: "hx-actions" }, HXUI.button("Restart worker to recover", { id: "rn-crash-restart", variant: "primary", size: "sm", icon: "reset", on_click: do_restart })));
    box.replaceChildren(HXUI.notice(r.tone, r.code && r.error ? [h("span", { class: "rn-code" }, r.code), " ", r.title === r.code ? "" : r.title] : r.title, body.length ? body : null));
  }

  /* ---------------------------------------------------------------- actions */
  function selected() {
    const env = env_now();
    const run = env ? find_run(env, HXUI.lab.selected_run) : null;
    return run ? { env, run, principal: env.principal(run.principal) } : null;
  }
  function need_run() {
    const sel = selected();
    if (!sel) throw new Precondition("Start a run first.");
    return sel;
  }

  function step_text(res, before) {
    const cp = res.checkpoint || {};
    const moved = before && cp.state_id && before !== cp.state_id ? move(before, cp.state_id) : [" at ", code(cp.state_id || "?")];
    return [h("span", { class: "rn-res-status" }, run_chip(res.status, cp.outcome)), " ", moved,
      res.detail && res.detail !== cp.state_id && res.detail !== res.status ? h("span", { class: "rn-res-detail" }, res.detail) : null];
  }

  /** The tone and title of a step result: a terminal takes its outcome's meaning, not just "finished". */
  function step_result(fn_name, res, before, sel) {
    const cp = res.checkpoint || {};
    const out = cp.outcome || null;
    let tone = res.status === "FAILED" ? "crit" : res.status === "COMPLETED" ? run_tone("COMPLETED", out) : res.status === "CANCELLED" ? "neutral" : "neutral";
    /* the status chip in the body carries the status and outcome; the heading names the call only, so it is said once */
    let title = [code(fn_name), " result"];
    const body = [h("p", { class: "rn-res-line" }, step_text(res, before))];
    if (res.status === "FAILED") {
      let ev = null;
      try { ev = stop_event(sel.env.service.inspect_run(sel.run.run_id, sel.principal).events); } catch (e) { ev = null; }
      if (ev && ev.code === "TERMINAL_ADMISSION_DENIED") {
        title = [code(fn_name), " result: the verified outcome was refused"];
        body.push(h("p", null, "The run reached ", code(cp.state_id), " but the terminal was refused: its evidence was invalidated after it was issued. See the outcome card."));
      } else if (ev) body.push(h("p", null, "Stopped with ", code(ev.code), ev.message ? ": " + ev.message : "", "."));
    }
    return { tone, code: res.status, title, body };
  }

  function do_step(until) {
    call("drive", () => {
      const sel = need_run();
      const before = sel.env.store.latest_checkpoint(sel.run.tenant_id, sel.run.run_id).state_id;
      const res = until ? sel.env.service.run_until_blocked(sel.run.run_id, sel.principal)
        : sel.env.service.advance_run(sel.run.run_id, sel.principal);
      return step_result(until ? "run_until_blocked" : "advance_run", res, before, sel);
    }, () => ({ run: (selected() || {}).run }));
  }

  function armed_list(env) {
    return env ? Array.from(env.faults.armed || []) : [];
  }

  function do_restart() {
    call("drive", () => {
      const env = env_now();
      if (!env) throw new Precondition("Nothing to restart yet: start a run first.");
      const armed = armed_list(env);
      const was = S.crash;
      HXUI.lab.env = env.restart();
      S.crash = null;
      HXUI.lab_changed("env");
      const sel = selected();
      let where = "";
      try { if (sel) where = " Run " + sel.run.run_id + " is " + (STATUS_TEXT[sel.run.status] || sel.run.status).toLowerCase() + " at " + sel.env.store.latest_checkpoint(sel.run.tenant_id, sel.run.run_id).state_id + "."; } catch (e) { where = ""; }
      HXUI.announce("Worker restarted." + where);
      return { tone: "ok", code: "RESTARTED", title: "Worker restarted",
        body: [h("p", null, "New store connection, broker and service over the same data (", code("env.restart()"), "). ",
          was ? "The crashed step left its intent and receipts in the store; the next step reconciles from them." : "Runs continue from their last committed checkpoint.",
          armed.length ? " Armed crash points belonged to the old process and are gone: " + armed.join(", ") + "." : "")] };
    });
  }

  function do_cancel() {
    call("drive", () => {
      const sel = need_run();
      const cr = sel.env.service.cancel_run(sel.run.run_id, null, sel.principal);
      const disclosed = (cr.disclosed_effects || []).map((e) => e.tool + " " + (e.external_ref || "?") + " (" + e.certainty + ")");
      return { tone: cr.status === "CANCELLED" ? "ok" : "warn", code: cr.status, title: [code("cancel_run"), " returned ", cr.status],
        body: [h("p", null, disclosed.length ? "Completed external effects disclosed: " + disclosed.join(", ") + "." : "No completed external effects to disclose."),
          (cr.unresolved || []).length ? h("p", null, "Unresolved: " + cr.unresolved.join("; ") + ".") : null,
          cr.status === "CANCEL_REQUESTED" ? h("p", null, "The cancellation is recorded and blocks any further dispatch. The worker that holds the run's lease finishes it on its next step: press Step.") : null] };
    }, () => ({ run: (selected() || {}).run }));
  }

  /** approval expiry and lease length, read from the engine (the selected run's package, the service) */
  function timing_facts(env, snap) {
    let expiry = null;
    try {
      const pkg = snap && snap.pkg ? snap.pkg : chosen_package(env);
      expiry = pkg && pkg.execution_policy ? pkg.execution_policy.approval_expiry_s : null;
    } catch (e) { expiry = null; }
    const lease = env && env.service ? env.service.lease_ttl : null;
    return { expiry, lease };
  }

  function do_clock(seconds, label) {
    call("drive", () => {
      const env = HXUI.lab_env();
      env.clock.advance(seconds);
      const f = timing_facts(env, P.last_snap);
      const fmt = F().secs;
      const ix = P.last_snap && P.last_snap.ix;
      const facts = [];
      if (f.expiry !== null && f.expiry !== undefined) facts.push("Approvals expire " + fmt(f.expiry) + " after they open");
      if (f.lease !== null && f.lease !== undefined) facts.push("a worker's lease lasts " + fmt(f.lease));
      const past = ix && ix.expires_at !== null && ix.expires_at !== undefined && env.clock() > ix.expires_at;
      return { tone: past ? "warn" : "neutral", code: "CLOCK", title: "Clock advanced " + label,
        body: [h("p", null, "Logical time is now ", h("span", { class: "hx-mono rn-nw" }, iso(env.clock())), ". ", facts.length ? facts.join("; ") + "." : ""),
          past ? h("p", null, "The open approval has expired. Press Step: the run records the expiry and ends unverified.") : null] };
    });
  }

  /** "char 25" in a parser message -> "line 2, column 4" of the text */
  function where_in(text, msg) {
    const m = /char(?:acter)?\s+(\d+)|position\s+(\d+)|offset\s+(\d+)/i.exec(msg);
    if (!m) return null;
    const at = Number(m[1] || m[2] || m[3]);
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const col = at - before.lastIndexOf("\n");
    return { line, col };
  }

  function example_task_text() { return JSON.stringify(HXUI.run_scenario("custom").task(), null, 2); }

  function custom_task(pkg) {
    const text = S.custom_text === null ? example_task_text() : S.custom_text;
    let v;
    try { v = HX.canonical.strict_loads(text); } catch (err) {
      const msg = String(err.message || err).replace(/\.$/, "").replace(/^invalid JSON:\s*/i, "");
      const at = where_in(text, msg);
      return { error: "Not valid JSON" + (at ? " at line " + at.line + ", column " + at.col : "") + ": " + msg + ". Fix it there, or press Reset to example." };
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "The task must be a JSON object, such as {\"supplier_ref\": \"SUP-10042\", ...}. Press Reset to example to start over." };
    const schema = pkg && pkg.contracts ? pkg.contracts.task_input_schema : null;
    if (schema) {
      let errs = [];
      try { errs = HX.catalog.validate_against(schema, v) || []; } catch (err) { errs = [String(err.message || err)]; }
      if (errs.length) {
        const missing = [], other = [];
        for (const e of errs) {
          const m = /'([^']+)' is a required property/.exec(e);
          if (m) missing.push(m[1]); else other.push(String(e).replace(/^<root>:\s*/, "task: "));
        }
        const parts = [];
        if (missing.length) parts.push("Missing fields: " + missing.join(", ") + ".");
        if (other.length) parts.push((other.length > 3 ? other.slice(0, 3).join("; ") + "; and " + (other.length - 3) + " more" : other.join("; ")) + ".");
        return { error: parts.join(" ") + " Add or fix them, or press Reset to example." };
      }
    }
    return { task: v };
  }

  function chosen_package(env) {
    if (S.machine === "refined") return refined_package(env);
    return env ? package_of(env, initial_hash()) || compiled_package() : compiled_package();
  }

  function do_start() {
    let started = false;
    call("start", () => {
      const sc = HXUI.run_scenario(S.scenario) || HXUI.run_scenario("clean");
      const env0 = HXUI.lab_env();
      const pkg = chosen_package(env0);
      if (!pkg) throw new HX.HXError("ARTIFACT_NOT_ADMITTED", "The refined machine is not admitted in this lab. Press Admit refined machine above first.");
      let task;
      if (sc.custom) {
        const r = custom_task(pkg);
        if (r.error) throw new HX.HXError("TASK_INPUT_INVALID", r.error);
        task = r.task;
      } else task = sc.task();
      /* the extraction model belongs to the worker: switch it with a restart when the scenario needs another one */
      let env = env0;
      const want = !!(sc.model && sc.model.gullible);
      const has = !!(env.model && env.model.gullible);
      let note = null;
      if (want !== has) {
        const armed = armed_list(env);
        const model = want ? new HX.fakes.FixtureExtractionModel({ gullible: true }) : new HX.fakes.FixtureExtractionModel();
        env = env.restart(model);
        HXUI.lab.env = env;
        S.crash = null;
        note = (want ? "The worker was restarted with the gullible fixture model (env.restart(model)); it obeys instructions it finds in documents."
          : "The worker was restarted with the standard fixture model (env.restart(model)).") +
          (armed.length ? " Armed crash points belonged to the old process and are gone: " + armed.join(", ") + "." : "");
      }
      const p = env.principal(S.initiator);
      const handle = env.service.start_run(pkg.artifact_hash, task, p);
      HXUI.lab.runs.push({ run_id: handle.run_id, tenant_id: handle.tenant_id, scenario: sc.id, title: sc.title, initiator: p.id,
        artifact_hash: pkg.artifact_hash, machine: pkg.artifact_hash === initial_hash() ? "initial" : "refined" });
      HXUI.lab.selected_run = handle.run_id;
      S.results.drive = null; S.results.human = null; S.results.erp = null;
      HXUI.lab_changed("runs");
      started = true;
      return { tone: "ok", code: "STARTED", title: ["Started ", code(handle.run_id)],
        body: [h("p", null, sc.title + " as ", code(p.id), " on the " + (pkg.artifact_hash === initial_hash() ? "initial" : "refined") + " machine. ",
          "Step through it in the workbench below, or run it until it blocks."), note ? h("p", null, note) : null] };
    }, () => ({ custom: !!(HXUI.run_scenario(S.scenario) || {}).custom }));
    if (started && P && P.drive) {
      /* hand the reader to the next action */
      const step = P.drive.step;
      try { step.focus({ preventScroll: true }); } catch (e) { step.focus(); }
      try { step.scrollIntoView({ block: "nearest", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { /* old engines */ }
    }
  }

  /** Admit the refined machine from the reference missing-documents trace (propose_update, then registry.admit), so
      the Missing documents scenario works without Learn from traces. */
  /** The archive the registry gates against, read from the store: its manifest and the stored trace bodies (the
      same sets Learn from traces passes), so admitting here works after Learn seeded or enrolled the archive. */
  function stored_archive(env, skill) {
    const man = env.store.archive(skill) || { version: null, protected: [], negative: [] };
    const parse = (entries) => (entries || []).map((e) => {
      const body = env.store.trace_body(e.trace_id);
      if (body === null || body === undefined) throw new HX.HXError("TRACE_MISSING", "The store has no body for " + e.trace_id + ".");
      const [t, errs] = HX.traces.from_jsonl(body);
      if (errs && errs.length) throw new HX.HXError("TRACE_INTEGRITY", e.trace_id + ": " + errs[0]);
      return t;
    });
    return { manifest: man, protected: parse(man.protected), negative: parse(man.negative) };
  }

  function do_admit_refined() {
    call("start", () => {
      const env = HXUI.lab_env();
      const R = HX.reference;
      const skill_text = HX.env.skill_source().text;
      const skill = HXUI.lab.packages.initial.machine.skill_id;
      /* the parent is the active version now (Learn may have moved it), and the gates see the stored archive */
      const act = env.store.get_active("sandbox", skill);
      const parent_hash = act ? act[0] : HXUI.lab.packages.initial.artifact_hash;
      const parent = env.service.package(parent_hash);
      const sets = stored_archive(env, skill);
      const trace = R.missing_docs_trace();
      const prop = HX.update.propose_update(parent, trace, sets.protected, sets.negative, env.catalog, new R.FixtureAligner(), skill_text);
      if (!prop || !prop.candidate) throw new HX.HXError("UPDATE_REJECTED", "propose_update returned " + (prop ? prop.status : "no result") + " and no candidate.");
      const protected_ = sets.protected.some((t) => t.trace_id === trace.trace_id) ? sets.protected : sets.protected.concat([trace]);
      const adm = HX.registry.admit(env.store, prop.candidate, env.catalog, { expected_parent_hash: parent_hash,
        approver: env.principal("user:dana"), environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(),
        protected: protected_, negative: sets.negative, now: env.clock(), skill_text });
      if (!adm || adm.status !== "ADMITTED") throw new HX.HXError("ADMISSION_FAILED", "The registry answered " + (adm ? adm.status + ". " + (adm.reasons || []).join("; ") : "nothing."));
      HXUI.lab.packages.refined = prop.candidate;
      HXUI.lab_changed("packages");
      const n = protected_.length;
      return { tone: "ok", code: "ADMITTED", title: ["Refined machine ", code(F().short(prop.candidate.artifact_hash, 19)), " admitted"],
        body: [h("p", null, "Learned from the missing-documents trace and admitted by ", code("user:dana"), " with every gate passing, including replay of ",
          n + (n === 1 ? " protected trace" : " protected traces"), ". Missing documents is now available.")] };
    });
  }

  function current_ix(sel) {
    return sel.env.store.interaction_for_revision(sel.run.tenant_id, sel.run.run_id, sel.env.store.latest_checkpoint(sel.run.tenant_id, sel.run.run_id).revision);
  }

  function do_answer_approval(decision) {
    let ctx = {};
    call("human", () => {
      const sel = need_run();
      const ix = current_ix(sel);
      if (!ix) throw new Precondition("This run has no open approval.");
      const who = P.approver.value;
      ctx = { kind: "approval", run: sel.run, who, ix };
      const tamper = P.tamper.checked;
      const digest = tamper ? tampered(ix.scope_digest) : ix.scope_digest;
      const res = sel.env.service.resume_interaction(sel.run.run_id, ix.interaction_id, { approval_decision: decision, scope_digest: digest }, sel.env.principal(who));
      return { tone: "ok", code: decision.toUpperCase(), title: [decision === "approved" ? "Approved by " : "Rejected by ", code(who)],
        body: [h("p", { class: "rn-res-line" }, "The run continued one step: ", step_text(res, ix.state_id))] };
    }, () => ctx);
  }

  function tampered(d) {
    const s = String(d || "");
    if (!s) return "sha256:0";
    const last = s.slice(-1);
    return s.slice(0, -1) + (last === "0" ? "1" : "0");
  }

  function do_answer_input(ev) {
    if (ev) ev.preventDefault();
    if (P.input_send && HXUI.is_disabled(P.input_send)) return;
    let ctx = {};
    call("human", () => {
      const sel = need_run();
      const ix = current_ix(sel);
      if (!ix) throw new Precondition("This run has no open input request.");
      const ids = String(P.docs_input.value || "").split(/[\s,]+/).filter(Boolean);
      const who = P.input_who.value;
      ctx = { kind: "input", run: sel.run, who, ix };
      const res = sel.env.service.resume_interaction(sel.run.run_id, ix.interaction_id, { document_ids: ids }, sel.env.principal(who));
      return { tone: "ok", code: "ANSWERED", title: ["Answered by ", code(who)],
        body: [h("p", { class: "rn-res-line" }, "Sent document_ids ", wrap_id(JSON.stringify(ids)), ". The run continued one step: ", step_text(res, ix.state_id))] };
    }, () => ctx);
  }

  function do_arm() {
    call("faults", () => {
      const env = HXUI.lab_env();
      const point = P.trouble.fault.value;
      if (ERP_FAULTS.indexOf(point) >= 0) env.erp.inject(point); else env.faults.arm(point);
      HXUI.announce("Armed " + point + (ERP_FAULTS.indexOf(point) >= 0 ? " on the next ERP call." : ": it fires on the next call that reaches it."));
      return { tone: "warn", code: "ARMED", title: ["Armed ", code(point)],
        body: [h("p", null, FAULT_HELP[point] || "", " It fires once, on the next call that reaches it.")] };
    });
  }

  function do_revoke() {
    call("policy", () => {
      const env = HXUI.lab_env();
      const who = P.trouble.pol_principal.value;
      const cap = P.trouble.pol_cap.value;
      if (!cap) throw new Precondition(who + " has no capabilities left to revoke.");
      const before = env.policy.version;
      env.policy.revoke_capability(who, cap);
      return { tone: "warn", code: "REVOKED", title: ["Revoked ", code(cap), " from ", code(who)],
        body: [h("p", null, "Policy version ", code(before), " is now ", code(env.policy.version), ". The broker re-checks capabilities and the approval's policy version before every dispatch."),
          h("p", null, "This stays in effect for every run in the lab until Reset lab.")] };
    });
  }

  function do_erp(kind) {
    call("erp", () => {
      const sel = need_run();
      const cp = sel.env.store.latest_checkpoint(sel.run.tenant_id, sel.run.run_id);
      const id = cp.variables && cp.variables.erp_draft_id;
      if (!id) throw new Precondition("The run has no ERP draft yet.");
      if (kind === "modify") {
        const changes = { legal_name: "Changed Later GmbH" };
        sel.env.erp.modify_out_of_band(sel.run.tenant_id, id, changes);
        return { tone: "warn", code: "MODIFIED", title: ["Draft ", code(id), " changed out of band"],
          body: [h("p", null, "Set legal_name to \"Changed Later GmbH\" and bumped the ERP version (", code("modify_out_of_band"), "). ",
            cp.state_id === "END_VERIFIED_DRAFT" ? "Step now: the terminal re-checks its evidence and refuses the verified outcome (Python test A25)."
              : "Step now: the read-back sees the change, so the run ends unverified (the outcome of Python test A28). To see A25, modify at END_VERIFIED_DRAFT instead.")] };
      }
      const changes = { tax_id: "DE000000000" };
      sel.env.erp.tamper_payload(sel.run.tenant_id, id, changes);
      return { tone: "warn", code: "TAMPERED", title: ["Draft ", code(id), " payload tampered"],
        body: [h("p", null, "Set tax_id to \"DE000000000\" without a version bump, as Python test A28 does: the connector persisted something other than the approved payload. Step now: the read-back catches it.")] };
    }, () => ({ run: (selected() || {}).run }));
  }

  function select_run(run_id) {
    HXUI.lab.selected_run = run_id;
    /* the picker follows the run on screen when it came from one of its scenarios */
    const m = meta_of(run_id);
    if (m && HXUI.run_scenario(m.scenario)) {
      S.scenario = m.scenario;
      S.machine = HXUI.run_scenario(m.scenario).machine === "refined" ? "refined" : "initial";
    }
    S.results.drive = null; S.results.human = null; S.results.erp = null;
    HXUI.lab_changed("selected_run");
    refresh();
  }

  /* ---------------------------------------------------------------- building blocks */
  function summary_item(label, id, value_el) {
    return h("div", { class: "rn-sum-item" }, h("p", { class: "hx-label" }, label), h("div", { class: "rn-sum-value", id }, value_el));
  }

  function build_summary() {
    return h("div", { class: "rn-summary", id: "rn-summary", role: "group", "aria-label": "Selected run" },
      summary_item("Run", "rn-sum-run", null),
      summary_item("Status", "rn-sum-status", null),
      summary_item("State", "rn-sum-state", null),
      summary_item("Transitions", "rn-sum-steps", null),
      summary_item("ERP drafts", "rn-sum-erp", null),
      summary_item("Logical clock", "rn-sum-clock", null));
  }

  /** the tenant whose ERP drafts the summary counts: the selected run's, else the chosen initiator's */
  function summary_tenant(snap) {
    if (snap.run) return snap.run.tenant_id;
    const d = principal_doc(snap.env, S.initiator);
    return d ? d.tenant_id : null;
  }

  function paint_summary(snap) {
    const set = (id, ...kids) => { const el = document.getElementById(id); if (el) el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined)); };
    const env = snap.env;
    if (!snap.run) {
      set("rn-sum-run", h("span", { class: "hx-faint" }, "None yet"), h("span", { class: "rn-sum-note" }, "pick a scenario below"));
      set("rn-sum-status", HXUI.chip("Ready to start", "neutral"), h("span", { class: "rn-sum-note" }, "nothing running"));
      let initial = "READ_INTAKE";
      try { initial = (chosen_package(env) || compiled_package()).machine.initial; } catch (e) { /* keep */ }
      set("rn-sum-state", code(initial), h("span", { class: "rn-sum-note" }, "initial state"));
      set("rn-sum-steps", h("span", { class: "hx-num" }, "0"), h("span", { class: "rn-sum-note" }, "no run yet"));
    } else {
      const meta = meta_of(snap.run.run_id);
      const out = snap.cp.outcome;
      set("rn-sum-run", h("span", { class: "hx-mono", title: snap.run.run_id }, snap.run.run_id), h("span", { class: "rn-sum-note", title: meta ? meta.title : null }, meta ? meta.title : "started elsewhere"));
      const crashed = S.crash && S.crash.run_id === snap.run.run_id;
      const pending_cancel = snap.run.cancel_requested && TERMINAL.indexOf(snap.run.status) < 0;
      set("rn-sum-status", run_chip(snap.run.status, out),
        crashed || pending_cancel ? h("span", { class: "rn-sum-note rn-sum-flags" },
          crashed ? HXUI.chip("Worker crashed at " + S.crash.point, "crit", { icon: "alert", class: "rn-sum-flag", title: "Restart the worker to recover" }) : null,
          pending_cancel ? HXUI.chip("Cancel requested", "warn", { class: "rn-sum-flag", title: "The next step finishes the cancellation" }) : null) : null);
      set("rn-sum-state", code(snap.cp.state_id), out && out.terminal !== snap.cp.state_id ? h("span", { class: "rn-sum-note" }, "→ " + out.terminal) : null);
      const steps = (snap.ins.events || []).filter((e) => e.type === "TRANSITION" || e.type === "FALLBACK_ENTERED").length;
      set("rn-sum-steps", h("span", { class: "hx-num" }, String(steps)), h("span", { class: "rn-sum-note" }, "revision " + snap.cp.revision));
    }
    let drafts = 0;
    const tenant = summary_tenant(snap);
    if (env && tenant) { try { drafts = env.erp.count(tenant); } catch (e) { drafts = 0; } }
    set("rn-sum-erp", h("span", { class: "hx-num", dataset: { count: drafts }, title: "Drafts in the fake ERP for tenant " + tenant + ", written by every run in the lab" }, String(drafts)),
      tenant ? h("span", { class: "rn-sum-note", title: "Counted for the whole tenant: every run in the lab" }, "tenant " + tenant) : null);
    /* the time on the first line, the date under it: the strip keeps its height as the clock moves */
    const when = iso(env ? env.clock() : LAB_EPOCH);
    const cut = when.indexOf(" ");
    set("rn-sum-clock", h("span", { class: "hx-mono rn-clock", title: when }, when.slice(cut + 1)), h("span", { class: "rn-sum-note" }, when.slice(0, cut)));
  }

  /* ---- start panel */
  function scenario_card(sc) {
    const id = "rn-sc-" + sc.id;
    const input = h("input", { type: "radio", name: "rn-scenario", id, value: sc.id, class: "rn-sc-input", checked: S.scenario === sc.id,
      "aria-labelledby": id + "-title", "aria-describedby": id + "-sum" });
    input.addEventListener("change", () => {
      if (!input.checked) return;
      S.scenario = sc.id;
      S.machine = sc.machine === "refined" ? "refined" : "initial";
      refresh();
    });
    const reason = h("span", { class: "rn-sc-reason", id: id + "-reason", hidden: true });
    const tag = h("span", { class: "rn-sc-tags" }, HXUI.chip(sc.refs, sc.machine === "refined" ? "accent" : "neutral", sc.refs_title ? { title: sc.refs_title } : undefined),
      sc.model && sc.model.gullible ? HXUI.chip("Gullible model", "info") : null);
    const card = h("label", { class: "rn-sc", for: id, dataset: { scenario: sc.id } },
      input,
      h("span", { class: "rn-sc-title", id: id + "-title" }, sc.title),
      tag,
      h("span", { class: "rn-sc-body", id: id + "-sum" }, HXUI.rich(sc.summary)),
      reason);
    return { sc, input, card, reason, tag };
  }

  function build_start() {
    const cards = HXUI.run_scenarios.map(scenario_card);
    const list = h("div", { class: "rn-sc-grid", role: "radiogroup", "aria-labelledby": "rn-start-title", "aria-describedby": "rn-picked" }, cards.map((c) => c.card));
    const expect = h("p", { class: "rn-expect", id: "rn-expect" });
    const picked = h("p", { class: "rn-picked", id: "rn-picked", hidden: true });

    /* the refined machine, admitted here when Learn from traces has not done it yet */
    const admit = HXUI.button("Admit refined machine", { id: "rn-admit-refined", size: "sm", icon: "check", on_click: do_admit_refined });
    const admit_wrap = h("div", { class: "rn-admit", id: "rn-admit", hidden: true },
      h("p", { class: "rn-admit-text", id: "rn-admit-text" }), h("div", { class: "hx-actions" }, admit));

    /* custom task editor */
    const ta = h("textarea", { id: "rn-custom", class: "hx-textarea rn-custom", rows: 9, spellcheck: "false", autocomplete: "off" });
    ta.value = S.custom_text === null ? example_task_text() : S.custom_text;
    let t = 0;
    ta.addEventListener("input", () => { S.custom_text = ta.value; clearTimeout(t); t = setTimeout(refresh, 200); });
    const custom = HXUI.field("Task JSON", ta, { id: "rn-custom", hint: "Parsed with HX.canonical.strict_loads, then checked against the package's task_input_schema." });
    const reset = HXUI.button("Reset to example", { id: "rn-custom-reset", size: "sm", variant: "ghost", icon: "reset", on_click: () => {
      S.custom_text = null;
      ta.value = example_task_text();
      refresh();
      try { ta.focus(); } catch (e) { /* gone */ }
    } });
    const custom_wrap = h("div", { class: "rn-custom-wrap", hidden: true }, custom, h("div", { class: "hx-actions" }, reset));

    /* machine toggle */
    const m_init = h("input", { type: "radio", name: "rn-machine", id: "rn-machine-initial", value: "initial", checked: S.machine === "initial" });
    const m_ref = h("input", { type: "radio", name: "rn-machine", id: "rn-machine-refined", value: "refined", checked: S.machine === "refined" });
    for (const m of [m_init, m_ref]) m.addEventListener("change", () => { if (m.checked) { S.machine = m.value; refresh(); } });
    const ref_reason = h("p", { class: "hx-field-hint rn-machine-reason", id: "rn-machine-reason" });
    const machine = h("fieldset", { class: "rn-seg-field" },
      h("legend", { class: "hx-field-label" }, "Machine"),
      h("div", { class: "rn-seg" },
        h("label", { class: "rn-seg-opt", for: "rn-machine-initial" }, m_init, h("span", null, "Initial")),
        h("label", { class: "rn-seg-opt", for: "rn-machine-refined" }, m_ref, h("span", null, "Refined"))),
      ref_reason);

    const principals = Object.keys(HX.data.policy.principals);
    const who = HXUI.select("rn-initiator", principals.map((p) => ({ value: p, label: principal_label(null, p, null) })),
      { value: S.initiator, on_change: (v) => { S.initiator = v; refresh(); } });
    const who_field = HXUI.field("Initiator", who, { hint: "The run's principal. The broker checks this identity's capabilities." });
    const start = HXUI.button("Start run", { id: "rn-start", variant: "primary", icon: "play", on_click: do_start });
    const result = h("div", { class: "rn-result", id: "rn-start-result", hidden: true });

    const form = h("form", { class: "rn-start", id: "rn-start-form", "aria-labelledby": "rn-start-title" },
      picked, list, admit_wrap, custom_wrap,
      h("div", { class: "rn-start-row" }, machine, who_field, h("div", { class: "rn-start-go" }, start)),
      expect, result);
    form.addEventListener("submit", (e) => { e.preventDefault(); do_start(); });
    const panel = h("section", { class: "hx-panel rn-panel", "aria-labelledby": "rn-start-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "rn-start-title" }, "Start a run"),
        h("div", { class: "hx-panel-meta" }, HXUI.chip("Fixture mode", "info"))),
      h("p", { class: "hx-panel-lead" }, "Each scenario is a task from the Python tests. The run starts in the lab's environment, which admitted the compiled machine as ",
        code("user:dana"), "."),
      form);
    return { panel, cards, list, custom_wrap, custom, ta, m_init, m_ref, ref_reason, who, start, result, expect, admit, admit_wrap, picked };
  }

  /** "user:mallory · globex · procurement_approver": the tenant first when it differs from the run's */
  function principal_label(env, p, tenant) {
    const d = principal_doc(env, p) || {};
    const roles = (d.roles || []).join(", ");
    return p + (d.tenant_id && tenant && d.tenant_id !== tenant ? " · " + d.tenant_id : "") + (roles ? " · " + roles : "");
  }

  const can_admit_here = () => !!(globalThis.HX && HX.update && HX.reference && HX.registry && HX.fixture && HX.env && HX.traces);

  function paint_start(snap) {
    const env = snap.env;
    const refined = env ? refined_package(env) : null;
    const here = can_admit_here();
    const no_ref = "Needs the refined machine, which is not admitted in this lab yet. " +
      (here ? "Press Admit refined machine below, or admit it in Learn from traces." : "Admit it in Learn from traces first.");
    for (const c of P.start.cards) {
      const off = c.sc.machine === "refined" && !refined;
      c.input.disabled = off;
      c.card.classList.toggle("is-disabled", off);
      c.card.classList.toggle("is-selected", S.scenario === c.sc.id);
      c.reason.hidden = !off;
      c.reason.textContent = off ? no_ref : "";
      c.input.setAttribute("aria-describedby", c.input.id + "-sum" + (off ? " " + c.reason.id : ""));
      c.input.checked = S.scenario === c.sc.id;
      /* a disabled card's tag reads as inactive */
      const first = c.tag.firstChild;
      if (first) { first.classList.toggle("hx-tone-accent", !off && c.sc.machine === "refined"); first.classList.toggle("hx-tone-neutral", off || c.sc.machine !== "refined"); }
    }
    if (S.scenario === "missing-docs" && !refined) { S.scenario = "clean"; S.machine = "initial"; return paint_start(snap); }
    if (S.machine === "refined" && !refined) S.machine = "initial";
    /* once a run exists the cards shrink to their titles on narrow screens (the selected one keeps its text) */
    P.start.list.classList.toggle("is-compact", (HXUI.lab.runs || []).length > 0);
    P.start.m_ref.disabled = !refined;
    if (refined) P.start.m_ref.removeAttribute("aria-describedby"); else P.start.m_ref.setAttribute("aria-describedby", "rn-machine-reason");
    P.start.m_init.checked = S.machine === "initial";
    P.start.m_ref.checked = S.machine === "refined";
    P.start.ref_reason.replaceChildren(...(refined ? ["Refined ", h("span", { class: "hx-mono", title: refined.artifact_hash }, F().short(refined.artifact_hash, 19)), " is admitted."]
      : ["Refined is available once it is admitted. ", h("a", { class: "hx-link", href: "#learn", id: "rn-open-learn" }, "Open Learn from traces")]));
    /* admit here */
    P.start.admit_wrap.hidden = !!refined || !here;
    if (!refined && here) {
      document.getElementById("rn-admit-text").replaceChildren("The Missing documents scenario runs on the refined machine. Learn it from the missing-documents trace and admit it as ",
        code("user:dana"), " here, with the same gates Learn from traces uses (", code("propose_update"), ", then ", code("registry.admit"), ").");
    }
    const sc = HXUI.run_scenario(S.scenario);
    P.start.custom_wrap.hidden = !sc.custom;
    let reason = "";
    const lock = tour_lock(snap);
    if (lock) reason = lock;
    HXUI.set_disabled(P.start.admit, !!lock, lock);
    if (sc.custom) {
      let pkg = null;
      try { pkg = chosen_package(env); } catch (e) { pkg = null; }
      const r = custom_task(pkg);
      P.start.custom.hx.set_error(r.error || "");
      P.start.custom.hx.set_hint(r.error ? "" : "Valid task with " + Object.keys(r.task).length + " fields, checked against the task schema.");
      if (r.error && !reason) reason = "Fix the task JSON first: " + r.error;
      HXUI.set_disabled(document.getElementById("rn-custom-reset"), S.custom_text === null, "The editor already shows the example task.");
    }
    HXUI.set_disabled(P.start.start, !!reason, reason);
    P.start.expect.replaceChildren(h("span", { class: "hx-label" }, "Expected"), " ", sc.expect);
    /* the run on screen came from somewhere else (the guided demo, another scenario): say so beside the picker */
    const m = snap.run ? meta_of(snap.run.run_id) : null;
    const other = snap.run && (!m || m.scenario !== S.scenario);
    P.start.picked.hidden = !other;
    P.start.picked.replaceChildren(...(other ? ["Showing ", code(snap.run.run_id), m ? ", " + m.title.replace(/^Guided demo: /, "from the guided demo: ") : ", started outside this workbench",
      ". The cards set up the next run."] : []));
    result_view("start");
  }

  /* ---- runs list */
  function build_runs() {
    const body = h("div", { class: "rn-runs-body", id: "rn-runs" });
    const panel = h("section", { class: "hx-panel rn-panel", "aria-labelledby": "rn-runs-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "rn-runs-title" }, "Runs in this lab"),
        h("div", { class: "hx-panel-meta", id: "rn-runs-meta" })),
      body);
    return { panel, body };
  }

  function paint_runs(snap) {
    const env = snap.env;
    const runs = all_runs(env).slice().reverse().map((r) => {
      let out = null;
      try { const cp = env.store.latest_checkpoint(r.tenant_id, r.run_id); out = cp ? cp.outcome : null; } catch (e) { out = null; }
      return Object.assign({}, r, { outcome: out });
    });
    document.getElementById("rn-runs-meta").replaceChildren(HXUI.chip(runs.length + (runs.length === 1 ? " run" : " runs"), "neutral"));
    const sel = HXUI.lab.selected_run;
    const table = HXUI.table({
      caption: "Runs in this lab, newest first", caption_hidden: true, class: "rn-runs-table",
      columns: [
        { key: "run_id", label: "Run", nowrap: true, render: (r) => h("button", {
          type: "button", class: "rn-run-btn", id: "rn-run-" + r.run_id, "aria-current": r.run_id === sel ? "true" : null,
          "aria-label": "Inspect " + r.run_id + (r.run_id === sel ? " (shown)" : ""), on: { click: () => select_run(r.run_id) },
        }, h("span", { class: "hx-mono" }, r.run_id)) },
        { key: "status", label: "Status", nowrap: true, render: (r) => run_chip(r.status, r.outcome) },
        { key: "outcome", label: "Outcome", nowrap: true, fold: true, fold_label: "outcome",
          render: (r) => r.outcome ? code(r.outcome.terminal) : h("span", { class: "hx-faint" }, "none yet") },
        { key: "scenario", label: "Scenario", fold: true, render: (r) => { const m = meta_of(r.run_id); return m ? m.title : h("span", { class: "hx-faint" }, "started elsewhere"); } },
        { key: "principal", label: "Initiator", mono: true, nowrap: true, fold: true, fold_label: "by" },
        { key: "machine", label: "Machine", fold: true, render: (r) => r.artifact_hash === initial_hash() ? "initial" : h("span", { class: "hx-mono", title: r.artifact_hash }, F().short(r.artifact_hash, 15)) },
      ],
      rows: runs, empty: "No runs yet. Pick a scenario and start one.",
      row_attrs: (r) => ({ class: r.run_id === sel ? "is-selected" : null, dataset: { run: r.run_id, status: r.status, terminal: r.outcome ? r.outcome.terminal : "" } }),
    });
    P.runs.body.replaceChildren(table);
  }

  /* ---- graph */
  function paint_graph(snap) {
    const box = P.graph_box;
    if (!HXUI.graph || typeof HXUI.graph.create !== "function") {
      if (!box.querySelector(".hx-unavailable")) box.replaceChildren(HXUI.unavailable(["HXUI.graph"], { compact: true, title: "The graph view is not in this build", hint: false }));
      return;
    }
    let pkg = null;
    try { pkg = snap.run ? snap.pkg : chosen_package(snap.env); } catch (e) { pkg = null; }
    if (!pkg) { try { pkg = compiled_package(); } catch (e) { pkg = null; } }
    if (!pkg) { box.replaceChildren(HXUI.notice("crit", "No machine to draw", "The compiler returned no package.")); return; }
    if (S.view_hash !== pkg.artifact_hash || !S.view || !box.contains(S.view.root)) {
      if (S.view) { try { S.view.destroy(); } catch (e) { /* gone */ } }
      box.replaceChildren();
      const kind = pkg.artifact_hash === (initial_hash() || compiled_package().artifact_hash) ? "Initial machine" : "Refined machine";
      S.view = HXUI.graph.create(box, pkg.machine, { title: kind, interactions: pkg.contracts ? pkg.contracts.interactions : undefined });
      S.view_hash = pkg.artifact_hash;
    }
    P.graph_hash.replaceChildren(HXUI.digest(pkg.artifact_hash, { short: 19, label: "artifact hash", id: "rn-graph-hash" }));
    if (!snap.run) { S.view.update({}); return; }
    const visited = (snap.ins.events || []).filter((e) => e.type === "TRANSITION" || e.type === "FALLBACK_ENTERED")
      .map((e) => (e.type === "TRANSITION" ? { from: e.from, to: e.to, edge: e.edge } : { from: e.from, to: e.to, edge: null, reason: e.reason }));
    const out = snap.cp.outcome;
    S.view.update({ current: snap.cp.state_id, visited, status: snap.run.status, terminal: out ? out.terminal : null });
  }

  /* ---- drive controls */
  function build_drive() {
    const b = (label, id, fn, o) => HXUI.button(label, Object.assign({ id, size: "sm", on_click: fn }, o || {}));
    const step = b("Step", "rn-step", () => do_step(false), { variant: "primary", icon: "arrow" });
    const wait = h("p", { class: "rn-drive-wait", id: "rn-drive-wait", hidden: true });
    const until = b("Run until blocked", "rn-until", () => do_step(true), { icon: "play" });
    const restart = b("Restart worker", "rn-restart", do_restart, { icon: "reset" });
    const cancel = b("Cancel run", "rn-cancel", do_cancel, { variant: "secondary" });
    const h1 = b("+1 h", "rn-clock-1h", () => do_clock(3600, "by 1 hour"), { variant: "secondary" });
    const h25 = b("+25 h", "rn-clock-25h", () => do_clock(90000, "by 25 hours"), { variant: "secondary" });
    const result = h("div", { class: "rn-result", id: "rn-drive-result", hidden: true });
    const lock = h("p", { class: "rn-drive-wait rn-drive-lock", id: "rn-drive-lock", hidden: true });
    /* one row above the graph: move the run, recover or stop it, move time */
    const panel = h("section", { class: "rn-drive", "aria-labelledby": "rn-drive-title" },
      h("h4", { class: "hx-label", id: "rn-drive-title" }, "Drive the run"),
      h("div", { class: "rn-drive-bar" },
        h("div", { class: "rn-drive-group" }, step, until),
        h("div", { class: "rn-drive-group" }, restart, cancel),
        h("div", { class: "rn-drive-group rn-clock-group", role: "group", "aria-labelledby": "rn-clock-label" },
          h("span", { class: "rn-clock-label", id: "rn-clock-label" }, "Advance clock"), h1, h25)),
      wait, lock,
      result);
    return { panel, step, until, restart, cancel, h1, h25, result, wait, lock };
  }

  /** whether the open approval's expiry has passed on the logical clock */
  function ix_expired(snap) {
    const ix = snap.ix;
    return !!(ix && ix.expires_at !== null && ix.expires_at !== undefined && snap.env && snap.env.clock() > ix.expires_at);
  }

  function paint_drive(snap) {
    const run = snap.run;
    const crashed = S.crash ? "The worker crashed at " + S.crash.point + ". Restart the worker first." : "";
    const none = "Start a run first.";
    const done = run && TERMINAL.indexOf(run.status) >= 0 ? "The run has finished (" + run.status + ")." : "";
    const cancel_pending = run && run.cancel_requested && !done ? "Cancellation already requested: press Step to finish it." : "";
    let waiting = "";
    if (cancel_pending) waiting = "";
    else if (run && run.status === "WAITING_FOR_APPROVAL" && !ix_expired(snap)) {
      waiting = "Waiting for approval: answer it below, or advance the clock past its expiry and then Step to record the expiry.";
    } else if (run && run.status === "WAITING_FOR_INPUT") {
      waiting = "Waiting for input: send the documents below. Stepping cannot move the run until someone answers.";
    }
    const lock = tour_lock(snap);
    const r1 = lock || (!run ? none : crashed || done || waiting);
    HXUI.set_disabled(P.drive.step, !!r1, r1);
    HXUI.set_disabled(P.drive.until, !!r1, r1);
    /* the one action that can move the run is the primary one: Step, unless a human answer or a restart is due */
    const step_primary = !r1;
    P.drive.step.classList.toggle("hx-btn--primary", step_primary);
    P.drive.step.classList.toggle("hx-btn--secondary", !step_primary);
    const rc = lock || (!run ? none : crashed || done || cancel_pending);
    HXUI.set_disabled(P.drive.cancel, !!rc, rc);
    const r2 = lock || (snap.env ? "" : "Nothing to restart yet: start a run first.");
    HXUI.set_disabled(P.drive.restart, !!r2, r2);
    HXUI.set_disabled(P.drive.h1, !!lock, lock);
    HXUI.set_disabled(P.drive.h25, !!lock, lock);
    P.drive.wait.hidden = !waiting || !!crashed || !!lock;
    P.drive.wait.textContent = waiting;
    P.drive.lock.hidden = !lock;
    P.drive.lock.textContent = lock;
    result_view("drive");
  }

  /* ---- human panel: approval or input */
  function scope_rows(scope, ix) {
    const ev = Array.isArray(scope.evidence) ? scope.evidence : [];
    const row = (k, v) => h("div", { class: "rn-scope-row" }, h("dt", null, k), h("dd", null, v));
    return h("dl", { class: "rn-scope", id: "rn-scope" },
      row("Tool", [code(scope.tool), " ", h("span", { class: "hx-faint" }, "v" + scope.tool_version)]),
      row("Args digest", HXUI.digest(scope.args_digest, { short: 19, label: "args digest", id: "rn-scope-args" })),
      row("Business ref", HXUI.digest(scope.target && scope.target.business_reference, { short: 19, label: "business reference", id: "rn-scope-ref" })),
      row("Evidence", ev.length ? h("ul", { class: "rn-scope-ev" }, ev.map((e) => h("li", null, wrap_id(e.claim, "rn-claim"), " ", HXUI.digest(e.receipt_id, { short: 14, copy: false }))))
        : h("span", { class: "hx-faint" }, "none")),
      row("Policy", wrap_id(scope.policy_version)),
      row("Role", code(scope.required_role)),
      row("Expires", h("span", { class: "hx-mono rn-nw", id: "rn-scope-expires" }, iso(scope.expires_at))),
      row("Scope digest", HXUI.digest(ix.scope_digest, { short: 19, label: "scope digest", id: "rn-scope-digest" })));
  }

  function build_approval(snap) {
    const ix = snap.ix;
    const ok = eligible_approvers(snap.env, snap.run, ix);
    const approver = HXUI.select("rn-approver", APPROVERS.map((p) => ({ value: p, label: principal_label(snap.env, p, snap.run.tenant_id) })),
      { value: ok.indexOf("user:bob") >= 0 || !ok.length ? "user:bob" : ok[0] });
    const tamper = h("input", { type: "checkbox", id: "rn-tamper" });
    const approve = HXUI.button("Approve", { id: "rn-approve", variant: "primary", size: "sm", icon: "check", on_click: () => do_answer_approval("approved") });
    const reject = HXUI.button("Reject", { id: "rn-reject", size: "sm", on_click: () => do_answer_approval("rejected") });
    const chip = h("span", { class: "rn-ix-chip", id: "rn-approval-state" });
    P.approver = approver;
    P.tamper = tamper;
    P.human_buttons = [approve, reject];
    P.ix_chip = chip;
    return h("section", { class: "hx-card rn-human", id: "rn-approval", "aria-labelledby": "rn-approval-title", dataset: { interaction: ix.interaction_id } },
      h("div", { class: "rn-human-head" },
        h("h4", { class: "rn-human-title", id: "rn-approval-title" }, "Approval requested"), chip),
      h("p", { class: "rn-human-lead" }, "The approver signs off this exact write. Any change to the tool, arguments, evidence or policy afterwards invalidates the approval."),
      scope_rows(ix.scope || {}, ix),
      HXUI.field("Approve as", approver, { hint: "Separation of duties: the initiator cannot approve their own run." + (ok.length ? " Eligible here: " + ok.join(", ") + "." : "") }),
      h("label", { class: "rn-check", for: "rn-tamper" }, tamper, "Tamper with the scope digest (negative demo)"),
      h("div", { class: "hx-actions" }, approve, reject),
      P.results.human);
  }

  /** documents on file for the task's supplier that the task did not list (fixture document store) */
  function documents_on_file(env, run, cp) {
    try {
      const docs = env.docs && env.docs.docs ? env.docs.docs[run.tenant_id] || {} : {};
      const task = cp.variables || {};
      const listed = Array.isArray(task.document_ids) ? task.document_ids : [];
      const num = String(task.supplier_ref || "").replace(/^\D+/, "");
      return Object.keys(docs).filter((d) => listed.indexOf(d) < 0 && num && d.endsWith("-" + num));
    } catch (e) { return []; }
  }

  function build_input(snap) {
    const ix = snap.ix;
    const ctx = (ix.scope && ix.scope.context) || {};
    const missing = Array.isArray(ctx.missing_document_ids) ? ctx.missing_document_ids : [];
    const on_file = documents_on_file(snap.env, snap.run, snap.cp);
    const docs = h("input", { type: "text", id: "rn-docs", class: "hx-input hx-mono", autocomplete: "off", spellcheck: "false",
      value: on_file.join(", ") });
    const principals = Object.keys(snap.env.policy.doc.principals);
    const who = HXUI.select("rn-input-who", principals.map((p) => ({ value: p, label: principal_label(snap.env, p, snap.run.tenant_id) })), { value: snap.run.principal });
    P.docs_input = docs;
    P.input_who = who;
    const send = HXUI.button("Send documents", { id: "rn-input-send", variant: "primary", size: "sm", type: "submit" });
    P.input_send = send;
    P.human_buttons = [send];
    const chip = h("span", { class: "rn-ix-chip", id: "rn-input-state" });
    P.ix_chip = chip;
    const form = h("form", { class: "rn-input-form", id: "rn-input-form" },
      HXUI.field("document_ids", docs, { hint: "Comma-separated document ids. " + (on_file.length
        ? "The fixture document store has " + on_file.join(", ") + " on file for " + (snap.cp.variables || {}).supplier_ref + " (prefilled)."
        : "The fixture document store has no other document on file for this supplier.") }),
      HXUI.field("Answer as", who, { hint: "The requester (" + snap.run.principal + ") or an approver may answer an input request." }),
      h("div", { class: "hx-actions" }, send));
    form.addEventListener("submit", do_answer_input);
    return h("section", { class: "hx-card rn-human", id: "rn-input", "aria-labelledby": "rn-input-title", dataset: { interaction: ix.interaction_id } },
      h("div", { class: "rn-human-head" }, h("h4", { class: "rn-human-title", id: "rn-input-title" }, "Input requested"), chip),
      h("p", { class: "rn-human-lead" }, "The machine asks the requester once for the missing documents: ",
        missing.length ? missing.map((m, i) => [i ? ", " : "", code(m)]) : "none listed", "."),
      form, P.results.human);
  }

  function paint_human(snap) {
    const ix = snap.ix;
    const key = ix && ix.status === "OPEN" ? snap.run.run_id + "|" + ix.interaction_id : null;
    if (key !== S.human_key) {
      S.human_key = key;
      if (!key) { P.human.replaceChildren(); P.human_buttons = []; P.ix_chip = null; }
      else P.human.replaceChildren(ix.type === "approval" ? build_approval(snap) : build_input(snap));
    }
    if (key) {
      const expired = ix_expired(snap);
      if (P.ix_chip) P.ix_chip.replaceChildren(expired ? HXUI.chip("Expired", "warn", { icon: "alert", title: "The logical clock passed " + iso(ix.expires_at) }) : HXUI.chip("Open", "accent"));
      const why = tour_lock(snap) || (S.crash ? "The worker crashed at " + S.crash.point + ". Restart the worker first." : "");
      for (const b of P.human_buttons || []) HXUI.set_disabled(b, !!why, why);
    }
    if (!key && S.results.human) {
      /* the answer moved the run on: keep its result visible under the controls */
      P.human.replaceChildren(P.results.human);
    }
    P.human.hidden = !key && !S.results.human;
    result_view("human");
  }

  /* ---- outcome */
  function paint_outcome(snap) {
    const box = P.outcome;
    const run = snap.run;
    if (!run || (TERMINAL.indexOf(run.status) < 0 && run.status !== "RECONCILING")) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const cp = snap.cp;
    const out = cp.outcome;
    const a = cp.assurance || {};
    const events = snap.ins.events || [];
    const list = (arr) => arr && arr.length ? h("ul", { class: "rn-out-list" }, arr.map((x) => h("li", null, typeof x === "string" ? x : F().compact_json(x, 200)))) : h("span", { class: "hx-faint" }, "none");
    const row = (k, v, id) => h("div", { class: "rn-scope-row", dataset: { key: id } }, h("dt", null, k), h("dd", null, v));
    const diag = (a.diagnostics || []).map((d) => [wrap_id(d.code || "?", "rn-diag-code"), " ", d.message || F().compact_json(d, 160)]);
    const tone = out ? CATEGORY_TONE[out.category] || "neutral" : STATUS_TONE[run.status] || "neutral";
    const stop = run.status === "FAILED" ? stop_event(events) : null;
    const refused = !!(stop && stop.code === "TERMINAL_ADMISSION_DENIED") ||
      ((a.diagnostics || []).length && a.diagnostics[a.diagnostics.length - 1].code === "TERMINAL_ADMISSION_DENIED");
    const title = out ? "Outcome" : refused ? "Verified outcome refused" : run.status === "RECONCILING" ? "Reconciling" : "Stopped without an outcome";
    let lead = null;
    if (refused) {
      lead = h("p", { class: "rn-out-lead" }, "The verified terminal ", code(cp.state_id), " was refused because its evidence was invalidated: the ERP draft changed after the read-back verified it. The run failed instead of claiming a verified outcome.");
    } else if (stop) {
      lead = h("p", { class: "rn-out-lead" }, "Stopped at ", code(stop.state || cp.state_id), " with ", code(stop.code), stop.message ? ": " + stop.message : "", ".");
    }
    /* why the run ended where it did: the guard of the last transition, or the fallback reason */
    const last = last_transition(events);
    let why = null;
    if (a.entered_fallback) why = [HXUI.chip("fallback", "crit"), " ", a.fallback_reason || "the step failed and the machine's fallback took over"];
    else if (out && out.category !== "verified" && last && (last.to === out.terminal || last.to === cp.state_id)) {
      const vars = cp.variables || {};
      const vals = (last.delta_keys || []).filter((k) => vars[k] !== null && vars[k] !== undefined && typeof vars[k] !== "object")
        .map((k, i) => [i ? ", " : "", code(k + " = " + JSON.stringify(vars[k]))]);
      why = [move(last.from, last.to), " ", last.edge && last.edge.if ? ["because ", wrap_id(last.edge.if)] : "by the default edge",
        vals.length ? [" after ", vals] : null];
    }
    box.dataset.status = run.status;
    box.dataset.terminal = out ? out.terminal : "";
    box.dataset.category = out ? out.category : "";
    box.dataset.refused = refused ? "1" : "";
    box.className = "hx-card rn-outcome hx-tone-" + tone;
    const fallback_text = a.entered_fallback ? h("span", null, HXUI.chip("entered", "crit"), " ", a.fallback_reason || "")
      : out && out.category === "fallback" ? "not entered: the machine routed to " + out.terminal + " by its own edge (see Why)" : "not entered";
    box.replaceChildren(...[
      h("div", { class: "rn-human-head" },
        h("h4", { class: "rn-human-title", id: "rn-outcome-title" }, title),
        out ? HXUI.chip(out.category, tone, { icon: out.category === "verified" ? "check" : "alert" }) : status_chip(run.status)),
      h("p", { class: "rn-out-terminal" }, out ? code(out.terminal) : [code(cp.state_id), " · ", run.status]),
      lead,
      h("dl", { class: "rn-scope" },
        why ? row("Why", why, "why") : null,
        row("Verification scope", a.verification_scope || h("span", { class: "hx-faint" }, out && out.category === "verified" ? "" : "no verified claim"), "scope"),
        out && out.evidence_receipts && out.evidence_receipts.length ? row("Evidence", h("span", { class: "rn-ev-ids" }, out.evidence_receipts.map((r) => code(r))), "evidence") : null,
        row("Fallback path", fallback_text, "fallback"),
        row("Missing evidence", list(a.missing_evidence), "missing"),
        row("Policy violations", list(a.policy_violations), "violations"),
        row("Unresolved effects", list(a.unresolved_effects), "unresolved"),
        row("Diagnostics", diag.length ? h("ul", { class: "rn-out-list" }, diag.map((d) => h("li", null, d))) : h("span", { class: "hx-faint" }, "none"), "diagnostics"))].filter(Boolean));
  }

  /* ---- trouble: faults, policy, ERP */
  function build_trouble() {
    const fault = h("select", { id: "rn-fault", class: "hx-select" },
      h("optgroup", { label: "Crash the worker (FaultInjector)" }, HX.broker.FaultInjector.POINTS.map((p) => h("option", { value: p }, "crash " + p))),
      h("optgroup", { label: "Fake ERP faults" }, ERP_FAULTS.map((p) => h("option", { value: p }, p))));
    fault.value = "timeout_after_commit";
    const fault_help = h("p", { class: "hx-field-hint", id: "rn-fault-help" });
    const sync_help = () => { fault_help.textContent = FAULT_HELP[fault.value] || ""; };
    fault.addEventListener("change", sync_help);
    sync_help();
    const arm = HXUI.button("Arm", { id: "rn-fault-arm", size: "sm", on_click: do_arm });
    const armed = h("div", { class: "rn-armed", id: "rn-armed" });

    const pol_principal = h("select", { id: "rn-pol-principal", class: "hx-select" });
    const pol_cap = h("select", { id: "rn-pol-cap", class: "hx-select" });
    pol_principal.addEventListener("change", () => paint_trouble(null));
    const revoke = HXUI.button("Revoke", { id: "rn-pol-revoke", size: "sm", variant: "danger", on_click: do_revoke });
    const pol_version = h("p", { class: "rn-pol-version", id: "rn-pol-version" });

    const modify = HXUI.button("Modify draft out of band", { id: "rn-erp-modify", size: "sm", on_click: () => do_erp("modify") });
    const tamper = HXUI.button("Tamper payload", { id: "rn-erp-tamper", size: "sm", on_click: () => do_erp("tamper") });
    const erp_note = h("p", { class: "hx-field-hint", id: "rn-erp-note" });

    const res = (area) => P_results_box(area);
    const group = (id, title, lead, ...kids) => h("section", { class: "rn-trouble-group", "aria-labelledby": id },
      h("h4", { class: "rn-group-title", id }, title), h("p", { class: "rn-group-lead" }, lead), kids);
    const panel = h("section", { class: "hx-panel rn-panel", "aria-labelledby": "rn-trouble-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "rn-trouble-title" }, "Make trouble")),
      h("p", { class: "hx-panel-lead" }, "Inject the failures the conformance tests use, then drive the run and watch the engine contain them."),
      h("div", { class: "rn-trouble" },
        group("rn-g-faults", "Faults", "Crash the worker at a dispatch boundary, or make the fake ERP misbehave on its next call.",
          HXUI.field("Fault", fault), fault_help, h("div", { class: "hx-actions" }, arm), armed, res("faults")),
        group("rn-g-policy", "Policy", "Revoke a capability. Every revocation creates a new policy version and stays in effect for every run in the lab until Reset lab.",
          HXUI.field("Principal", pol_principal), HXUI.field("Capability", pol_cap), h("div", { class: "hx-actions" }, revoke), pol_version, res("policy")),
        group("rn-g-erp", "ERP draft", "Change the persisted draft behind the engine's back, after it was written.",
          h("div", { class: "rn-erp-actions" }, modify, tamper), erp_note, res("erp"))));
    return { panel, fault, arm, armed, pol_principal, pol_cap, revoke, pol_version, modify, tamper, erp_note };
  }

  let result_boxes = {};
  function P_results_box(area) {
    if (!result_boxes[area]) result_boxes[area] = h("div", { class: "rn-result", id: "rn-" + area + "-result", hidden: true });
    return result_boxes[area];
  }

  function paint_trouble(snap0) {
    const snap = snap0 || P.last_snap || { env: env_now() };
    const env = snap.env;
    const T = P.trouble;
    /* armed */
    const armed = env ? Array.from(env.faults.armed || []).map((p) => "crash " + p).concat((env.erp.faults || []).slice()) : [];
    T.armed.replaceChildren(h("span", { class: "rn-armed-label" }, "Armed: "),
      armed.length ? armed.map((a) => HXUI.chip(a, "warn", { mono: true })) : h("span", { class: "hx-faint" }, "nothing"));
    T.armed.dataset.armed = armed.join(" ");
    /* policy */
    const doc = env ? env.policy.doc : HX.data.policy;
    const keep = T.pol_principal.value || "user:alice";
    const ps = Object.keys(doc.principals).filter((p) => (doc.principals[p].capabilities || []).length || p === keep);
    T.pol_principal.replaceChildren(...ps.map((p) => h("option", { value: p }, p)));
    T.pol_principal.value = ps.indexOf(keep) >= 0 ? keep : ps[0] || "";
    const caps = ((doc.principals[T.pol_principal.value] || {}).capabilities || []).slice();
    const keep_cap = T.pol_cap.value || "erp:draft:create";
    T.pol_cap.replaceChildren(...caps.map((c) => h("option", { value: c }, c)));
    T.pol_cap.value = caps.indexOf(keep_cap) >= 0 ? keep_cap : caps[0] || "";
    T.pol_cap.disabled = !caps.length;
    const lock = tour_lock(snap);
    const no_caps = lock || (caps.length ? "" : T.pol_principal.value + " has no capabilities left to revoke.");
    HXUI.set_disabled(T.revoke, !!no_caps, no_caps);
    HXUI.set_disabled(T.arm, !!lock, lock);
    /* what this lab revoked so far, against the policy the lab started with */
    const revoked = [];
    const base = HX.data.policy.principals || {};
    for (const p of Object.keys(base)) {
      const now = (doc.principals[p] || {}).capabilities || [];
      for (const c of base[p].capabilities || []) if (now.indexOf(c) < 0) revoked.push([p, c]);
    }
    T.pol_version.replaceChildren("Policy version ", wrap_id(env ? env.policy.version : doc.policy_version), ". ",
      revoked.length ? h("span", null, "Revoked in this lab: ", revoked.map(([p, c], i) => [i ? ", " : "", code(c), " from ", code(p)]), ". Reset lab restores the policy.")
        : "Nothing revoked.");
    T.pol_version.dataset.revoked = String(revoked.length);
    /* ERP */
    const draft = snap.run && snap.cp && snap.cp.variables ? snap.cp.variables.erp_draft_id : null;
    const terminal = snap.run && TERMINAL.indexOf(snap.run.status) >= 0;
    const r = lock ? lock : !snap.run ? "Start a run first." : terminal ? "The run has finished (" + snap.run.status + "); a change now has no visible effect. Start another run."
      : !draft ? "The run has no ERP draft yet. It writes one at PERSIST_DRAFT, after approval." : "";
    HXUI.set_disabled(T.modify, !!r, r);
    HXUI.set_disabled(T.tamper, !!r, r);
    T.erp_note.replaceChildren(r ? r : h("span", null, "Acts on draft ", code(draft), " of ", code(snap.run.run_id), " at ", code(snap.cp.state_id), ". ",
      snap.cp.state_id === "END_VERIFIED_DRAFT" ? "Modify now, then Step, to see Python test A25: terminal admission denied."
        : "Tamper, then Step, for Python test A28 (ends unverified). For A25, Step to END_VERIFIED_DRAFT first, then Modify."));
    for (const a of ["faults", "policy", "erp"]) result_view(a);
  }

  /* ---------------------------------------------------------------- sticky strip and focus */
  /* While the summary strip is sticky (wide workbench), focus and anchor scrolling must stop below it, never under
     it (WCAG 2.4.11): the page's scroll-padding-top follows the strip's height. Narrow screens keep the section
     strip's padding from 01_base.css. */
  let strip_observer = null;
  function sync_scroll_pad() {
    const root = document.documentElement;
    const sum = P && P.root ? P.root.querySelector(".rn-summary") : null;
    let on = false, px = 0;
    if (sum && sum.isConnected && !sum.closest("[hidden]")) {
      try { on = getComputedStyle(sum).position === "sticky"; } catch (e) { on = false; }
      if (on) {
        const top = parseFloat(getComputedStyle(sum).top) || 0;
        px = Math.ceil(top + sum.getBoundingClientRect().height + 8);
      }
    }
    if (on && px > 8) { root.style.setProperty("scroll-padding-top", px + "px"); root.dataset.rnPad = String(px); }
    else if (root.dataset.rnPad) { root.style.removeProperty("scroll-padding-top"); delete root.dataset.rnPad; }
  }
  function watch_strip() {
    if (strip_observer) { strip_observer.disconnect(); strip_observer = null; }
    const sum = P && P.root ? P.root.querySelector(".rn-summary") : null;
    if (sum && typeof ResizeObserver === "function") {
      strip_observer = new ResizeObserver(() => sync_scroll_pad());
      strip_observer.observe(sum);
    }
    sync_scroll_pad();
  }
  HXUI.bus.on("section:shown", () => sync_scroll_pad());

  /* ---------------------------------------------------------------- render */
  function render(el) {
    S.human_key = null;
    /* the old graph view observes the old workbench: release it with the old tree */
    if (S.view) { try { S.view.destroy(); } catch (e) { /* gone */ } S.view = null; S.view_hash = null; }
    result_boxes = {};
    const start = build_start();
    const runs = build_runs();
    const drive = build_drive();
    const graph_box = h("div", { class: "rn-graph", id: "rn-graph" });
    const graph_hash = h("div", { class: "hx-panel-meta rn-graph-hash" });
    const human = h("div", { class: "rn-human-slot", id: "rn-human", hidden: true });
    const outcome = h("section", { class: "hx-card rn-outcome", id: "rn-outcome", "aria-labelledby": "rn-outcome-title", hidden: true });
    P = {
      start, runs, drive, graph_box, graph_hash, human, outcome,
      results: { start: start.result, drive: drive.result, human: P_results_box("human") },
    };
    P.trouble = build_trouble();
    P.results.faults = P_results_box("faults");
    P.results.policy = P_results_box("policy");
    P.results.erp = P_results_box("erp");
    const insp = HXUI.run_inspector.create("rn-insp");
    P.insp = insp;
    /* the controls run across the top; the graph takes the full width so its full drawing (guards and tool names)
       fits; the approval or input card comes before the graph and the outcome after it, or both sit beside the
       graph when the workbench is wide enough for the two */
    const work = h("section", { class: "hx-panel rn-panel", "aria-labelledby": "rn-work-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "rn-work-title" }, "Workbench"), graph_hash),
      drive.panel,
      h("div", { class: "rn-work" },
        h("div", { class: "rn-work-graph" }, graph_box), human, outcome));
    const inspector = h("section", { class: "hx-panel rn-panel", "aria-labelledby": "rn-insp-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "rn-insp-title" }, "Inspector"),
        h("div", { class: "hx-panel-meta", id: "rn-insp-meta" })),
      insp.el);
    const root = h("div", { class: "rn", id: "rn" },
      build_summary(),
      h("div", { class: "rn-body hx-ruled" }, start.panel, work, inspector, P.trouble.panel, runs.panel));
    el.replaceChildren(root);
    P.root = root;
    refresh();
    watch_strip();
  }

  let painting = false;
  function refresh() {
    if (!P || !P.root || !P.root.isConnected || painting) return;
    painting = true;
    const had_focus = document.activeElement && P.root.contains(document.activeElement) ? document.activeElement : null;
    const had_id = had_focus ? had_focus.id : "";
    try {
      let snap;
      try { snap = snapshot(); } catch (err) {
        snap = { env: env_now(), run: null };
        set_result("drive", error_notice(err));
      }
      P.last_snap = snap;
      P.root.dataset.status = snap.run ? snap.run.status : "idle";
      P.root.dataset.run = snap.run ? snap.run.run_id : "";
      P.root.dataset.crash = S.crash ? S.crash.point : "";
      paint_summary(snap);
      paint_start(snap);
      paint_runs(snap);
      paint_graph(snap);
      paint_drive(snap);
      paint_human(snap);
      paint_outcome(snap);
      paint_trouble(snap);
      P.insp.update(snap.run ? snap : null);
      document.getElementById("rn-insp-meta").replaceChildren(...(snap.run ? [h("span", { class: "hx-mono rn-insp-run" }, snap.run.run_id)] : []));
      const st = snap.run ? snap.run.run_id + " " + snap.run.status + " " + snap.cp.state_id : null;
      if (st && st !== S.last_status) {
        const prev = S.last_status;
        S.last_status = st;
        if (prev !== null || snap.run) HXUI.announce("Run " + snap.run.run_id + ": " + (STATUS_TEXT[snap.run.status] || snap.run.status) + " at " + snap.cp.state_id + ".");
      }
      /* a control that went away with the step (an answered approval, a crash notice) hands focus to the next action */
      if (had_focus && !had_focus.isConnected) {
        /* the same control rebuilt (a runs-list button, a tab control) keeps focus; otherwise the next action gets it */
        const same = had_id ? document.getElementById(had_id) : null;
        const next = same && P.root.contains(same) ? same
          : [P.drive.until, P.drive.step, P.start.start].find((b) => b && !HXUI.is_disabled(b)) || P.drive.restart;
        try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); }
      }
    } finally {
      painting = false;
    }
  }

  HXUI.bus.on("lab:changed", () => {
    /* a crash belongs to one worker: another env (a tour mirroring its own) has no crashed worker */
    if (S.crash && S.crash.env && HXUI.lab.env !== S.crash.env) S.crash = null;
    refresh();
  });
  HXUI.bus.on("lab:reset", () => {
    if (S.view) { try { S.view.destroy(); } catch (e) { /* gone */ } }
    S = fresh_state();
    base_cache = null;
    if (P && P.root && P.root.isConnected) render(P.root.parentNode);
  });

  HXUI.run_workbench = {
    /** the snapshot the screen shows now (for the tour and tests) */
    snapshot: () => (P && P.last_snap) || null,
    refresh,
    select_run,
  };

  HXUI.register_section({
    id: "run",
    title: "Run workbench",
    nav: "Run",
    summary: "Drive runs through approvals, faults and recovery",
    needs: NEEDS,
    about: ABOUT,
    mount(el) { render(el); },
    on_show() { refresh(); },
  });
})();
