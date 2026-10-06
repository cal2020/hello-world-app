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
    registry_store: null, admission: null, admit_error: null, admits: 0,
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
      S.admits += 1;
      S.admission = HX.registry.admit(S.registry_store, r.package, catalog, {
        expected_parent_hash: null, approver, environment: ADMIT_ENV, now: LAB_EPOCH,
        deployment_policy: HX.fixture.deployment_policy(), skill_text: HX.data.skill_md,
      });
    } catch (e) {
      S.admission = null;
      S.admit_error = e;
    }
    if (HXUI.lab.compile) { HXUI.lab.compile.admission = S.admission; HXUI.lab_changed("compile"); }
  }

  /* ---------------------------------------------------------------- clause highlighting */
  let lit = [];
  function light(ids, opts) {
    const o = opts || {};
    for (const el of lit) el.classList.remove("is-lit");
    lit = [];
    if (!S.parts) return;
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
  function scroll_into_pane(pane, el) {
    const pr = pane.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const margin = 24;
    let delta = 0;
    if (er.top < pr.top + margin) delta = er.top - pr.top - margin;
    else if (er.bottom > pr.bottom - margin) delta = Math.min(er.bottom - pr.bottom + margin, er.top - pr.top - margin);
    if (!delta) return;
    try { pane.scrollBy({ top: delta, behavior: reduced_motion() ? "auto" : "smooth" }); } catch (e) { pane.scrollTop += delta; }
  }

  function clause_button(id, critical, opts) {
    const o = opts || {};
    const btn = h("button", {
      type: "button", class: ["cp-cid-btn", critical ? "is-critical" : null], id: o.id || null,
      dataset: { clauseRef: id }, title: "Show " + id + " in SKILL.md", "aria-label": "Show clause " + id + " in SKILL.md",
    }, id);
    btn.addEventListener("click", () => light([id], { scroll: true }));
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
        class: ["cp-clause", critical ? "is-critical" : null], id: "cp-clause-" + c.id, dataset: { clause: c.id },
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
    const meta = h("div", { class: "hx-panel-meta" },
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
      items.push(item("Status", HXUI.chip(ok ? "Validated" : "Rejected", ok ? "ok" : "crit", { icon: ok ? "check" : "stop" })));
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

  function where_bits(f) {
    const bits = [];
    if (f.state) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "state "), h("code", null, f.state)));
    if (f.edge !== null && f.edge !== undefined) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "edge "), h("code", null, String(f.edge))));
    if (f.variable) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "variable "), h("code", null, f.variable)));
    if (f.clause) bits.push(h("span", { class: "cp-where-item" }, h("span", { class: "cp-where-k" }, "clause "), clause_button(f.clause, false)));
    return bits;
  }

  function finding_item(f) {
    const detail = f.detail || {};
    return h("li", { class: "cp-finding", dataset: { code: f.code } },
      h("div", { class: "cp-finding-head" },
        HXUI.chip(f.code, f.severity === "error" ? "crit" : "warn", { mono: true }),
        h("span", { class: "cp-where" }, where_bits(f))),
      h("p", { class: "cp-finding-msg" }, f.message),
      Array.isArray(detail.path) && detail.path.length ? path_chain(detail.path) : null);
  }

  function diff_note(diff) {
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
        clauses.map((c) => clause_button(c, false))) : null);
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
        HXUI.chip(valid ? "Valid" : "Invalid", valid ? "ok" : "crit", { icon: valid ? "check" : "cross" }),
        errors.length ? HXUI.chip(plural(errors.length, "finding"), "neutral") : null,
        h("span", { class: "cp-attempt-hash" }, h("span", { class: "cp-attempt-hash-k" }, "draft"),
          HXUI.digest(a.draft_hash, { short: 15, label: "draft hash of attempt " + a.attempt }))),
      h("p", { class: "cp-attempt-lead" }, lead),
      findings.length ? h("ul", { class: "cp-findings", "aria-label": "Findings of attempt " + a.attempt }, findings.map(finding_item)) : null,
      a.diff_from_previous ? diff_note(a.diff_from_previous) : null);
  }

  function attempts_panel() {
    const r = S.result;
    const btn = HXUI.button(S.runs ? "Compile again" : "Compile skill", {
      id: "cp-compile", variant: "primary", icon: "play", on_click: () => {
        btn.setAttribute("aria-busy", "true");
        setTimeout(() => { compile_now(); render(); focus_after_compile(); }, 0);
      },
    });
    let body;
    if (S.error) {
      body = HXUI.notice("crit", "The compiler stopped with an error", h("div", { class: "hx-stack-tight" },
        h("p", null, "No package was produced. Compile again; if it fails again, open Self-test to see which engine modules loaded."),
        HXUI.code(err_text(S.error), { label: "Compiler error" })));
    } else if (!r) {
      body = h("p", { class: "cp-wait" }, "Compiling ", code("SKILL.md"), " in this page…");
    } else {
      body = h("ol", { class: "cp-attempts", "aria-label": "Compile attempts" }, r.attempts.map(attempt_card));
    }
    const timing = r || S.error
      ? h("p", { class: "cp-timing", id: "cp-timing" }, "Compiled in this page in " + ms_text(S.ms) + (S.runs > 1 ? " (run " + S.runs + ")" : "") + ".")
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
    if (!r) return null;
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
          " ", plural(analyses.length, "analysis", "analyses") + " (disjointness and loop bounds), " + proven + " proven. Validator ",
          code(rep.validator || (HX.validate && HX.validate.VALIDATOR_VERSION) || ""), ", profile ", code(rep.profile || "production"), ".") : null,
        review);
    }
    return h("section", { class: "hx-panel cp-artifact", "aria-labelledby": "cp-artifact-title", dataset: { parity: "none" } },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-artifact-title" }, "Artifact")),
      HXUI.notice("crit", "No package: compilation was rejected", "Every attempt failed validation. The findings of the last attempt say what the machine still violates."));
  }

  /* ---------------------------------------------------------------- admission */
  function admit_panel() {
    const r = S.result;
    if (!r || !r.package) return null;
    const missing = HXUI.engine_missing(ADMIT_NEEDS);
    const label = "Admit as " + ADMIN + " (artifact_admin)";
    const reason = missing.length ? "Admission needs engine modules that are not in this build: " + missing.join(", ") + "." : "";
    const btn = HXUI.button(S.admits ? "Admit again" : label, {
      id: "cp-admit", variant: S.admits ? "secondary" : "primary", disabled: !!reason, disabled_reason: reason,
      on_click: () => { admit_now(); render(); const b = document.getElementById("cp-admit"); if (b) b.focus(); announce_admission(); },
    });
    const parts = [h("div", { class: "cp-actions" }, btn,
      reason ? h("p", { class: "hx-reason", id: "cp-admit-reason" }, HXUI.icon("info"),
        h("span", null, "Admission needs engine modules that are not in this build: ", missing.map((n, i) => [i ? ", " : "", code(n)]), "."))
        : S.admits ? h("p", { class: "hx-reason" }, HXUI.icon("info"), h("span", null, "Admitting the same package again tests the compare-and-swap on the active version.")) : null)];
    if (S.admit_error) {
      parts.push(HXUI.notice("crit", "Admission stopped with an error", h("div", { class: "hx-stack-tight" },
        h("p", null, "The registry raised an error instead of returning a result. Reset the lab and admit again; if it repeats, Self-test lists the modules in this build."),
        HXUI.code(err_text(S.admit_error), { label: "Admission error" }))));
    } else if (S.admission) {
      parts.push(admission_result(S.admission));
    }
    return h("section", { class: "hx-panel cp-admit", "aria-labelledby": "cp-admit-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-admit-title" }, "Admission"),
        S.admission ? h("div", { class: "hx-panel-meta" }, status_chip(S.admission.status)) : null),
      h("p", { class: "hx-panel-lead" }, "Admission validates the package again against the operator's deployment policy, checks the approver's role and signs a record. It publishes into an in-memory registry owned by this section, in the ",
        code(ADMIT_ENV), " environment. The run workbench admits the same package into its own lab environment."),
      parts);
  }

  function status_chip(status) {
    const tone = status === "ADMITTED" ? "ok" : status === "CONFLICT" ? "warn" : "crit";
    return HXUI.chip(status, tone, { mono: true, icon: status === "ADMITTED" ? "check" : status === "CONFLICT" ? "alert" : "stop" });
  }

  function admission_result(res) {
    const rec = res.record || null;
    const kv = (k, v) => h("div", { class: "cp-kv" }, h("dt", null, k), h("dd", null, v));
    const rows = [kv("Status", status_chip(res.status))];
    if (res.archive_version !== null && res.archive_version !== undefined) rows.push(kv("Archive version", h("span", { class: "hx-num", id: "cp-admit-version" }, String(res.archive_version))));
    if (rec) {
      rows.push(kv("Signature key", h("code", { id: "cp-admit-key" }, rec.key_id)));
      if (rec.key_id === "insecure-demo-key") rows.push(kv("", h("span", { class: "cp-note" }, "A fixed demo key, labelled as such in the record. Production deployments supply their own.")));
      rows.push(kv("Approver", h("code", null, rec.approver)));
      rows.push(kv("Environment", h("code", null, rec.environment)));
      rows.push(kv("Admitted at", h("code", null, rec.admitted_at)));
      rows.push(kv("Signature", HXUI.digest(rec.signature, { short: 24, label: "signature" })));
      rows.push(kv("Report digest", HXUI.digest(rec.validation_report_digest, { short: 19, label: "validation report digest" })));
    }
    const reasons = res.reasons || [];
    return h("div", { class: "cp-admission", id: "cp-admission", dataset: { status: res.status } },
      h("dl", { class: "cp-kvs" }, rows),
      reasons.length ? h("ul", { class: "cp-reasons", "aria-label": "Reasons" }, reasons.map((t) => h("li", null, t))) : null);
  }

  function announce_admission() {
    if (S.admit_error) HXUI.announce("Admission stopped with an error.");
    else if (S.admission) HXUI.announce("Admission result: " + S.admission.status + ".");
  }

  /* ---------------------------------------------------------------- coverage */
  function coverage_panel() {
    const r = S.result;
    if (!r) return h("section", { class: "hx-panel cp-coverage", "aria-labelledby": "cp-cov-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-cov-title" }, "Clause coverage")));
    const rows = r.coverage || [];
    const counts = {};
    for (const c of rows) counts[c.classification] = (counts[c.classification] || 0) + 1;
    const meta = h("div", { class: "hx-panel-meta" }, Object.keys(CLASS_INFO).filter((k) => counts[k]).map((k) =>
      HXUI.chip(counts[k] + " " + CLASS_INFO[k].label.toLowerCase(), CLASS_INFO[k].tone)));
    const table = HXUI.table({
      caption: "How each clause is enforced", caption_hidden: true, class: "cp-cov-table",
      columns: [
        { key: "clause", label: "Clause", nowrap: true, render: (c) => h("span", { class: "cp-cov-id" }, clause_button(c.clause, c.critical, { id: "cp-cov-" + c.clause.replace(/\./g, "-") }),
          c.critical ? h("strong", { class: "cp-must", title: "Critical clause" }, "MUST") : null) },
        { key: "classification", label: "Classification", nowrap: true, render: (c) => {
          const ci = CLASS_INFO[c.classification] || { label: c.classification, tone: "neutral", note: "" };
          return HXUI.chip(ci.label, ci.tone, { title: ci.note });
        } },
        { key: "states", label: "States", render: (c) => c.states.length
          ? h("span", { class: "cp-states" }, c.states.map((s) => h("code", { class: "cp-state" }, s)))
          : h("span", { class: "hx-faint" }, "none"), fold: true, fold_label: "States" },
        { key: "justification", label: "Justification", render: (c) => h("span", { class: "cp-just" }, c.justification), fold: true },
      ],
      rows,
      row_attrs: (c) => ({
        dataset: { rowClause: c.clause },
        class: c.critical ? "is-critical" : null,
        on: {
          mouseenter: () => light([c.clause], { scroll: true }),
          mouseleave: () => light([]),
          focusin: () => light([c.clause], { scroll: true }),
          focusout: () => light([]),
        },
      }),
    });
    return h("section", { class: "hx-panel cp-coverage", "aria-labelledby": "cp-cov-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "cp-cov-title" }, "Clause coverage"), meta),
      h("p", { class: "hx-panel-lead" }, "Every clause is classified. Critical clauses must be executable control: states and guards the kernel enforces. Point at a row, or focus its clause id, to find the clause in the skill text."),
      table);
  }

  /* ---------------------------------------------------------------- section */
  function render() {
    if (!S.root) return;
    const scroll_pane = S.parts && S.parts.source ? S.parts.source.scrollTop : 0;
    lit = [];
    const skill = skill_panel();
    const coverage = coverage_panel();
    const work = h("div", { class: "cp-work hx-ruled" }, attempts_panel(), artifact_panel(), admit_panel(), coverage);
    const grid = h("div", { class: "cp-grid" }, h("div", { class: "cp-skill-col" }, skill), work);
    S.root.replaceChildren(summary_strip(), grid);
    S.parts = { source: skill.querySelector(".cp-source") || h("div"), coverage };
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
    S.registry_store = null; S.admission = null; S.admit_error = null; S.admits = 0;
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
