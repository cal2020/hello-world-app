/* HEXIS Runtime Lab: guided tour (HXUI.tour). The Overview's "Start guided demo" calls HXUI.tour.start().
   The tour drives HX.demo.create() (the port of the CLI demo, procurement_demo.run_demo) one step at a time. After
   each step it shows the step's narration lines with a plain-language account built from the step's live facts,
   mirrors the demo's environment into the lab (HXUI.lab.env = d.ctx.env, plus the demo's runs and packages), and
   moves to the section where the step's effect is visible. The guide panel sits above every section until the
   demo ends, with Next, Back to overview and End demo.

   Determinism: the demo uses the goldens' clock (1790000000.25), sequential ids and a 0.125 s counter timer, so its
   lines equal the Python CLI's output; the final summary says so when the golden sample is embedded.

   DOM contract: #tour[data-step][data-status] (status: running | ready | done | error), #tour-title, #tour-next,
   #tour-back, #tour-end, #tour-restart, ol#tour-lines, #tour-summary with #tour-sum-<key>[data-value].
   API: HXUI.tour = {start(), next(), end(), active(), demo()}. Emits "tour:step" {id, index} on the bus. */
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
  const SHORT = { "1": "Compile the skill", "2": "Run a clean intake", "3": "Restart and approve", "4": "ERP timeout after commit",
    "5": "Evidence-linked record", "6a": "Learn from a trace", "6b": "Refuse a shortcut" };
  const SECTION_NAMES = { compile: "Compile", run: "Run workbench", learn: "Learn from traces", overview: "Overview" };

  let T = null; /* {demo, status, error, results, panel parts} */

  function reduced_motion() {
    try { return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return true; }
  }
  function pb() { return globalThis.HX && HX.data && HX.data.python_build ? HX.data.python_build : {}; }
  function list_text(xs) { return (xs || []).map(String).join(", "); }

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

  function mark_overview(index) {
    /* the Overview's step list carries data-status idle | active | done for the tour */
    const cur = index === null ? 0 : PLACE[T.demo.steps[index].id][1];
    for (let n = 1; n <= 6; n++) {
      const li = document.getElementById("ov-step-" + n);
      if (!li) continue;
      li.dataset.status = !T || T.status === "ended" ? "idle" : n < cur || (T.status === "done") ? "done" : n === cur ? "active" : "idle";
    }
  }

  /* ---------------------------------------------------------------- copy per step (from live facts) */
  function parity(value, expected, label) {
    if (!expected) return null;
    return value === expected ? HXUI.chip("Equals the Python build", "ok", { icon: "check", title: label })
      : HXUI.chip("Differs from the Python build", "crit", { icon: "cross", title: label });
  }
  function fact(label, value) { return h("div", { class: "tour-fact" }, h("dt", null, label), h("dd", null, value)); }
  const STATUS_TONE = { COMPLETED: "ok", ADMITTED: "ok", CANDIDATE: "ok", WAITING_FOR_APPROVAL: "warn", WAITING_FOR_INPUT: "warn",
    FAILED: "crit", REJECTED: "crit", EXCLUDED: "crit", CONFLICT: "warn", DENY: "crit", ALLOW: "ok",
    REFUSED: "ok", UNCHANGED: "ok", CHANGED: "crit", END_VERIFIED_DRAFT: "ok", END_UNVERIFIED: "warn", END_REVIEW: "warn", validated: "ok", PASSED: "ok" };
  const chip = (t) => HXUI.chip(String(t), STATUS_TONE[t] || "neutral", { mono: /^[A-Z_]+$/.test(String(t)) });

  function copy_for(r) {
    const f = r.facts;
    switch (r.id) {
      case "1": return {
        what: ["The fixture compiler drafted the machine from ", code("SKILL.md"), " in " + f.attempts.length + " attempts. ",
          f.attempts.map((a, i) => [i ? "; " : "", (i ? "attempt " : "Attempt ") + a.attempt + " was " + a.status, a.codes.length ? [" (", a.codes.map((x, j) => [j ? ", " : "", code(x)]), ")"] : ""]),
          ". Then ", code("user:dana"), " admitted the validated package."],
        why: "Nothing runs until the machine passes the static gates and an administrator admits that exact hash. The first draft wrote to the ERP before validating, so the validator sent it back.",
        facts: [fact("Artifact", [HXUI.digest(f.artifact_hash, { short: 19, label: "artifact hash", id: "tour-hash-initial" }), parity(f.artifact_hash, pb().initial_artifact_hash, "initial artifact hash")]),
          fact("Compile", chip(f.compile_status)), fact("Admission", [chip(f.admission), " archive v" + f.archive_version])],
      };
      case "2": return {
        what: ["Run ", code(f.run_id), " read the documents, looked up the supplier, extracted a draft and validated it with one bounded repair. Then it paused at ", code(f.status), "."],
        why: ["The approval request binds the exact write: tool ", code(f.tool), " with arguments digest ", code(f.args_digest.slice(0, 19) + "…"), ". Nothing has been written to the ERP yet."],
        facts: [fact("Status", chip(f.status)), fact("Scope digest", HXUI.digest(f.scope_digest, { short: 19, label: "approval scope digest", id: "tour-scope" }))],
      };
      case "3": return {
        what: ["The worker process restarted and resumed the run from its stored checkpoint. The initiator, ", code("user:alice"), ", then tried to approve her own run. ",
          f.self_approval_refused ? ["The service refused: ", code(f.detail || "")] : "The service did not refuse it.", "."],
        why: ["Approval is a separate identity's decision. In isolation, an approver acting on their own run gets ", code(f.sod_outcome), f.sod_reasons.length ? [" (", f.sod_reasons.join("; "), ")"] : "", "."],
        facts: [fact("Self-approval", chip(f.self_approval_refused ? "REFUSED" : "ALLOWED")), fact("Separation of duties", chip(f.sod_outcome))],
      };
      case "4": return {
        what: [code("user:bob"), " approved the exact scope. ", f.fault_injected ? "The fake ERP committed the draft, then the call timed out, so the effect was unknown. " : "No fault was injected. ",
          "The run continued to ", code(f.status), (f.reconciliation_events.length ? [" after ", f.reconciliation_events.map((x, i) => [i ? " then " : "", code(x)])] : ""), "."],
        why: "The broker never retries a write blindly. It reconciled the uncertain call by its idempotency key, so the ERP holds exactly one draft.",
        facts: [fact("ERP drafts", h("span", { class: "tour-num", id: "tour-drafts" }, String(f.erp_drafts))), fact("Status", chip(f.status))],
      };
      case "5": return {
        what: ["The run ended ", code(f.status), " at ", code(String(f.terminal)), ". A second run for supplier ", code("SUP-55555"), " hit a registry conflict and ended at ",
          code(f.conflict_terminal), " (" + f.conflict_category + "). Both run traces were enrolled into the protected archive."],
        why: ["Success is claimed only for what the evidence covers: ", h("q", null, f.verification_scope), " Every later machine must replay the protected traces."],
        facts: [fact("Outcome", chip(f.terminal)), fact("Archive", [chip(f.enrollment), " v" + f.archive_version]), fact("Protected traces", String(f.protected_trace_ids.length))],
      };
      case "6a": return {
        what: ["A development trace where documents were missing produced a refined machine that asks for input once. The proposal is ", code(f.proposal),
          " and every gate passed; the admission with a compare-and-set on the parent is ", code(f.admission), ". A live run on the refined machine paused at ",
          code(f.refined_first_status), ", took the documents and the approval, and ended at ", code(f.refined_terminal), "."],
        why: "Machines learn from traces only through the same gates: policy is not widened, validation passes, the new trace replays and every protected trace still replays.",
        facts: [fact("Refined", [HXUI.digest(f.refined_hash, { short: 19, label: "refined artifact hash", id: "tour-hash-refined" }), parity(f.refined_hash, pb().refined_artifact_hash, "refined artifact hash")]),
          fact("Gates", Object.keys(f.gates).map((g) => HXUI.chip(g.replace(/_/g, " "), f.gates[g] ? "ok" : "crit", { icon: f.gates[g] ? "check" : "cross" }))),
          fact("Admission", chip(f.admission))],
      };
      case "6b": return {
        what: ["A trace that went from repair straight to approval, skipping re-validation, is ", code(f.eligibility), " as a learning source. The candidate built from it fails the static gate",
          f.violations.length ? [": ", h("span", { class: "tour-path" }, f.violations[0].path.map((s, i) => [i ? " → " : "", code(s)]))] : "", "."],
        why: ["The active version did not change", f.active_unchanged ? "" : " (it should have)", ": ", code(f.active_after[0].slice(0, 23) + "…"), ", archive v" + f.active_after[1], ". The rejected candidate was never submitted for admission."],
        facts: [fact("Eligibility", chip(f.eligibility)), fact("Static gate", chip(f.static_gate_passed ? "PASSED" : "FAILED")), fact("Active version", chip(f.active_unchanged ? "UNCHANGED" : "CHANGED"))],
      };
      default: return { what: [], why: "", facts: [] };
    }
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
    const f6a = d.results[5].facts, f6b = d.results[6].facts, f4 = d.results[3].facts;
    const rows = [
      ["compile", "Compile", chip(s.compile.status), s.compile.attempts + " attempts"],
      ["self-approval", "Self-approval", chip(s.self_approval.refused ? "REFUSED" : "ALLOWED"), "the initiator cannot approve"],
      ["run", "Clean intake", chip(s.run.outcome ? s.run.outcome.terminal : s.run.status), s.run.status],
      ["drafts", "ERP drafts", h("span", { class: "tour-num" }, String(s.run.erp_drafts)), f4.fault_injected ? "after a timeout after commit" : "no fault injected"],
      ["proposal", "Refinement proposal", chip(s.refine.proposal), "every gate passed"],
      ["admission", "Refinement admission", chip(s.refine.admission), "compare-and-set on the parent"],
      ["shortcut", "Shortcut trace", chip(s.shortcut.eligibility), "static and negative-corpus gates fail"],
      ["active", "Active version", chip(s.shortcut.active_unchanged ? "UNCHANGED" : "CHANGED"), f6b.active_after[0].slice(0, 23) + "…"],
    ];
    const vals = { compile: s.compile.status, "self-approval": String(s.self_approval.refused), run: s.run.outcome ? s.run.outcome.terminal : s.run.status,
      drafts: String(s.run.erp_drafts), proposal: s.refine.proposal, admission: s.refine.admission, shortcut: s.shortcut.eligibility, active: String(s.shortcut.active_unchanged) };
    const match = lines_match(d);
    return h("section", { class: "tour-summary", id: "tour-summary", "aria-labelledby": "tour-summary-title" },
      h("h3", { class: "tour-summary-title", id: "tour-summary-title", tabindex: "-1" }, "What the demo showed"),
      h("dl", { class: "tour-sum-list" }, rows.map(([k, label, value, note]) =>
        h("div", { class: "tour-sum-row", id: "tour-sum-" + k, dataset: { value: vals[k] } },
          h("dt", null, label), h("dd", null, value, h("span", { class: "tour-sum-note" }, note))))),
      h("p", { class: "tour-sum-foot" },
        match === true ? [HXUI.chip("Lines equal the Python CLI", "ok", { icon: "check" }), " Every narration line above equals the Python demo's output for the same clock and ids."]
          : match === false ? [HXUI.chip("Lines differ from the Python CLI", "crit", { icon: "cross" }), " Open Self-test and run check G15 to see the first difference."]
            : "The refined machine is now active in the lab. Run and Learn show the demo's runs.",
        " Refined hash ", code(f6a.refined_hash.slice(0, 23) + "…"), "."));
  }

  /* ---------------------------------------------------------------- panel */
  function build_panel() {
    const progress = h("ol", { class: "tour-progress", "aria-label": "Demo steps" });
    const counter = h("p", { class: "tour-counter" });
    const title = h("h2", { class: "tour-title", id: "tour-title", tabindex: "-1" });
    const body = h("div", { class: "tour-body" });
    const next = HXUI.button("Next", { id: "tour-next", variant: "primary", icon: "arrow", on_click: () => next_step() });
    const restart = HXUI.button("Run the demo again", { id: "tour-restart", variant: "primary", icon: "reset", on_click: () => start() });
    const back = HXUI.button("Back to overview", { id: "tour-back", variant: "secondary", on_click: () => HXUI.go("overview", { focus: false }) });
    const end_btn = HXUI.button("End demo", { id: "tour-end", variant: "ghost", on_click: () => end(true) });
    restart.hidden = true;
    const panel = h("section", { class: "tour", id: "tour", "aria-labelledby": "tour-title", dataset: { status: "running", step: "" } },
      h("div", { class: "tour-head" },
        h("p", { class: "tour-label" }, HXUI.icon("play"), h("span", null, "Guided demo"), counter),
        progress),
      title, body,
      h("div", { class: "tour-actions" }, next, restart, back, end_btn));
    return { panel, progress, counter, title, body, next, restart, back, end_btn };
  }

  function paint() {
    if (!T || !T.parts) return;
    const d = T.demo;
    const P = T.parts;
    const idx = d.results.length - 1;
    const r = idx >= 0 ? d.results[idx] : null;
    P.panel.dataset.status = T.status;
    P.panel.dataset.step = r ? r.id : "";
    P.progress.replaceChildren(...d.steps.map((s, i) => {
      const state = T.status === "done" || i < idx ? "done" : (T.status === "running" ? i === idx + 1 : i === idx) ? "current" : i === idx ? "done" : "todo";
      return h("li", { class: "tour-dot", dataset: { state }, title: s.title, "aria-current": i === Math.max(idx, 0) ? "step" : null },
        h("span", { class: "hx-visually-hidden" }, "Step " + s.id + ": " + s.title + (state === "done" ? " (done)" : "")),
        h("span", { "aria-hidden": "true" }, s.id));
    }));
    P.counter.textContent = T.status === "done" ? "Finished" : "Step " + Math.max(idx + 1, 1) + " of " + d.steps.length;
    const nxt = d.done ? null : d.steps[d.cursor];
    if (T.status === "error") {
      P.title.textContent = "The demo stopped at step " + (nxt ? nxt.id : "?");
      P.body.replaceChildren(HXUI.notice("crit", "Step " + (nxt ? nxt.id + ", " + nxt.title.toLowerCase() : "") + " failed",
        [h("p", null, T.error), h("p", null, "The lab keeps the state from the last good step. End the demo and start it again from the Overview.")]));
    } else if (!r) {
      P.title.textContent = d.steps[0].title;
      P.body.replaceChildren(h("p", { class: "tour-what" }, "Running the first step in this page…"));
    } else {
      P.title.textContent = r.title;
      const c = copy_for(r);
      const lines = r.lines.filter((l) => !/^== /.test(l));
      P.body.replaceChildren(...[
        h("p", { class: "tour-what" }, c.what),
        h("p", { class: "tour-why" }, h("strong", null, "Why it matters. "), c.why),
        h("dl", { class: "tour-facts" }, c.facts),
        h("details", { class: "tour-out", open: true },
          h("summary", null, "Engine output, as the command-line demo prints it (" + lines.length + (lines.length === 1 ? " line)" : " lines)")),
          h("ol", { class: "tour-lines", id: "tour-lines" }, lines.map((l) => h("li", null, l.replace(/^ {3}/, ""))))),
        h("p", { class: "tour-where" }, "Shown in ", h("a", { class: "hx-link", href: "#" + PLACE[r.id][0] }, SECTION_NAMES[PLACE[r.id][0]]),
          PLACE[r.id][0] === "run" ? " with the run selected." : "."),
        T.status === "done" ? summary_el(d) : null].filter(Boolean));
    }
    const busy = T.status === "running";
    P.next.hidden = T.status === "done" || T.status === "error";
    P.restart.hidden = T.status !== "done";
    P.next.querySelector(".hx-btn-label").textContent = busy ? "Working…" : nxt ? "Next: " + (SHORT[nxt.id] || nxt.title) : "Next";
    HXUI.set_disabled(P.next, busy, "The engine is running this step.");
  }

  function show_place(step_id) {
    const sec = PLACE[step_id][0];
    if (HXUI.has_section(sec)) HXUI.go(sec, { focus: false });
    const panel = T && T.parts && T.parts.panel;
    if (panel && panel.getBoundingClientRect().top < 0) {
      try { panel.scrollIntoView({ block: "start", behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { panel.scrollIntoView(); }
    }
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
        tour.status = tour.demo.done ? "done" : "ready";
      } catch (err) {
        tour.status = "error";
        tour.error = (err && err.code !== undefined ? err.code + ": " : "") + String((err && (err.msg !== undefined ? err.msg : err.message)) || err);
      }
      paint();
      if (r) {
        show_place(r.id);
        mark_overview(tour.demo.results.length - 1);
        HXUI.announce("Guided demo, step " + r.id + ": " + r.title + (tour.status === "done" ? ". The demo is finished." : "."));
        HXUI.bus.emit("tour:step", { id: r.id, index: tour.demo.results.length - 1 });
      } else HXUI.announce("The guided demo stopped: " + tour.error);
      if (typeof after === "function") after();
      else if (tour.status === "done") {
        const s = document.getElementById("tour-summary-title");
        if (s) { try { s.focus({ preventScroll: true }); } catch (e) { s.focus(); } }
      } else if (tour.status === "error") tour.parts.back.focus();
    }, 0);
  }

  function next_step() {
    if (!T || T.status === "running" || T.demo.done) return;
    run_next();
  }

  function start() {
    const missing = HXUI.engine_missing(NEEDS);
    if (missing.length) { HXUI.announce("The guided demo needs engine modules that are not in this build: " + missing.join(", ") + "."); return false; }
    end(false);
    let n = 0;
    const demo = HX.demo.create({ scenario: "full", clock_start: HX.demo.CLOCK_START, ids: HX.env.make_seq_ids(1), timer: () => 0.125 * ++n });
    T = { demo, status: "running", error: null, parts: build_panel() };
    const main = document.getElementById("hx-main");
    if (main) main.insertBefore(T.parts.panel, main.firstChild);
    run_next(() => {
      const t = document.getElementById("tour-title");
      if (t) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } }
    });
    return true;
  }

  function end(user) {
    if (!T) return;
    const had_focus = T.parts && T.parts.panel.contains(document.activeElement);
    if (T.parts && T.parts.panel.parentNode) T.parts.panel.parentNode.removeChild(T.parts.panel);
    T.status = "ended";
    mark_overview(null);
    T = null;
    if (user) {
      HXUI.announce("Guided demo ended. The lab keeps the demo's environment until you reset it.");
      if (had_focus) {
        const head = document.querySelector(".hx-section:not([hidden]) .hx-section-title");
        if (head) head.focus();
      }
    }
  }

  HXUI.bus.on("lab:reset", () => end(false));

  HXUI.tour = {
    start,
    next: next_step,
    end: () => end(true),
    active: () => !!T,
    /** the running demo (read-only), for tests */
    demo: () => (T ? T.demo : null),
    status: () => (T ? T.status : "idle"),
  };
})();
