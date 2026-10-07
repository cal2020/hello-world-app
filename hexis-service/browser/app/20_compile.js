/* HEXIS Runtime Lab: Compile section. SKILL.md with its clause spans (HX.clauses), the live compile run
   (HX.compile.compile_procurement: attempts, findings, counterexample paths, final hash with a parity chip
   against the Python build), the clause coverage table, and admission as user:dana (HX.registry.admit).
   The section compiles once when it is first shown (complete at rest) and on "Compile skill". It stores the
   result in HXUI.lab.compile and emits lab:changed {what: "compile"}. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline" }, t);

  /* compile_procurement() runs the clause index, the fixture compiler model, validation, repair and diff */
  const NEEDS = ["compile", "clauses", "validate", "diff", "fixture", "catalog", "pkg", "efsm", "guards", "data"];
  /* admission also needs the registry, a store and the policy directory (for user:dana) */
  const ADMIT_NEEDS = ["registry", "store", "policy"];
  const ADMIN = "user:dana";
  const ADMIT_ENV = "sandbox";
  const LAB_EPOCH = 1790000000.25; /* the lab's manual clock starts here (specs/ui-round2.md) */

  /* plain data: HXUI.rich() sets {code} in mono and {strong} in bold when the list renders */
  const ABOUT = [
    ["Read ", { code: "SKILL.md" }, " with every clause tagged by its id (", { code: "S1.1" }, ", ", { code: "S1.2" }, ", …) and the ", { strong: "MUST" }, " clauses marked."],
    "Compile the skill and inspect each attempt: its status, its findings, and the counterexample path of any ordering violation.",
    ["Check clause coverage and compare the artifact hash with the Python build, then admit the package as ", { code: "user:dana" }, "."],
  ];

  const CLASS_INFO = {
    executable_control: { label: "Executable control", tone: "ok", note: "enforced by states and guards of the machine" },
    state_local_knowledge: { label: "State-local knowledge", tone: "neutral", note: "carried by one state's prompt or schema" },
    external_precondition: { label: "External precondition", tone: "neutral", note: "enforced outside the machine (catalog, adapter, broker)" },
    unsupported: { label: "Unsupported", tone: "warn", note: "not enforced: needs review or a trace refinement" },
  };

  /* ---------------------------------------------------------------- state */
  const S = {
    root: null, parts: null,
    result: null, ms: 0, error: null, runs: 0,
    clauses: [], clause_error: null,
    registry_store: null, admission: null, admissions: [], admit_error: null,
    stale: false, scheduled: false,
  };

  function err_text(e) {
    if (e && e.code && e.message) return e.code + ": " + e.message;
    return String((e && e.message) || e);
  }
  function ms_text(ms) { return ms < 1 ? "under 1 ms" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function python_build() { return globalThis.HX && HX.data && HX.data.python_build ? HX.data.python_build : null; }
  function reduced_motion() {
    try { return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- engine calls */
  function compile_now() {
    const t0 = performance.now();
    S.error = null;
    try {
      S.result = HX.compile.compile_procurement();
      S.ms = performance.now() - t0;
      S.runs += 1;
    } catch (e) {
      S.result = null;
      S.ms = performance.now() - t0;
      S.error = e;
    }
    publish();
  }

  function publish() {
    const r = S.result;
    if (!r) { HXUI.lab.compile = null; HXUI.lab_changed("compile"); return; }
    HXUI.lab.compile = {
      result: r, status: r.status, package: r.package, artifact_hash: r.package ? r.package.artifact_hash : null,
      attempts: r.attempts, coverage: r.coverage, review_required: r.review_required, ms: S.ms,
      admission: S.admission,
    };
    HXUI.lab_changed("compile");
  }

  function index_clauses() {
    try {
      S.clauses = HX.clauses.index_clauses(HX.data.skill_md);
      S.clause_error = null;
    } catch (e) {
      S.clauses = [];
      S.clause_error = e;
    }
  }

  function admit_now() {
    const r = S.result;
    if (!r || !r.package) return;
    S.admit_error = null;
    try {
      if (!S.registry_store) S.registry_store = new HX.store.Store(":memory:");
      const directory = new HX.policy.PolicyService(HX.data.policy);
      const approver = directory.authenticate(ADMIN);
      const catalog = HX.catalog.load_catalog(HX.data.tool_catalog);
      const res = HX.registry.admit(S.registry_store, r.package, catalog, {
        expected_parent_hash: null, approver, environment: ADMIT_ENV, now: LAB_EPOCH,
        deployment_policy: HX.fixture.deployment_policy(), skill_text: HX.data.skill_md,
      });
      /* only a returned result counts as an admission; the history keeps every one, newest first */
      S.admission = res;
      S.admissions.unshift({ n: S.admissions.length + 1, res });
    } catch (e) {
      S.admit_error = e;
    }
    if (HXUI.lab.compile) { HXUI.lab.compile.admission = S.admission; HXUI.lab_changed("compile"); }
  }

  /* ---------------------------------------------------------------- clause highlighting */
  let lit = [];
  let pinned = null; /* the clause a clause-id button went to: stays lit until focus leaves it or Back */
  function light(ids, opts) {
    const o = opts || {};
    for (const el of lit) el.classList.remove("is-lit");
    lit = [];
    if (!S.parts) return;
    if ((!ids || !ids.length) && pinned) ids = [pinned];
    for (const id of ids || []) {
      for (const el of S.root.querySelectorAll('[data-clause="' + CSS.escape(id) + '"]')) {
        el.classList.add("is-lit");
        lit.push(el);
      }
    }
    if (o.scroll && ids && ids.length) {
      const span = S.parts.source.querySelector('.cp-clause[data-clause="' + CSS.escape(ids[0]) + '"]');
      if (span) scroll_into_pane(S.parts.source, span);
    }
  }

  /* Scroll the skill pane (only the pane, never the page) so the clause is visible with some margin. */
  function scroll_into_pane(pane, el, instant) {
    const pr = pane.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const margin = 24;
    let delta = 0;
    if (er.top < pr.top + margin) delta = er.top - pr.top - margin;
    else if (er.bottom > pr.bottom - margin) delta = Math.min(er.bottom - pr.bottom + margin, er.top - pr.top - margin);
    if (!delta) return;
    try { pane.scrollBy({ top: delta, behavior: instant || reduced_motion() ? "auto" : "smooth" }); } catch (e) { pane.scrollTop += delta; }
  }

  /* Selecting a clause id lights the clause and scrolls the skill pane to it. When the pane is not on screen
     (one column, or the coverage table below the two columns) the page goes to the clause too, focus moves to
     it, and a "Back to ..." button above the pane returns to where the reader was. */
  let back_to = null;
  function in_view(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= (globalThis.innerHeight || document.documentElement.clientHeight);
  }
  /** Height of a sticky or fixed bar along the top of the viewport (the narrow section tabs), if any. */
  function top_inset() {
    let inset = 0;
    try {
      for (const el of document.elementsFromPoint(globalThis.innerWidth / 2, 1)) {
        for (let e = el; e && e !== document.body; e = e.parentElement) {
          const pos = getComputedStyle(e).position;
          if (pos === "sticky" || pos === "fixed") { inset = Math.max(inset, e.getBoundingClientRect().bottom); break; }
        }
      }
    } catch (e) { inset = 0; }
    return Math.min(inset, globalThis.innerHeight / 3);
  }
  function go_to_clause(id, origin, back_label) {
    light([id]);
    if (!S.parts) return;
    const span = S.parts.source.querySelector('.cp-clause[data-clause="' + CSS.escape(id) + '"]');
    if (!span) return;
    scroll_into_pane(S.parts.source, span, true);
    if (in_view(span)) return;
    /* a third of the way down the pane: pane-relative, so it holds wherever the page scrolls */
    const pane = S.parts.source;
    pane.scrollTop = Math.max(0, span.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - pane.clientHeight / 3);
    /* bring the whole panel (its head holds the Back button) to the top of the viewport */
    const behavior = reduced_motion() ? "auto" : "smooth";
    const panel = S.parts.source.closest(".cp-skill") || S.parts.source;
    const top = globalThis.scrollY + panel.getBoundingClientRect().top - top_inset() - 16;
    try { globalThis.scrollTo({ top, behavior }); } catch (e) { globalThis.scrollTo(0, top); }
    pinned = id;
    span.focus({ preventScroll: true });
    span.addEventListener("blur", () => { if (pinned === id) { pinned = null; light([]); } }, { once: true });
    light([id]);
    back_to = origin;
    const back = S.parts.back;
    if (back) {
      back.querySelector(".hx-btn-label").textContent = back_label || "Back";
      back.hidden = false;
    }
  }
  function go_back() {
    const origin = back_to && back_to.isConnected ? back_to : null;
    back_to = null;
    pinned = null;
    if (S.parts && S.parts.back) S.parts.back.hidden = true;
    light([]);
    if (!origin) return;
    const behavior = reduced_motion() ? "auto" : "smooth";
    try { origin.scrollIntoView({ block: "center", behavior }); } catch (e) { origin.scrollIntoView(); }
    origin.focus({ preventScroll: true });
  }

  /** clause_button(id, critical, {id, back}): a stable id is required; back names where "Back" returns to. */
  function clause_button(id, critical, opts) {
    const o = opts || {};
    const btn = h("button", {
      type: "button", class: ["cp-cid-btn", critical ? "is-critical" : null], id: o.id,
      dataset: { clauseRef: id }, title: "Show " + id + " in SKILL.md", "aria-label": "Show clause " + id + " in SKILL.md",
    }, id);
    btn.addEventListener("click", () => go_to_clause(id, btn, o.back));
    return btn;
  }

  /* ---------------------------------------------------------------- SKILL.md with clause spans */
  /** Code point offsets (Python's) -> UTF-16 offsets into the same string. */
  function cp_to_utf16(text) {
    const map = [0];
    let i = 0;
    for (const ch of text) { i += ch.length; map.push(i); }
    return map;
  }

  /** Non-clause text, line by line: Markdown headings get their own style. */
  function plain_segment(text) {
    const out = [];
    const lines = text.split(/(\n)/);
    for (const part of lines) {
      if (!part) continue;
      if (part === "\n") { out.push("\n"); continue; }
      const m = /^(#{1,6})(\s+)(.*)$/.exec(part);
      if (m) {
        out.push(h("span", { class: ["cp-heading", "cp-h" + m[1].length] },
          h("span", { class: "cp-hmark", "aria-hidden": "true" }, m[1] + m[2]), m[3]));
      } else {
        out.push(h("span", { class: "cp-plain" }, part));
      }
    }
    return out;
  }

  /** Clause text: **MUST** is shown as a strong MUST mark (the asterisks are Markdown). */
  function clause_text(text) {
    const parts = text.split(HX.clauses.CRITICAL_MARK);
    const out = [];
    parts.forEach((p, i) => {
      if (i) out.push(h("strong", { class: "cp-must" }, "MUST"));
      if (p) out.push(p);
    });
    return out;
  }

  function skill_view() {
    const text = HX.data.skill_md;
    const map = cp_to_utf16(text);
    const nodes = [];
    let pos = 0;
    for (const c of S.clauses) {
      const a = map[c.start], b = map[c.end];
      if (a > pos) nodes.push(...plain_segment(text.slice(pos, a)));
      const critical = HX.clauses.is_critical(c);
      nodes.push(h("span", {
        class: ["cp-clause", critical ? "is-critical" : null], id: "cp-clause-" + c.id, dataset: { clause: c.id }, tabindex: "-1",
      },
      h("span", { class: "cp-cid", "aria-hidden": "true" }, c.id),
      h("span", { class: "hx-visually-hidden" }, "Clause " + c.id + (critical ? ", critical: " : ": ")),
      clause_text(text.slice(a, b))));
      pos = b;
    }
    if (pos < text.length) nodes.push(...plain_segment(text.slice(pos)));
    const source = h("div", { class: "cp-source", id: "cp-source", tabindex: "0", role: "region", "aria-label": "SKILL.md with clause ids" }, nodes);
    source.addEventListener("mouseover", (e) => {
      const span = e.target instanceof Element ? e.target.closest(".cp-clause") : null;
      if (span) row_light(span.dataset.clause);
    });
    source.addEventListener("mouseleave", () => row_light(null));
    return source;
  }

  /** A clause hovered in the text marks its coverage row. */
  function row_light(id) {
    if (!S.parts) return;
    for (const tr of S.parts.coverage.querySelectorAll("tr.is-row-lit")) tr.classList.remove("is-row-lit");
    if (!id) return;
    for (const tr of S.parts.coverage.querySelectorAll('tr[data-row-clause="' + CSS.escape(id) + '"]')) tr.classList.add("is-row-lit");
  }

  function skill_panel() {
    const critical = S.clauses.filter((c) => HX.clauses.is_critical(c)).length;
    const pb = python_build();
    const count_ok = pb && typeof pb.clause_count === "number" ? pb.clause_count === S.clauses.length : null;
    const back = HXUI.button("Back", { id: "cp-skill-back", variant: "secondary", size: "sm", class: "cp-back", on_click: go_back });
    back.hidden = true;
    const meta = h("div", { class: "hx-panel-meta" }, back,
      HXUI.chip(plural(S.clauses.length, "clause"), count_ok === false ? "crit" : "neutral",
        { title: count_ok === null ? null : "The Python build indexes " + pb.clause_count + " clauses" }),
      HXUI.chip(critical + " MUST", "neutral", { class: "cp-must-chip" }));
    const body = S.clause_error
      ? HXUI.notice("crit", "The skill text could not be indexed", err_text(S.clause_error))
      : skill_view();
    return h("section", { class: "hx-panel cp-skill", "aria-labelledby": "cp-skill-title" },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "cp-skill-title" }, h("code", { class: "cp-title-code" }, "SKILL.md")),
        meta),
      h("p", { class: "cp-skill-lead" }, "Each list item and paragraph is one clause, indexed in this page. ",
        h("strong", { class: "cp-must cp-must-inline" }, "MUST"), " marks a critical clause, which the machine has to enforce."),
      body);
  }

  /* ---------------------------------------------------------------- summary strip */
  function summary_strip() {
    const r = S.result;
    const items = [];
    const item = (label, value, extra) => h("div", { class: "cp-stat" }, h("dt", { class: "hx-label" }, label), h("dd", null, value, extra || null));
    if (S.error) {
      items.push(item("Status", HXUI.chip("Compiler error", "crit", { icon: "stop" })));
    } else if (!r) {
      items.push(item("Status", HXUI.chip("Compiling", "neutral")));
    } else {
      const ok = r.status === "validated";
      items.push(item("Status", HXUI.status_chip(S.result.status, ok ? "ok" : "crit", { icon: ok ? "check" : "stop" })));
      const repairs = Math.max(0, r.attempts.length - 1);
      items.push(item("Attempts", h("span", { class: "cp-stat-text" }, String(r.attempts.length)),
        h("span", { class: "cp-stat-note" }, repairs ? plural(repairs, "repair") : "no repair")));
      const crit = r.coverage.filter((c) => c.critical);
      const crit_ok = crit.filter((c) => c.classification === "executable_control" && c.states.length).length;
      items.push(item("Critical clauses", h("span", { class: "cp-stat-text" }, crit_ok + " of " + crit.length),
        h("span", { class: "cp-stat-note" }, "executable")));
      const pb = python_build();
      const hash = r.package ? r.package.artifact_hash : "";
      const parity = !pb ? null : hash === pb.initial_artifact_hash
        ? HXUI.chip("Equal to Python", "ok", { icon: "check" }) : HXUI.chip("Differs from Python", "crit", { icon: "cross" });
      items.push(item("Artifact hash", HXUI.digest(hash, { short: 19, label: "artifact hash", id: "cp-sum-hash" }), parity));
    }
    return h("dl", { class: "cp-summary", id: "cp-summary", dataset: { status: S.error ? "error" : r ? r.status : "pending" } }, items);
  }

  /* ---------------------------------------------------------------- attempts */
  function path_chain(path, label) {
    const list = Array.isArray(path) ? path : [];
    return h("div", { class: "cp-path-wrap" },
      h("p", { class: "cp-path-label" }, label || "Counterexample path"),
      h("ol", { class: "cp-path", "aria-label": (label || "Counterexample path") + ", " + list.length + " states" },
        list.map((sid, i) => h("li", { class: ["cp-path-step", i === list.length - 1 ? "is-last" : null] },
          i ? h("span", { class: "cp-path-arrow", "aria-hidden": "true" }, "→") : null,
          h("code", { class: "cp-path-state" }, sid)))));
  }

  function where_bits(f, attempt, i) {
    const bits = [];
    if (f.state) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "state "), h("code", null, f.state)));
    if (f.edge !== null && f.edge !== undefined) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "edge "), h("code", null, String(f.edge))));
    if (f.variable) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "variable "), h("code", null, f.variable)));
    if (f.clause) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "clause "), clause_button(f.clause, false,
      { id: "cp-a" + attempt + "-f" + i + "-clause", back: "Back to attempt " + attempt })));
    return bits;
  }

  function finding_item(f, attempt, i) {
    const detail = f.detail || {};
    return h("li", { class: "cp-finding", dataset: { code: f.code } },
      h("div", { class: "cp-finding-head" },
        HXUI.chip(f.code, f.severity === "error" ? "crit" : "warn", { mono: true }),
        h("span", { class: "cp-where" }, where_bits(f, attempt, i))),
      h("p", { class: "cp-finding-msg" }, HXUI.plain_lists(f.message)),
      Array.isArray(detail.path) && detail.path.length ? path_chain(detail.path) : null);
  }

  function diff_note(diff, attempt) {
    if (!diff) return null;
    const rows = [];
    for (const ec of diff.edges_changed || []) {
      const parts = [];
      for (const t of ec.added || []) parts.push(h("li", { class: "cp-chg is-add" }, h("span", { class: "cp-chg-mark", "aria-hidden": "true" }, "+"),
        h("span", { class: "hx-visually-hidden" }, "added: "), "edge to ", h("code", null, t.to), t.if ? [" if ", h("code", null, t.if)] : " (default)"));
      for (const t of ec.removed || []) parts.push(h("li", { class: "cp-chg is-del" }, h("span", { class: "cp-chg-mark", "aria-hidden": "true" }, "−"),
        h("span", { class: "hx-visually-hidden" }, "removed: "), "edge to ", h("code", null, t.to), t.if ? [" if ", h("code", null, t.if)] : " (default)"));
      rows.push(h("div", { class: "cp-chg-state" }, h("p", null, h("code", null, ec.state)), h("ul", { class: "cp-chg-list" }, parts)));
    }
    const other = [];
    if ((diff.states_added || []).length) other.push("states added: " + diff.states_added.join(", "));
    if ((diff.states_removed || []).length) other.push("states removed: " + diff.states_removed.join(", "));
    if ((diff.actions_changed || []).length) other.push("actions changed: " + diff.actions_changed.map((a) => a.state || a).join(", "));
    if ((diff.contracts_changed || []).length) other.push("contracts changed: " + diff.contracts_changed.join(", "));
    if (diff.execution_policy_changed) other.push("execution policy changed");
    const clauses = diff.affected_clauses || [];
    return h("div", { class: "cp-diff" },
      h("p", { class: "cp-sub" }, "What the repair changed"),
      rows.length || other.length ? null : h("p", { class: "hx-faint" }, "Nothing structural."),
      rows,
      other.length ? h("p", { class: "cp-chg-other" }, other.join("; ") + ".") : null,
      clauses.length ? h("p", { class: "cp-chg-clauses" }, "Affected ", clauses.length === 1 ? "clause " : "clauses ",
        clauses.map((c) => clause_button(c, false, { id: "cp-a" + attempt + "-diff-" + c.replace(/\./g, "-"), back: "Back to attempt " + attempt }))) : null);
  }

  function attempt_card(a, i, list) {
    const valid = a.status === "valid";
    const findings = a.findings || [];
    const errors = findings.filter((f) => f.severity === "error");
    const last = i === list.length - 1;
    let lead;
    if (valid) lead = i === 0 ? "The first draft passed validation." : "The repaired draft passed validation.";
    else if (last) lead = "Validation rejected this draft and no attempts were left, so compilation failed.";
    else lead = "Validation rejected this draft. Its findings went back to the compiler model as diagnostics for the next attempt.";
    return h("li", { class: ["hx-card", "cp-attempt"], id: "cp-attempt-" + a.attempt, dataset: { status: a.status } },
      h("div", { class: "cp-attempt-head" },
        h("h4", { class: "cp-attempt-title" }, "Attempt " + a.attempt),
        HXUI.status_chip(a.status, valid ? "ok" : "crit", { icon: valid ? "check" : "cross" }),
        errors.length ? HXUI.chip(plural(errors.length, "finding"), "neutral") : null,
        h("span", { class: "cp-attempt-hash" }, h("span", { class: "cp-attempt-hash-k" }, "draft"),
          HXUI.digest(a.draft_hash, { short: 15, label: "draft hash of attempt " + a.attempt, id: "cp-attempt-" + a.attempt + "-hash" }))),
      h("p", { class: "cp-attempt-lead" }, lead),
      findings.length ? h("ul", { class: "cp-findings", "aria-label": "Findings of attempt " + a.attempt }, findings.map((f, k) => finding_item(f, a.attempt, k))) : null,
      a.diff_from_previous ? diff_note(a.diff_from_previous, a.attempt) : null);
  }

  function attempts_panel() {
    const r = S.result;
    const btn = HXUI.button(S.error ? "Try compiling again" : S.runs ? "Compile again" : "Compile skill", {
      id: "cp-compile", variant: "primary", icon: "play", on_click: () => {
        btn.setAttribute("aria-busy", "true");
        setTimeout(() => { compile_now(); render(); focus_after_compile(); }, 0);
      },
    });
    let body;
    if (S.error) {
      body = HXUI.notice("crit", "The compiler stopped with an error", h("div", { class: "hx-stack-tight" },
        h("p", null, "No package was produced, so there is no artifact, coverage or admission below. Try compiling again; if it fails again, open Self-test to see which engine modules loaded."),
        HXUI.code(err_text(S.error), { label: "Compiler error" })));
    } else if (!r) {
      body = h("p", { class: "cp-wait" }, "Compiling ", code("SKILL.md"), " in this page…");
    } else {
      body = h("ol", { class: "cp-attempts", "aria-label": "Compile attempts" }, r.attempts.map(attempt_card));
    }
    const timing = S.error
      ? h("p", { class: "cp-timing", id: "cp-timing" }, "The compiler stopped after " + ms_text(S.ms) + ".")
      : r ? h("p", { class: "cp-timing", id: "cp-timing" }, "Compiled in this page in " + ms_text(S.ms) + (S.runs > 1 ? " (run " + S.runs + ")" : "") + ".")
        : null;
    return h("section", { class: "hx-panel cp-attempts-panel", "aria-labelledby": "cp-attempts-title" },
      h("div", { class: "hx-panel-head" },
        h("h3", { class: "hx-panel-title", id: "cp-attempts-title" }, "Compile attempts"),
        r ? h("div", { class: "hx-panel-meta" }, HXUI.chip("Fixture compiler model", "info")) : null),
      h("p", { class: "hx-panel-lead" },
        "The compiler drafts a machine from the clauses, validates it, and feeds the findings back for at most two repairs. A scripted fixture model stands in for the language model, so every run gives the same drafts."),
      h("div", { class: "cp-actions" }, btn, timing),
      body);
  }

  function focus_after_compile() {
    const t = document.getElementById("cp-compile");
    if (t) t.focus();
    const r = S.result;
    if (S.error) HXUI.announce("The compiler stopped with an error.");
    else if (r) {
      const pb = python_build();
      const eq = pb && r.package && r.package.artifact_hash === pb.initial_artifact_hash;
      HXUI.announce("Compiled: " + r.status + " after " + plural(r.attempts.length, "attempt") + "." + (pb ? eq ? " The artifact hash equals the Python build." : " The artifact hash differs from the Python build." : ""));
    }
  }

  /* ---------------------------------------------------------------- artifact */
  function artifact_panel() {
    const r = S.result;
    if (!r) {
      if (!S.error) return null;
      return h("section", { class: "hx-panel cp-artifact", "aria-labelledby": "cp-artifact-title", dataset: { parity: "none" } },
        h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-artifact-title" }, "Artifact and admission")),
        h("p", { class: "cp-empty" }, "No package, so there is no hash to compare with the Python build and nothing to admit. Both appear after a successful compile."));
    }
    const pb = python_build();
    const pkg = r.package;
    const rows = [];
    if (pkg) {
      const eq = pb ? pkg.artifact_hash === pb.initial_artifact_hash : null;
      rows.push(h("div", { class: "cp-kv" }, h("dt", null, "This page"),
        h("dd", null, h("code", { class: "cp-hash", id: "cp-hash" }, pkg.artifact_hash), HXUI.copy_button(pkg.artifact_hash, { label: "artifact hash", id: "cp-hash-copy" }))));
      if (pb) {
        rows.push(h("div", { class: "cp-kv" }, h("dt", null, "Python build"),
          h("dd", null, h("code", { class: "cp-hash is-ref", id: "cp-hash-ref" }, pb.initial_artifact_hash), HXUI.copy_button(pb.initial_artifact_hash, { label: "Python artifact hash", id: "cp-hash-ref-copy" }))));
      }
      const rep = r.report;
      const analyses = rep ? rep.analyses || [] : [];
      const proven = analyses.filter((x) => x.status === "PROVEN").length;
      const parity = eq === null ? HXUI.chip("No Python value in this build", "neutral")
        : eq ? HXUI.chip("Equal to the Python build", "ok", { icon: "check" }) : HXUI.chip("Differs from the Python build", "crit", { icon: "cross" });
      const review = (r.review_required || []).length
        ? HXUI.notice("warn", "Needs review before production", h("ul", { class: "cp-review" }, r.review_required.map((t) => h("li", null, t))))
        : null;
      return h("section", { class: "hx-panel cp-artifact", "aria-labelledby": "cp-artifact-title", dataset: { parity: eq === null ? "none" : eq ? "equal" : "differs" } },
        h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-artifact-title" }, "Artifact"), h("div", { class: "hx-panel-meta", id: "cp-parity" }, parity)),
        h("p", { class: "hx-panel-lead" }, "The package is hashed over its canonical JSON. The same skill compiled by the Python reference gives the value below it."),
        h("dl", { class: "cp-kvs" }, rows),
        rep ? h("p", { class: "cp-report" },
          HXUI.chip(rep.passed ? "Validation passed" : "Validation failed", rep.passed ? "ok" : "crit"),
          /* one inline sentence: the strip is a flex row, which would put a gap around each code chip */
          h("span", { class: "cp-report-text" }, plural(analyses.length, "analysis", "analyses") + " (disjointness and loop bounds), " + proven + " proven. Validator ",
            code(rep.validator || (HX.validate && HX.validate.VALIDATOR_VERSION) || ""), ", profile ", code(rep.profile || "production"), ".")) : null,
        review);
    }
    return h("section", { class: "hx-panel cp-artifact", "aria-labelledby": "cp-artifact-title", dataset: { parity: "none" } },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-artifact-title" }, "Artifact")),
      HXUI.notice("crit", "No package: compilation was rejected", "Every attempt failed validation. The findings of the last attempt say what the machine still violates. Without a package there is nothing to admit."));
  }

  /* ---------------------------------------------------------------- admission */
  function admit_panel() {
    const r = S.result;
    if (!r || !r.package) return null;
    const missing = HXUI.engine_missing(ADMIT_NEEDS);
    const label = "Admit as " + ADMIN + " (artifact_admin)";
    const reason = missing.length ? "Admission needs engine modules that are not in this build: " + missing.join(", ") + "." : "";
    const again = S.admissions.length > 0;
    const btn = HXUI.button(again ? "Admit again" : label, {
      id: "cp-admit", variant: again ? "secondary" : "primary", disabled: !!reason, disabled_reason: reason,
      on_click: () => { admit_now(); render(); const b = document.getElementById("cp-admit"); if (b) b.focus(); announce_admission(); },
    });
    const parts = [h("div", { class: "cp-actions" }, btn,
      reason ? h("p", { class: "hx-reason", id: "cp-admit-reason" }, HXUI.icon("info"),
        h("span", null, "Admission needs engine modules that are not in this build: ", missing.map((n, i) => [i ? ", " : "", code(n)]), "."))
        : again ? h("p", { class: "hx-reason" }, HXUI.icon("info"), h("span", null, "Admitting the same package again tests the compare-and-swap on the active version.")) : null)];
    if (S.admit_error) {
      parts.push(HXUI.notice("crit", "Admission stopped with an error", h("div", { class: "hx-stack-tight" },
        h("p", null, "The registry raised an error instead of returning a result, so nothing was admitted. Reset the lab and admit again; if it repeats, Self-test lists the modules in this build."),
        HXUI.code(err_text(S.admit_error), { label: "Admission error" }))));
    }
    if (S.admissions.length) {
      parts.push(h("ol", { class: "cp-admissions", id: "cp-admissions", "aria-label": "Admissions, newest first", dataset: { latest: S.admissions[0].res.status } },
        S.admissions.map((a) => h("li", null, admission_result(a)))));
    }
    return h("section", { class: "hx-panel cp-admit", "aria-labelledby": "cp-admit-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-admit-title" }, "Admission")),
      h("p", { class: "hx-panel-lead" }, "Admission validates the package again against the operator's deployment policy, checks the approver's role and signs a record. It publishes into an in-memory registry owned by this section, in the ",
        code(ADMIT_ENV), " environment. The run workbench admits the same package into its own lab environment."),
      parts);
  }

  function status_chip(status) {
    const tone = status === "ADMITTED" ? "ok" : status === "CONFLICT" ? "warn" : "crit";
    return HXUI.status_chip(status, tone, { icon: status === "ADMITTED" ? "check" : status === "CONFLICT" ? "alert" : "stop" });
  }

  /** admitted_at is an ISO string from the registry (or epoch seconds from older stand-ins): shown as UTC. */
  function time_view(v) {
    let d = null;
    if (typeof v === "number" && isFinite(v)) d = new Date(v * 1000);
    else if (typeof v === "string" && v) d = new Date(v.replace(/(\.\d{3})\d+/, "$1"));
    if (!d || isNaN(d.getTime())) return h("code", null, String(v));
    const iso = d.toISOString();
    return h("time", { datetime: iso, title: "Lab clock, epoch seconds: " + (d.getTime() / 1000) },
      iso.slice(0, 10) + " " + iso.slice(11, 23) + " UTC");
  }

  function admission_note(res, n) {
    if (res.status === "ADMITTED") return "Version " + res.archive_version + " is now the active version in " + ADMIT_ENV + ".";
    if (res.status === "CONFLICT") {
      const prev = S.admissions.find((a) => a.n < n && a.res.status === "ADMITTED");
      const active = prev ? "version " + prev.res.archive_version : "a version";
      return "Expected outcome. The registry already has " + active + " active; this admission expected no active version (parent none), so the compare-and-swap refused it. Two admins can never overwrite each other's version.";
    }
    return "The registry refused the package. The reasons below say which gate failed.";
  }

  function admission_result(a) {
    const res = a.res, n = a.n;
    const rec = res.record || null;
    const pre = "cp-admit-" + n;
    const kv = (k, v) => h("div", { class: "cp-kv" }, h("dt", null, k), h("dd", null, v));
    const rows = [];
    if (res.archive_version !== null && res.archive_version !== undefined) rows.push(kv("Archive version", h("span", { class: "hx-num", id: pre + "-version" }, String(res.archive_version))));
    if (rec) {
      rows.push(kv("Signature key", [h("code", { id: pre + "-key" }, rec.key_id),
        rec.key_id === "insecure-demo-key" ? h("span", { class: "cp-note" }, "A fixed demo key, labelled as such in the record. Production deployments supply their own.") : null]));
      rows.push(kv("Approver", h("code", null, rec.approver)));
      rows.push(kv("Environment", h("code", null, rec.environment)));
      rows.push(kv("Admitted at", time_view(rec.admitted_at)));
      rows.push(kv("Signature", HXUI.digest(rec.signature, { short: 24, label: "signature of admission " + n, id: pre + "-sig" })));
      rows.push(kv("Report digest", HXUI.digest(rec.validation_report_digest, { short: 19, label: "validation report digest of admission " + n, id: pre + "-digest" })));
    }
    const reasons = res.reasons || [];
    return h("article", { class: "cp-admission", id: "cp-admission-" + n, dataset: { status: res.status }, "aria-labelledby": pre + "-title" },
      h("div", { class: "cp-admission-head" },
        h("h4", { class: "cp-admission-title", id: pre + "-title" }, "Admission " + n),
        status_chip(res.status)),
      h("p", { class: "cp-admission-note" }, admission_note(res, n)),
      rows.length ? h("dl", { class: "cp-kvs" }, rows) : null,
      reasons.length ? h("div", { class: "cp-reasons-wrap" }, h("p", { class: "cp-sub" }, "Registry reason"),
        h("ul", { class: "cp-reasons", "aria-label": "Registry reasons" }, reasons.map((t) => h("li", null, t)))) : null);
  }

  function announce_admission() {
    if (S.admit_error) HXUI.announce("Admission stopped with an error. Nothing was admitted.");
    else if (S.admission) HXUI.announce("Admission " + S.admissions.length + ": " + S.admission.status + ".");
  }

  /* ---------------------------------------------------------------- coverage */
  function coverage_panel() {
    const r = S.result;
    const head = (meta) => h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-cov-title" }, "Clause coverage"), meta || null);
    if (!r) {
      return h("section", { class: "hx-panel cp-coverage", "aria-labelledby": "cp-cov-title" }, head(),
        h("p", { class: "cp-empty" }, S.error
          ? "No coverage: the compiler stopped before it produced a package. Coverage appears after a successful compile."
          : "Coverage appears once the skill has compiled."));
    }
    const rows = r.coverage || [];
    const counts = {};
    for (const c of rows) counts[c.classification] = (counts[c.classification] || 0) + 1;
    const meta = h("div", { class: "hx-panel-meta" }, Object.keys(CLASS_INFO).filter((k) => counts[k]).map((k) =>
      HXUI.chip(counts[k] + " " + CLASS_INFO[k].label.toLowerCase(), CLASS_INFO[k].tone)));
    const class_chip = (c) => {
      const ci = CLASS_INFO[c.classification] || { label: c.classification, tone: "neutral", note: "" };
      return HXUI.chip(ci.label, ci.tone, { title: ci.note });
    };
    const must = () => h("strong", { class: "cp-must", title: "Critical clause" }, "MUST");
    const table = HXUI.table({
      caption: "How each clause is enforced", caption_hidden: true, class: "cp-cov-table",
      columns: [
        { key: "clause", label: "Clause", nowrap: true, render: (c) => clause_button(c.clause, c.critical,
          { id: "cp-cov-" + c.clause.replace(/\./g, "-"), back: "Back to coverage of " + c.clause }) },
        { key: "critical", label: "Critical", nowrap: true, render: (c) => (c.critical ? must() : h("span", { class: "hx-faint" }, "no")),
          fold: (c) => (c.critical ? must() : null) },
        { key: "classification", label: "Classification", nowrap: true, render: class_chip, fold: true },
        { key: "states", label: "States", render: (c) => c.states.length
          ? h("span", { class: "cp-states" }, c.states.map((s) => h("code", { class: "cp-state" }, s)))
          : h("span", { class: "hx-faint" }, "none"), fold: true, fold_label: "States" },
        { key: "justification", label: "Justification", render: (c) => h("span", { class: "cp-just" }, c.justification), fold: true },
      ],
      rows,
      row_attrs: (c) => ({
        dataset: { rowClause: c.clause, classification: c.classification, critical: c.critical ? "yes" : "no" },
        class: c.critical ? "is-critical" : null,
        on: {
          mouseenter: () => light([c.clause], { scroll: true }),
          mouseleave: () => light([]),
          focusin: () => light([c.clause], { scroll: true }),
          focusout: () => light([]),
        },
      }),
    });
    return h("section", { class: "hx-panel cp-coverage", "aria-labelledby": "cp-cov-title" }, head(meta),
      h("p", { class: "hx-panel-lead" }, "Every clause is classified. Executable control: states and guards the kernel enforces (every critical clause must be this). State-local knowledge: guidance carried by one state's prompt or schema. External precondition: enforced outside the machine, by the tool catalog, an adapter or the broker. Unsupported: not enforced, so it needs review. Hover or focus a row to highlight its clause; select a clause id to go to it."),
      table);
  }

  /* ---------------------------------------------------------------- section */
  /* DOM order is summary, results, skill text, coverage (summary before detail, also for screen readers); on
     wide screens the grid places the skill text in the left column beside the results. */
  function render() {
    if (!S.root) return;
    const scroll_pane = S.parts && S.parts.source ? S.parts.source.scrollTop : 0;
    lit = [];
    back_to = null;
    pinned = null;
    const skill = skill_panel();
    const coverage = coverage_panel();
    const work = h("div", { class: "cp-work hx-ruled" }, attempts_panel(), artifact_panel(), admit_panel());
    const grid = h("div", { class: "cp-grid" }, work, h("div", { class: "cp-skill-col" }, skill));
    S.root.replaceChildren(summary_strip(), grid, coverage);
    S.parts = { source: skill.querySelector(".cp-source") || h("div"), coverage, back: skill.querySelector("#cp-skill-back") };
    if (S.parts.source) S.parts.source.scrollTop = scroll_pane;
  }

  function schedule_compile() {
    if (S.scheduled) return;
    S.scheduled = true;
    setTimeout(() => {
      S.scheduled = false;
      compile_now();
      render();
    }, 0);
  }

  function on_reset() {
    S.result = null; S.error = null; S.runs = 0; S.ms = 0;
    S.registry_store = null; S.admission = null; S.admissions = []; S.admit_error = null;
    if (!S.root) return;
    render();
    if (HXUI.current() === "compile") schedule_compile();
    else S.stale = true;
  }

  HXUI.bus.on("lab:reset", on_reset);

  HXUI.register_section({
    id: "compile",
    title: "Compile",
    nav: "Compile",
    summary: "From the written skill to an admitted state machine",
    needs: NEEDS,
    about: ABOUT,
    mount(el) {
      S.root = h("div", { class: "cp" });
      el.appendChild(S.root);
      index_clauses();
      render();
      schedule_compile(); /* first paint before any engine work */
    },
    on_show() {
      if (S.stale) { S.stale = false; schedule_compile(); }
    },
  });

  /** For the guided demo and tests: the last compile and admission. */
  HXUI.compile_view = {
    result: () => S.result,
    admission: () => S.admission,
    compile: () => { compile_now(); render(); return S.result; },
    highlight: (ids) => light(ids || [], { scroll: true }),
  };
})();
