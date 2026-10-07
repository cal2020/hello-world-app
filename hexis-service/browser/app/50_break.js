/* HEXIS Runtime Lab: Break it. Two tools:
   * Mutation lab: the named mutations of the Python conformance tests (HXUI.mutations, app/52_mutations.js).
     Selecting one shows the changed element before and after and runs HX.validate.validate_package live, with
     the skill text and the operator's deployment policy, like admission does. Every mutation is also checked in
     the background (in chunks) for the scoreboard: the Python test's assertions, the full code set and the
     resealed artifact hash against the Python build's.
   * Guard playground: HX.guards.typecheck, analyze_disjoint and evaluate / evaluate3 on guards you edit, with
     the machine's variable types. Guards are parsed and checked, never executed. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline" }, t);

  const NEEDS = ["guards"];
  const LAB_NEEDS = ["validate", "compile", "pkg", "catalog", "fixture", "data", "efsm", "clauses", "diff"];
  const MACHINE_NEEDS = ["compile", "efsm", "fixture", "catalog", "pkg", "clauses", "validate", "diff", "data"];
  const DEFAULT_MUTATION = "a17-shortcut";
  const DEFAULT_STATE = "VALIDATE_DRAFT";
  const TYPES = ["string", "integer", "number", "boolean", "array", "object"];

  /* plain data: HXUI.rich() sets {code} in mono when the list renders */
  const ABOUT = [
    "Apply a named mutation, such as removing the verifier, widening the approval guard or tampering with the hash, and compare the JSON before and after.",
    ["Run ", { code: "validate_package" }, " on the mutated package and read each finding with its code, location and message."],
    "Edit guards and variable types to see parse errors, type errors and overlap counterexamples live, then evaluate a guard against your own JSON environment.",
  ];

  const ENV_PRESETS = {
    READ_INTAKE: { docs_status: "available" },
    LOOKUP_SUPPLIER: { lookup_status: "conflict" },
    VALIDATE_DRAFT: { validation_status: "repairable", repair_count: 1 },
    REQUEST_APPROVAL: { approval_decision: "rejected" },
    PERSIST_DRAFT: { persist_status: "created" },
    READ_BACK: { readback_status: "unavailable", readback_count: 1 },
    VERIFY_PERSISTED: { verify_status: "match" },
  };
  const EXAMPLES = [
    { id: "ex-overlap", label: "Example: overlapping guards (A08)",
      guards: ["validation_status == 'pass'", "validation_status in ['pass', 'repairable'] and repair_count < 2"],
      env: { validation_status: "pass", repair_count: 0 } },
    { id: "ex-unknown", label: "Example: undecidable comparison (A08)",
      guards: ["validation_status == 'pass'", "validation_status == 'repairable' and repair_count < readback_count"],
      env: { validation_status: "repairable", repair_count: 0 } },
    { id: "ex-malicious", label: "Example: malicious guards (A03)",
      guards: ["__import__('os').system('touch /tmp/pwned') == 0", "constructor.constructor('globalThis.__hx_pwned = 1')() == 1",
        "draft.__class__ == 'x'", "lambda: 1", "not " .repeat(20) + "(validation_status == 'pass')"],
      env: { validation_status: "pass" } },
  ];

  /* ================================================================ shared helpers */
  function err_text(e) {
    if (e && e.code && e.message) return e.code + ": " + e.message;
    return String((e && e.message) || e);
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function pretty(v) { return v === undefined ? "(absent)" : JSON.stringify(v, null, 2); }
  function py_value(v) {
    if (v === null) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string" && HX.guards && HX.guards._py_repr_str) return HX.guards._py_repr_str(v);
    return JSON.stringify(v);
  }

  /** Line diff (longest common subsequence) -> [{t: " " | "-" | "+", s}] */
  function line_diff(a, b) {
    const A = a.split("\n"), B = b.split("\n");
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: " ", s: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: "-", s: A[i] }); i++; }
      else { out.push({ t: "+", s: B[j] }); j++; }
    }
    while (i < n) out.push({ t: "-", s: A[i++] });
    while (j < m) out.push({ t: "+", s: B[j++] });
    return out;
  }

  /** Keep 3 lines of context around changes; longer unchanged runs fold into one note line. */
  function collapse(ops, ctx) {
    const keep = ops.map(() => false);
    ops.forEach((o, i) => { if (o.t !== " ") for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true; });
    const out = [];
    let skipped = 0;
    ops.forEach((o, i) => {
      if (keep[i]) {
        if (skipped) { out.push({ t: "~", s: plural(skipped, "unchanged line") }); skipped = 0; }
        out.push(o);
      } else skipped++;
    });
    if (skipped) out.push({ t: "~", s: plural(skipped, "unchanged line") });
    return out;
  }

  /** A run of n removed lines followed by n added lines is a set of edited lines: pair them, so each pair can
      mark the characters that changed (common prefix and suffix stay plain). */
  function pair_edits(ops) {
    for (let i = 0; i < ops.length;) {
      if (ops[i].t !== "-") { i++; continue; }
      let j = i;
      while (j < ops.length && ops[j].t === "-") j++;
      let k = j;
      while (k < ops.length && ops[k].t === "+") k++;
      if (k - j === j - i) {
        for (let n = 0; n < j - i; n++) { ops[i + n].pair = ops[j + n].s; ops[j + n].pair = ops[i + n].s; }
      }
      i = k > i ? k : i + 1;
    }
    return ops;
  }

  const ELIDE = 48; /* unchanged characters kept on each side of an in-line change */
  function elided(text, keep_end) {
    if (text.length <= ELIDE * 2) return [text];
    const n = text.length - ELIDE;
    const note = h("span", { class: "br-elide" }, "… " + n + " unchanged characters …");
    return keep_end ? [note, text.slice(-ELIDE)] : [text.slice(0, ELIDE), note];
  }

  /** The text of an edited line: unchanged start, the changed middle in a mark, unchanged end. */
  function line_text(o) {
    if (o.pair === undefined || !o.s) return o.s || " ";
    const a = o.s, b = o.pair;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const mid = a.slice(p, a.length - q);
    return [elided(a.slice(0, p), true), mid ? h("mark", { class: "br-intra" }, mid) : null, elided(a.slice(a.length - q), false)];
  }

  function diff_block(label, before, after) {
    const ops = pair_edits(collapse(line_diff(before, after), 3));
    const adds = ops.filter((o) => o.t === "+").length, dels = ops.filter((o) => o.t === "-").length;
    const lines = ops.map((o) => {
      if (o.t === "~") return h("span", { class: "br-line is-fold" }, h("span", { class: "br-mark", "aria-hidden": "true" }, "⋯"), h("span", { class: "br-text" }, o.s));
      const cls = o.t === "+" ? "is-add" : o.t === "-" ? "is-del" : "is-ctx";
      const sr = o.t === "+" ? "added: " : o.t === "-" ? "removed: " : "";
      return h("span", { class: ["br-line", cls] },
        h("span", { class: "br-mark", "aria-hidden": "true" }, o.t === "-" ? "−" : o.t),
        sr ? h("span", { class: "hx-visually-hidden" }, sr) : null,
        h("span", { class: "br-text" }, line_text(o)));
    });
    return h("figure", { class: "br-diff" },
      h("figcaption", { class: "br-diff-head" }, HXUI.wrap_id(label, { class: "br-diff-path" }),
        h("span", { class: "br-diff-count" }, h("span", { class: "br-add-n" }, "+" + adds), " ", h("span", { class: "br-del-n" }, "−" + dels))),
      h("pre", { class: "br-diff-code" }, lines));
  }

  /* ================================================================ base package (compiled once) */
  /* A failure is kept until the lab is reset, so 42 mutations and the playground do not each compile again. */
  let BASE = null;
  let BASE_ERROR = null;
  function base() {
    if (BASE) return BASE;
    if (BASE_ERROR) throw BASE_ERROR;
    try {
      const c = HXUI.lab && HXUI.lab.compile && HXUI.lab.compile.package ? HXUI.lab.compile.package : HX.compile.compile_procurement().package;
      if (!c) throw new Error("The compiler returned no package, so there is nothing to mutate.");
      BASE = JSON.parse(JSON.stringify(c));
    } catch (e) {
      BASE_ERROR = e;
      throw e;
    }
    return BASE;
  }
  let CATALOG = null;
  function catalog() { return CATALOG || (CATALOG = HX.catalog.load_catalog(HX.data.tool_catalog)); }

  /* ================================================================ mutation lab */
  const results = {}; /* id -> evaluation */

  function evaluate_mutation(m) {
    const t0 = performance.now();
    const out = { id: m.id, state: "error" };
    try {
      const pkg = HXUI.mutations.build(m, base());
      const skill_text = typeof m.skill === "function" ? m.skill(HX.data.skill_md) : HX.data.skill_md;
      const rep = HX.validate.validate_package(pkg, catalog(), "production", { skill_text, deployment_policy: HX.fixture.deployment_policy() });
      const rj = rep.to_json();
      const errors = rep.errors().map((f) => f.to_json());
      const view = { codes: rep.codes(), errors, passed: rep.passed };
      const asserts = m.asserts.map((a) => { let ok = false; try { ok = !!a.test(view); } catch (e) { ok = false; } return { text: a.text, ok }; });
      const codes = Array.from(rep.codes()).sort();
      const py = m.python || { codes: [], hash: "" };
      Object.assign(out, {
        pkg, report: rj, findings: rj.findings, codes, passed: rep.passed, asserts,
        codes_equal: JSON.stringify(codes) === JSON.stringify(py.codes.slice().sort()),
        hash_equal: (pkg.artifact_hash || "") === (py.hash || ""),
        skill_text,
      });
      const caught = !rep.passed && asserts.every((a) => a.ok);
      out.state = !caught ? "missed" : out.codes_equal && out.hash_equal ? "caught" : "differs";
    } catch (e) {
      out.error = e;
    }
    out.ms = performance.now() - t0;
    results[m.id] = out;
    return out;
  }

  /* [list label, detail label, tone, icon]. Caught is the expected state: in the list it is a quiet check mark,
     so the ones that differ, are missed or failed stand out. */
  const STATE_CHIP = {
    caught: ["Caught", "Caught: rejected as in Python", "ok", "check"],
    differs: ["Differs", "Caught, but differs from Python", "warn", "alert"],
    missed: ["Not caught", "Not caught: passes validation", "crit", "cross"],
    error: ["Error", "Could not be checked", "crit", "stop"],
    pending: ["Checking", "Checking", "neutral", null],
  };
  function state_label(st) { return (STATE_CHIP[st] || STATE_CHIP.pending)[0]; }
  function state_chip(st) {
    const s = STATE_CHIP[st] || STATE_CHIP.pending;
    return HXUI.chip(s[1], s[2], { icon: s[3] || undefined });
  }
  function state_mark(st) {
    const s = STATE_CHIP[st] || STATE_CHIP.pending;
    if (st === "caught") return h("span", { class: "br-mut-ok" }, HXUI.icon("check"), h("span", { class: "hx-visually-hidden" }, s[0]));
    if (st === "pending" || !STATE_CHIP[st]) return h("span", { class: "br-mut-wait" }, h("span", { "aria-hidden": "true" }, "…"), h("span", { class: "hx-visually-hidden" }, s[0]));
    return HXUI.chip(s[0], s[2], { icon: s[3] || undefined });
  }

  const L = { root: null, list: null, select: null, detail: null, meta: null, selected: DEFAULT_MUTATION, sweep: 0 };

  function lab_meta() {
    const list = HXUI.mutations.list;
    const done = list.filter((m) => results[m.id]);
    const counts = {};
    for (const m of done) counts[results[m.id].state] = (counts[results[m.id].state] || 0) + 1;
    const chips = [];
    if (done.length === list.length && L.meta.dataset.done !== "yes") HXUI.announce("Mutation lab: " + (counts.caught || 0) + " of " + list.length + " mutations caught as in Python.");
    if (done.length < list.length) chips.push(HXUI.chip("Checking " + done.length + " of " + list.length, "neutral"));
    else chips.push(HXUI.chip((counts.caught || 0) + " of " + list.length + " caught as in Python", counts.caught === list.length ? "ok" : "warn", { icon: counts.caught === list.length ? "check" : "alert" }));
    if (counts.differs) chips.push(HXUI.chip(counts.differs + " differ from Python", "warn"));
    if (counts.missed) chips.push(HXUI.chip(counts.missed + " not caught", "crit"));
    if (counts.error) chips.push(HXUI.chip(plural(counts.error, "error"), "crit"));
    L.meta.replaceChildren(...chips);
    L.meta.dataset.done = done.length === list.length ? "yes" : "no";
    paint_strip(done, counts);
  }

  /** the section's summary strip: the sweep, the selected mutation, and parity with the Python test's findings */
  function paint_strip(done, counts) {
    if (!L.strip) return;
    const list = HXUI.mutations.list;
    const all = done.length === list.length;
    const m = HXUI.mutations.find(L.selected);
    const r = results[L.selected];
    const parity = done.filter((x) => results[x.id].codes_equal && results[x.id].hash_equal).length;
    L.strip.hx.set([
      { id: "br-sum-caught", label: "Caught as in Python", value: [h("span", { class: "hx-num" }, String(counts.caught || 0)), h("span", { class: "br-sum-of" }, "of " + list.length)],
        note: all ? (counts.caught === list.length ? "every mutation rejected" : (list.length - (counts.caught || 0)) + " need a look") : "checking " + done.length + " of " + list.length },
      { id: "br-sum-selected", label: "Selected", value: m ? h("span", { class: "br-sum-title" }, m.title) : "none", note: r ? (STATE_CHIP[r.state] || STATE_CHIP.pending)[1] : "checking" },
      { id: "br-sum-findings", label: "Findings", value: h("span", { class: "hx-num" }, r && r.findings ? String(r.findings.length) : "–"),
        note: r && r.codes ? plural(r.codes.length, "distinct code") : null },
      { id: "br-sum-parity", label: "Codes and hash equal Python", value: [h("span", { class: "hx-num" }, String(parity)), h("span", { class: "br-sum-of" }, "of " + done.length)],
        note: "validate_package in this page" },
    ]);
  }

  function paint_item(id) {
    const btn = L.list && L.list.querySelector('[data-mutation="' + id + '"]');
    if (!btn) return;
    const r = results[id];
    btn.dataset.state = r ? r.state : "pending";
    btn.querySelector(".br-mut-status").replaceChildren(state_mark(r ? r.state : "pending"));
    const opt = L.select && L.select.querySelector('option[value="' + id + '"]');
    if (opt) opt.textContent = HXUI.mutations.find(id).title + (r ? " · " + state_label(r.state) : "");
  }

  function sweep() {
    const token = ++L.sweep;
    const queue = HXUI.mutations.list.filter((m) => !results[m.id]);
    const step = () => {
      if (token !== L.sweep) return;
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 12) {
        const m = queue.shift();
        if (!results[m.id]) evaluate_mutation(m);
        paint_item(m.id);
      }
      lab_meta();
      if (queue.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  function select_mutation(id, opts) {
    const o = opts || {};
    const m = HXUI.mutations.find(id);
    if (!m) return;
    L.selected = id;
    for (const b of L.list.querySelectorAll(".br-mut")) {
      b.setAttribute("aria-pressed", b.dataset.mutation === id ? "true" : "false");
      b.tabIndex = b.dataset.mutation === id ? 0 : -1;
    }
    if (L.select.value !== id) L.select.value = id;
    const r = results[id] || evaluate_mutation(m);
    paint_item(id);
    lab_meta();
    L.detail.replaceChildren(detail_view(m, r));
    L.detail.dataset.mutation = id;
    L.detail.dataset.state = r.state;
    if (o.announce) HXUI.announce(m.title + ": " + (STATE_CHIP[r.state] || STATE_CHIP.pending)[1] + (r.codes ? ", " + plural(r.codes.length, "code") : "") + ".");
  }

  function picker() {
    const groups = HXUI.mutations.groups;
    const list = h("div", { class: "br-picker-list", id: "br-picker-list", role: "group", "aria-label": "Mutations", "aria-describedby": "br-picker-keys" },
      h("p", { class: "hx-visually-hidden", id: "br-picker-keys" }, "Tab reaches the selected mutation. Arrow keys, Home and End move between mutations; Enter or Space selects one."),
      groups.map((g) => {
      const items = HXUI.mutations.list.filter((m) => m.group === g.id);
      if (!items.length) return null;
      const gid = "br-group-" + g.id;
      return h("div", { class: "br-group" },
        h("h4", { class: "hx-label br-group-title", id: gid }, g.title),
        h("ul", { class: "br-mut-list", "aria-labelledby": gid }, items.map((m) => {
          const b = h("button", { type: "button", class: "br-mut", id: "br-mut-" + m.id, "aria-pressed": "false", tabindex: "-1", dataset: { mutation: m.id, state: "pending" } },
            h("span", { class: "br-mut-title" }, m.title), h("span", { class: "br-mut-status" }, state_mark("pending")));
          b.addEventListener("click", () => select_mutation(m.id, { announce: true }));
          return h("li", null, b);
        })));
      }));
    /* roving tabindex: one Tab stop for the whole list; the arrow keys move focus, Enter or Space selects */
    list.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll(".br-mut")];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === "ArrowDown") j = Math.min(items.length - 1, i + 1);
      else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = items.length - 1;
      else return;
      e.preventDefault();
      for (const b of items) b.tabIndex = -1;
      items[j].tabIndex = 0;
      items[j].focus();
    });
    list.addEventListener("focusout", (e) => {
      if (e.relatedTarget && list.contains(e.relatedTarget)) return;
      for (const b of list.querySelectorAll(".br-mut")) b.tabIndex = b.dataset.mutation === L.selected ? 0 : -1;
    });
    /* a fade at the edge that has more items behind it */
    const sync_more = () => {
      const max = list.scrollHeight - list.clientHeight;
      list.dataset.moreAbove = max > 1 && list.scrollTop > 2 ? "yes" : "no";
      list.dataset.moreBelow = max > 1 && list.scrollTop < max - 2 ? "yes" : "no";
    };
    list.addEventListener("scroll", sync_more, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(sync_more).observe(list);
    setTimeout(sync_more, 0);
    const sel = h("select", { id: "br-mut-select", class: "hx-select" }, groups.map((g) => h("optgroup", { label: g.title },
      HXUI.mutations.list.filter((m) => m.group === g.id).map((m) => h("option", { value: m.id }, m.title)))));
    sel.addEventListener("change", () => select_mutation(sel.value, { announce: true }));
    L.list = list;
    L.select = sel;
    return h("div", { class: "br-picker" }, list, h("div", { class: "br-picker-select" }, HXUI.field("Mutation", sel)));
  }

  function finding_where(f) {
    const bits = [];
    if (f.state) bits.push(["state ", h("code", null, f.state)]);
    if (f.edge !== null && f.edge !== undefined) bits.push(["edge ", h("code", null, String(f.edge))]);
    if (f.variable) bits.push(["variable ", h("code", null, f.variable)]);
    if (f.clause) bits.push(["clause ", h("code", null, f.clause)]);
    return bits.length ? h("span", { class: "br-where" }, bits.map((b) => h("span", { class: "br-where-item" }, b))) : h("span", { class: "hx-faint" }, "package");
  }

  function finding_extra(f) {
    const d = f.detail || {};
    const parts = [];
    if (Array.isArray(d.path) && d.path.length) {
      parts.push(h("div", { class: "cp-path-wrap" }, h("p", { class: "cp-path-label" }, "Counterexample path"),
        h("ol", { class: "cp-path", "aria-label": "Counterexample path, " + d.path.length + " states" }, d.path.map((sid, i) =>
          h("li", { class: ["cp-path-step", i === d.path.length - 1 ? "is-last" : null] },
            i ? h("span", { class: "cp-path-arrow", "aria-hidden": "true" }, "→") : null, h("code", { class: "cp-path-state" }, sid))))));
    }
    if (d.counterexample && typeof d.counterexample === "object" && Object.keys(d.counterexample).length) {
      parts.push(h("p", { class: "br-cx" }, "Counterexample: ", Object.keys(d.counterexample).map((k, i) =>
        [i ? ", " : "", h("code", null, k + " = " + py_value(d.counterexample[k]))])));
    }
    return parts;
  }

  function codes_row(label, codes, other, id) {
    return h("div", { class: "br-kv" }, h("dt", null, label),
      h("dd", { id }, codes.length ? codes.map((c) => HXUI.chip(c, other.indexOf(c) >= 0 ? "neutral" : "warn", { mono: true })) : h("span", { class: "hx-faint" }, "none")));
  }

  function detail_view(m, r) {
    const sub = (t) => h("h5", { class: "br-sub" }, t);
    const head = h("div", { class: "br-detail-head" },
      h("h4", { class: "br-detail-title", id: "br-detail-title" }, m.title),
      h("div", { class: "br-detail-chips" }, state_chip(r.state)));
    const intro = [h("p", { class: "br-why" }, m.why),
      h("p", { class: "br-test" }, "Python test ", HXUI.wrap_id(m.test, { class: "br-test-name" }))];
    if (r.error) {
      return h("div", { class: "br-detail-body" }, head, intro,
        HXUI.notice("crit", "This mutation could not be checked", h("div", { class: "hx-stack-tight" },
          h("p", null, "Building or validating the mutated package raised an error. Reset the lab and try again; Self-test lists the engine modules in this build."),
          HXUI.code(err_text(r.error), { label: "Error" }))));
    }
    /* the change */
    const diffs = [];
    const after_dump = JSON.parse(JSON.stringify(r.pkg));
    for (const p of m.focus || []) {
      diffs.push(diff_block(HXUI.mutations.path_text(p), pretty(HXUI.mutations.get(base(), p)), pretty(HXUI.mutations.get(after_dump, p))));
    }
    if (m.skill_focus) {
      const line_of = (text, needle) => text.split("\n").find((l) => l.indexOf(needle) >= 0) || "";
      const after_needle = m.skill(m.skill_focus);
      diffs.push(diff_block("SKILL.md", line_of(HX.data.skill_md, m.skill_focus), line_of(r.skill_text, after_needle)));
    }
    /* what the Python test asserts */
    const checks = h("ul", { class: "br-asserts", id: "br-asserts" }, r.asserts.map((a) => h("li", { class: ["br-assert", a.ok ? "is-ok" : "is-bad"] },
      h("span", { class: "br-assert-icon" }, HXUI.icon(a.ok ? "check" : "cross", { label: a.ok ? "holds" : "fails" })),
      h("span", null, HXUI.rich(a.text)))));
    /* findings */
    const findings = r.findings.length
      ? h("ul", { class: "cp-findings br-findings", id: "br-findings", "aria-label": "Findings of validate_package", dataset: { digest: r.report.report_digest || "" } }, r.findings.map((f) =>
        h("li", { class: "cp-finding", dataset: { code: f.code, state: f.state || "", edge: f.edge === null || f.edge === undefined ? "" : f.edge, variable: f.variable || "" } },
          h("div", { class: "cp-finding-head" }, HXUI.chip(f.code, f.severity === "error" ? "crit" : "warn", { mono: true }), finding_where(f)),
          h("p", { class: "cp-finding-msg" }, HXUI.plain_lists(f.message)),
          finding_extra(f))))
      : h("p", { class: "br-note", id: "br-findings" }, "No findings: the mutated package passes validation.");
    const py = m.python;
    const hash_rows = [
      h("div", { class: "br-kv" }, h("dt", null, "Hash, this page"),
        h("dd", null, HXUI.digest(r.pkg.artifact_hash, { short: 19, label: "mutated artifact hash", id: "br-hash" }),
          r.hash_equal ? HXUI.chip("Equal to Python", "ok", { icon: "check" }) : HXUI.chip("Differs from Python", "crit", { icon: "cross" }))),
      h("div", { class: "br-kv" }, h("dt", null, "Hash, Python build"),
        h("dd", null, HXUI.digest(py.hash, { short: 19, label: "Python artifact hash", id: "br-hash-ref" }))),
    ];
    const keep_note = m.mode === "keep"
      ? h("p", { class: "br-note" }, "Not resealed: the package keeps the hash it had before the change, as a tampered package would.")
      : h("p", { class: "br-note" }, "Resealed after the change, as the Python test's ", code("mutate()"), " does, so only the change itself is judged.");
    return h("div", { class: "br-detail-body" }, head, intro,
      h("section", { class: "br-block" }, sub("The change"), diffs.length ? diffs : h("p", { class: "hx-faint" }, "No package field changes."), keep_note),
      h("section", { class: "br-block" }, sub("What the Python test asserts"), checks),
      h("section", { class: "br-block" },
        h("div", { class: "br-block-head" }, sub("Findings (" + r.findings.length + ")"), h("span", { class: "br-ms" }, "validate_package ran in this page in " + (r.ms < 1 ? "under 1" : Math.round(r.ms)) + " ms")),
        findings),
      h("section", { class: "br-block" }, sub("Compared with the Python build"),
        h("dl", { class: "br-kvs" },
          codes_row("Codes, this page", r.codes, py.codes, "br-codes"),
          codes_row("Codes, Python build", py.codes.slice().sort(), r.codes, "br-codes-ref"),
          hash_rows)));
  }

  function lab_panel() {
    const missing = HXUI.engine_missing(LAB_NEEDS);
    if (!HXUI.mutations) missing.push("HXUI.mutations");
    L.meta = h("div", { class: "hx-panel-meta", id: "br-score" });
    const panel = h("section", { class: "hx-panel br-lab", "aria-labelledby": "br-lab-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "br-lab-title" }, "Mutation lab"), L.meta),
      h("p", { class: "hx-panel-lead" }, "Each mutation is one change from the Python conformance tests, applied to the package compiled in this page. ",
        code("validate_package"), " then runs here with the skill text and the operator's deployment policy, as admission does. Every mutation must be rejected with the codes the Python test expects."));
    if (missing.length) {
      panel.appendChild(HXUI.unavailable(missing, { compact: true, title: "The mutation lab is not in this build",
        lead: "The mutation lab needs the compiler and the validator. Missing:" }));
      L.meta.appendChild(HXUI.chip("Not in this build", "neutral"));
      return panel;
    }
    try { base(); } catch (e) {
      L.detail = null;
      panel.appendChild(HXUI.notice("crit", "The base package could not be compiled", h("div", { class: "hx-stack-tight" },
        h("p", null, "Every mutation starts from the package compiled in this page, so there is nothing to mutate. Reset the lab to compile again; if it fails again, Compile shows the compiler's error."),
        HXUI.code(err_text(e), { label: "Compiler error" }))));
      L.meta.dataset.done = "error";
      L.meta.appendChild(HXUI.chip("No base package", "crit", { icon: "stop" }));
      return panel;
    }
    L.detail = h("div", { class: "br-detail", id: "br-detail" });
    panel.appendChild(h("div", { class: "br-lab-grid" }, picker(), L.detail));
    lab_meta();
    return panel;
  }

  /* ================================================================ guard playground */
  const G = { types: null, guards: null, env: null, unknown: null, source: null, out: null, timer: 0, loaded: null, types0: null, types_edited: false };
  const ALLOWED = "Guards may use declared variables, string, number, boolean and list literals, comparisons, and / or / not, in, empty(x) and nonempty(x).";

  function machine_or_null() {
    if (HXUI.engine_missing(MACHINE_NEEDS).length) return null;
    try { return base().machine; } catch (e) { return null; }
  }

  function guarded_states(m) {
    if (!m) return [];
    return Object.keys(m.states).filter((sid) => (m.states[sid].transitions || []).some((t) => t.if));
  }

  function types_hint() {
    if (G.types_edited) return "Edited. Load guards again to restore the " + (G.machine ? "machine's" : "example") + " types. Types: " + TYPES.join(", ") + ".";
    return G.machine ? "Pre-filled from the compiled machine. Types: " + TYPES.join(", ") + "."
      : "The compiled machine is not in this build, so these are the types of the example guards. Declare any others your guards use.";
  }

  function load_source(id, opts) {
    const m = G.machine;
    const ex = EXAMPLES.find((e) => e.id === id);
    if (ex) {
      G.loaded = { id, guards: ex.guards.slice(), targets: null };
      G.guards.value = ex.guards.join("\n");
      G.env.value = JSON.stringify(ex.env, null, 2);
    } else if (m && m.states[id]) {
      const ts = HX.efsm.ordered_transitions ? HX.efsm.ordered_transitions(m.states[id]) : m.states[id].transitions;
      const guarded = ts.filter((t) => t.if);
      const dflt = ts.find((t) => !t.if) || null;
      G.loaded = { id, guards: guarded.map((t) => t.if), targets: guarded.map((t) => t.to), fallback: dflt ? dflt.to : null };
      G.guards.value = G.loaded.guards.join("\n");
      G.env.value = JSON.stringify(ENV_PRESETS[id] || {}, null, 2);
    }
    /* loading restores the types too: every source is checked against the machine's variables */
    G.types.value = JSON.stringify(G.types0, null, 2);
    G.types_edited = false;
    G.types_field.hx.set_hint(types_hint());
    analyze(opts);
  }

  function parse_types() {
    let v;
    try { v = JSON.parse(G.types.value); } catch (e) {
      return { error: "Variable types are not valid JSON (" + e.message + "). Write an object such as {\"repair_count\": \"integer\"}." };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Variable types must be a JSON object mapping each variable name to its type." };
    for (const k of Object.keys(v)) {
      if (TYPES.indexOf(v[k]) < 0) return { error: "The type of " + k + " is " + JSON.stringify(v[k]) + ". Use one of " + TYPES.join(", ") + "." };
    }
    return { value: v };
  }

  function parse_env() {
    try {
      const v = HX.canonical && HX.canonical.strict_loads ? HX.canonical.strict_loads(G.env.value) : JSON.parse(G.env.value);
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "The environment must be a JSON object such as {\"repair_count\": 1}." };
      return { value: v };
    } catch (e) {
      const why = String((e && e.message) || e).replace(/^invalid JSON:\s*/i, "");
      return { error: "The environment is not valid JSON: " + why + ". Fix it to evaluate the guards." };
    }
  }

  function guard_lines() { return G.guards.value.split("\n").map((s) => s.trim()).filter(Boolean); }

  function truth_chip(v) {
    if (v === true) return HXUI.chip("true", "ok", { mono: true });
    if (v === false) return HXUI.chip("false", "neutral", { mono: true });
    return HXUI.chip("unknown", "warn", { mono: true });
  }

  /** One line in place of the blocks that cannot run yet. */
  function blocked(id, title, text) {
    return h("section", { class: "br-block", id, "aria-labelledby": id + "-title" },
      h("h4", { class: "br-sub", id: id + "-title" }, title),
      h("p", { class: "br-blocked" }, HXUI.icon("info"), h("span", null, text)));
  }

  function check_block(guards, checks) {
    const bad = checks.filter((c) => c.errors.length).length;
    return h("section", { class: "br-block", "aria-labelledby": "br-g-check-title" },
      h("div", { class: "br-block-head" }, h("h4", { class: "br-sub", id: "br-g-check-title" }, "Parse and type check"),
        guards.length ? bad ? HXUI.chip(bad + " of " + guards.length + " rejected", "crit", { icon: "cross" }) : HXUI.chip("All " + guards.length + " well-typed", "ok", { icon: "check" }) : null),
      guards.length ? h("ol", { class: "br-guards", id: "br-guard-results" }, checks.map((c, i) => h("li", { class: ["br-guard", c.errors.length ? "is-bad" : "is-ok"], dataset: { index: i } },
        h("span", { class: "br-guard-idx" }, "#" + i),
        h("code", { class: "br-guard-text" }, c.g),
        c.errors.length ? HXUI.chip("Rejected", "crit", { icon: "cross" }) : HXUI.chip("OK", "ok", { icon: "check" }),
        c.errors.length ? h("ul", { class: "br-guard-errors" }, c.errors.map((e) => h("li", null, e))) : null)))
        : h("p", { class: "hx-faint" }, "Write one guard per line above."),
      bad ? h("p", { class: "br-note", id: "br-allowed" }, ALLOWED) : null);
  }

  function disjoint_block(guards, vt) {
    let an = null;
    try { an = HX.guards.analyze_disjoint(guards, vt); } catch (e) { an = { status: "ERROR", detail: err_text(e), counterexample: {}, edges: [] }; }
    const tone = { PROVEN: "ok", COUNTEREXAMPLE: "crit", UNKNOWN: "warn", ERROR: "crit" }[an.status] || "neutral";
    const label = { PROVEN: "Disjoint (proven)", COUNTEREXAMPLE: "Overlap found", UNKNOWN: "Undecided", ERROR: "Error" }[an.status] || an.status;
    const cx = an.counterexample || {};
    const cx_keys = Object.keys(cx);
    const el = h("section", { class: "br-block br-disjoint", id: "br-disjoint", dataset: { status: an.status }, "aria-labelledby": "br-g-dis-title" },
      h("div", { class: "br-block-head" }, h("h4", { class: "br-sub", id: "br-g-dis-title" }, "Disjointness"), HXUI.chip(label, tone)),
      h("p", { class: "br-detail-text" }, h("code", null, "analyze_disjoint"), ": " + an.detail + "."),
      an.status === "UNKNOWN" ? h("p", { class: "br-note" }, "Admission treats an undecided pair like an overlap: it fails closed (", code("GUARDS_DISJOINTNESS_UNKNOWN"), ").") : null,
      an.status === "COUNTEREXAMPLE" ? h("div", { class: "br-cx-box" },
        h("p", null, "Under this assignment guards ", (an.edges || []).map((e, i) => [i ? " and " : "", h("code", null, "#" + e)]), (an.edges || []).length === 2 ? " are both true:" : " are all true:"),
        HXUI.table({ caption: "Counterexample assignment", caption_hidden: true, class: "br-cx-table", columns: [
          { key: "k", label: "Variable", mono: true },
          { key: "v", label: "Value", mono: true },
        ], rows: cx_keys.map((k) => ({ k, v: py_value(cx[k]) })) })) : null);
    return { el, an, label };
  }

  function eval_block(guards, checks, env) {
    const unknown = G.unknown.checked;
    const evals = checks.map((c) => {
      try {
        if (unknown) {
          const e = Object.assign({}, env);
          for (const name of HX.guards.vars_of(c.g)) if (!Object.prototype.hasOwnProperty.call(e, name)) e[name] = HX.guards.UNKNOWN;
          return { v: HX.guards.evaluate3(c.g, e) };
        }
        return { v: HX.guards.evaluate(c.g, env) };
      } catch (e) { return { error: err_text(e) }; }
    });
    const same = G.loaded && G.loaded.targets && G.loaded.guards.join("\n") === guards.join("\n");
    let verdict = null;
    if (same) {
      let taken = null, undecided = null;
      for (let i = 0; i < evals.length; i++) {
        const e = evals[i];
        if (e.error || e.v === null || e.v === undefined) { undecided = i; break; }
        if (e.v === true) { taken = i; break; }
      }
      if (undecided !== null) verdict = ["Undecided: guard #" + undecided + " cannot be evaluated with these values, so the kernel's choice depends on what is missing."];
      else if (taken !== null) verdict = ["The kernel takes edge #" + taken + " to ", h("code", null, G.loaded.targets[taken]), ": the first guard that holds."];
      else verdict = ["No guard holds, so the kernel takes the default edge to ", h("code", null, G.loaded.fallback || "(none)"), "."];
    }
    return h("section", { class: "br-block", "aria-labelledby": "br-g-eval-title" },
      h("div", { class: "br-block-head" }, h("h4", { class: "br-sub", id: "br-g-eval-title" }, "Evaluated with your environment")),
      guards.length ? h("ol", { class: "br-guards", id: "br-eval-results" }, checks.map((c, i) => {
        const e = evals[i];
        return h("li", { class: "br-guard", dataset: { index: i, value: e.error ? "error" : String(e.v) } },
          h("span", { class: "br-guard-idx" }, "#" + i), h("code", { class: "br-guard-text" }, c.g),
          e.error ? HXUI.chip("Error", "crit") : truth_chip(e.v),
          e.error ? h("ul", { class: "br-guard-errors" }, h("li", null, e.error)) : null);
      })) : null,
      verdict ? h("p", { class: "br-verdict", id: "br-verdict" }, HXUI.icon("arrow"), h("span", null, verdict)) : null);
  }

  /** analyze({announce}): the type editor gates everything; rejected guards gate the analysis and evaluation. */
  function analyze(opts) {
    const o = opts || {};
    clearTimeout(G.timer);
    const types = parse_types();
    G.types_field.hx.set_error(types.error || "");
    const env = parse_env();
    G.env_field.hx.set_error(env.error || "");
    const guards = guard_lines();
    const out = [];
    let status, summary;
    if (types.error) {
      status = "TYPES_INVALID";
      summary = "The variable types are not valid. Fix them to check the guards.";
      out.push(blocked("br-g-blocked", "Guards not checked", "Fix the variable types above to check the guards. Every guard is checked against those types, so nothing below can run until they are valid."));
    } else {
      const vt = types.value;
      const checks = guards.map((g) => {
        let errors;
        try { errors = HX.guards.typecheck(g, vt); } catch (e) { errors = [err_text(e)]; }
        return { g, errors };
      });
      const bad = checks.filter((c) => c.errors.length).length;
      out.push(check_block(guards, checks));
      if (!guards.length) {
        status = "EMPTY";
        summary = "No guards to check.";
      } else if (bad) {
        status = "GUARDS_REJECTED";
        summary = bad + " of " + guards.length + " guards rejected.";
        out.push(blocked("br-g-blocked", "Disjointness and evaluation", "Not analysed: fix or remove the rejected guards first. Admission rejects a package with an invalid guard before it looks at overlaps."));
      } else {
        const d = disjoint_block(guards, vt);
        status = d.an.status;
        out.push(d.el);
        if (env.error) out.push(blocked("br-g-eval-blocked", "Evaluated with your environment", "Fix the environment above to evaluate the guards."));
        else out.push(eval_block(guards, checks, env.value));
        summary = d.label + ", " + plural(guards.length, "guard") + " well-typed.";
      }
    }
    G.out.replaceChildren(...out);
    G.out.dataset.status = status;
    if (o.announce) HXUI.announce("Guard playground: " + summary);
  }

  function schedule() { clearTimeout(G.timer); G.timer = setTimeout(() => analyze({ announce: true }), 250); }

  function playground_panel() {
    const m = machine_or_null();
    G.machine = m;
    const states = guarded_states(m);
    /* without the compiled machine, the types of the variables the example guards use */
    G.types0 = m ? Object.assign({}, HX.efsm.var_types(m))
      : { draft: "object", readback_count: "integer", repair_count: "integer", validation_status: "string" };
    G.types_edited = false;
    const opts = states.map((sid) => ({ value: sid, label: sid + " (" + plural(m.states[sid].transitions.filter((t) => t.if).length, "guarded edge") + ")" }))
      .concat(EXAMPLES.map((e) => ({ value: e.id, label: e.label })));
    G.source = HXUI.select("br-guard-source", opts, { value: states.indexOf(DEFAULT_STATE) >= 0 ? DEFAULT_STATE : opts[0] && opts[0].value, on_change: (v) => load_source(v, { announce: true }) });
    G.guards = h("textarea", { id: "br-guards", class: "hx-textarea", rows: 5, spellcheck: "false", autocomplete: "off", "autocapitalize": "off" });
    G.types = h("textarea", { id: "br-types", class: "hx-textarea", rows: 9, spellcheck: "false", autocomplete: "off", "autocapitalize": "off" }, JSON.stringify(G.types0, null, 2));
    G.env = h("textarea", { id: "br-env", class: "hx-textarea", rows: 4, spellcheck: "false", autocomplete: "off", "autocapitalize": "off" });
    G.unknown = h("input", { type: "checkbox", id: "br-unknown", checked: true });
    for (const el of [G.guards, G.env]) el.addEventListener("input", schedule);
    G.types.addEventListener("input", () => {
      if (!G.types_edited) { G.types_edited = true; G.types_field.hx.set_hint(types_hint()); }
      schedule();
    });
    G.unknown.addEventListener("change", () => analyze({ announce: true }));
    G.types_field = HXUI.field("Variable types (JSON)", G.types, { hint: types_hint() });
    G.env_field = HXUI.field("Environment (JSON)", G.env, { hint: "Values to evaluate the guards with." });
    const guards_field = HXUI.field("Guards, one per line", G.guards, { hint: "Edges are numbered from #0 in the order the kernel tries them." });
    G.out = h("div", { class: "br-g-out", id: "br-g-out" });
    const form = h("form", { class: "br-g-form", id: "br-g-form", "aria-label": "Guard playground inputs" },
      h("div", { class: "br-g-source" }, HXUI.field("Load guards from", G.source)),
      h("div", { class: "br-g-inputs" },
        h("div", { class: "br-g-col" }, guards_field,
          G.env_field,
          h("div", { class: "br-check" }, G.unknown, h("label", { for: "br-unknown" }, "Treat variables missing from the environment as unknown (three-valued, as structural replay does)"))),
        h("div", { class: "br-g-col" }, G.types_field)));
    form.addEventListener("submit", (e) => { e.preventDefault(); analyze({ announce: true }); });
    const panel = h("section", { class: "hx-panel br-play", "aria-labelledby": "br-play-title" },
      h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "br-play-title" }, "Guard playground"),
        h("div", { class: "hx-panel-meta" }, HXUI.chip("Parsed, never executed", "neutral"))),
      h("p", { class: "hx-panel-lead" }, "A guard is a boolean expression over the machine's typed variables. ", code("HX.guards"),
        " parses it into a syntax tree, checks every node against an allowlist and the variable types, and decides whether a state's guards can be true at the same time. Nothing in a guard is ever executed."),
      form, G.out);
    setTimeout(() => load_source(G.source.value), 0);
    return panel;
  }

  /* ================================================================ section */
  let root = null;
  function render() {
    if (!root) return;
    L.sweep++;
    L.strip = HXUI.summary_strip("br-summary", "Mutation lab summary");
    root.replaceChildren(L.strip, lab_panel(), playground_panel());
    if (L.detail) {
      select_mutation(L.selected);
      sweep();
    }
  }

  HXUI.bus.on("lab:reset", () => {
    BASE = null;
    BASE_ERROR = null;
    for (const k of Object.keys(results)) delete results[k];
    L.selected = DEFAULT_MUTATION;
    if (root) render();
  });

  HXUI.register_section({
    id: "break",
    title: "Break it",
    nav: "Break it",
    summary: "Mutate the machine and watch validation catch it",
    needs: NEEDS,
    about: ABOUT,
    mount(el) {
      root = h("div", { class: "br hx-ruled" });
      el.appendChild(root);
      render();
    },
  });

  /** For tests and the guided demo. */
  HXUI.break_view = {
    results: () => results,
    select: (id) => select_mutation(id, { announce: true }),
    analyze: () => analyze(),
  };
})();
