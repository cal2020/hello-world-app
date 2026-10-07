/* HEXIS Runtime Lab: Self-test section (#selftest).
   Runs the check catalog of app/62_checks.js in this page: the Python build's parity anchors, golden vectors sampled
   from the Python reference (golden/selftest.json, embedded as #hx-embed "selftest") and the A01 to A32 acceptance
   checks. The run starts the first time the section is shown and streams its results into one table per group, one
   check per setTimeout tick, so the page stays responsive. It also lists the engine modules in this build.

   DOM contract (tests and other sections):
     #st-root[data-run-state]   idle | running | done; data-pass, data-fail, data-skip, data-total once done
     #st-run                    Run all checks again (aria-disabled while a run is in progress)
     #st-problems-only          checkbox: show only failed and skipped checks
     tr[data-check=<key>][data-status]   one row per check: pending | running | pass | fail | skip
     .st-modules                the engine inventory table (tr[data-module][data-status])
   HXUI.selftest = {run(), state(), results()}. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline" }, t);

  const ABOUT = [
    ["Recompute the Python build's three anchors: the initial and refined artifact hashes and the tool catalog digest."],
    ["Replay golden vectors from the Python reference: canonical JSON, guards, kernel steps and walks, three service transcripts and the demo narrative."],
    ["Run the acceptance checks ", { code: "A01" }, " to ", { code: "A32" }, ", each against a fresh engine environment, asserting what the Python test asserts."],
  ];

  const MODULE_STATUS = {
    loaded: ["Loaded", "ok", "check"],
    failed: ["Failed to load", "crit", "stop"],
    absent: ["Not in this build", "neutral", null],
  };
  const RESULT = {
    pass: ["Passed", "ok", "check"],
    fail: ["Failed", "crit", "stop"],
    skip: ["Skipped", "neutral", null],
    running: ["Running", "accent", null],
    pending: ["Waiting", "neutral", null],
  };

  function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
  function ms_text(ms) {
    if (ms === null || ms === undefined) return "";
    return ms < 1 ? "<1 ms" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
  }
  /** a long identifier that may wrap after "_", ".", "/" or "[" (never inside a word) */
  function wrap_id(t) {
    const kids = [];
    String(t).split(/(?<=[_./[])/).forEach((p, i) => { if (i) kids.push(h("wbr")); kids.push(p); });
    return kids;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /* ---------------------------------------------------------------- state */
  const S = { state: "idle", gen: 0, results: new Map(), started: 0, finished: 0, engine_ms: 0, current: null, problems_only: false };
  let P = null; /* mounted parts */

  function checks() { return HXUI.checks && typeof HXUI.checks.list === "function" ? HXUI.checks : null; }
  function list() { const c = checks(); return c ? c.list() : []; }
  function counts() {
    const out = { pass: 0, fail: 0, skip: 0, pending: 0, running: 0, total: 0 };
    for (const c of list()) {
      const r = S.results.get(c.key);
      const st = r ? r.status : "pending";
      out[st] = (out[st] || 0) + 1;
      out.total++;
    }
    return out;
  }

  /* ---------------------------------------------------------------- runner */
  function run_all() {
    const C = checks();
    if (!C || S.state === "running") return;
    S.gen += 1;
    const gen = S.gen;
    const items = C.list();
    S.results = new Map();
    S.state = "running";
    S.started = now();
    S.engine_ms = 0;
    S.current = null;
    const ctx = C.context();
    HXUI.announce("Self-test started: " + plural(items.length, "check", "checks") + ".");
    paint_all();
    let i = 0;
    const finish = () => {
      try { ctx.close(); } catch (e) { /* nothing to free */ }
      S.state = "done";
      S.current = null;
      S.finished = now();
      paint_summary();
      const n = counts();
      HXUI.announce("Self-test finished: " + n.pass + " passed, " + n.fail + " failed, " + n.skip + " skipped.");
    };
    const step = () => {
      if (gen !== S.gen) return; /* a newer run took over */
      if (i >= items.length) { finish(); return; }
      const c = items[i];
      S.current = c.key;
      S.results.set(c.key, { status: "running" });
      paint_check(c);
      paint_summary();
      /* yield once so "Running" paints before the engine work starts */
      setTimeout(() => {
        if (gen !== S.gen) return;
        let r;
        try { r = C.run(c.key, ctx); } catch (err) { r = { status: "fail", ms: 0, message: "The runner failed: " + String((err && err.message) || err) }; }
        S.engine_ms += r.ms || 0;
        S.results.set(c.key, r);
        i += 1;
        paint_check(c);
        paint_summary();
        setTimeout(step, 0);
      }, 0);
    };
    setTimeout(step, 0);
  }

  /* ---------------------------------------------------------------- summary */
  function headline(n) {
    if (S.state === "idle") return { tone: "neutral", icon: "info", text: "The checks have not run yet." };
    if (S.state === "running") {
      const done = n.pass + n.fail + n.skip;
      return { tone: "accent", icon: null, text: "Running check " + Math.min(done + 1, n.total) + " of " + n.total + "…" };
    }
    if (n.fail) return { tone: "crit", icon: "stop", text: plural(n.fail, "check failed", "checks failed") + ". Each failure below shows its assertion." };
    if (n.skip && !n.pass) return { tone: "neutral", icon: "info", text: "No check could run in this build." };
    return { tone: "ok", icon: "check", text: n.skip ? "Every check that could run passed." : "All " + n.total + " checks passed.",
      sub: n.skip ? plural(n.skip, "check needs", "checks need") + " parts of the engine that are not in this build." : null };
  }

  function summary_block() {
    const n = counts();
    const hl = headline(n);
    const done = n.pass + n.fail + n.skip;
    const total_ms = S.state === "done" ? S.finished - S.started : S.state === "running" ? now() - S.started : 0;
    const meter = h("div", { class: "st-progress", role: "img", "aria-label": done + " of " + n.total + " checks finished: " + n.pass + " passed, " + n.fail + " failed, " + n.skip + " skipped" },
      list().map((c) => {
        const r = S.results.get(c.key);
        return h("span", { class: "st-progress-cell", dataset: { status: r ? r.status : "pending" }, title: c.id + " · " + c.name });
      }));
    const chips = [
      HXUI.chip(n.pass + " passed", n.pass ? "ok" : "neutral", { icon: n.pass ? "check" : undefined }),
      HXUI.chip(n.fail + " failed", n.fail ? "crit" : "neutral", { icon: n.fail ? "stop" : undefined }),
      HXUI.chip(n.skip + " skipped", "neutral"),
    ];
    const timing = S.state === "idle" ? null
      : h("p", { class: "st-timing" }, S.state === "running"
        ? [String(done), " of ", String(n.total), " finished in ", ms_text(total_ms), "."]
        : ["Ran ", plural(n.total, "check", "checks"), " in this page in ", ms_text(total_ms), " (", ms_text(S.engine_ms), " of engine time; the rest is yielding to the page between checks)."]);
    return h("div", { class: "st-summary" },
      h("p", { class: ["st-headline", "hx-tone-" + hl.tone] }, hl.icon ? HXUI.icon(hl.icon) : h("span", { class: "st-spinner", "aria-hidden": "true" }), h("span", null, hl.text)),
      hl.sub ? h("p", { class: "st-headline-sub" }, hl.sub) : null,
      meter,
      h("div", { class: "st-chips" }, chips),
      timing);
  }

  function paint_summary() {
    if (!P) return;
    const n = counts();
    P.root.dataset.runState = S.state;
    for (const k of ["pass", "fail", "skip", "total"]) P.root.dataset[k] = String(n[k]);
    P.summary.replaceChildren(summary_block());
    const running = S.state === "running";
    const label = running ? "Running…" : S.state === "done" ? "Run all checks again" : "Run all checks";
    P.run.querySelector(".hx-btn-label").textContent = label;
    HXUI.set_disabled(P.run, running || !checks(), running ? "The checks are running. Results appear below as each one finishes."
      : "The check catalog (app/62_checks.js) is not in this build.");
    for (const g of P.groups) paint_group_meta(g);
  }

  /* ---------------------------------------------------------------- group tables */
  function result_chip(r) {
    const st = r ? r.status : "pending";
    const spec = RESULT[st] || RESULT.pending;
    return HXUI.chip(spec[0], spec[1], { icon: spec[2] || undefined });
  }

  function name_cell(c) {
    const r = S.results.get(c.key);
    const parts = [h("p", { class: "st-name" }, h("span", { class: "st-id" }, c.id), h("span", { class: "st-sep", "aria-hidden": "true" }, " · "), h("span", { class: "hx-visually-hidden" }, ": "), c.name)];
    if (r && r.status === "fail") {
      parts.push(h("p", { class: "st-message is-fail" }, HXUI.icon("alert"), h("span", null, r.message || "Failed without a message.")));
    } else if (r && r.status === "skip") {
      parts.push(h("p", { class: "st-message is-skip" }, h("span", null, r.message || "Skipped.")));
    }
    return h("div", { class: "st-cell-name" }, parts);
  }
  function detail_cell(c) {
    const r = S.results.get(c.key);
    const note = r && r.status === "pass" && r.note ? h("span", { class: "st-note" }, r.note) : null;
    const py = c.python ? h("span", { class: "st-py", title: "The Python test or value this check mirrors" }, wrap_id(c.python)) : null;
    if (!note && !py) return null;
    return h("div", { class: "st-cell-detail" }, note, py);
  }

  function group_table(g) {
    const rows = g.items.filter((c) => {
      if (!S.problems_only) return true;
      const r = S.results.get(c.key);
      return r && (r.status === "fail" || r.status === "skip");
    });
    return HXUI.table({
      caption: g.title, caption_hidden: true, class: "st-checks",
      columns: [
        { key: "name", label: "Check", render: name_cell },
        { key: "result", label: "Result", nowrap: true, render: (c) => result_chip(S.results.get(c.key)) },
        { key: "ms", label: "Time", align: "right", nowrap: true, render: (c) => { const r = S.results.get(c.key); return r && r.ms !== undefined && r.status !== "skip" ? ms_text(r.ms) : ""; },
          fold: (c) => { const r = S.results.get(c.key); return r && r.ms !== undefined && r.status !== "skip" ? ms_text(r.ms) : null; } },
        { key: "detail", label: "Detail", render: (c) => detail_cell(c) || "", fold: (c) => detail_cell(c) },
      ],
      rows,
      empty: S.problems_only ? "No failed or skipped checks in this group." : "No checks in this group.",
      row_attrs: (c) => { const r = S.results.get(c.key); return { dataset: { check: c.key, status: r ? r.status : "pending" } }; },
    });
  }

  function paint_group_meta(g) {
    let pass = 0, fail = 0, skip = 0;
    for (const c of g.items) {
      const r = S.results.get(c.key);
      if (!r) continue;
      if (r.status === "pass") pass++; else if (r.status === "fail") fail++; else if (r.status === "skip") skip++;
    }
    const chips = [HXUI.chip(pass + " of " + g.items.length + " passed", pass === g.items.length ? "ok" : "neutral", { icon: pass === g.items.length ? "check" : undefined })];
    if (fail) chips.push(HXUI.chip(fail + " failed", "crit", { icon: "stop" }));
    if (skip) chips.push(HXUI.chip(skip + " skipped", "neutral"));
    g.meta.replaceChildren(...chips);
  }

  function paint_check(c) {
    if (!P) return;
    const g = P.groups.find((x) => x.items.some((y) => y.key === c.key));
    if (g) g.body.replaceChildren(group_table(g));
  }

  function paint_all() {
    if (!P) return;
    for (const g of P.groups) g.body.replaceChildren(group_table(g));
    paint_summary();
  }

  /* ---------------------------------------------------------------- golden sample panel */
  function sample_rows(e) {
    const s = e.sources || {};
    const k = e.kernel || {}, g = e.guards || {}, c = e.canonical || {};
    const len = (x) => (Array.isArray(x) ? x.length : 0);
    return [
      { src: "canonical", what: "Canonical JSON, floats, parsing, hashes", here: len(c.canonical) + len(c.floats) + len(c.loads) + len(c.sha256) + len(c.hmac), checks: "G1–G4" },
      { src: "guards_parse", what: "Guard parser", here: len(g.parse), checks: "G5" },
      { src: "guards_semantics", what: "Guard type checks and evaluation", here: len(g.semantics), checks: "G6–G7" },
      { src: "guards_disjoint", what: "Guard disjointness", here: len(g.disjoint), checks: "G8" },
      { src: "kernel", what: "Kernel packages, vectors and walks", here: len(k.select_edge) + len(k.fill_template) + len(k.resolve_path) + len(k.walks), checks: "G9–G11" },
      { src: "runtime", what: "Service scenarios (full transcripts)", here: len((e.runtime || {}).scenarios), checks: "G12–G14" },
      { src: "demo", what: "Demo narrative", here: e.demo ? 1 : 0, checks: "G15" },
    ].map((r) => Object.assign(r, { file: (s[r.src] || {}).file || r.src + ".json", total: (s[r.src] || {}).vectors }));
  }

  function embed_size() {
    try {
      const el = document.getElementById("hx-embed");
      return el ? el.textContent.length : 0;
    } catch (e) { return 0; }
  }

  function sample_panel() {
    const C = checks();
    const e = C ? C.embed() : null;
    const head = h("div", { class: "hx-panel-head" },
      h("h3", { class: "hx-panel-title", id: "st-sample-title" }, "Golden sample"),
      h("div", { class: "hx-panel-meta" }, e ? HXUI.chip(Math.round(embed_size() / 1024) + " KB embedded", "info") : HXUI.chip("Not embedded", "neutral")));
    const panel = h("section", { class: "hx-panel st-sample", "aria-labelledby": "st-sample-title" }, head);
    if (!e) {
      panel.appendChild(HXUI.notice("warn", "This build has no golden sample",
        ["The golden checks are skipped. Build the page with ", code("app/embed.json"), " listing ", code("golden/selftest.json"), ", which ", code("golden/gen_selftest.py"), " writes."]));
      return panel;
    }
    panel.append(
      h("p", { class: "hx-panel-lead" }, "Vectors written by running the Python reference, sampled by ", code("golden/gen_selftest.py"),
        " and embedded in this page. The golden checks replay them against the JavaScript engine and require identical results."),
      HXUI.table({
        caption: "Golden vectors embedded in this page", caption_hidden: true, class: "st-sample-table",
        columns: [
          { key: "what", label: "Vectors", render: (r) => h("span", null, r.what) },
          { key: "here", label: "Replayed here", align: "right", nowrap: true, render: (r) => String(r.here) },
          { key: "total", label: "In the Python file", align: "right", nowrap: true, render: (r) => (r.total === undefined ? "" : String(r.total)),
            fold: (r) => (r.total === undefined ? null : r.here + " of " + r.total + " in the Python file") },
          { key: "file", label: "Golden file", mono: true, render: (r) => h("span", { class: "st-file" }, "golden/" + r.file.split(", ")[0]), fold: (r) => "golden/" + r.file.split(", ")[0], fold_label: "From" },
          { key: "checks", label: "Checks", nowrap: true, mono: true, fold: true },
        ],
        rows: sample_rows(e),
      }));
    return panel;
  }

  /* ---------------------------------------------------------------- engine panel */
  function engine_summary(inv) {
    const n = (st) => inv.filter((m) => m.status === st).length;
    const loaded = n("loaded"), failed = n("failed"), absent = n("absent");
    const label = loaded + " of " + inv.length + " engine modules loaded";
    return h("div", { class: "st-summary st-engine-summary" },
      h("p", { class: "st-count" },
        h("span", { class: "st-count-num" }, String(loaded)),
        h("span", { class: "st-count-of" }, " of " + inv.length),
        h("span", { class: "st-count-label" }, "engine modules loaded")),
      h("div", { class: "hx-meter st-meter", role: "img", "aria-label": label },
        inv.map((m) => h("span", { class: "hx-meter-cell", dataset: { status: m.status }, title: "HX." + m.ns[0] + ": " + MODULE_STATUS[m.status][0] }))),
      h("div", { class: "hx-panel-meta" },
        HXUI.chip(failed + " failed", failed ? "crit" : "neutral", { icon: failed ? "stop" : undefined }),
        HXUI.chip(absent + " not in this build", "neutral")));
  }

  function inventory_table(inv) {
    const namespaces = (m) => m.ns.map((x) => "HX." + x).join(", ");
    return HXUI.table({
      caption: "Engine modules in this build", caption_hidden: true, class: "st-modules",
      columns: [
        { key: "prefix", label: "Module", nowrap: true, render: (m) => h("span", { class: "st-module", title: m.file || "No script for this module in this build" }, h("code", null, m.prefix), " " + m.label) },
        { key: "status", label: "Status", nowrap: true, render: (m) => HXUI.chip(MODULE_STATUS[m.status][0], MODULE_STATUS[m.status][1], { icon: MODULE_STATUS[m.status][2] || undefined }) },
        { key: "ns", label: "Namespace", mono: true, nowrap: true, render: namespaces, fold: namespaces },
        { key: "ref", label: "Python reference", mono: true, nowrap: true, render: (m) => m.ref || h("span", { class: "hx-faint" }, "none"), fold: (m) => m.ref || null },
      ],
      rows: inv,
      row_attrs: (m) => ({ dataset: { module: m.prefix, status: m.status } }),
    });
  }

  function engine_panel() {
    const inv = HXUI.engine_inventory();
    const extras = HXUI.engine_extras();
    return h("section", { class: "hx-panel st-engine", "aria-labelledby": "st-engine-title" },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "st-engine-title" }, "Engine in this build"),
        h("div", { class: "hx-panel-meta" }, HXUI.chip(globalThis.HX && HX.VERSION ? String(HX.VERSION) : "engine not loaded", "neutral", { mono: true }))),
      engine_summary(inv),
      inventory_table(inv),
      extras.length ? h("p", { class: "st-extras" }, "Also present: ", extras.map((x, i) => [i ? ", " : "", h("code", { class: "hx-inline" }, "HX." + x)]), ".") : null);
  }

  /* ---------------------------------------------------------------- section */
  function render(el) {
    const C = checks();
    const run = HXUI.button("Run all checks", { id: "st-run", variant: "primary", icon: "play", on_click: () => run_all() });
    const only = h("input", { type: "checkbox", id: "st-problems-only", class: "hx-check" });
    only.checked = S.problems_only;
    only.addEventListener("change", () => { S.problems_only = only.checked; paint_all(); });
    const filter = h("div", { class: "st-filter" }, only, h("label", { for: "st-problems-only" }, "Show only failed and skipped checks"));
    const summary = h("div", { class: "st-summary-wrap", "aria-live": "off" });
    const groups = [];
    const group_els = [];
    if (C) {
      const items = C.list();
      for (const g of C.GROUPS) {
        const gi = items.filter((c) => c.group === g.id);
        if (!gi.length) continue;
        const meta = h("div", { class: "hx-panel-meta" });
        const body = h("div", { class: "st-group-body" });
        const title_id = "st-group-" + g.id + "-title";
        group_els.push(h("section", { class: "st-group", id: "st-group-" + g.id, "aria-labelledby": title_id },
          h("div", { class: "st-group-head" },
            h("div", { class: "st-group-titles" },
              h("h4", { class: "st-group-title", id: title_id }, g.title),
              h("p", { class: "st-group-lead" }, g.lead)),
            meta),
          body));
        groups.push({ id: g.id, title: g.title, items: gi, meta, body });
      }
    }
    const checks_panel = h("section", { class: "hx-panel st-checks-panel", "aria-labelledby": "st-checks-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "st-checks-title" }, "Checks")),
      summary,
      h("div", { class: "hx-action-row st-actions" }, run, filter),
      C ? group_els : HXUI.unavailable(["HXUI.checks"], { compact: true, title: "The check catalog is not in this build",
        lead: "The checks live in app/62_checks.js, which this build does not include:", hint: false }),
      HXUI.about_list(ABOUT, { title: "What the runner does", level: 4 }));
    const root = h("div", { class: "st hx-ruled", id: "st-root", dataset: { runState: S.state } }, checks_panel, sample_panel(), engine_panel());
    el.replaceChildren(root);
    P = { root, run, summary, groups };
    paint_all();
  }

  HXUI.selftest = {
    run: run_all,
    state: () => S.state,
    results: () => list().map((c) => Object.assign({ key: c.key, id: c.id, name: c.name, group: c.group }, S.results.get(c.key) || { status: "pending" })),
  };

  HXUI.register_section({
    id: "selftest",
    title: "Self-test",
    nav: "Self-test",
    summary: "Golden vectors and acceptance checks, run in this page",
    needs: [],
    about: ABOUT,
    mount(el) { render(el); },
    /* complete at rest: the first visit runs every check */
    on_show() { if (S.state === "idle" && checks()) run_all(); },
  });
})();
