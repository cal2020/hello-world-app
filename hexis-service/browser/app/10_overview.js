/* HEXIS Runtime Lab: Overview section. The thesis, the live parity check against the Python build,
   a compact graph of the compiled machine, the guided demo steps and what is simulated.
   Every digest here is computed in this page; only the Python reference values come from HX.data. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */

  /* Engine namespaces each part needs. The first entries name the module that does the work. */
  const BASE = ["data", "canonical", "jsonschema"];
  const COMPILE_NEEDS = ["compile"].concat(BASE, ["guards", "efsm", "pkg", "catalog", "clauses", "fixture", "validate"]);
  const REFINE_NEEDS = ["update", "reference"].concat(COMPILE_NEEDS.slice(1), ["compile", "diff", "traces", "normalize", "replay"]);
  const CATALOG_NEEDS = ["catalog"].concat(BASE);
  const DEMO_NEEDS = ["env", "service", "registry", "update", "reference", "traces", "compile"];

  /* Copy is plain data: strings, and {code: "id"} for identifiers, which HXUI.rich() sets in mono. */
  const CHECKS = [
    {
      id: "initial", label: "Initial artifact hash",
      how: ["Compile ", { code: "SKILL.md" }, " with the fixture compiler model and hash the package."],
      needs: COMPILE_NEEDS, primary: 1,
      expected: (pb) => pb.initial_artifact_hash,
      compute: compute_initial,
    },
    {
      id: "refined", label: "Refined artifact hash",
      how: ["Apply the refinement learned from the missing-documents trace and hash the candidate."],
      needs: REFINE_NEEDS, primary: 1, after: "initial",
      expected: (pb) => pb.refined_artifact_hash,
      compute: compute_refined,
    },
    {
      id: "catalog", label: "Tool catalog digest",
      how: ["Load the trusted tool catalog with every default filled in and hash it."],
      needs: CATALOG_NEEDS, primary: 1,
      expected: (pb) => pb.catalog_digest,
      compute: compute_catalog,
    },
  ];

  const STEPS = [
    { title: "Compile the skill", section: "compile",
      body: ["The fixture compiler drafts a state machine from ", { code: "SKILL.md" }, ". Validation rejects a draft that writes to the ERP before validating, the repaired draft passes, and ", { code: "user:dana" }, " admits it."] },
    { title: "Run a clean intake", section: "run",
      body: ["The run reads the documents, looks up the supplier, extracts a draft and validates it with one bounded repair. Then it stops and asks for approval of the exact write."] },
    { title: "Restart the worker; self-approval is refused", section: "run",
      body: ["The worker restarts and resumes from stored state. The initiator, ", { code: "user:alice" }, ", tries to approve her own run, and the engine refuses: the run keeps waiting for someone else."] },
    { title: "Approve, then the ERP times out after committing", section: "run",
      body: [{ code: "user:bob" }, " approves the exact write. The fake ERP commits the draft, then the call times out. The broker reconciles the write by its idempotency key, and the ERP still holds one draft."] },
    { title: "Read the evidence-linked record", section: "run",
      body: ["The run reports success only after the draft read back from the ERP matches the approved payload. The record links every receipt to that evidence."] },
    { title: "Learn from a trace and refuse a shortcut", section: "learn",
      body: ["Part a: a missing-documents trace yields a refined machine that passes every gate and is admitted against its parent. Part b: a shortcut that skips validation fails the gates, and the active version stays the same."] },
  ];
  /* the guide (65_tour.js) names its steps with these titles; 6a and 6b are the two parts of step 6 */
  HXUI.demo_titles = { "1": STEPS[0].title, "2": STEPS[1].title, "3": STEPS[2].title, "4": STEPS[3].title, "5": STEPS[4].title,
    "6a": "Learn from a missing-documents trace", "6b": "Refuse a shortcut trace" };

  /* parity digests show "sha256:" and 12 hex characters, which fits a grid column with its copy button */
  const SHORT = 19;

  /* ---------------------------------------------------------------- engine calls */
  function compute_initial(ctx) {
    const comp = HX.compile.compile_procurement();
    if (!comp || !comp.package || !comp.package.artifact_hash) {
      throw new Error("The compiler returned no package (status " + (comp ? comp.status : "none") + ").");
    }
    ctx.compiled = comp;
    return { value: comp.package.artifact_hash, note: attempts_note(comp.attempts) };
  }

  function make_aligner(Aligner) {
    if (typeof Aligner !== "function") return Aligner;
    try { return new Aligner(); } catch (e) { return Aligner(); }
  }

  function compute_refined(ctx) {
    const R = HX.reference;
    const trace = typeof R.missing_docs_trace === "function" ? R.missing_docs_trace() : R.missing_docs_trace;
    const catalog = HX.catalog.load_catalog(HX.data.tool_catalog);
    const prop = HX.update.propose_update(ctx.compiled.package, trace, [], [], catalog, make_aligner(R.FixtureAligner), HX.data.skill_md);
    if (!prop || prop.status !== "CANDIDATE" || !prop.candidate) {
      throw new Error("The refinement was not accepted (status " + (prop ? prop.status : "none") + ").");
    }
    return { value: prop.candidate.artifact_hash, note: "Proposal status " + prop.status };
  }

  function compute_catalog() {
    const cat = HX.catalog.load_catalog(HX.data.tool_catalog);
    const n = cat && cat.tools ? Object.keys(cat.tools).length : 0;
    return { value: HX.catalog.digest(cat), note: n + " tools, catalog version " + (cat ? cat.version : "?") };
  }

  function attempts_note(attempts) {
    const list = Array.isArray(attempts) ? attempts : [];
    if (!list.length) return "";
    const parts = list.map((a) => {
      const codes = Array.from(new Set((a.findings || []).map((f) => f && f.code).filter(Boolean))).sort();
      const shown = a.status === "valid" || !codes.length ? "" : " (" + codes.slice(0, 2).join(", ") + (codes.length > 2 ? ", +" + (codes.length - 2) : "") + ")";
      return "attempt " + a.attempt + " " + a.status + shown;
    });
    return "Compiled in " + list.length + (list.length === 1 ? " attempt: " : " attempts: ") + parts.join(", ");
  }

  /* ---------------------------------------------------------------- parity state (computed once) */
  const results = {};
  const ctx = { compiled: null };
  let started = false;
  const watchers = new Set();

  function python_build() {
    return globalThis.HX && HX.data && HX.data.python_build ? HX.data.python_build : null;
  }

  function init_results() {
    for (const c of CHECKS) {
      if (results[c.id]) continue;
      const missing = HXUI.engine_missing(c.needs);
      results[c.id] = missing.length ? { state: "unavailable", missing } : { state: "pending" };
    }
  }

  function notify(id) { for (const fn of Array.from(watchers)) fn(id); }

  function run_checks() {
    if (started) return;
    started = true;
    const queue = CHECKS.filter((c) => results[c.id].state === "pending");
    const step = () => {
      const c = queue.shift();
      if (!c) { notify(null); return; }
      if (c.after && !ctx.compiled) {
        results[c.id] = { state: "blocked", reason: "Needs the initial package, which was not computed." };
      } else {
        const t0 = performance.now();
        try {
          const r = c.compute(ctx);
          const expected = c.expected(python_build());
          results[c.id] = { state: r.value === expected ? "match" : "mismatch", value: r.value, expected, ms: performance.now() - t0, note: r.note || "" };
        } catch (err) {
          results[c.id] = { state: "error", error: String((err && err.message) || err), ms: performance.now() - t0 };
        }
      }
      notify(c.id);
      setTimeout(step, 0);
    };
    setTimeout(step, 0); /* first paint before any engine work */
  }

  function parity_done() { return CHECKS.every((c) => results[c.id] && results[c.id].state !== "pending"); }

  /* ---------------------------------------------------------------- small builders */
  function h(...a) { return HXUI.h(...a); }
  function code(text) { return h("code", { class: "hx-inline" }, text); }

  function ms_text(ms) { return ms < 1 ? "under 1 ms" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s"; }

  function missing_summary(c, missing) {
    const primary = c.needs.slice(0, c.primary).map((n) => "HX." + n);
    const lead = missing.filter((m) => primary.indexOf(m) >= 0);
    const shown = lead.length ? lead : missing.slice(0, 1);
    const rest = missing.length - shown.length;
    return h("p", { class: "ov-missing", title: "Not in this build: " + missing.join(", ") },
      h("span", { class: "ov-missing-text" }, "Needs"),
      shown.map((n) => HXUI.chip(n, "neutral", { mono: true })),
      rest > 0 ? h("span", { class: "ov-missing-more" }, "and " + rest + " more") : null);
  }

  /** ["HX.a", "HX.b", "HX.c", "HX.d"] -> "HX.a, HX.b, HX.c and 1 more" as text, or as nodes with mono names */
  function names_list(list, max, as_nodes) {
    const shown = list.slice(0, max);
    const rest = list.length - shown.length;
    const out = [];
    shown.forEach((n, i) => {
      if (i) out.push(i === shown.length - 1 && !rest ? " and " : ", ");
      out.push(as_nodes ? code(n) : n);
    });
    if (rest) out.push(" and " + rest + " more");
    return as_nodes ? out : out.join("");
  }

  function first_difference(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return n;
  }

  /** Full digest with the part after the first difference marked. */
  function diff_digest(value, at, label, id) {
    const text = h("code", { class: "hx-digest-text is-expanded ov-diff", title: value, id },
      value.slice(0, at), h("mark", { class: "ov-diff-mark" }, value.slice(at)));
    return h("span", { class: "hx-digest ov-diff-digest" }, text, HXUI.copy_button(value, { label, target: text, id: id + "-copy" }));
  }

  const RESULT_CHIPS = {
    match: ["Match", "ok", "check"],
    mismatch: ["Differs", "crit", "cross"],
    error: ["Error", "crit", "stop"],
    unavailable: ["Not in this build", "neutral", null],
    blocked: ["Skipped", "neutral", null],
    pending: ["Computing", "neutral", null],
  };

  function result_chip(state) {
    const spec = RESULT_CHIPS[state] || RESULT_CHIPS.pending;
    return HXUI.chip(spec[0], spec[1], { icon: spec[2] || undefined });
  }

  /* ---------------------------------------------------------------- thesis */
  function thesis() {
    return h("div", { class: "ov-thesis" },
      h("p", { class: "hx-lead" },
        "HEXIS compiles a written skill (a ", code("SKILL.md"), " file) into a state machine, admits it only after it passes static gates, " +
        "and runs it with a deterministic kernel. A broker stands in front of every external write, so the ERP sees a write " +
        "only after policy, approval and evidence checks pass."),
      h("p", { class: "hx-prose" },
        "This page runs the JavaScript port of that engine in your browser. It computes every status and digest below, " +
        "and shows the Python reference values next to them for comparison."));
  }

  /* ---------------------------------------------------------------- parity panel */
  function parity_panel() {
    const pb = python_build();
    const meta = h("div", { class: "hx-panel-meta ov-parity-summary", "aria-live": "polite" });
    const panel = h("section", { class: "hx-panel ov-parity", "aria-labelledby": "ov-parity-title", dataset: { parityState: "running" } },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "ov-parity-title" }, "Parity with the Python reference"),
        meta),
      h("p", { class: "hx-panel-lead" },
        "Each check runs the engine in this page and compares its digest with the value the Python build produced from the same inputs."));
    if (!pb) {
      panel.appendChild(HXUI.unavailable(["HX.data"], { title: "No reference values in this build", lead: "The Python reference values ship in a module that is not in this build:" }));
      panel.dataset.parityState = "done";
      return panel;
    }
    const rows = {};
    const list = h("ul", { class: "ov-checks", role: "list" });
    for (const c of CHECKS) {
      const this_body = h("div", { class: "ov-cell-body" });
      const ref_body = h("div", { class: "ov-cell-body" },
        HXUI.digest(c.expected(pb), { short: SHORT, label: "Python " + c.label.toLowerCase(), id: "ov-" + c.id + "-ref" }));
      const result = h("div", { class: "ov-check-result" });
      const li = h("li", { class: "ov-check", dataset: { check: c.id, state: "pending" } },
        h("div", { class: "ov-check-name" },
          h("p", { class: "ov-check-label" }, c.label),
          h("p", { class: "ov-check-how" }, HXUI.rich(c.how))),
        h("div", { class: "ov-check-cell ov-check-this" }, h("p", { class: "hx-label ov-cell-label" }, "This page"), this_body),
        h("div", { class: "ov-check-cell ov-check-ref" }, h("p", { class: "hx-label ov-cell-label" }, "Python build"), ref_body),
        result);
      rows[c.id] = { li, this_body, ref_body, result };
      list.appendChild(li);
    }
    const head = h("div", { class: "ov-checks-head", "aria-hidden": "true" },
      h("span", null, "Check"), h("span", null, "This page"), h("span", null, "Python build"), h("span", null, "Result"));
    const commit = String(pb.generated_from || "");
    const foot = h("p", { class: "ov-parity-foot" },
      "Python values come from the reference build at hexis-service commit ",
      h("code", { class: "hx-inline", title: commit }, commit.slice(0, 7) || "unknown"),
      ". The ", code("efsm-v1"), " format follows upstream HEXIS ",
      h("code", { class: "hx-inline", title: String(pb.upstream_commit || "") }, String(pb.upstream_commit || "").slice(0, 7) || "unknown"),
      ".");
    panel.append(h("div", { class: "ov-checks-wrap" }, head, list), foot);

    function paint_row(id) {
      const c = CHECKS.find((x) => x.id === id);
      const r = results[id];
      const row = rows[id];
      if (!c || !r || !row) return;
      row.li.dataset.state = r.state;
      row.result.replaceChildren(result_chip(r.state));
      if (r.state === "match") {
        row.this_body.replaceChildren(
          HXUI.digest(r.value, { short: SHORT, label: "computed " + c.label.toLowerCase(), id: "ov-" + c.id + "-this" }),
          h("p", { class: "ov-check-note", title: r.note || null }, "Computed in this page in " + ms_text(r.ms)));
      } else if (r.state === "mismatch") {
        const at = first_difference(String(r.value), String(r.expected));
        row.this_body.replaceChildren(
          diff_digest(String(r.value), at, "computed " + c.label.toLowerCase(), "ov-" + c.id + "-this"),
          h("p", { class: "ov-check-error" }, "Differs from the Python value at character " + (at + 1) + "."),
          h("p", { class: "ov-check-note", title: r.note || null }, "Computed in this page in " + ms_text(r.ms)));
        row.ref_body.replaceChildren(diff_digest(String(r.expected), at, "Python " + c.label.toLowerCase(), "ov-" + c.id + "-ref"));
      } else if (r.state === "unavailable") {
        row.this_body.replaceChildren(missing_summary(c, r.missing));
      } else if (r.state === "error") {
        row.this_body.replaceChildren(h("p", { class: "ov-check-error" }, "Could not compute: " + r.error));
      } else if (r.state === "blocked") {
        row.this_body.replaceChildren(h("p", { class: "ov-check-note" }, r.reason));
      } else {
        row.this_body.replaceChildren(h("p", { class: "ov-check-note ov-computing" }, "Computing in this page…"));
      }
    }

    function paint_summary() {
      const counts = {};
      for (const c of CHECKS) { const st = results[c.id].state; counts[st] = (counts[st] || 0) + 1; }
      const chips = [];
      if (counts.pending) chips.push(HXUI.chip("Checking", "neutral"));
      if (counts.match) chips.push(HXUI.chip(counts.match + " of " + CHECKS.length + " match", "ok", { icon: "check" }));
      if (counts.mismatch) chips.push(HXUI.chip(counts.mismatch + (counts.mismatch === 1 ? " differs" : " differ"), "crit", { icon: "cross" }));
      if (counts.error) chips.push(HXUI.chip(counts.error + (counts.error === 1 ? " error" : " errors"), "crit", { icon: "stop" }));
      if (counts.unavailable) chips.push(HXUI.chip(counts.unavailable + " not in this build", "neutral"));
      if (counts.blocked) chips.push(HXUI.chip(counts.blocked + " skipped", "neutral"));
      meta.replaceChildren(...chips);
      panel.dataset.parityState = parity_done() ? "done" : "running";
    }

    for (const c of CHECKS) paint_row(c.id);
    paint_summary();
    panel.hx_update = (id) => { if (id) paint_row(id); paint_summary(); };
    return panel;
  }

  /* ---------------------------------------------------------------- machine panel */
  function machine_stats(machine) {
    const states = machine && machine.states ? Object.values(machine.states) : [];
    const transitions = states.reduce((n, st) => n + (Array.isArray(st.transitions) ? st.transitions.length : 0), 0);
    const outcomes = machine && Array.isArray(machine.terminals) ? machine.terminals.length : 0;
    return [states.length + " states", transitions + " transitions", outcomes + " outcomes"];
  }

  /** The title of the machine panel's "not in this build" box names what is missing or broken. */
  function machine_unavailable_title(missing) {
    const failed = missing.filter((n) => HXUI.namespace_status(n) === "failed");
    if (failed.indexOf("HXUI.graph") >= 0) return "The graph failed to load";
    if (failed.length) return "The compiler failed to load";
    const no_graph = missing.indexOf("HXUI.graph") >= 0;
    const no_engine = missing.some((n) => n !== "HXUI.graph");
    if (no_graph && no_engine) return "The compiler and the graph view are not in this build";
    return no_graph ? "The graph view is not in this build" : "The compiler is not in this build";
  }

  function machine_panel() {
    const meta = h("div", { class: "hx-panel-meta" });
    /* one line above the figure says where the machine comes from; the figure keeps its own caption line */
    const lead = h("p", { class: "hx-panel-lead ov-machine-lead", hidden: true },
      "Compiled from ", code("SKILL.md"), " in this page. The run workbench drives this machine one step at a time. ",
      h("a", { class: "hx-link", href: "#run" }, "Open the run workbench"));
    const stage = h("div", { class: "ov-graph" });
    const panel = h("section", { class: "hx-panel ov-machine", "aria-labelledby": "ov-machine-title", dataset: { graph: "pending" } },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "ov-machine-title" }, "The compiled machine"), meta),
      lead, stage);
    let view = null;
    let fit_observer = null;

    function set_state(st) {
      panel.dataset.graph = st;
      if (panel.parentNode && panel.parentNode.classList.contains("ov-split")) panel.parentNode.dataset.graph = st;
    }

    /* The panel may stay in view beside the steps (CSS makes it sticky) only while all of it fits in the
       window with 16px above and below; otherwise its lower part would stay out of reach.
       The graph's caption grows when a state takes focus (one line per transition). Deciding from the current
       height would flip the panel from sticky to static at that moment and throw it off screen, so the decision
       counts the caption at its tallest: the measured worst case for this machine at the caption's width. */
    let reserve = { width: -1, height: 0 };
    function caption_lines(n, outs) {
      const c = (t) => h("code", { class: "hxg-code" }, t);
      const kids = [c(n.id), ": " + (n.kind_text || n.kind || "") + (n.detail ? " · " + (n.lead || "") : ""),
        n.detail ? (n.detail_mono ? c(n.detail) : n.detail) : null];
      for (const e of outs) {
        kids.push(h("br"), "→ ", c(e.to), e.cond ? " if " : " otherwise", e.cond ? c(e.cond) : null,
          e.inc ? ", then +1 " : null, e.inc ? c(e.inc) : null);
      }
      return kids.filter((k) => k !== null);
    }
    function caption_reserve(cap) {
      const width = cap.clientWidth;
      if (width === reserve.width) return reserve.height;
      let tallest = 0;
      try {
        const L = HXUI.graph.layout(ctx.compiled.package.machine, { compact: true });
        const probe = cap.cloneNode(false);
        probe.removeAttribute("hidden");
        Object.assign(probe.style, { position: "absolute", visibility: "hidden", pointerEvents: "none", inset: "0 auto auto 0", height: "auto", maxHeight: "none", width: width + "px" });
        cap.parentNode.appendChild(probe);
        for (const n of L.nodes) {
          if (n.kind === "end") continue;
          probe.replaceChildren(...caption_lines(n, L.edges.filter((e) => e.from === n.id)));
          tallest = Math.max(tallest, probe.getBoundingClientRect().height);
        }
        probe.remove();
      } catch (err) {
        tallest = 0; /* no worst case known: fall back to what the caption shows now */
      }
      reserve = { width, height: tallest };
      return tallest;
    }
    function sync_fit() {
      const height = panel.getBoundingClientRect().height;
      if (!height) return;
      const cap = panel.querySelector(".hxg-caption");
      let extra = 0;
      if (cap && !cap.hidden && cap.parentNode) {
        const now = cap.getBoundingClientRect().height;
        /* a caption taller than the measured worst case (new caption text) raises the reserve for good */
        const most = Math.max(caption_reserve(cap), now);
        reserve.height = most;
        extra = most - now;
      }
      panel.dataset.fit = height + extra + 32 <= (globalThis.innerHeight || 0) ? "yes" : "no";
    }
    function watch_fit() {
      if (fit_observer || typeof ResizeObserver !== "function") return;
      fit_observer = new ResizeObserver(sync_fit);
      fit_observer.observe(panel);
      globalThis.addEventListener("resize", sync_fit, { passive: true });
    }

    function paint() {
      const missing = HXUI.engine_missing(COMPILE_NEEDS);
      if (!HXUI.graph || typeof HXUI.graph.create !== "function") missing.push("HXUI.graph");
      if (missing.length) {
        set_state("unavailable");
        stage.replaceChildren(HXUI.unavailable(missing, {
          compact: true, title: machine_unavailable_title(missing),
          lead: "The compiled state machine is drawn here when the compiler and the graph view are in the build. Missing:",
        }));
        lead.hidden = true;
        return;
      }
      const r = results.initial;
      if (!r || r.state === "pending") {
        stage.replaceChildren(h("p", { class: "ov-graph-wait" }, "Compiling ", code("SKILL.md"), " in this page…"));
        lead.hidden = true;
        return;
      }
      if (!ctx.compiled) {
        set_state("error");
        stage.replaceChildren(HXUI.notice("crit", "The machine could not be compiled", r.error || "The compiler returned no package."));
        lead.hidden = true;
        return;
      }
      if (view) return;
      const machine = ctx.compiled.package.machine;
      meta.replaceChildren(...machine_stats(machine).map((t) => HXUI.chip(t, "neutral")));
      try {
        stage.replaceChildren();
        /* no title: the panel heading names the graph, so the compact view needs no header of its own */
        view = HXUI.graph.create(stage, machine, { compact: true });
        set_state("ready");
        lead.hidden = false;
        watch_fit();
      } catch (err) {
        set_state("error");
        lead.hidden = true;
        stage.replaceChildren(HXUI.notice("crit", "The graph could not be drawn", String((err && err.message) || err)));
      }
    }
    paint();
    panel.hx_update = paint;
    panel.hx_view = () => view;
    return panel;
  }

  /* ---------------------------------------------------------------- guided demo */
  function demo_panel() {
    const missing = HXUI.engine_missing(DEMO_NEEDS);
    const tour = HXUI.tour && typeof HXUI.tour.start === "function" ? HXUI.tour : null;
    const lead_in = "The guided demo needs engine modules that are not in this build: ";
    const no_tour = "The guided demo is not in this build yet. You can still do each step yourself in the section it links to.";
    const reason = missing.length ? lead_in + names_list(missing, 3, false) + "." : !tour ? no_tour : "";
    const start = HXUI.button("Start guided demo", {
      id: "ov-demo-start", variant: "primary", icon: "play", disabled: !!reason, disabled_reason: reason,
      on_click: () => { if (tour) tour.start(); },
    });
    const steps = h("ol", { class: "ov-steps", "aria-label": "Guided demo steps" }, STEPS.map((s, i) => {
      const sec = HXUI.sections().find((x) => x.id === s.section);
      const name = sec ? sec.nav : s.section;
      return h("li", { class: "ov-step", id: "ov-step-" + (i + 1), dataset: { step: i + 1, section: s.section, status: "idle" } },
        h("span", { class: "ov-step-num", "aria-hidden": "true" }, String(i + 1)),
        h("div", { class: "ov-step-main" },
          h("p", { class: "ov-step-title" }, h("span", { class: "hx-visually-hidden" }, "Step " + (i + 1) + ": "), s.title),
          h("p", { class: "ov-step-body" }, HXUI.rich(s.body))),
        h("a", { class: "ov-step-link", href: "#" + s.section, "aria-label": "Open " + name + " for step " + (i + 1) },
          h("span", null, name), HXUI.icon("arrow")));
    }));
    /* the visible reason sets module names in mono; the button's tooltip and description carry the same text */
    const reason_el = !reason ? null
      : h("p", { class: "hx-reason", id: "ov-demo-reason", title: missing.length ? "Not in this build: " + missing.join(", ") : null },
        HXUI.icon("info"), h("span", null, missing.length ? [lead_in, names_list(missing, 3, true), "."] : no_tour));
    return h("section", { class: "hx-panel ov-demo", "aria-labelledby": "ov-demo-title" },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "ov-demo-title" }, "Guided demo"),
        h("div", { class: "hx-panel-meta" }, HXUI.chip(STEPS.length + " steps", "neutral"))),
      h("p", { class: "hx-panel-lead" },
        "Follow the supplier-onboarding story from the command-line demo. The guide runs each step in the section it links to, then explains what happened and why it matters."),
      h("div", { class: "ov-demo-actions" }, start, reason_el),
      steps);
  }

  /* ---------------------------------------------------------------- what is simulated */
  function identities() {
    const policy = globalThis.HX && HX.data && HX.data.policy ? HX.data.policy : null;
    if (!policy || !policy.principals) return null;
    const rows = Object.keys(policy.principals).map((id) => Object.assign({ id }, policy.principals[id]));
    /* each unit stays on one line ("BU-EMEA" never breaks at its hyphen) */
    const units = (r) => (r.business_units || []).length
      ? r.business_units.map((u, i) => [i ? ", " : "", h("span", { class: "hx-nowrap" }, u)]) : null;
    return HXUI.table({
      caption: "Principals in the onboarding policy",
      class: "ov-ids",
      columns: [
        { key: "id", label: "Principal", mono: true, nowrap: true },
        { key: "roles", label: "Roles", render: (r) => (r.roles || []).length
          ? h("span", { class: "ov-roles" }, r.roles.map((x) => HXUI.chip(x, x === policy.approver_role ? "accent" : "neutral", { mono: true })))
          : h("span", { class: "hx-faint" }, "none") },
        /* on a narrow screen tenant and units move under the principal */
        { key: "tenant_id", label: "Tenant", mono: true, fold: true, fold_label: "Tenant" },
        { key: "business_units", label: "Business units", render: (r) => units(r) || h("span", { class: "hx-faint" }, "none"),
          fold: (r) => units(r) || "no business units" },
      ],
      rows,
    });
  }

  function simulated_panel() {
    const items = [
      ["ERP", "An in-memory fake ERP. It creates and reads drafts, and on command it times out, fails a read or has a draft changed out of band."],
      ["Documents and registry", "Fixed intake documents and supplier records for a few suppliers. One document carries a prompt-injection attempt."],
      ["Models and clock", "Scripted fixture models stand in for the compiler and extraction models, so no language model is called. A manual clock moves only when you advance it."],
    ];
    const ids = identities();
    return h("section", { class: "hx-panel ov-sim", "aria-labelledby": "ov-sim-title" },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "ov-sim-title" }, "What is simulated"),
        h("div", { class: "hx-panel-meta" }, HXUI.chip("Fixture mode", "info"))),
      h("p", { class: "hx-panel-lead" },
        "The engine is the real port. Everything it talks to is simulated, so runs work offline and repeat exactly."),
      h("dl", { class: "ov-sim-list" }, items.map(([t, d]) =>
        h("div", { class: "ov-sim-item" }, h("dt", null, t), h("dd", null, d)))),
      h("div", { class: "ov-sim-ids" },
        h("p", { class: "ov-sim-ids-lead" }, h("strong", null, "Identities. "),
          "Simulated principals from the onboarding policy. Nobody signs in, and the approver role is highlighted."),
        ids || HXUI.unavailable(["HX.data"], { compact: true, hint: false })));
  }

  /* ---------------------------------------------------------------- section */
  let parts = null;

  function render(el) {
    init_results();
    const parity = parity_panel();
    const machine = machine_panel();
    const root = h("div", { class: "ov" },
      thesis(),
      h("div", { class: "ov-body hx-ruled" },
        parity,
        h("div", { class: "ov-split", dataset: { graph: machine.dataset.graph } }, demo_panel(), machine),
        simulated_panel()));
    el.replaceChildren(root);
    parts = { parity, machine };
    run_checks();
  }

  watchers.add((id) => {
    if (!parts) return;
    parts.parity.hx_update(id);
    if (id === "initial" || id === null) parts.machine.hx_update();
  });

  HXUI.overview = {
    /** parity results by check id: {state, value, expected, ms, note, missing, error} */
    parity: () => JSON.parse(JSON.stringify(results)),
    parity_done,
    /** the compact graph view on the Overview (null until it is drawn), for the guided demo */
    graph: () => (parts ? parts.machine.hx_view() : null),
  };

  HXUI.register_section({
    id: "overview",
    title: "Overview",
    nav: "Overview",
    summary: "What HEXIS does, checked live against the Python build",
    needs: [],
    mount(el) { render(el); },
  });
})();
