/* HEXIS Runtime Lab: the Run workbench's inspector tabs (HXUI.run_inspector).
   const insp = HXUI.run_inspector.create("rn-insp")  -> {el, update(data), select(tab_id), selected()}
   data = null (no run selected) or {
     env,                       the lab Env the run lives in
     run,                       the run row (store.get_run)
     ins,                       env.service.inspect_run(run_id, initiator)
     checkpoints,               env.store.checkpoints(tenant, run_id), oldest first
     metrics,                   HX.metrics.collect(store, tenant, {run_id}) | null when HX.metrics is missing
     metrics_error,             an error collect() raised, if any
   }
   Tabs: Timeline, Variables, Ledger, Evidence, Interactions, ERP, Metrics. Every value shown is read from the
   engine's store, the fake ERP or HX.metrics at render time; nothing is cached between steps. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const h = (...a) => HXUI.h(...a);
  const code = (t) => h("code", { class: "hx-inline" }, t);
  /** a long identifier as plain mono text that may wrap after "_", "-", "/", ":", "." or ", " */
  function wrap_id(t) {
    const parts = String(t === null || t === undefined ? "" : t).split(/(?<=[_\-/:.,])/);
    const kids = [];
    parts.forEach((p, i) => { if (i) kids.push(h("wbr")); kids.push(p); });
    return h("span", { class: "hx-mono rn-wrapid" }, kids);
  }
  const mono = (t, cls) => h("span", { class: ["hx-mono", cls] }, t);

  /* ---------------------------------------------------------------- formatting */
  function short(id, n) {
    const s = String(id === null || id === undefined ? "" : id);
    const k = n || 14;
    return s.length > k + 1 ? s.slice(0, k) + "…" : s;
  }
  function idcell(id, n) {
    if (id === null || id === undefined || id === "") return h("span", { class: "hx-faint" }, "none");
    return h("span", { class: "hx-mono rn-id", title: String(id) }, short(id, n));
  }
  function compact_json(v, max) {
    let s;
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    if (s === undefined) s = "undefined";
    const m = max || 140;
    return s.length > m ? s.slice(0, m - 1) + "…" : s;
  }
  function secs(v) {
    if (v === null || v === undefined) return "unknown";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    if (n === 0) return "0 s";
    if (Math.abs(n) >= 3600) return (n / 3600).toFixed(n % 3600 === 0 ? 0 : 2) + " h";
    return (Math.round(n * 1000) / 1000) + " s";
  }
  HXUI.run_format = { short, idcell, compact_json, secs };

  const STATUS_TONE = {
    SUCCEEDED: "ok", COMPLETED: "ok", ADMITTED: "ok", pass: "ok", match: "ok", certain: "ok", reconciled: "ok",
    human_resolved: "warn", OPEN: "accent", ANSWERED: "ok", EXPIRED: "warn", PENDING: "neutral", DISPATCHING: "warn",
    UNKNOWN_EFFECT: "warn", unknown: "warn", repairable: "warn", DENIED: "crit", FAILED: "crit", ABANDONED: "neutral",
    no_effect: "neutral", fail: "crit", mismatch: "crit", CLOSED: "neutral",
  };
  const tone = (s) => STATUS_TONE[s] || "neutral";
  const schip = (s) => HXUI.chip(String(s), tone(s), { mono: false });

  /* ---------------------------------------------------------------- timeline */
  const EVENT_TONE = {
    TRANSITION: "accent", TERMINAL_ADMITTED: "ok", RECONCILED: "ok", RUN_STOPPED: "crit", OBSERVATION_REJECTED: "crit",
    MODEL_OUTPUT_REJECTED: "crit", FALLBACK_ENTERED: "crit", EFFECT_UNKNOWN: "warn", RECONCILIATION_REQUIRED: "warn",
    EVIDENCE_INVALIDATED: "warn", APPROVAL_EXPIRED: "warn", EFFECT_RESOLVED: "warn",
  };

  function guard_text(edge) {
    if (!edge || typeof edge !== "object") return null;
    return edge.if ? code(edge.if) : h("span", { class: "hx-faint" }, "otherwise (default edge)");
  }

  function event_detail(e) {
    const t = e.type;
    const arrow = (a, b) => [code(a), h("span", { class: "rn-arrow", "aria-hidden": "true" }, " → "),
      h("span", { class: "hx-visually-hidden" }, " to "), code(b)];
    switch (t) {
      case "RUN_CREATED": return ["Created by ", code(e.principal), " on artifact ", idcell(e.artifact_hash, 19)];
      case "OBSERVATION": {
        const o = e.observation || {};
        return [code(o.state_id || "?"), " · ", o.kind || "?", " observation from ", code(o.actor || "?"),
          o.failure ? [" · failure ", h("span", { class: "rn-bad" }, o.failure)] : null];
      }
      case "OBSERVATION_ACCEPTED": return ["Accepted at ", code(e.state || "?"), " from ", code(e.actor || "?")];
      case "OBSERVATION_REJECTED": return [h("strong", null, e.code), ": ", e.message];
      case "TRANSITION": return [arrow(e.from, e.to), h("span", { class: "rn-guard" }, " if ", guard_text(e.edge)),
        e.edge && e.edge.inc ? [", then +1 ", code(e.edge.inc)] : null];
      case "FALLBACK_ENTERED": return [arrow(e.from, e.to), " · ", e.reason || "fallback"];
      case "TIMING": return [code(e.state || "?"), " · ", e.status || "", " · total ", secs(e.total_s), ", model ", secs(e.model_s), ", tools ", secs(e.tool_s),
        e.human_wait_s !== null && e.human_wait_s !== undefined ? [", human wait ", secs(e.human_wait_s)] : null];
      case "EVIDENCE_INVALIDATED": return ["Receipt ", idcell(e.receipt_id, 18), ": ", e.reason];
      case "INTERACTION_OPEN": return [e.kind === "approval" ? "Approval" : "Input", " requested: ", code(e.interaction_id), " · scope ", idcell(e.scope_digest, 19)];
      case "INTERACTION_ANSWERED": return [code(e.interaction_id), " answered by ", code(e.responder)];
      case "APPROVAL_EXPIRED": return [code(e.interaction_id), " expired before anyone answered"];
      case "EFFECT_UNKNOWN": return ["Write ", idcell(e.logical_action_id, 18), ": ", e.reason];
      case "RECONCILED": return ["Write ", idcell(e.logical_action_id, 18), ": ", e.status, e.certainty ? " (" + e.certainty + ")" : "",
        e.during ? " during " + e.during : "", e.reason ? " · " + e.reason : ""];
      case "RECONCILIATION_REQUIRED": return ["Write ", idcell(e.logical_action_id, 18), ": ", e.reason];
      case "RUN_STOPPED": return [h("strong", null, e.status), " at ", code(e.state || "?"), " · ", code(e.code), " ", e.message || ""];
      case "TERMINAL_ADMITTED": return ["Outcome ", code(e.terminal), " (", e.category, ")"];
      case "MODEL_OUTPUT_REJECTED": return [code(e.state || "?"), " · ", h("strong", null, e.code), " · keys ", code((e.keys || []).join(", "))];
      case "EFFECT_RESOLVED": return [idcell(e.logical_action_id, 18), " resolved ", e.outcome, " by ", code(e.resolver)];
      default: return [h("span", { class: "rn-raw" }, compact_json(Object.assign({}, e, { type: undefined, sequence: undefined }), 160))];
    }
  }

  function timeline(d, st) {
    const events = d.ins.events || [];
    const shown = st.timing ? events : events.filter((e) => e.type !== "TIMING");
    const box = h("input", { type: "checkbox", id: "rn-tl-timing", checked: !!st.timing });
    box.addEventListener("change", () => { st.timing = box.checked; st.refresh(); });
    const transitions = events.filter((e) => e.type === "TRANSITION").length;
    const hidden = events.length - shown.length;
    return h("div", { class: "rn-tab" },
      h("div", { class: "rn-tab-head" },
        h("p", { class: "rn-tab-sum", id: "rn-tl-sum" }, (hidden ? shown.length + " of " + events.length + " events shown (timing hidden), " : events.length + " events, ") +
          transitions + (transitions === 1 ? " transition" : " transitions") + ". Newest last; numbers are the event sequence."),
        h("label", { class: "rn-check", for: "rn-tl-timing" }, box, "Show timing events")),
      h("ol", { class: "rn-timeline", "aria-label": "Run events", id: "rn-timeline" }, shown.map((e) =>
        h("li", { class: "rn-ev", dataset: { type: e.type, seq: e.sequence } },
          h("span", { class: "rn-ev-seq hx-num" }, String(e.sequence)),
          HXUI.chip(e.type, EVENT_TONE[e.type] || "neutral", { mono: true, class: "rn-ev-type" }),
          h("span", { class: "rn-ev-detail" }, event_detail(e))))));
  }

  /* ---------------------------------------------------------------- variables */
  /** JSON with a space after "," and ":" so long values wrap between tokens, never inside one */
  function spaced_json(v, max) {
    let s;
    try { s = JSON.stringify(v, null, 1); } catch (e) { s = String(v); }
    if (s === undefined) s = "undefined";
    s = s.replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]").replace(/\{ /g, "{").replace(/ \}/g, "}");
    const m = max || 140;
    return s.length > m ? s.slice(0, m - 1) + "…" : s;
  }

  /** JSON text with each short string literal kept on one line ("BU-EMEA" never breaks at its hyphen) */
  function json_tokens(text) {
    return text.split(/("(?:[^"\\]|\\.)*"?)/).map((part, i) => i % 2 && part.length <= 32 ? h("span", { class: "rn-nw" }, part) : part);
  }

  function variables(d, st) {
    const cps = d.checkpoints || [];
    const cur = d.ins.checkpoint.variables || {};
    const prev = cps.length > 1 ? cps[cps.length - 2].variables || {} : {};
    const keys = Object.keys(cur);
    const changed = (k) => cps.length > 1 && JSON.stringify(prev[k]) !== JSON.stringify(cur[k]);
    const n_changed = keys.filter(changed).length;
    const rows = keys.map((k) => ({ k, v: cur[k], changed: changed(k) }));
    const set = rows.filter((r) => r.v !== null && r.v !== undefined).length;
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum" }, "Checkpoint revision " + d.ins.checkpoint.revision + " at ", code(d.ins.checkpoint.state_id), ". ",
        set + " of " + keys.length + " variables set; ",
        cps.length > 1 ? (n_changed ? n_changed + " changed in the last step (marked)." : "none changed in the last step.") : "this is the initial checkpoint."),
      HXUI.table({
        caption: "Checkpoint variables", caption_hidden: true, class: "rn-vars",
        columns: [
          { key: "k", label: "Variable", render: (r) => h("span", { class: "rn-var-name" }, h("span", { class: "hx-mono" }, r.k),
            r.changed ? HXUI.chip("changed", "accent") : null) },
          { key: "v", label: "Value", render: (r) => r.v === null || r.v === undefined ? h("span", { class: "hx-faint" }, "null")
            : h("code", { class: "rn-val", title: compact_json(r.v, 4000) }, json_tokens(spaced_json(r.v, 160))) },
        ],
        rows,
        row_attrs: (r) => ({ class: r.changed ? "is-changed" : null, dataset: { var: r.k, changed: r.changed ? "1" : "0" } }),
      }),
      keep_open(st, "budget", h("details", { class: "rn-more", id: "rn-budget" }, h("summary", { id: "rn-budget-summary" }, "Budget used"),
        HXUI.json_view(d.ins.checkpoint.budget || {}, { open_depth: 1, label: "Budget" }))));
  }

  /** a <details> whose open state survives the re-render after every step */
  function keep_open(st, key, el) {
    st.open = st.open || {};
    if (st.open[key]) el.open = true;
    el.addEventListener("toggle", () => { st.open[key] = el.open; });
    return el;
  }

  /* ---------------------------------------------------------------- ledger */
  function ledger(d) {
    const intents = d.ins.action_intents || [];
    const receipts = d.ins.action_receipts || [];
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum" }, intents.length + " intents, " + receipts.length + " receipts. The broker records the intent durably before it dispatches, and a receipt for every outcome."),
      HXUI.table({
        caption: "Action intents", class: "rn-intents",
        columns: [
          { key: "tool", label: "Tool", mono: true, nowrap: true },
          { key: "status", label: "Status", nowrap: true, render: (r) => schip(r.status) },
          { key: "state_id", label: "State", mono: true, nowrap: true, fold: true },
          { key: "revision", label: "Rev", align: "right", fold: true, fold_label: "rev", render: (r) => h("span", { class: "hx-num" }, r.revision) },
          { key: "attempts", label: "Attempts", align: "right", fold: true, fold_label: "attempts" },
          { key: "logical_action_id", label: "Logical action", fold: true, render: (r) => idcell(r.logical_action_id, 16) },
        ],
        rows: intents, empty: "No intents yet: the run has not reached a tool state.",
        row_attrs: (r) => ({ dataset: { tool: r.tool, status: r.status } }),
      }),
      HXUI.table({
        caption: "Action receipts", class: "rn-receipts",
        columns: [
          { key: "tool", label: "Tool", mono: true, nowrap: true },
          { key: "dispatch_state", label: "Dispatch · certainty", render: (r) => h("span", { class: "rn-pair" }, schip(r.dispatch_state),
            r.certainty ? schip(r.certainty) : h("span", { class: "hx-faint" }, "no certainty")) },
          { key: "external_ref", label: "External ref", mono: true, fold: true, fold_label: "ref", render: (r) => r.external_ref || h("span", { class: "hx-faint" }, "none") },
          { key: "seq", label: "Receipt", fold: true, render: (r) => idcell(r.logical_action_id + "#" + r.seq, 18) },
        ],
        rows: receipts, empty: "No receipts yet.",
        row_attrs: (r) => ({ dataset: { tool: r.tool, dispatch: r.dispatch_state, certainty: r.certainty || "" } }),
      }));
  }

  /* ---------------------------------------------------------------- evidence */
  function evidence(d) {
    const ev = d.ins.evidence || [];
    const valid = ev.filter((e) => e.invalidated_at === null || e.invalidated_at === undefined).length;
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum" }, ev.length + " receipts, " + valid + " valid. A receipt is bound to the digests of its subject variables; a later change to them invalidates it."),
      HXUI.table({
        caption: "Evidence receipts", caption_hidden: true, class: "rn-evidence",
        columns: [
          { key: "claim", label: "Claim", render: (r) => wrap_id(r.claim) },
          { key: "valid", label: "Validity", render: (r) => r.invalidated_at === null || r.invalidated_at === undefined
            ? HXUI.chip("Valid", "ok", { icon: "check" })
            : h("span", { class: "rn-inval" }, HXUI.chip("Invalidated", "warn", { icon: "alert" }), h("span", { class: "rn-inval-why" }, r.invalidation_reason || "")) },
          { key: "result", label: "Result", nowrap: true, fold: true, fold_label: "result", render: (r) => schip(r.result) },
          { key: "verifier", label: "Verifier", mono: true, nowrap: true, fold: true, fold_label: "verifier" },
          { key: "receipt_id", label: "Receipt", fold: true, render: (r) => idcell(r.receipt_id, 18) },
        ],
        rows: ev, empty: "No evidence yet: validation and verification tools issue it.",
        row_attrs: (r) => ({ dataset: { claim: r.claim, valid: r.invalidated_at === null || r.invalidated_at === undefined ? "1" : "0" } }),
      }));
  }

  /* ---------------------------------------------------------------- interactions */
  function interactions(d) {
    const t = d.run.tenant_id;
    const ids = [];
    for (const e of d.ins.events || []) if (e.type === "INTERACTION_OPEN" && ids.indexOf(e.interaction_id) < 0) ids.push(e.interaction_id);
    const rows = ids.map((iid) => {
      const ix = d.env.store.interaction(t, iid) || { interaction_id: iid };
      const resp = d.env.store.response(t, iid);
      return { ix, resp };
    });
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum" }, rows.length ? rows.length + (rows.length === 1 ? " interaction." : " interactions.") + " Each binds its answer to the scope digest shown when it opened." : ""),
      HXUI.table({
        caption: "Interactions", caption_hidden: true, class: "rn-ix",
        columns: [
          { key: "id", label: "Interaction", render: (r) => h("span", { class: "rn-ix-id" }, h("span", null, r.ix.type === "approval" ? "Approval" : r.ix.type === "input" ? "Input" : r.ix.type || "?"),
            " ", h("span", { class: "hx-mono rn-id" }, r.ix.interaction_id)) },
          { key: "status", label: "Status", nowrap: true, render: (r) => schip(r.ix.status || "?") },
          { key: "resp", label: "Answer", fold: true, fold_label: "answer", render: (r) => r.resp ? [h("span", { class: "hx-mono" }, r.resp.responder), ": ", wrap_id(spaced_json(r.resp.response, 80))] : h("span", { class: "hx-faint" }, "none yet") },
          { key: "scope", label: "Scope digest", fold: true, fold_label: "scope", render: (r) => idcell(r.ix.scope_digest, 19) },
        ],
        rows, empty: "No interactions: the run has not asked anyone for approval or input.",
      }));
  }

  /* ---------------------------------------------------------------- ERP */
  /** The fake ERP's drafts for a tenant. FakeERP has no public listing yet (see the run group's open issues), so
      this is the one place that reads its rows; without them the table falls back to read_draft by id. */
  function erp_drafts(e, tenant) {
    if (!e) return [];
    if (typeof e.list_drafts === "function") { try { return e.list_drafts(tenant) || []; } catch (err) { /* fall through */ } }
    if (Array.isArray(e._rows)) return e._rows.filter((r) => r.tenant_id === tenant);
    return [];
  }
  function erp(d) {
    const e = d.env.erp;
    const rows = erp_drafts(e, d.run.tenant_id);
    const calls = Array.isArray(e && e.calls) ? e.calls : [];
    let n = 0;
    try { n = e.count(d.run.tenant_id); } catch (err) { n = rows.length; }
    const payload = (r) => { try { return JSON.parse(r.payload); } catch (err) { return r.payload; } };
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum", id: "rn-erp-count", dataset: { count: n } }, "The fake ERP holds " + n + (n === 1 ? " draft" : " drafts") + " for tenant ", code(d.run.tenant_id),
        " (every run in this lab). The call log of this ERP connection lists ", String(calls.length), calls.length === 1 ? " call" : " calls", "."),
      HXUI.table({
        caption: "ERP drafts", class: "rn-erp-drafts",
        columns: [
          { key: "draft_id", label: "Draft", mono: true, nowrap: true },
          { key: "supplier_ref", label: "Supplier", mono: true, nowrap: true },
          { key: "version", label: "Version", align: "right", render: (r) => h("span", { class: "hx-num" }, r.version) },
          { key: "payload", label: "Payload", render: (r) => h("code", { class: "rn-val", title: r.payload }, compact_json(payload(r), 110)) },
        ],
        rows, empty: "No drafts: nothing has been written to the ERP.",
      }),
      HXUI.table({
        caption: "ERP call log", class: "rn-erp-calls",
        columns: [
          { key: "i", label: "#", align: "right", render: (r, i) => h("span", { class: "hx-num" }, i + 1) },
          { key: "op", label: "Operation", mono: true, render: (r) => r[0] },
          { key: "key", label: "Idempotency key", render: (r) => idcell(r[1], 22) },
        ],
        rows: calls, empty: "No create calls on this ERP connection yet.",
      }));
  }

  /* ---------------------------------------------------------------- metrics */
  const SPLIT = [
    { key: "engine_s", label: "Engine", cls: "is-engine" },
    { key: "model_s", label: "Model", cls: "is-model" },
    { key: "tool_s", label: "Tools", cls: "is-tool" },
  ];

  function metrics(d) {
    if (!globalThis.HX || !HX.metrics) return HXUI.unavailable(["HX.metrics"], { compact: true, hint: false });
    if (d.metrics_error) return HXUI.notice("crit", "The metrics could not be collected", String(d.metrics_error.message || d.metrics_error));
    const rep = d.metrics;
    const r = rep && rep.per_run ? rep.per_run[d.run.run_id] : null;
    if (!r) return h("p", { class: "rn-tab-sum" }, "No timing recorded for this run yet.");
    const total = SPLIT.reduce((s, x) => s + (Number(r[x.key]) || 0), 0);
    const bar = h("div", { class: "rn-split", role: "img", "aria-label": SPLIT.map((x) => x.label + " " + secs(r[x.key])).join(", ") },
      SPLIT.map((x) => {
        const v = Number(r[x.key]) || 0;
        return v > 0 ? h("span", { class: ["rn-split-seg", x.cls], style: { flexGrow: String(v) }, title: x.label + ": " + secs(v) }) : null;
      }));
    const keys = Object.keys(rep.by_state || {}).sort();
    const states = keys.map((k) => Object.assign({ state: k }, rep.by_state[k]));
    return h("div", { class: "rn-tab" },
      h("p", { class: "rn-tab-sum" }, "From ", code("HX.metrics.collect"), " over this run's TIMING events. Latencies come from the lab's counter timer (0.125 s per reading), so they repeat exactly; human wait is logical clock time."),
      h("dl", { class: "rn-split-legend" },
        SPLIT.map((x) => h("div", { class: "rn-split-item", dataset: { key: x.key } },
          h("dt", null, h("span", { class: ["rn-split-sw", x.cls], "aria-hidden": "true" }), x.label),
          h("dd", { class: "hx-num" }, secs(r[x.key]), h("span", { class: "rn-split-pct" }, total ? " · " + Math.round(100 * (Number(r[x.key]) || 0) / total) + "%" : "")))),
        h("div", { class: "rn-split-item", dataset: { key: "human_wait_s" } },
          h("dt", null, h("span", { class: "rn-split-sw is-human", "aria-hidden": "true" }), "Human wait"),
          h("dd", { class: "hx-num" }, secs(r.human_wait_s))),
        h("div", { class: "rn-split-item" }, h("dt", { title: "Timed steps, including steps that paused or retried; the summary counts transitions" }, "Timed steps"), h("dd", { class: "hx-num" }, String(r.steps))),
        h("div", { class: "rn-split-item" }, h("dt", null, "Tokens"), h("dd", { class: "hx-num" }, String(r.tokens))),
        h("div", { class: "rn-split-item" }, h("dt", null, "Cost"), h("dd", null, r.cost_usd === null || r.cost_usd === undefined ? h("span", { title: "The fixture model reports no cost; unknown is never shown as 0." }, "unknown") : "$" + r.cost_usd)),
        h("div", { class: "rn-split-item" }, h("dt", null, "Uncertain effects"), h("dd", { class: "hx-num" }, String(r.uncertain_effects)))),
      total ? bar : null,
      HXUI.table({
        caption: "Latency by state", class: "rn-by-state",
        columns: [
          { key: "state", label: "State", mono: true, nowrap: true },
          { key: "count", label: "Timed steps", align: "right" },
          { key: "lat", label: "Total", align: "right", nowrap: true, render: (x) => secs(x.latency_s && x.latency_s.total) },
          { key: "engine_s", label: "Engine", align: "right", nowrap: true, fold: true, fold_label: "Engine", render: (x) => secs(x.engine_s) },
          { key: "model_s", label: "Model", align: "right", nowrap: true, fold: true, fold_label: "Model", render: (x) => secs(x.model_s) },
          { key: "tool_s", label: "Tools", align: "right", nowrap: true, fold: true, fold_label: "Tools", render: (x) => secs(x.tool_s) },
        ],
        rows: states, empty: "No steps timed yet.",
      }));
  }

  /* ---------------------------------------------------------------- tabs */
  const TABS = [
    { id: "timeline", label: "Timeline", render: timeline },
    { id: "variables", label: "Variables", render: variables },
    { id: "ledger", label: "Ledger", render: ledger },
    { id: "evidence", label: "Evidence", render: evidence },
    { id: "interactions", label: "Interactions", render: interactions },
    { id: "erp", label: "ERP", render: erp },
    { id: "metrics", label: "Metrics", render: metrics },
  ];

  HXUI.run_inspector = {
    TABS: TABS.map((t) => t.id),
    create(id, opts) {
      const o = opts || {};
      let data = null;
      /* re-rendering a tab keeps keyboard focus on the same control (by id) and <details> open states (st.open) */
      const repaint = () => {
        const a = document.activeElement;
        const keep = a && tabs.contains(a) && a.id ? a.id : null;
        tabs.hx.refresh();
        if (keep && !(document.activeElement && document.activeElement.id === keep)) {
          const el = document.getElementById(keep);
          if (el && tabs.contains(el)) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
        }
      };
      const st = { timing: false, open: {}, refresh: repaint };
      const tabs = HXUI.tabs(id, TABS.map((t) => ({
        id: t.id, label: t.label,
        render: () => {
          if (!data) return h("p", { class: "rn-tab-sum" }, "Start a run or pick one from the list to inspect it.");
          try { return t.render(data, st); } catch (err) {
            return HXUI.notice("crit", "This tab could not be shown", String((err && (err.code ? err.code + ": " : "") + err.message) || err));
          }
        },
      })), { selected: o.selected || "timeline", label: "Run inspector", on_change: o.on_change });
      return {
        el: tabs,
        update(d) { data = d; repaint(); },
        select(tid) { tabs.hx.select(tid); },
        selected() { return tabs.hx.selected(); },
      };
    },
  };
})();
