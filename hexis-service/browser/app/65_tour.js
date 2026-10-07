/* HEXIS Runtime Lab: guided tour (HXUI.tour). The Overview's "Start guided demo" calls HXUI.tour.start().
   The tour drives HX.demo.create() (the port of the CLI demo, procurement_demo.run_demo) one step at a time. After
   each step it shows the step's narration lines with a plain-language account built from the step's live facts,
   mirrors the demo's environment into the lab (HXUI.lab.env = d.ctx.env, plus the demo's runs and packages), and
   moves to the section where the step's effect is visible. The guide panel sits above every section until the
   demo ends, with Next, Back to overview and End demo.

   The tour and the sections share one env. Before each step the tour compares what the last step left (the demo's
   runs: status and checkpoint revision; the approval request; ERP drafts; the clock; the active version; which env
   the lab shows) with the env now. If the viewer changed any of it from another section, the tour stops in a
   designed "changed outside the tour" state with "Run the demo again", instead of narrating events that did not
   happen.

   Determinism: the demo uses the goldens' clock (1790000000.25), sequential ids and a 0.125 s counter timer, so its
   lines equal the Python CLI's output; the final summary says so when the golden sample is embedded.

   Chip rule: a status chip takes the tone of the value itself (ok: finished well; warn: waiting or needs review;
   neutral: a refusal, exclusion or unchanged state; crit: a run that failed). Where a step demonstrates a safeguard,
   a second chip says whether it held: "As expected" (ok) or "Not expected" (crit).

   DOM contract: #tour[data-step][data-status] (status: running | ready | done | error | changed | unavailable),
   #tour-title, #tour-counter, #tour-next, #tour-back, #tour-end, #tour-restart, #tour-expand, ol#tour-lines,
   li.tour-dot[data-state=todo|current|done|failed], #tour-summary with #tour-sum-<key>[data-value].
   API: HXUI.tour = {NEEDS, start(), next(), end(), active(), demo(), status()}.
   Bus: "tour:step" {id, index, status}, "tour:learn" {step, proposal, admission, gates, refined_hash, shortcut,
   active_after} (also appended to HXUI.lab.log as {source: "tour", ...}), "tour:end" {}. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline" }, String(t));

  const NEEDS = ["demo", "env", "service", "registry", "update", "reference", "traces", "normalize", "replay", "compile"];
  /* demo step id -> the section that shows its effect, and the Overview step it belongs to */
  const PLACE = { "1": ["compile", 1], "2": ["run", 2], "3": ["run", 3], "4": ["run", 4], "5": ["run", 5], "6a": ["learn", 6], "6b": ["learn", 6] };
  /* One name per step everywhere (the Overview's list, this guide's heading, its Next button and announcements). The
     command-line heading appears only inside "Engine output". 10_overview.js publishes the same names as
     HXUI.demo_titles; these are the fallback when the Overview is not in the build. */
  const SHORT = { "1": "Compile the skill", "2": "Run a clean intake", "3": "Restart the worker; self-approval is refused",
    "4": "Approve, then the ERP times out after committing", "5": "Read the evidence-linked record",
    "6a": "Learn from a missing-documents trace", "6b": "Refuse a shortcut trace" };
  const title_of = (id, fallback) => (HXUI.demo_titles && HXUI.demo_titles[id]) || SHORT[id] || fallback || "";
  /* the Overview counts six steps; the demo's 6a and 6b are the two parts of step 6 */
  const STEP_COUNT = 6;
  const step_no = (id) => String(id || "").replace(/[ab]$/, "");
  const part_of = (id) => (/[ab]$/.test(String(id || "")) ? String(id).slice(-1) : "");
  /** "Step 3 of 6" or "Step 6 of 6, part a" */
  const step_label = (id) => "Step " + step_no(id) + " of " + STEP_COUNT + (part_of(id) ? ", part " + part_of(id) : "");
  const SECTION_NAMES = { compile: "Compile", run: "Run workbench", learn: "Learn from traces", overview: "Overview" };
  const GATE_LABELS = { policy_non_widening: "Policy not widened", static_validation: "Static validation", new_trace_replay: "New trace replays",
    protected_replay: "Protected traces replay", negative_corpus: "Negative corpus" };
  /* error codes of a refusal that comes from the approval rules (role or separation of duties) */
  const AUTH_CODES = ["NOT_AUTHORIZED", "SEPARATION_OF_DUTIES", "SOD_VIOLATION", "SELF_APPROVAL"];
  const PLAIN_ERRORS = {
    ALREADY_ANSWERED: "The engine refused the next call because the approval was already answered.",
    NOT_AUTHORIZED: "The engine refused the next call because the principal is not allowed to make it.",
    SCOPE_MISMATCH: "The engine refused the approval because its scope no longer matches the pending write.",
    REVISION_CONFLICT: "The engine refused to save the run because another change saved it first.",
    RUN_NOT_WAITING: "The engine refused the next call because the run is no longer waiting for it.",
    LEASE_HELD: "The engine refused the next call because another worker holds the run.",
  };

  let T = null; /* {demo, status, error, change, fp, parts, expanded} */

  function reduced_motion() {
    try { return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return true; }
  }
  function wide() {
    try { return globalThis.matchMedia("(min-width: 900px)").matches; } catch (e) { return true; }
  }
  function pb() { return globalThis.HX && HX.data && HX.data.python_build ? HX.data.python_build : {}; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function short_hash(x) { return String(x || "").slice(0, 23) + "…"; }
  function first_code(text) { const m = /^([A-Z][A-Z0-9_]+)\b/.exec(String(text || "")); return m ? m[1] : ""; }

  /* ---------------------------------------------------------------- lab mirror */
  function mirror(d, step_id) {
    const c = d.ctx;
    const lab = HXUI.lab;
    if (!c.env) return;
    lab.env = c.env;
    if (c.pkg) lab.packages.initial = c.pkg;
    if (c.refined && c.adm2 && c.adm2.status === "ADMITTED") lab.packages.refined = c.refined;
    const runs = [];
    const add = (id, title, hash, machine) => { if (id) runs.push({ run_id: id, tenant_id: "acme", scenario: "tour", title, initiator: "user:alice", artifact_hash: hash, machine }); };
    add(c.run_ids.main, "Guided demo: clean intake", c.pkg && c.pkg.artifact_hash, "initial");
    add(c.run_ids.conflict, "Guided demo: registry conflict", c.pkg && c.pkg.artifact_hash, "initial");
    add(c.run_ids.refined, "Guided demo: missing documents, refined machine", c.refined && c.refined.artifact_hash, "refined");
    lab.runs = runs;
    const focus = { "2": "main", "3": "main", "4": "main", "5": "main", "6a": "refined", "6b": "refined" }[step_id];
    if (focus && c.run_ids[focus]) lab.selected_run = c.run_ids[focus];
    HXUI.lab_changed("env");
  }

  /** publish the learning results, so Learn from traces (or anything else) can show what the tour did */
  function publish_learn(d, r) {
    const c = d.ctx;
    const payload = r.id === "6a"
      ? { step: "6a", proposal: r.facts.proposal, admission: r.facts.admission, gates: Object.assign({}, r.facts.gates), refined_hash: r.facts.refined_hash,
        parent_hash: r.facts.parent_hash, prop: c.prop || null, adm: c.adm2 || null }
      : { step: "6b", shortcut: { eligibility: r.facts.eligibility, static_gate_passed: r.facts.static_gate_passed,
        negative_gate_passed: r.facts.negative_gate_passed }, active_after: r.facts.active_after.slice(), active_unchanged: r.facts.active_unchanged };
    try { if (Array.isArray(HXUI.lab.log)) HXUI.lab.log.push(Object.assign({ source: "tour", kind: "learn" }, payload)); } catch (e) { /* the log is optional */ }
    HXUI.bus.emit("tour:learn", payload);
  }

  /* ---------------------------------------------------------------- change detection */
  /** what the tour narrates about the shared env, as plain data */
  function fingerprint(d) {
    const c = d.ctx;
    const env = c.env;
    if (!env) return null;
    const fp = { lab_env: HXUI.lab.env === env, clock: null, runs: {}, run_count: null, ix: null, erp: null, active: null };
    try { fp.clock = env.clock(); } catch (e) { /* no clock */ }
    try { fp.run_count = env.store.list_runs("acme").length; } catch (e) { /* no store */ }
    for (const k of Object.keys(c.run_ids)) {
      const id = c.run_ids[k];
      try {
        const run = env.store.get_run("acme", id);
        const cp = env.store.latest_checkpoint("acme", id);
        fp.runs[k] = run ? { id, status: run.status, revision: cp ? cp.revision : null, cancel: !!run.cancel_requested } : { id, status: "missing", revision: null, cancel: false };
      } catch (e) { fp.runs[k] = { id, status: "unreadable", revision: null, cancel: false }; }
    }
    try { if (c.ix) { const ix = env.store.interaction("acme", c.ix.interaction_id); fp.ix = ix ? JSON.stringify(ix) : "missing"; } } catch (e) { fp.ix = "unreadable"; }
    try { fp.erp = env.erp.count("acme"); } catch (e) { /* no ERP */ }
    try { if (c.pkg) fp.active = JSON.stringify(env.store.get_active("sandbox", c.pkg.machine.skill_id)); } catch (e) { /* none */ }
    return fp;
  }

  /** the differences between what the last step left and now, as sentences (empty: nothing changed) */
  function changes(was, now) {
    if (!was || !now) return [];
    const out = [];
    if (!now.lab_env) out.push({ run: false, text: "The lab now shows a different environment (a worker restart or a lab reset replaced it)." });
    for (const k of Object.keys(was.runs)) {
      const a = was.runs[k], b = now.runs[k] || { status: "missing" };
      if (a.status !== b.status || a.revision !== b.revision || a.cancel !== b.cancel) {
        out.push({ run: true, text: ["Run ", code(a.id), " was ", code(a.status), " at revision " + a.revision + "; it is now ", code(b.status),
          b.revision !== null && b.revision !== undefined ? " at revision " + b.revision : "", b.cancel && !a.cancel ? ", with a cancel requested" : "", "."] });
      }
    }
    if (was.ix !== now.ix) out.push({ run: true, text: "The run's approval request was answered or changed." });
    if (was.run_count !== now.run_count) out.push({ run: true, text: plural((now.run_count || 0) - (was.run_count || 0), "new run was", "new runs were") + " started in the demo's environment." });
    if (was.erp !== now.erp) out.push({ run: true, text: "The fake ERP holds " + plural(now.erp, "draft", "drafts") + "; the tour left " + was.erp + "." });
    if (was.clock !== now.clock) out.push({ run: false, text: "The clock moved by " + Math.round((now.clock - was.clock) / 60) + " minutes." });
    if (was.active !== now.active) out.push({ run: false, text: "The active version of the skill changed." });
    return out;
  }

  /** true when the env still matches what the last step left; otherwise switch to the "changed" state */
  function check_in_sync() {
    if (!T || !T.fp || T.status !== "ready") return true;
    const diff = changes(T.fp, fingerprint(T.demo));
    if (!diff.length) return true;
    T.status = "changed";
    T.change = diff;
    paint();
    mark_overview();
    HXUI.announce("The guided demo paused: the demo's environment changed outside the tour.");
    HXUI.bus.emit("tour:step", { id: last_id(), index: T.demo.results.length - 1, status: T.status });
    return false;
  }

  /* ---------------------------------------------------------------- Overview marks */
  function last_id() { const rs = T ? T.demo.results : []; return rs.length ? rs[rs.length - 1].id : null; }

  function mark_overview() {
    /* the Overview's step list carries data-status idle | active | done for the tour, plus a visible text mark
       (a "Done" or "Current" chip) and aria-current on the current step, so the state never relies on color */
    const id = last_id();
    const shown = !T || T.status === "ended" ? 0 : id ? PLACE[id][1] : 1;
    const running = T && T.status !== "ended";
    for (let n = 1; n <= 6; n++) {
      const li = document.getElementById("ov-step-" + n);
      if (!li) continue;
      const st = !running ? "idle" : T.status === "done" || n < shown ? "done" : n === shown ? "active" : "idle";
      li.dataset.status = st;
      if (st === "active") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
      const title = li.querySelector(".ov-step-title");
      const old = li.querySelector(".tour-ov-mark");
      if (old) old.remove();
      if (title && st !== "idle") {
        title.appendChild(h("span", { class: "tour-ov-mark" }, " ",
          st === "done" ? HXUI.chip("Done", "ok", { icon: "check" }) : HXUI.chip("Current", "accent", { icon: "arrow" })));
      }
    }
    const btn = document.getElementById("ov-demo-start");
    const label = btn && btn.querySelector(".hx-btn-label");
    if (label) {
      if (label.dataset.tourOriginal === undefined) label.dataset.tourOriginal = label.textContent;
      label.textContent = !running ? label.dataset.tourOriginal : T.status === "done" ? "Show the demo's summary" : "Continue guided demo";
      if (!running) delete label.dataset.tourOriginal;
    }
  }

  /* ---------------------------------------------------------------- chips */
  const STATUS_TONE = { COMPLETED: "ok", ADMITTED: "ok", CANDIDATE: "ok", VALIDATED: "ok", END_VERIFIED_DRAFT: "ok", ENROLLED: "ok",
    WAITING_FOR_APPROVAL: "warn", WAITING_FOR_INPUT: "warn", END_UNVERIFIED: "warn", END_REVIEW: "warn", CONFLICT: "warn",
    FAILED: "crit",
    REFUSED: "neutral", ALLOWED: "neutral", EXCLUDED: "neutral", REJECTED: "neutral", DENY: "neutral", ALLOW: "neutral",
    UNCHANGED: "neutral", CHANGED: "neutral", "NOT PASSED": "neutral", PASSED: "neutral" };
  /** a status value, toned by the value itself. The one chip rule (HXUI.status_chip): engine status values read as
      words ("Waiting for approval", "Candidate"), with the engine's value in the tooltip; state ids stay mono. */
  const chip = (t) => {
    const v = String(t === null || t === undefined ? "NONE" : t).toUpperCase();
    if (/^END_/.test(v)) return HXUI.chip(v, STATUS_TONE[v] || "neutral", { mono: true, title: "Terminal state" });
    return HXUI.status_chip ? HXUI.status_chip(v, STATUS_TONE[v] || "neutral") : HXUI.chip(v, STATUS_TONE[v] || "neutral");
  };
  /** did the safeguard hold */
  const expect = (held) => (held ? HXUI.chip("As expected", "ok", { icon: "check" }) : HXUI.chip("Not expected", "crit", { icon: "cross" }));
  function parity(value, expected, label) {
    if (!expected) return null;
    return value === expected ? HXUI.chip("Equals the Python build", "ok", { icon: "check", title: label })
      : HXUI.chip("Differs from the Python build", "crit", { icon: "cross", title: label });
  }
  function fact(label, value) { return h("div", { class: "tour-fact" }, h("dt", null, label), h("dd", null, value)); }

  function self_approval(f) {
    const c = first_code(f.detail);
    return { refused: !!f.self_approval_refused, code: c, by_rule: !!f.self_approval_refused && AUTH_CODES.indexOf(c) >= 0 };
  }
  function failing_gates(gates) { return Object.keys(gates || {}).filter((g) => !gates[g]); }
  function gate_names(list) { return list.map((g) => (GATE_LABELS[g] || g.replace(/_/g, " ")).toLowerCase()).join(", "); }

  /* ---------------------------------------------------------------- copy per step (from live facts) */
  function copy_for(r) {
    const f = r.facts;
    switch (r.id) {
      case "1": {
        const first = f.attempts[0];
        const ordering = first && first.codes.indexOf("ORDERING_VIOLATION") >= 0;
        const sent_back = f.attempts.length > 1;
        return {
          what: ["The fixture compiler drafted the machine from ", code("SKILL.md"), " in " + plural(f.attempts.length, "attempt", "attempts") + ". ",
            f.attempts.map((a, i) => [i ? "; " : "", (i ? "attempt " : "Attempt ") + a.attempt + " was " + a.status, a.codes.length ? [" (", a.codes.map((x, j) => [j ? ", " : "", code(x)]), ")"] : ""]),
            ". ", f.admission === "ADMITTED" ? ["Then ", code("user:dana"), " admitted the validated package."] : ["The admission by ", code("user:dana"), " ended ", code(f.admission), "."]],
          why: ["Nothing runs until the machine passes the static gates and an administrator admits that exact hash. ",
            ordering ? "The first draft wrote to the ERP before validating, so the validator sent it back."
              : sent_back ? ["The first draft had findings (", first.codes.join(", ") || "none listed", "), so the validator sent it back."]
                : "The first draft passed the validator."],
          facts: [fact("Artifact", [HXUI.digest(f.artifact_hash, { short: 19, label: "artifact hash", id: "tour-hash-initial" }), parity(f.artifact_hash, pb().initial_artifact_hash, "initial artifact hash")]),
            fact("Compile", chip(f.compile_status)), fact("Admission", [chip(f.admission), " archive v" + f.archive_version])],
        };
      }
      case "2": return {
        what: ["Run ", code(f.run_id), " read the documents, looked up the supplier, extracted a draft and validated it with one bounded repair. Then it paused at ", code(f.status), "."],
        why: ["The approval request binds the exact write: tool ", code(f.tool), " with arguments digest ", code(f.args_digest.slice(0, 19) + "…"), ". Nothing has been written to the ERP yet."],
        facts: [fact("Status", chip(f.status)), fact("Scope digest", HXUI.digest(f.scope_digest, { short: 19, label: "approval scope digest", id: "tour-scope" }))],
      };
      case "3": {
        const sa = self_approval(f);
        return {
          what: ["The worker process restarted and resumed the run from its stored checkpoint. The initiator, ", code("user:alice"), ", then tried to approve her own run. ",
            !sa.refused ? "The service did not refuse it." : sa.by_rule ? ["The service refused it with ", code(sa.code || first_code(f.detail) || "a refusal"), ": ", h("span", { class: "tour-msg" }, String(f.detail || "").replace(/^[A-Z][A-Z0-9_]+:\s*/, ""))]
              : ["The service refused it for a reason unrelated to the approval rules: ", code(sa.code || "?"), " ", h("span", { class: "tour-msg" }, String(f.detail || "").replace(/^[A-Z][A-Z0-9_]+:\s*/, ""))],
            sa.by_rule ? ". The run keeps waiting for an approval by an eligible principal; " : ". ", sa.by_rule ? [code("user:bob"), " approves it in step 4."] : ""],
          why: ["Approval is a separate identity's decision. Checked on its own, the separation-of-duties rule returns ", code(f.sod_outcome), f.sod_reasons.length ? [" (", f.sod_reasons.join("; "), ")"] : "", "."],
          facts: [fact("Self-approval", [chip(!sa.refused ? "ALLOWED" : sa.by_rule ? "REFUSED" : sa.code || "REFUSED"), expect(sa.by_rule)]),
            fact("Separation of duties", [chip(f.sod_outcome), expect(f.sod_outcome === "DENY")])],
        };
      }
      case "4": return {
        what: [code("user:bob"), " approved the exact scope. ", f.fault_injected ? "The fake ERP committed the draft, then the call timed out, so the effect was unknown. " : "No fault was injected. ",
          "The run continued to ", code(f.status), (f.reconciliation_events.length ? [" after ", f.reconciliation_events.map((x, i) => [i ? " then " : "", code(x)])] : ""), "."],
        why: [f.reconciliation_events.length ? "The broker never retries a write blindly. It reconciled the uncertain call by its idempotency key, so the ERP holds "
          : "The broker records every write by its idempotency key. The ERP holds ",
        f.erp_drafts === 1 ? "exactly one draft." : plural(f.erp_drafts, "draft", "drafts") + "."],
        facts: [fact("ERP drafts", [HXUI.chip(plural(f.erp_drafts, "draft", "drafts"), "neutral", { mono: true }), expect(f.erp_drafts === 1)]), fact("Status", chip(f.status))],
      };
      case "5": return {
        what: ["The run ended ", code(f.status), " at ", code(String(f.terminal)), ". A second run for supplier ", code("SUP-55555"), " hit a registry conflict and ended at ",
          code(f.conflict_terminal), " (" + f.conflict_category + "). ", plural(f.protected_trace_ids.length, "run trace was", "run traces were"), " enrolled into the protected archive."],
        why: ["Success is claimed only for what the evidence covers: ", h("q", null, f.verification_scope), " Every later machine must replay the protected traces."],
        facts: [fact("Outcome", chip(f.terminal)), fact("Archive", [chip(f.enrollment), " v" + f.archive_version]), fact("Protected traces", HXUI.chip(String(f.protected_trace_ids.length), "neutral", { mono: true }))],
      };
      case "6a": {
        const bad = failing_gates(f.gates);
        return {
          what: ["A development trace where documents were missing produced a refined machine that asks for input once. The proposal is ", code(f.proposal), " and ",
            bad.length ? ["these gates failed: ", gate_names(bad)] : "every gate passed", ". Admission uses a compare-and-swap: the candidate is admitted only if the active version is still its expected parent. The result is ", code(f.admission), ". A live run on the refined machine paused at ",
            code(f.refined_first_status), ", took the documents and the approval, and ended at ", code(f.refined_terminal), "."],
          why: "Machines learn from traces only through the same gates: policy is not widened, validation passes, the new trace replays and every protected trace still replays.",
          facts: [fact("Refined", [HXUI.digest(f.refined_hash, { short: 19, label: "refined artifact hash", id: "tour-hash-refined" }), parity(f.refined_hash, pb().refined_artifact_hash, "refined artifact hash")]),
            fact("Gates", Object.keys(f.gates).map((g) => HXUI.chip(GATE_LABELS[g] || g.replace(/_/g, " "), f.gates[g] ? "ok" : "crit", { icon: f.gates[g] ? "check" : "cross", title: f.gates[g] ? "passed" : "failed" }))),
            fact("Admission", chip(f.admission))],
        };
      }
      case "6b": {
        const v0 = f.violations && f.violations[0];
        const path = v0 && Array.isArray(v0.path) ? v0.path : [];
        const after = Array.isArray(f.active_after) ? f.active_after : [null, null];
        return {
          what: ["A trace that went from repair straight to approval, skipping re-validation, is ", code(f.eligibility), " as a learning source. The candidate built from it ",
            f.static_gate_passed ? "passes the static gate" : ["fails the static gate", path.length ? [": ", h("span", { class: "tour-path" }, path.map((s, i) => [i ? " → " : "", code(s)]))] : ""],
            ", and ", f.negative_gate_passed ? "passes" : "fails", " the negative-corpus gate."],
          why: [f.active_unchanged ? "The active version did not change: " : "The active version changed, which it should not have: ",
            code(short_hash(after[0])), ", archive v" + after[1] + ". The rejected candidate was never submitted for admission."],
          facts: [fact("Eligibility", [chip(f.eligibility), expect(f.eligibility === "EXCLUDED")]),
            fact("Static gate", [chip(f.static_gate_passed ? "PASSED" : "NOT PASSED"), expect(!f.static_gate_passed)]),
            fact("Active version", [chip(f.active_unchanged ? "UNCHANGED" : "CHANGED"), expect(!!f.active_unchanged)])],
        };
      }
      default: return { what: [], why: "", facts: [] };
    }
  }

  /** where the step's effect is visible, saying only what that section really shows */
  function where_for(r, d) {
    const sec = PLACE[r.id][0];
    const link = h("a", { class: "hx-link", href: "#" + sec }, SECTION_NAMES[sec]);
    if (sec === "run") return ["Shown in ", link, " with the run selected."];
    if (sec === "compile") return ["Shown in ", link, "."];
    const n = (d.ctx.protected || []).length;
    return [link, " shows this result as its last proposal, labelled as coming from the guided demo, with the refined machine as the active version and ",
      plural(n, "protected trace", "protected traces"), " in the archive. Its own tools run against the machine that is active now."];
  }

  /* ---------------------------------------------------------------- final summary */
  function lines_match(d) {
    const g = HXUI.checks && HXUI.checks.embed ? HXUI.checks.embed() : null;
    if (!g || !g.demo || g.demo.scenario !== d.scenario) return null;
    const want = g.demo.lines.map((l) => (/^== done\. Artifacts in .*\/ ==$/.test(l) ? "== done ==" : l));
    return want.length === d.lines.length && want.every((l, i) => l === d.lines[i]);
  }

  function summary_el(d) {
    const s = d.summary.steps;
    const f6a = d.results[5].facts, f6b = d.results[6].facts, f4 = d.results[3].facts, f3 = d.results[2].facts;
    const sa = self_approval(f3);
    const bad = failing_gates(f6a.gates);
    const sc = s.shortcut;
    const sc_note = sc.static_gate_passed && sc.negative_gate_passed ? "both gates passed"
      : !sc.static_gate_passed && !sc.negative_gate_passed ? "static and negative-corpus gates fail"
        : (sc.static_gate_passed ? "negative-corpus" : "static") + " gate fails";
    const rows = [
      ["compile", "Compile", [chip(s.compile.status)], plural(s.compile.attempts, "attempt", "attempts")],
      ["self-approval", "Self-approval", [chip(!sa.refused ? "ALLOWED" : sa.by_rule ? "REFUSED" : sa.code || "REFUSED"), expect(sa.by_rule)],
        !sa.refused ? "the initiator approved her own run" : sa.by_rule ? "the initiator cannot approve" : "refused for an unrelated reason"],
      ["run", "Clean intake", [chip(s.run.outcome ? s.run.outcome.terminal : s.run.status)], s.run.status.toLowerCase()],
      ["drafts", "ERP drafts", [HXUI.chip(plural(s.run.erp_drafts, "draft", "drafts"), "neutral", { mono: true }), expect(s.run.erp_drafts === 1)],
        f4.fault_injected ? "after a timeout after commit" : "no fault injected"],
      ["proposal", "Refinement proposal", [chip(s.refine.proposal)], bad.length ? "failed: " + gate_names(bad) : "every gate passed"],
      ["admission", "Refinement admission", [chip(s.refine.admission)], "compare-and-swap on the parent " + String(f6a.parent_hash || "").slice(7, 19)],
      ["shortcut", "Shortcut trace", [chip(sc.eligibility), expect(sc.eligibility === "EXCLUDED")], sc_note],
      ["active", "Active version", [chip(sc.active_unchanged ? "UNCHANGED" : "CHANGED"), expect(!!sc.active_unchanged)], short_hash(f6b.active_after[0])],
    ];
    const vals = { compile: s.compile.status, "self-approval": String(s.self_approval.refused), run: s.run.outcome ? s.run.outcome.terminal : s.run.status,
      drafts: String(s.run.erp_drafts), proposal: s.refine.proposal, admission: s.refine.admission, shortcut: sc.eligibility, active: String(sc.active_unchanged) };
    const match = lines_match(d);
    return h("section", { class: "tour-summary", id: "tour-summary", "aria-labelledby": "tour-summary-title" },
      h("h3", { class: "tour-summary-title", id: "tour-summary-title", tabindex: "-1" }, "What the demo showed"),
      h("dl", { class: "tour-sum-list" }, rows.map(([k, label, value, note]) =>
        h("div", { class: "tour-sum-row", id: "tour-sum-" + k, dataset: { value: vals[k] } },
          h("dt", null, label), h("dd", null, h("span", { class: "tour-sum-value" }, value), h("span", { class: "tour-sum-note" }, note))))),
      h("p", { class: "tour-sum-foot" },
        match === true ? [HXUI.chip("Narration matches the Python CLI", "ok", { icon: "check" }), " Every narration line equals the Python demo's output for the same clock and ids."]
          : match === false ? [HXUI.chip("Narration differs from the Python CLI", "crit", { icon: "cross" }), " Open Self-test and run check G15 to see the first difference."]
            : "The refined machine is now active in the lab.",
        " Run and Learn show the demo's runs. Refined hash ", code(short_hash(f6a.refined_hash)), "."));
  }

  /* ---------------------------------------------------------------- panel */
  function build_panel() {
    const progress = h("ol", { class: "tour-progress", "aria-label": "Demo steps" });
    const counter = h("p", { class: "tour-counter", id: "tour-counter" });
    const title = h("h2", { class: "tour-title", id: "tour-title", tabindex: "-1" });
    const body = h("div", { class: "tour-body" });
    const next = HXUI.button("Next", { id: "tour-next", variant: "primary", icon: "arrow", on_click: () => next_step() });
    const restart = HXUI.button("Run the demo again", { id: "tour-restart", variant: "primary", icon: "reset", on_click: () => restart_demo() });
    const expand = HXUI.button("Show summary", { id: "tour-expand", variant: "secondary", on_click: () => { if (T) { T.expanded = true; paint(); focus_id("tour-summary-title"); } } });
    const back = HXUI.button("Back to overview", { id: "tour-back", variant: "secondary", on_click: () => HXUI.go("overview", { focus: false }) });
    const end_btn = HXUI.button("End demo", { id: "tour-end", variant: "ghost", on_click: () => end(true) });
    restart.hidden = true;
    expand.hidden = true;
    const head = h("div", { class: "tour-head" },
      h("p", { class: "tour-label" }, HXUI.icon("play"), h("span", null, "Guided demo"), counter),
      progress);
    const panel = h("section", { class: "tour", id: "tour", "aria-labelledby": "tour-title", dataset: { status: "running", step: "" } },
      head, title, body,
      h("div", { class: "tour-actions" }, next, restart, expand, back, end_btn));
    return { panel, head, progress, counter, title, body, next, restart, expand, back, end_btn };
  }

  /** After a new step the narration starts at the top of the guide. When focus stays on Next (the viewer pressed it)
      and the taller panel pushed it off screen, focus the step's title instead, so a keyboard user starts reading
      the new step and never presses an invisible button. */
  function reveal_focus() {
    if (!T || !T.parts) return;
    const a = document.activeElement;
    if (!a || !T.parts.panel.contains(a)) return;
    const r = a.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= (globalThis.innerHeight || 0)) return;
    const title = T.parts.title;
    try { title.focus({ preventScroll: true }); } catch (e) { title.focus(); }
    try { title.scrollIntoView({ block: "nearest", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { title.scrollIntoView(); }
  }

  function focus_id(id) {
    const el = document.getElementById(id);
    if (el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
  }

  function paint_progress(d, idx) {
    const P = T.parts;
    const failed = T.status === "error" ? d.cursor : -1;
    const current = T.status === "running" ? idx + 1 : T.status === "ready" ? idx : -1;
    P.progress.replaceChildren(...d.steps.map((s, i) => {
      const state = i === failed ? "failed" : i === current ? "current" : T.status === "done" || i <= idx ? "done" : "todo";
      const word = { failed: " (failed)", current: T.status === "running" ? " (running)" : " (current)", done: " (done)", todo: "" }[state];
      const name = step_label(s.id).replace(/ of \d+/, "") + ": " + title_of(s.id, s.title);
      return h("li", { class: "tour-dot", dataset: { state }, title: name + word, "aria-current": i === current ? "step" : null },
        h("span", { class: "hx-visually-hidden" }, name + word),
        state === "done" ? HXUI.icon("check", { class: "tour-dot-icon" }) : state === "failed" ? HXUI.icon("cross", { class: "tour-dot-icon" }) : null,
        h("span", { "aria-hidden": "true" }, s.id));
    }));
  }

  function step_body(r, d, opts) {
    const c = copy_for(r);
    const lines = r.lines.filter((l) => !/^== /.test(l));
    return [
      h("p", { class: "tour-what" }, c.what),
      h("p", { class: "tour-why" }, h("strong", null, "Why it matters. "), c.why),
      h("dl", { class: "tour-facts" }, c.facts),
      h("details", { class: "tour-out", open: !!opts.open_output },
        h("summary", null, "Engine output, as the command-line demo prints it (" + plural(lines.length, "line", "lines") + ")"),
        h("p", { class: "tour-cli-title" }, h("span", { class: "hx-label" }, "CLI heading"), " ", r.title),
        h("ol", { class: "tour-lines", id: opts.ids ? "tour-lines" : null }, lines.map((l) => h("li", null, l.replace(/^ {3}/, ""))))),
      h("p", { class: "tour-where" }, where_for(r, d)),
    ];
  }

  function paint() {
    if (!T || !T.parts) return;
    try { paint_inner(); } catch (err) {
      if (T.status === "error" && T.error && T.error.render) throw err; /* the error state itself failed: let it surface */
      T.status = "error";
      T.error = { render: true, plain: "The step ran, but its account could not be shown: " + String((err && err.message) || err), detail: null };
      paint_inner();
    }
  }

  function paint_inner() {
    const d = T.demo;
    const P = T.parts;
    const idx = d.results.length - 1;
    const r = idx >= 0 ? d.results[idx] : null;
    const nxt = d.done ? null : d.steps[d.cursor];
    const sec = HXUI.current ? HXUI.current() : null;
    const collapsed = T.status === "done" && !T.expanded && sec !== PLACE["6b"][0];
    P.panel.dataset.status = T.status;
    P.panel.dataset.step = r ? r.id : "";
    P.panel.dataset.collapsed = collapsed ? "true" : "false";
    paint_progress(d, idx);
    const shown_id = T.status === "running" ? (nxt ? nxt.id : r ? r.id : "1") : r ? r.id : "1";
    P.counter.textContent = T.status === "done" ? "Finished, all " + STEP_COUNT + " steps"
      : T.status === "error" ? "Stopped at s" + step_label(nxt ? nxt.id : shown_id).slice(1)
        : T.status === "changed" ? "Paused after s" + step_label(r ? r.id : "1").slice(1)
          : step_label(shown_id);
    if (T.status === "error") {
      P.title.textContent = nxt ? "Step " + nxt.id + " failed: " + title_of(nxt.id, nxt.title) : "The step failed";
      const e = T.error || {};
      P.body.replaceChildren(HXUI.notice("crit", e.plain || "The engine raised an error while running this step.",
        [e.detail ? h("p", null, "Engine error: ", code(e.detail)) : null,
          h("p", null, "The lab keeps the state from the last good step. Run the demo again to start over from step 1 with a fresh environment.")]));
    } else if (T.status === "changed") {
      const runs = (T.change || []).some((x) => x.run);
      P.title.textContent = runs ? "You changed the demo's run in the workbench" : "The demo's environment changed outside the tour";
      P.body.replaceChildren(HXUI.notice("warn", "The tour stopped so it does not narrate events that did not happen.",
        [h("ul", { class: "tour-changes" }, (T.change || []).map((x) => h("li", null, x.text))),
          h("p", null, "The next steps assume the state step " + (r ? r.id : "1") + " left. Run the demo again to start over with a fresh environment; what you did in the workbench stays in the old one until then.")]));
    } else if (!r) {
      P.title.textContent = title_of(d.steps[0].id, d.steps[0].title);
      P.body.replaceChildren(h("p", { class: "tour-what" }, "Running the first step in this page…"));
    } else if (T.status === "done") {
      P.title.textContent = collapsed ? "Guided demo finished" : "The guided demo is finished";
      P.body.replaceChildren(...(collapsed ? [h("p", { class: "tour-what" }, "All " + STEP_COUNT + " steps ran (step 6 in two parts). The summary stays here until you end the demo.")]
        : [summary_el(d),
          h("details", { class: "tour-last" },
            h("summary", null, step_label(r.id) + ": " + title_of(r.id, r.title)),
            h("div", { class: "tour-body" }, step_body(r, d, { open_output: false, ids: true })))]));
    } else {
      P.title.textContent = title_of(r.id, r.title);
      P.body.replaceChildren(...step_body(r, d, { open_output: wide(), ids: true }));
    }
    const busy = T.status === "running";
    const stopped = T.status === "error" || T.status === "changed";
    P.next.hidden = T.status === "done" || stopped;
    P.restart.hidden = !(T.status === "done" || stopped);
    P.expand.hidden = !collapsed;
    P.restart.classList.toggle("hx-btn--primary", stopped);
    P.restart.classList.toggle("hx-btn--secondary", !stopped);
    P.next.querySelector(".hx-btn-label").textContent = busy ? "Working…" : nxt ? "Next: " + title_of(nxt.id, nxt.title) : "Next";
    HXUI.set_disabled(P.next, busy, "The engine is running this step.");
    /* Back to overview does nothing on the Overview itself */
    P.back.hidden = sec === "overview";
  }

  function show_place(step_id) {
    const sec = PLACE[step_id][0];
    if (HXUI.has_section(sec)) HXUI.go(sec, { focus: false });
    const panel = T && T.parts && T.parts.panel;
    if (panel && panel.getBoundingClientRect().top < 0) {
      try { panel.scrollIntoView({ block: "start", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { panel.scrollIntoView(); }
    }
  }

  function error_of(err) {
    const c = err && err.code !== undefined ? String(err.code) : "";
    const msg = String((err && (err.msg !== undefined ? err.msg : err.message)) || err);
    const name = !c && err && err.name ? err.name : "";
    return { plain: PLAIN_ERRORS[c] || "The engine raised an error while running this step, so the tour cannot continue.",
      detail: (c ? c + ": " : name ? name + ": " : "") + msg };
  }

  function run_next(after) {
    const tour = T;
    tour.status = "running";
    paint();
    setTimeout(() => {
      if (T !== tour) return;
      let r = null;
      try {
        r = tour.demo.next();
        mirror(tour.demo, r.id);
        /* what this step left in the shared env; the next step starts only if nothing changed it */
        tour.fp = fingerprint(tour.demo);
      } catch (err) {
        tour.status = "error";
        tour.error = error_of(err);
      }
      if (r) {
        /* still "running" while the section opens, so its own events are not taken for a change */
        show_place(r.id);
        if (r.id === "6a" || r.id === "6b") publish_learn(tour.demo, r);
        tour.status = tour.demo.done ? "done" : "ready";
      }
      paint();
      mark_overview();
      if (r && tour.status !== "error") {
        HXUI.announce("Guided demo, " + step_label(r.id).toLowerCase() + ": " + title_of(r.id, r.title) + (tour.status === "done" ? ". The demo is finished." : "."));
        HXUI.bus.emit("tour:step", { id: r.id, index: tour.demo.results.length - 1, status: tour.status });
      } else {
        HXUI.announce("The guided demo stopped: " + tour.parts.title.textContent + ".");
        HXUI.bus.emit("tour:step", { id: tour.demo.steps[tour.demo.cursor] ? tour.demo.steps[tour.demo.cursor].id : null, index: tour.demo.cursor, status: "error" });
      }
      if (tour.status === "error") focus_id("tour-restart");
      else if (typeof after === "function") after();
      else if (tour.status === "done") focus_id("tour-summary-title");
      else reveal_focus();
    }, 0);
  }

  function next_step() {
    if (!T || T.status !== "ready" || T.demo.done) return;
    if (!check_in_sync()) { focus_id("tour-restart"); return; }
    run_next();
  }

  function insert_panel(panel) {
    const main = document.getElementById("hx-main");
    if (main) main.insertBefore(panel, main.firstChild);
  }

  /** the designed "not in this build" state: the button never fails silently */
  function show_unavailable(missing) {
    end(false);
    const title = h("h2", { class: "tour-title", id: "tour-title", tabindex: "-1" }, "The guided demo is not in this build");
    const end_btn = HXUI.button("Close", { id: "tour-end", variant: "secondary", on_click: () => { panel.remove(); const b = document.getElementById("ov-demo-start"); if (b) b.focus(); } });
    const panel = h("section", { class: "tour", id: "tour", "aria-labelledby": "tour-title", dataset: { status: "unavailable", step: "" } },
      h("div", { class: "tour-head" }, h("p", { class: "tour-label" }, HXUI.icon("play"), h("span", null, "Guided demo"))),
      title,
      HXUI.unavailable(missing, { compact: true, lead: "The demo runs the whole engine in this page, and these modules are missing:" }),
      h("p", { class: "tour-where" }, "You can still do each step yourself in the section the Overview links to."),
      h("div", { class: "tour-actions" }, end_btn));
    const old = document.getElementById("tour");
    if (old) old.remove();
    insert_panel(panel);
    if (HXUI.current && HXUI.current() !== "overview" && HXUI.has_section("overview")) HXUI.go("overview", { focus: false });
    try { panel.scrollIntoView({ block: "start", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { panel.scrollIntoView(); }
    focus_id("tour-title");
    HXUI.announce("The guided demo needs engine modules that are not in this build: " + missing.join(", ") + ".");
  }

  function start() {
    const missing = HXUI.engine_missing(NEEDS);
    if (missing.length) { show_unavailable(missing); return false; }
    if (T) {
      /* already running: take the viewer back to the guide instead of discarding it */
      if (T.status === "done") T.expanded = true;
      paint();
      const panel = T.parts.panel;
      try { panel.scrollIntoView({ block: "start", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { panel.scrollIntoView(); }
      focus_id("tour-title");
      return true;
    }
    return begin();
  }

  function restart_demo() {
    end(false);
    begin();
  }

  function begin() {
    let n = 0;
    const demo = HX.demo.create({ scenario: "full", clock_start: HX.demo.CLOCK_START, ids: HX.env.make_seq_ids(1), timer: () => 0.125 * ++n });
    T = { demo, status: "running", error: null, change: null, fp: null, expanded: false, parts: build_panel() };
    insert_panel(T.parts.panel);
    run_next(() => focus_id("tour-title"));
    return true;
  }

  function end(user) {
    const stray = document.getElementById("tour");
    if (!T) { if (stray && stray.dataset.status === "unavailable") stray.remove(); return; }
    const had_focus = T.parts && T.parts.panel.contains(document.activeElement);
    if (T.parts && T.parts.panel.parentNode) T.parts.panel.parentNode.removeChild(T.parts.panel);
    T.status = "ended";
    mark_overview();
    T = null;
    HXUI.bus.emit("tour:end", {});
    if (user) {
      HXUI.announce("Guided demo ended. The lab keeps the demo's environment until you reset it.");
      if (had_focus) {
        const head = document.querySelector(".hx-section:not([hidden]) .hx-section-title");
        if (head) head.focus();
      }
    }
  }

  HXUI.bus.on("lab:reset", () => end(false));
  /* another section changed the shared env: stop before narrating something that did not happen */
  HXUI.bus.on("lab:changed", () => { if (T && T.status === "ready") check_in_sync(); });
  /* the Run workbench answers approvals and steps runs without a lab event: after any action outside the guide,
     look again (cheap: a few store reads), so the guide shows the change before the viewer presses Next */
  function after_action(e) {
    if (!T || T.status !== "ready" || !T.parts || (e && e.target && T.parts.panel.contains(e.target))) return;
    for (const ms of [30, 400]) setTimeout(() => { if (T && T.status === "ready") check_in_sync(); }, ms);
  }
  document.addEventListener("click", after_action, true);
  document.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") after_action(e); }, true);
  HXUI.bus.on("section:shown", (p) => {
    if (!T) return;
    /* repaint: the done bar collapses away from Learn, and Back to overview hides on the Overview */
    if (T.status === "ready") { if (check_in_sync()) paint(); }
    else if (T.status === "done") paint();
    if (p && p.id === "overview") mark_overview(); /* the Overview may have re-rendered its step list */
  });

  HXUI.tour = {
    NEEDS: NEEDS.slice(),
    start,
    next: next_step,
    end: () => end(true),
    active: () => !!T,
    /** the running demo (read-only), for tests */
    demo: () => (T ? T.demo : null),
    status: () => (T ? T.status : "idle"),
  };
})();
