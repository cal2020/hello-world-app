/* Integration Workbench UI. Vanilla JS, same-origin fetch, no dependencies.
 * Simulated identities only: the bearer token is a fixed demo string chosen in the header. */
"use strict";

const MODEL_FIXTURES = [
  "model/A_initial.json", "model/B_rename_gateway.json", "model/C_remove_serial_field.json",
  "model/D_unit_ms_to_s.json", "model/E_replace_sensor.json", "model/partial_sensors_only.json",
  "model/conflict_same_revision_B.json", "model/delta_delete_temperature_sensor.json",
  "model/late_revision_based_on_A.json", "records/cmms_main.json",
];
const PROJECTION_FIXTURES = [
  "equipment-health_1.0.0.json", "equipment-health_1.1.0.json", "equipment-health_1.2.0.json",
  "equipment-health_1.3.0_bad_version.json", "equipment-health_2.0.0.json", "hostile_labels.json",
];
// Mirrors lucidwb/projection.py BLOCKING (display only; the server decides).
const BLOCKING = new Set(["definition_missing", "unit_mismatch", "relation_direction_mismatch",
  "unknown_element_type", "enum_value_outside_contract", "contract_version_reused_with_different_shape",
  "invalid_projection", "instance_value_missing", "unresolved_relation_target"]);

const S = {
  token: "demo-carol",
  project: null,
  lastReq: null,          // {label, method, path, headers, raw} for "retry with same key"
  selSnapshot: null,
  selElement: null,
  selRelease: null,
  diffFrom: null, diffTo: null,
  releases: null,         // last GET releases body (client's view)
  history: null,
  proposalsView: {},      // proposal_id -> proposal object as currently displayed
  histTimer: null,
};

// ------------------------------------------------------------------ DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const mono = (t) => h("span", { class: "mono" }, t == null ? "—" : String(t));
const fmt = (v) => v == null ? "—" : (typeof v === "object" ? JSON.stringify(v) : String(v));
function badge(text, color) { return h("span", { class: "badge b-" + color }, text); }
function jsonDetails(label, obj, open) {
  return h("details", open ? { open: true } : null, h("summary", null, label),
    h("pre", null, JSON.stringify(obj, null, 2)));
}
function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return h("div", { class: "empty" }, opts.empty || "None.");
  const thead = h("thead", null, h("tr", null, cols.map((c) => h("th", null, c.label))));
  const tbody = h("tbody");
  rows.forEach((r, i) => {
    const tr = h("tr", opts.rowAttrs ? opts.rowAttrs(r, i) : null,
      cols.map((c) => {
        const v = c.render ? c.render(r) : r[c.key];
        return h("td", c.mono ? { class: "mono" } : null, v instanceof Node || Array.isArray(v) ? v : fmt(v));
      }));
    tbody.appendChild(tr);
  });
  return h("table", null, thead, tbody);
}
function genericTable(rows, empty) {
  if (!rows || !rows.length) return h("div", { class: "empty" }, empty || "None.");
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return table(keys.map((k) => ({ label: k, key: k, mono: /_id$|uid|digest|revision/.test(k) })), rows);
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ------------------------------------------------------------------ toasts
function toast(msg, kind = "error", ms = 15000) {
  const t = h("div", { class: "toast" + (kind === "error" ? "" : " " + kind) },
    h("button", { class: "close", title: "Dismiss", onclick: () => t.remove() }, "×"), msg);
  $("toasts").prepend(t);
  while ($("toasts").children.length > 6) $("toasts").lastChild.remove();
  if (ms) setTimeout(() => t.remove(), ms);
}
function errorToast(method, path, res) {
  const e = res.body && res.body.error;
  const code = e && typeof e === "object" ? e.code : (typeof e === "string" ? e : "http_" + res.status);
  const msg = e && typeof e === "object" ? e.message : (res.text || "").slice(0, 200);
  toast(h("span", null, h("strong", null, `HTTP ${res.status} `), h("code", null, code), " — ", msg || "",
    h("div", { class: "small mono" }, `${method} ${path}`),
    e && e.details ? h("details", null, h("summary", { class: "small" }, "details"),
      h("pre", { class: "small" }, JSON.stringify(e.details, null, 1))) : null));
}

// ------------------------------------------------------------------ HTTP
async function request(method, path, opts = {}) {
  const headers = Object.assign({ Authorization: "Bearer " + S.token }, opts.headers || {});
  let body;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers["Content-Type"] = "application/json"; }
  let resp;
  try {
    resp = await fetch(path, { method, headers, body, cache: "no-store" });
  } catch (err) {
    const res = { status: 0, ok: false, headers: new Headers(), body: { error: { code: "network_error", message: String(err) } }, text: "" };
    errorToast(method, path, res);
    if (opts.show) showLast(method, path, res, headers);
    return res;
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  const res = { status: resp.status, ok: resp.ok, headers: resp.headers, body: parsed, text };
  if (opts.show) showLast(method, path, res, headers);
  if (!resp.ok && !opts.quiet) errorToast(method, path, res);
  return res;
}
const GET = (path, opts) => request("GET", path, opts);

function showLast(method, path, res, reqHeaders) {
  const interesting = ["Idempotent-Replay", "Idempotency-Key", "ETag", "Content-Location"]
    .filter((k) => res.headers.get(k)).map((k) => `${k}: ${res.headers.get(k)}`);
  const sentKeys = ["Idempotency-Key", "If-Match"].filter((k) => reqHeaders[k]).map((k) => `${k}: ${reqHeaders[k]}`);
  $("lr-summary").textContent = `${method} ${path} → HTTP ${res.status}` +
    (res.headers.get("Idempotent-Replay") ? "  [Idempotent-Replay: true]" : "");
  $("lr-summary").className = res.ok ? "" : "blocking";
  $("lr-body").textContent =
    (sentKeys.length ? "Request headers: " + sentKeys.join("; ") + "\n" : "") +
    (interesting.length ? "Response headers: " + interesting.join("; ") + "\n" : "") +
    "\n" + (res.body !== null ? JSON.stringify(res.body, null, 2) : res.text);
  $("last-response").open = true;
}

// A management call from a button: shows response, remembers it for retry if asked, refreshes all.
async function action(method, path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.idem && $("send-idem").checked && !headers["Idempotency-Key"]) headers["Idempotency-Key"] = uuid();
  let raw = opts.raw;
  if (raw === undefined && opts.json !== undefined) { raw = JSON.stringify(opts.json); headers["Content-Type"] = "application/json"; }
  if (opts.remember) {
    S.lastReq = { label: opts.remember, method, path, headers: Object.assign({}, headers), raw };
    $("retry-desc").textContent = `Last: ${opts.remember} — ${method} ${path}` +
      (headers["Idempotency-Key"] ? ` (key ${headers["Idempotency-Key"]})` : " (no Idempotency-Key)");
  }
  const res = await request(method, path, { headers, raw, show: true });
  if (opts.after) await opts.after(res);
  await refreshAll();
  return res;
}

async function fetchFixture(rel) {
  const res = await request("GET", "/web/fixtures/" + rel, { quiet: true });
  if (!res.ok) {
    errorToast("GET", "/web/fixtures/" + rel, res);
    return null;
  }
  return res.text;
}
function askReason(what) {
  const r = prompt(`Reason for ${what} (recorded in the audit log):`);
  if (r === null) return null;
  return r;
}

// ------------------------------------------------------------------ header
async function loadIdentity() {
  const who = await GET("/api/whoami");
  $("whoami").textContent = who.ok ? `${who.body.display} [${who.body.kind}]` : "";
  const res = await GET("/api/projects");
  const sel = $("project");
  sel.innerHTML = "";
  const list = res.ok ? res.body.projects : [];
  list.forEach((p) => sel.appendChild(h("option", { value: p }, p)));
  if (!list.length) sel.appendChild(h("option", { value: "" }, "(no readable projects)"));
  S.project = list.includes(S.project) ? S.project : (list[0] || null);
  if (S.project) sel.value = S.project;
  S.selSnapshot = S.selElement = S.selRelease = S.diffFrom = S.diffTo = null;
}

// ------------------------------------------------------------------ refresh
let refreshing = null;
async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!S.project) {
      for (const id of ["model-body", "release-body", "review-body", "history-body"]) {
        $(id).replaceChildren(h("div", { class: "empty" },
          "This identity cannot read any project. (demo-admin only manages grants.)"));
      }
      return;
    }
    await Promise.all([renderModel(), renderReleases(), renderReview(), renderHistory()]);
  })();
  try { await refreshing; } finally { refreshing = null; }
}
const P = () => encodeURIComponent(S.project);

// ------------------------------------------------------------------ Model / revision explorer
function outcomeBadge(o) {
  if (!o) return badge("—", "grey");
  if (o === "accepted_head") return badge(o, "green");
  if (o === "duplicate_no_change") return badge(o, "grey");
  if (o === "staged_partial") return badge(o, "blue");
  if (o.startsWith("quarantined_")) return badge(o, "amber");
  if (o.startsWith("rejected_")) return badge(o, "red");
  return badge(o, "grey");
}
function snapStatusBadge(s) {
  return badge(s, s === "head" ? "green" : s === "staged_partial" ? "blue" : "grey");
}

async function renderModel() {
  const [src, snaps, imps] = await Promise.all([
    GET(`/api/projects/${P()}/sources`), GET(`/api/projects/${P()}/snapshots`), GET(`/api/projects/${P()}/imports`)]);
  const root = h("div");
  // heads
  root.appendChild(h("h3", null, "Source heads"));
  if (src.ok) {
    root.appendChild(table([
      { label: "source", key: "source" }, { label: "revision", key: "revision", mono: true },
      { label: "head_seq", key: "head_seq" }, { label: "snapshot_id", key: "snapshot_id", mono: true },
      { label: "updated_at", key: "updated_at" }], src.body.heads, { empty: "No source heads yet." }));
    root.appendChild(h("details", null, h("summary", null, `Head history (${src.body.head_history.length})`),
      table([{ label: "source", key: "source" }, { label: "head_seq", key: "head_seq" },
        { label: "revision", key: "revision", mono: true }, { label: "snapshot_id", key: "snapshot_id", mono: true },
        { label: "import_id", key: "import_id", mono: true }, { label: "at", key: "at" }], src.body.head_history)));
  }
  // imports
  root.appendChild(h("h3", null, "Import receipts"));
  if (imps.ok) {
    root.appendChild(h("div", { class: "scroll" }, table([
      { label: "received_at", key: "received_at" }, { label: "import_id", key: "import_id", mono: true },
      { label: "source", key: "source" }, { label: "revision", key: "revision", mono: true },
      { label: "parent", key: "parent_revision", mono: true }, { label: "kind", key: "kind" },
      { label: "outcome", render: (r) => outcomeBadge(r.outcome) },
      { label: "snapshot", key: "snapshot_id", mono: true },
      { label: "dup of / reconciled by", render: (r) => [r.duplicate_of ? mono("dup " + r.duplicate_of) : null,
        r.reconciled_by ? mono(" reconciled→" + r.reconciled_by) : null] },
      { label: "actor", key: "actor" },
      { label: "diagnostics", render: (r) => r.diagnostics && r.diagnostics.length
        ? jsonDetails(r.diagnostics.map((d) => d.code).join(", "), r.diagnostics) : "—" },
    ], imps.body.imports.slice().reverse(), { empty: "No imports yet." })));
  }
  // snapshots
  root.appendChild(h("h3", null, "Snapshots (click to view elements)"));
  let snapList = [];
  if (snaps.ok) {
    snapList = snaps.body.snapshots;
    root.appendChild(h("div", { class: "scroll" }, table([
      { label: "created_at", key: "created_at" }, { label: "snapshot_id", key: "snapshot_id", mono: true },
      { label: "source", key: "source" }, { label: "revision", key: "revision", mono: true },
      { label: "kind", key: "kind" }, { label: "status", render: (r) => snapStatusBadge(r.status) },
      { label: "completeness", render: (r) => badge(r.completeness, r.completeness === "complete" ? "grey" : "blue") },
      { label: "counts", render: (r) => `el ${r.counts.elements_present} (del ${r.counts.elements_deleted}), rel ${r.counts.relationships_present}, rec ${r.counts.records}` },
      { label: "warnings", render: (r) => r.warnings.length ? jsonDetails(`${r.warnings.length}: ` + r.warnings.map((w) => w.code).join(", "), r.warnings) : "—" },
    ], snapList, {
      empty: "No snapshots yet.",
      rowAttrs: (r) => ({ class: "clickable" + (r.snapshot_id === S.selSnapshot ? " selected" : ""),
        onclick: () => { S.selSnapshot = r.snapshot_id; S.selElement = null; renderModel(); } }),
    })));
  }
  const detail = h("div", { class: "two-col" });
  root.appendChild(detail);
  if (S.selSnapshot) {
    const el = await GET(`/api/projects/${P()}/snapshots/${S.selSnapshot}/elements`);
    const left = h("div", null, h("h3", null, `Elements of ${S.selSnapshot}`));
    if (el.ok) {
      left.appendChild(h("div", { class: "muted small" },
        `revision ${el.body.revision} · ${el.body.completeness} · ${el.body.status}`));
      left.appendChild(h("div", { class: "scroll" }, table([
        { label: "source_id", key: "source_id", mono: true }, { label: "entity_uid", key: "entity_uid", mono: true },
        { label: "type", key: "type" }, { label: "name", key: "name" },
        { label: "state", render: (r) => badge(r.state, r.state === "present" ? "green" : "red") },
        { label: "version_id", key: "version_id", mono: true },
        { label: "unrecognized_keys", render: (r) => r.unrecognized_keys.length ? badge(r.unrecognized_keys.join(", "), "amber") : "—" },
      ], el.body.elements, {
        rowAttrs: (r) => ({ class: "clickable" + (r.entity_uid === S.selElement ? " selected" : ""),
          onclick: () => { S.selElement = r.entity_uid; renderModel(); } }),
      })));
      left.appendChild(jsonDetails("Definitions (types / relationship types)", el.body.definitions));
    }
    detail.appendChild(left);
    const right = h("div");
    if (S.selElement) {
      const hist = await GET(`/api/projects/${P()}/entities/${S.selElement}/history`);
      right.appendChild(h("h3", null, "Element history"));
      if (hist.ok) {
        right.appendChild(h("dl", { class: "kv" },
          h("dt", null, "entity_uid"), h("dd", null, mono(hist.body.identity.entity_uid)),
          h("dt", null, "source / native id"), h("dd", null, mono(`${hist.body.identity.source} / ${hist.body.identity.native_id}`)),
          h("dt", null, "first snapshot"), h("dd", null, mono(hist.body.identity.first_snapshot_id))));
        right.appendChild(table([
          { label: "created_at", key: "created_at" }, { label: "revision", key: "revision", mono: true },
          { label: "snapshot", key: "snapshot_id", mono: true }, { label: "snap status", key: "status" },
          { label: "state", key: "state" }, { label: "name", key: "name" },
          { label: "version_id", key: "version_id", mono: true }], hist.body.history));
      }
      const selEl = el.ok && el.body.elements.find((x) => x.entity_uid === S.selElement);
      if (selEl) right.appendChild(jsonDetails("Properties & provenance (in this snapshot)",
        { properties: selEl.properties, owner: selEl.owner, provenance: selEl.provenance }, true));
    } else {
      right.appendChild(h("div", { class: "empty" }, "Click an element to see its history across snapshots."));
    }
    detail.appendChild(right);
  }
  // diff
  root.appendChild(h("h3", null, "Diff between snapshots"));
  const modelSnaps = snapList.filter((s) => s.source !== "cmms");
  const mkSel = (cur, onch) => {
    const s = h("select", { onchange: (e) => onch(e.target.value) },
      h("option", { value: "" }, "— choose —"),
      modelSnaps.map((x) => h("option", { value: x.snapshot_id, selected: x.snapshot_id === cur ? true : null },
        `${x.revision} · ${x.status} · ${x.snapshot_id}`)));
    return s;
  };
  root.appendChild(h("div", { class: "row" }, "from ", mkSel(S.diffFrom, (v) => { S.diffFrom = v; }),
    " to ", mkSel(S.diffTo, (v) => { S.diffTo = v; }),
    h("button", { onclick: () => renderModel() }, "Show diff")));
  if (S.diffFrom && S.diffTo) {
    const d = await GET(`/api/projects/${P()}/diff?from=${encodeURIComponent(S.diffFrom)}&to=${encodeURIComponent(S.diffTo)}`);
    if (d.ok) root.appendChild(renderDiffGroups(d.body));
  }
  $("model-body").replaceChildren(root);
}

function renderDiffGroups(d) {
  const wrap = h("div");
  for (const g of ["data", "structural", "semantic", "identity_review", "relationships"]) {
    const rows = d[g] || [];
    const color = rows.length ? (g === "semantic" || g === "identity_review" ? "amber" : "blue") : "grey";
    wrap.appendChild(h("h4", null, g, " ", badge(String(rows.length), color)));
    wrap.appendChild(genericTable(rows, "No changes."));
  }
  return wrap;
}

// ------------------------------------------------------------------ Release status
function releaseStatusBadge(s) {
  const c = { candidate: "blue", tested_pass: "green", activated_once: "green", tested_fail: "red",
    blocked_generation: "red" }[s] || "grey";
  return badge(s, c);
}

async function renderReleases() {
  const [rels, projs] = await Promise.all([GET(`/api/projects/${P()}/releases`), GET(`/api/projects/${P()}/projections`)]);
  const root = h("div");
  if (projs.ok) fillApprovedProjections(projs.body.projections);
  if (!rels.ok) { $("release-body").replaceChildren(root); return; }
  S.releases = rels.body;
  fillReleaseSelect(rels.body);
  const a = rels.body.active_source;
  root.appendChild(h("dl", { class: "kv" },
    h("dt", null, "Active release"), h("dd", null, rels.body.active_release_id ? mono(rels.body.active_release_id) : badge("none", "grey")),
    a ? [h("dt", null, "Pinned source revision"), h("dd", null, mono(a.revision), " (snapshot ", mono(a.snapshotId), ")"),
      h("dt", null, "Latest validated head"), h("dd", null, mono(a.headRevision)),
      h("dt", null, "isCurrentHead / headsBehind"), h("dd", null, `${a.isCurrentHead} / ${a.headsBehind}`)] : null));
  if (a) {
    if (a.headsBehind > 0) {
      root.appendChild(h("div", { class: "callout warn" },
        `Consumer is ${a.headsBehind} head(s) behind the latest validated source (${a.headRevision}).`));
    }
    if (!a.isCurrentHead) {
      root.appendChild(h("div", { class: "callout warn" },
        `Serving pinned older snapshot: revision ${a.revision}, not current head ${a.headRevision}.`));
    } else {
      root.appendChild(h("div", { class: "callout ok" }, `Active release serves the current head (${a.revision}).`));
    }
  }
  root.appendChild(h("h3", null, "Releases (click for detail)"));
  root.appendChild(table([
    { label: "created_at", key: "created_at" }, { label: "release_id", key: "release_id", mono: true },
    { label: "projection", render: (r) => `${r.projection_id}@${r.projection_version}` },
    { label: "revision", key: "revision", mono: true }, { label: "snapshot", key: "snapshot_id", mono: true },
    { label: "status", render: (r) => [releaseStatusBadge(r.status),
      r.release_id === rels.body.active_release_id ? [" ", badge("ACTIVE", "green")] : null] },
    { label: "contract_digest", render: (r) => mono((r.contract_digest || "").slice(0, 16)) },
    { label: "created_by", key: "created_by" },
  ], rels.body.releases.slice().reverse(), {
    empty: "No releases yet.",
    rowAttrs: (r) => ({ class: "clickable" + (r.release_id === S.selRelease ? " selected" : ""),
      onclick: () => { S.selRelease = r.release_id; $("release-select").value = r.release_id; renderReleases(); } }),
  }));
  root.appendChild(h("details", null, h("summary", null, `Activation history (${rels.body.activation_history.length})`),
    table([{ label: "pointer_seq", key: "pointer_seq" }, { label: "action", key: "action" },
      { label: "release_id", key: "release_id", mono: true }, { label: "previous", key: "previous_release_id", mono: true },
      { label: "actor", key: "actor" }, { label: "reason", key: "reason" }, { label: "at", key: "at" }],
    rels.body.activation_history.slice().reverse())));
  if (S.selRelease) root.appendChild(await renderReleaseDetail(S.selRelease));
  $("release-body").replaceChildren(root);
}

async function renderReleaseDetail(rid) {
  const box = h("div", { class: "panel" });
  const r = await GET(`/api/releases/${rid}`);
  if (!r.ok) return box;
  const v = r.body;
  box.appendChild(h("h3", null, "Release ", mono(rid), " ", releaseStatusBadge(v.status),
    v.is_active ? [" ", badge("ACTIVE", "green")] : null));
  box.appendChild(h("div", { class: "muted small" }, `created by ${v.created_by} at ${v.created_at}; manifest digest `,
    mono(v.manifest_digest)));
  box.appendChild(jsonDetails("Manifest", v.manifest));
  // diagnostics
  box.appendChild(h("h4", null, "Diagnostics"));
  const groups = {};
  v.diagnostics.forEach((d) => (groups[d.class || "other"] = groups[d.class || "other"] || []).push(d));
  const blockingCount = v.diagnostics.filter((d) => BLOCKING.has(d.code)).length;
  if (blockingCount) box.appendChild(h("div", { class: "callout bad" }, `${blockingCount} blocking diagnostic(s)`));
  if (!v.diagnostics.length) box.appendChild(h("div", { class: "empty" }, "No diagnostics."));
  for (const cls of ["structural", "semantic", "data", ...Object.keys(groups).filter((k) => !["structural", "semantic", "data"].includes(k))]) {
    if (!groups[cls]) continue;
    box.appendChild(h("div", { class: "small" }, h("strong", null, cls), ` (${groups[cls].length})`));
    const keys = [...new Set(groups[cls].flatMap((d) => Object.keys(d)))].filter((k) => k !== "class");
    box.appendChild(table(keys.map((k) => ({ label: k,
      render: (d) => k === "code" ? h("span", { class: BLOCKING.has(d.code) ? "blocking mono" : "mono" },
        d.code + (BLOCKING.has(d.code) ? " (blocking)" : "")) : fmt(d[k]) })), groups[cls]));
  }
  // contract diff
  box.appendChild(h("h4", null, "Contract diff vs active"));
  if (v.contract_diff_vs_active) {
    box.appendChild(h("div", { class: "small muted" }, `baseline contract version: ${fmt(v.contract_diff_vs_active.baseline)}`));
    box.appendChild(table([
      { label: "change", key: "change" },
      { label: "class", render: (c) => badge(c.class, /breaking/.test(c.class) ? "red" : c.class === "semantic" ? "amber" : "blue") },
      { label: "schema", key: "schema" }, { label: "field", key: "field" },
      { label: "detail", render: (c) => fmt(Object.fromEntries(Object.entries(c).filter(([k]) => !["change", "class", "schema", "field"].includes(k)))) },
    ], v.contract_diff_vs_active.changes, { empty: "No contract changes." }));
  } else box.appendChild(h("div", { class: "empty" }, "This is the active release."));
  box.appendChild(h("h4", null, "Source diff vs active"));
  box.appendChild(v.source_diff_vs_active ? renderDiffGroups(v.source_diff_vs_active)
    : h("div", { class: "empty" }, "Same source snapshot as active (or no active release)."));
  // consumer checks
  box.appendChild(h("h4", null, `Consumer test runs (${v.consumer_test_runs.length})`));
  if (!v.consumer_test_runs.length) box.appendChild(h("div", { class: "empty" }, "Consumer checks not run."));
  v.consumer_test_runs.slice().reverse().forEach((run) => {
    const d = h("details", { open: run === v.consumer_test_runs[v.consumer_test_runs.length - 1] ? true : null },
      h("summary", null, badge(run.passed ? "PASS" : "FAIL", run.passed ? "green" : "red"), " ", mono(run.run_id),
        ` · ${run.consumer_id} v${run.consumer_version} · ${run.started_at}`));
    const res = run.results || {};
    if (res.error) d.appendChild(h("div", { class: "callout bad" }, res.error));
    (res.profiles || []).forEach((p) => {
      d.appendChild(h("div", null, h("strong", null, "Profile ", p.profile, " "), badge(p.passed ? "pass" : "fail", p.passed ? "green" : "red")));
      d.appendChild(table([
        { label: "check", key: "check" },
        { label: "result", render: (c) => badge(c.passed ? "pass" : "fail", c.passed ? "green" : "red") },
        { label: "detail", key: "detail" }], p.checks));
    });
    const sc = run.schema_check || {};
    d.appendChild(h("div", null, h("strong", null, "Schema check "), badge(sc.passed ? "pass" : "fail", sc.passed ? "green" : "red"),
      h("span", { class: "muted small" }, " ", sc.note || "")));
    d.appendChild(table([{ label: "resource", key: "resource" }, { label: "pages", key: "pages" },
      { label: "valid", render: (x) => badge(String(x.valid), x.valid ? "green" : "red") },
      { label: "errors", render: (x) => x.errors.join("\n") || "—" }], sc.resources || []));
    d.appendChild(h("div", { class: "muted small" }, "expectations digest ", mono(run.expectations_digest)));
    box.appendChild(d);
  });
  // openapi
  const pre = h("pre", { hidden: true });
  box.appendChild(h("div", { class: "row" }, h("button", {
    onclick: async () => {
      const o = await GET(`/api/releases/${rid}/openapi.json`);
      pre.hidden = false;
      pre.textContent = o.ok ? JSON.stringify(o.body, null, 2) : `HTTP ${o.status}\n${o.text}`;
    } }, "Load /api/releases/" + rid + "/openapi.json"), h("span", { class: "muted small" }, "(fetched with the auth header)")));
  box.appendChild(pre);
  return box;
}

function fillApprovedProjections(list) {
  const sel = $("proj-approved");
  const prev = sel.value;
  sel.innerHTML = "";
  const approved = list.filter((p) => p.status === "approved");
  if (!approved.length) sel.appendChild(h("option", { value: "" }, "(no approved projection)"));
  approved.forEach((p) => sel.appendChild(h("option", { value: `${p.projection_id}@${p.version}` }, `${p.projection_id}@${p.version}`)));
  const others = list.filter((p) => p.status !== "approved");
  if (others.length) sel.appendChild(h("optgroup", { label: "not approved (build will be refused)" },
    others.map((p) => h("option", { value: `${p.projection_id}@${p.version}` }, `${p.projection_id}@${p.version} [${p.status}]`))));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (approved.length) sel.value = `${approved[approved.length - 1].projection_id}@${approved[approved.length - 1].version}`;
}
function fillReleaseSelect(body) {
  const sel = $("release-select");
  const prev = S.selRelease || sel.value;
  sel.innerHTML = "";
  if (!body.releases.length) sel.appendChild(h("option", { value: "" }, "(no releases)"));
  body.releases.slice().reverse().forEach((r) => sel.appendChild(h("option", { value: r.release_id },
    `${r.release_id} · ${r.projection_version} · ${r.revision} · ${r.status}${r.release_id === body.active_release_id ? " · ACTIVE" : ""}`)));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ------------------------------------------------------------------ Relationship review
function validationBadge(v) { return badge(v, v === "valid" ? "green" : "amber"); }
function dispositionBadge(d) {
  const c = { unresolved: "blue", accepted: "green", rejected: "grey", no_match: "grey", missing_evidence: "amber",
    stale_needs_review: "red", superseded: "grey", predicate_changed: "grey" }[d] || "grey";
  return badge(d, c);
}

function renderEvidence(ev, records) {
  const rec = records[ev.record_id];
  const field = ev.field || "text";
  const src = rec ? (rec[field] ?? "") : null;
  if (!ev.valid) {
    return h("div", { class: "evidence invalid" }, mono(`${ev.record_id}.${field} `),
      h("span", { class: "strike" }, `“${ev.quote}”`), " ", badge("not found in source bytes", "red"));
  }
  if (src == null) {
    return h("div", { class: "evidence" }, mono(`${ev.record_id}.${field} [${ev.start},${ev.end}) `),
      `“${ev.quote}” `, h("span", { class: "muted small" }, "(record not in current record head)"));
  }
  const matches = src.slice(ev.start, ev.end) === ev.quote;
  return h("div", { class: "evidence" }, mono(`${ev.record_id}.${field} [${ev.start},${ev.end}) v${ev.record_version || "?"}`), h("br"),
    matches ? [src.slice(0, ev.start), h("mark", null, src.slice(ev.start, ev.end)), src.slice(ev.end)]
      : [src, " ", badge(`span does not match current record text; cited quote: “${ev.quote}”`, "amber")]);
}

async function renderReview() {
  const [props, recs, lnks] = await Promise.all([GET(`/api/projects/${P()}/proposals`),
    GET(`/api/projects/${P()}/records`), GET(`/api/projects/${P()}/links`)]);
  const root = h("div");
  if (!props.ok) { $("review-body").replaceChildren(root); return; }
  const records = {};
  if (recs.ok) recs.body.records.forEach((r) => { records[r.record_id] = r; });
  // runs
  const runs = props.body.runs;
  if (runs.some((r) => r.mode === "fixture")) {
    root.appendChild(h("div", { class: "callout fixture" },
      "FIXTURE MODE: some proposals come from scripted model outputs — not evidence of model quality."));
  }
  root.appendChild(h("h3", null, `Proposal runs (${runs.length})`));
  root.appendChild(table([
    { label: "started_at", key: "started_at" }, { label: "run_id", key: "run_id", mono: true },
    { label: "method / mode", render: (r) => [r.method, " / ", r.mode === "fixture" ? badge("FIXTURE MODE", "amber") : r.mode] },
    { label: "provider / model", render: (r) => `${fmt(r.provider)} / ${fmt(r.model)}` },
    { label: "status", render: (r) => badge(r.status, r.status === "completed" ? "green" : "red") },
    { label: "error", render: (r) => r.error ? h("span", { class: "blocking" }, r.error) : "—" },
    { label: "prompt / vocab", render: (r) => `${fmt(r.prompt_version)} / ${fmt(r.vocabulary_version)}` },
    { label: "stats", render: (r) => { try { const s = JSON.parse(r.stats_json || "null"); return s ? `cand ${s.candidates}, stored ${s.stored}, valid ${s.valid}, ${s.elapsed_ms}ms` : "—"; } catch (_) { return r.stats_json; } } },
  ], runs.slice().reverse(), { empty: "No proposal runs yet." }));
  // proposals grouped by record
  const list = props.body.proposals;
  S.proposalsView = {};
  list.forEach((p) => { S.proposalsView[p.proposal_id] = p; });
  const byRecord = {};
  list.forEach((p) => (byRecord[p.record.id] = byRecord[p.record.id] || []).push(p));
  const competing = new Set(Object.entries(byRecord).filter(([, ps]) => {
    const open = ps.filter((p) => ["unresolved", "stale_needs_review"].includes(p.disposition));
    const targets = new Set(open.map((p) => p.target ? p.target.entity_uid : null));
    return targets.size > 1 || ps.some((p) => p.validation_notes.some((n) => n.code === "competing_candidates_for_record")
      && ["unresolved", "stale_needs_review"].includes(p.disposition));
  }).map(([k]) => k));
  root.appendChild(h("h3", null, `Proposals (${list.length}) grouped by record`,
    competing.size ? [" ", badge(`${competing.size} record(s) with competing candidates`, "red")] : null));
  const tbody = h("tbody");
  Object.keys(byRecord).sort().forEach((rid) => {
    byRecord[rid].forEach((p, i) => {
      const fr = p.freshness;
      const open = ["unresolved", "stale_needs_review"].includes(p.disposition);
      const unresolved = p.disposition === "unresolved";
      const cls = [i === 0 ? "group-start" : "", competing.has(rid) ? "competing" : ""].join(" ");
      const btn = (label, fn, dis) => h("button", { class: "small", disabled: dis ? true : null, onclick: fn }, label);
      tbody.appendChild(h("tr", { class: cls },
        h("td", null, i === 0 ? [mono(rid), competing.has(rid) ? [h("br"), badge("competing candidates", "red")] : null,
          records[rid] ? h("div", { class: "muted small" }, `asset_ref: ${fmt(records[rid].asset_ref)}`) : null] : ""),
        h("td", null, p.target ? [mono(p.target.source_id), h("br"), p.target.name_at_proposal, h("div", { class: "muted small" }, p.target.type)] : badge("no target", "grey")),
        h("td", { class: "mono wrap" }, p.predicate.replace(/_/g, "_\u200b")),
        h("td", null, p.method ? [p.method.method, " / ", p.method.mode === "fixture" ? badge("FIXTURE MODE", "amber") : p.method.mode,
          h("div", { class: "muted small" }, fmt(p.method.model))] : "—"),
        h("td", null, fmt(p.confidence)),
        h("td", null, validationBadge(p.validation)),
        h("td", null, p.validation_notes.length ? p.validation_notes.map((n) => h("div", { class: "small" },
          badge(n.code, "amber"), " ", n.message || "")) : "—"),
        h("td", null, badge(fr.status, fr.status === "current" ? "green" : "red"),
          fr.issues.length ? h("div", { class: "small" }, fr.issues.join(", ")) : null,
          h("div", { class: "muted small mono" }, `model ${fmt(fr.model_head)}`, h("br"), `record ${fmt(fr.record_head)}`)),
        h("td", null, dispositionBadge(p.disposition), p.decisions.length ? h("div", { class: "muted small" },
          p.decisions.map((d) => `${d.decision} by ${d.actor}${d.revoked_at ? " (revoked)" : ""}`).join("; ")) : null),
        h("td", null, h("div", { class: "btn-wrap" },
          btn("Accept", () => decide(p.proposal_id, "accept"), !unresolved),
          btn("Reject", () => decide(p.proposal_id, "reject"), !unresolved),
          btn("No match", () => decide(p.proposal_id, "no_match"), !unresolved),
          btn("Missing evidence", () => decide(p.proposal_id, "missing_evidence"), !unresolved),
          btn("Rebase", () => rebase(p.proposal_id), !open)),
        h("div", { class: "muted small mono" }, p.proposal_id, " r", p.revision))));
      tbody.appendChild(h("tr", { class: "evrow" + (competing.has(rid) ? " competing" : "") }, h("td"),
        h("td", { colspan: "9" }, h("strong", { class: "small" }, "Evidence: "),
          p.evidence.length ? p.evidence.map((ev) => renderEvidence(ev, records)) : h("span", { class: "muted" }, "no evidence"),
          p.contradictions.length ? h("div", { class: "small" }, badge("contradictions", "amber"), " ", p.contradictions.join("; ")) : null)));
    });
  });
  if (list.length) {
    root.appendChild(h("table", null, h("thead", null, h("tr", null,
      ["record", "target (source_id / name at proposal)", "predicate", "method", "conf.", "validation",
        "validation notes", "freshness", "disposition", "actions"].map((c) => h("th", null, c)))), tbody));
  } else root.appendChild(h("div", { class: "empty" }, "No proposals yet. Run a proposal run from Demo controls."));
  // links
  root.appendChild(h("h3", null, "Accepted links"));
  if (lnks.ok) {
    root.appendChild(table([
      { label: "link_id", key: "link_id", mono: true }, { label: "record", key: "record_id", mono: true },
      { label: "target", key: "target_source_id", mono: true }, { label: "predicate", key: "predicate", mono: true },
      { label: "authority", key: "authority" },
      { label: "status", render: (l) => badge(l.status, l.status === "active" ? "green" : "grey") },
      { label: "current_target_status", render: (l) => badge(l.current_target_status, l.current_target_status === "target_present" ? "green" : "red") },
      { label: "created_at", key: "created_at" }, { label: "note", key: "status_note" },
    ], lnks.body.links, { empty: "No accepted links." }));
  }
  if (recs.ok) {
    root.appendChild(h("details", null, h("summary", null, `Records at record head ${fmt(recs.body.revision)} (${recs.body.records.length})`),
      table([{ label: "record_id", key: "record_id", mono: true }, { label: "version", key: "record_version", mono: true },
        { label: "kind", key: "kind" }, { label: "asset_ref", key: "asset_ref" }, { label: "text", key: "text" }], recs.body.records)));
  }
  $("review-body").replaceChildren(root);
}

async function decide(pid, decision) {
  const view = S.proposalsView[pid];  // the client's view as displayed; NOT refetched before posting
  const reason = askReason(`${decision} of ${pid}`);
  if (reason === null) return;
  const g = await GET(`/api/proposals/${pid}`);
  if (!g.ok) return;
  const etag = g.headers.get("ETag");
  const key = uuid();
  await action("POST", `/manage/proposals/${pid}/decision`, {
    headers: { "If-Match": etag, "Idempotency-Key": key },
    json: { decision, reason, expected_model_revision: view ? view.freshness.model_head : null,
      expected_record_revision: view ? view.freshness.record_head : null },
    remember: `proposal ${decision}`,
  });
}
async function rebase(pid) {
  const g = await GET(`/api/proposals/${pid}`);
  if (!g.ok) return;
  const headers = { "If-Match": g.headers.get("ETag") };
  await action("POST", `/manage/proposals/${pid}/rebase`, { headers, idem: true, remember: "proposal rebase" });
}

// ------------------------------------------------------------------ Operation history
async function renderHistory() {
  const res = await GET(`/api/projects/${P()}/history`);
  const root = h("div");
  if (!res.ok) { $("history-body").replaceChildren(root); return; }
  const b = res.body;
  S.history = b;
  fillEventSelect(b.outbox);
  root.appendChild(h("div", null, "Outbox worker: ",
    badge(b.outbox_worker, b.outbox_worker === "running" ? "green" : "amber")));
  root.appendChild(h("h3", null, `Outbox events (${b.outbox.length})`));
  root.appendChild(h("div", { class: "scroll" }, table([
    { label: "seq", key: "seq" }, { label: "event_id", key: "event_id", mono: true }, { label: "type", key: "type" },
    { label: "created_at", key: "created_at" },
    { label: "delivered_at", render: (e) => e.delivered_at || badge("pending", "amber") },
    { label: "attempts", key: "attempts" }, { label: "last_error", key: "last_error" },
    { label: "attempts_log", render: (e) => e.attempts_log.length ? h("div", { class: "small" },
      e.attempts_log.map((a) => h("div", null, `#${a.attempt} ${a.at} `,
        badge(a.outcome, /ack|ok|deliver/.test(a.outcome) ? "green" : "amber"), a.detail ? " " + a.detail : ""))) : "—" },
    { label: "payload", render: (e) => jsonDetails("payload", e.payload) },
  ], b.outbox, { empty: "No events." })));
  root.appendChild(h("h3", null, `Operation receipts (${b.receipts.length})`));
  root.appendChild(h("div", { class: "scroll" }, table([
    { label: "created_at", key: "created_at" }, { label: "caller", key: "caller" },
    { label: "operation_id", key: "operation_id", mono: true }, { label: "operation", key: "operation" },
    { label: "status_code", render: (r) => badge(String(r.status_code), r.status_code < 300 ? "green" : r.status_code < 500 ? "amber" : "red") },
    { label: "state", key: "state" }, { label: "expires_at", key: "expires_at" },
    { label: "response", render: (r) => jsonDetails("response", r.response) },
  ], b.receipts, { empty: "No receipts (only requests with Idempotency-Key produce receipts)." })));
  root.appendChild(h("h3", null, `Audit events (${b.audit.length})`));
  root.appendChild(h("div", { class: "scroll" }, table([
    { label: "at", key: "at" }, { label: "actor", key: "actor" }, { label: "action", key: "action" },
    { label: "outcome", render: (a) => badge(a.outcome, /^(refused|rejected|fail|quarantined)/.test(a.outcome) ? "amber"
      : /committed|accepted|approved|pass|completed/.test(a.outcome) ? "green" : "grey") },
    { label: "operation_id", key: "operation_id", mono: true },
    { label: "detail", render: (a) => jsonDetails("detail", a.detail) },
  ], b.audit, { empty: "No audit events." })));
  $("history-body").replaceChildren(root);
}
function fillEventSelect(events) {
  const sel = $("event-select");
  const prev = sel.value;
  sel.innerHTML = "";
  if (!events.length) sel.appendChild(h("option", { value: "" }, "(no outbox events)"));
  events.forEach((e) => sel.appendChild(h("option", { value: e.event_id },
    `#${e.seq} ${e.type} · ${e.delivered_at ? "delivered" : "pending"} · ${e.event_id}`)));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ------------------------------------------------------------------ Demo controls wiring
function needProject() {
  if (!S.project) { toast("No readable project selected for this identity.", "warn"); return false; }
  return true;
}
function wireControls() {
  const ib = $("import-buttons");
  MODEL_FIXTURES.forEach((rel) => ib.appendChild(h("button", {
    onclick: async () => {
      if (!needProject()) return;
      const raw = await fetchFixture(rel);
      if (raw === null) return;
      await action("POST", `/manage/projects/${P()}/imports`, { raw, idem: true, remember: `import ${rel}`,
        headers: { "Content-Type": "application/json" } });
    } }, rel.replace(/\.json$/, ""))));

  $("retry-last").addEventListener("click", async () => {
    const r = S.lastReq;
    if (!r) { toast("Nothing to retry yet: send an import, decision or activation first.", "warn"); return; }
    if (!r.headers["Idempotency-Key"]) toast("Previous request had no Idempotency-Key: this retry is a new operation.", "warn", 8000);
    await action(r.method, r.path, { headers: r.headers, raw: r.raw });
  });

  PROJECTION_FIXTURES.forEach((f) => $("proj-fixture").appendChild(h("option", { value: f }, f)));
  $("proj-fixture").value = "equipment-health_1.1.0.json";
  $("btn-register").addEventListener("click", async () => {
    const f = $("proj-fixture").value;
    const raw = await fetchFixture("projections/" + f);
    if (raw === null) return;
    let body;
    try { body = JSON.parse(raw); } catch (e) { toast("Projection fixture is not JSON: " + e); return; }
    const reg = await action("POST", "/manage/projections", { raw, headers: { "Content-Type": "application/json" } });
    if (!reg.ok) return;
    const reason = askReason(`approving projection ${body.projection_id}@${body.version}`);
    if (reason === null) { toast("Registered but not approved (no reason given).", "warn"); return; }
    await action("POST", `/manage/projections/${encodeURIComponent(body.projection_id)}/${encodeURIComponent(body.version)}/review`,
      { json: { decision: "approve", reason } });
  });
  $("btn-build").addEventListener("click", async () => {
    if (!needProject()) return;
    const v = $("proj-approved").value;
    if (!v) { toast("Choose a projection version first.", "warn"); return; }
    const [projection_id, version] = v.split("@");
    const res = await action("POST", `/manage/projects/${P()}/releases`, { json: { projection_id, version } });
    if (res.ok && res.body && res.body.release_id) { S.selRelease = res.body.release_id; await refreshAll(); }
  });
  const rid = () => { const v = $("release-select").value; if (!v) toast("Choose a release first.", "warn"); return v; };
  $("release-select").addEventListener("change", (e) => { S.selRelease = e.target.value; renderReleases(); });
  $("btn-checks").addEventListener("click", async () => {
    const r = rid(); if (!r) return;
    const res = await action("POST", `/manage/releases/${r}/consumer-checks`, {});
    if (res.ok && res.body) {
      const last = res.body.consumer_test_runs[res.body.consumer_test_runs.length - 1];
      if (last && !last.passed) toast(`Consumer checks FAILED for ${r} (status ${res.body.status}).`, "error");
      else if (last) toast(`Consumer checks passed for ${r}.`, "info", 5000);
    }
  });
  $("btn-activate").addEventListener("click", async () => {
    const r = rid(); if (!r) return;
    const reason = askReason(`activating ${r}`); if (reason === null) return;
    const expected = S.releases ? S.releases.active_release_id : null;  // client's current view
    await action("POST", `/manage/releases/${r}/activate`, { idem: true, remember: `activate ${r}`,
      json: { expected_active_release_id: expected, reason } });
  });
  $("btn-rollback").addEventListener("click", async () => {
    if (!needProject()) return;
    const reason = askReason("rollback"); if (reason === null) return;
    const expected = S.releases ? S.releases.active_release_id : null;
    await action("POST", `/manage/projects/${P()}/rollback`, { idem: true, remember: "rollback",
      json: { expected_active_release_id: expected, reason } });
  });
  document.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", async () => {
    if (!needProject()) return;
    const k = b.dataset.run;
    const json = k === "deterministic" ? { method: "deterministic" } : { method: "model", mode: k };
    const res = await action("POST", `/manage/projects/${P()}/proposal-runs`, { json });
    if (res.body && res.body.status === "failed") {
      toast(h("span", null, h("strong", null, `Proposal run FAILED (${k}): `), res.body.error || "unknown error"), "error", 0);
    } else if (res.body && res.body.label) {
      toast(res.body.label, "warn", 10000);
    }
  }));
  document.querySelectorAll("[data-outbox]").forEach((b) => b.addEventListener("click",
    () => action("POST", `/manage/outbox/${b.dataset.outbox}`, {})));
  $("btn-fault").addEventListener("click", () => action("POST", "/manage/consumer/faults", { json: { drop_ack_after_commit: 1 } }));
  $("btn-redeliver").addEventListener("click", () => {
    const e = $("event-select").value;
    if (!e) { toast("Choose an outbox event first.", "warn"); return; }
    return action("POST", `/manage/outbox/${e}/redeliver`, {});
  });
  $("btn-grant").addEventListener("click", () => action("POST", "/manage/grants", { json: {
    user: $("g-user").value, project: $("g-project").value.trim(), permission: $("g-perm").value,
    action: $("g-action").value } }));

  $("token").addEventListener("change", async (e) => { S.token = e.target.value; await loadIdentity(); await refreshAll(); });
  $("project").addEventListener("change", async (e) => {
    S.project = e.target.value || null;
    S.selSnapshot = S.selElement = S.selRelease = S.diffFrom = S.diffTo = null;
    await refreshAll();
  });
  $("refresh").addEventListener("click", async () => { await loadIdentity(); await refreshAll(); });
  $("hist-auto").addEventListener("change", (e) => {
    clearInterval(S.histTimer); S.histTimer = null;
    if (e.target.checked) S.histTimer = setInterval(() => { if (S.project) renderHistory(); }, 3000);
  });
}

window.addEventListener("unhandledrejection", (e) => toast("UI error: " + (e.reason && e.reason.message || e.reason)));
window.addEventListener("error", (e) => toast("UI error: " + e.message));

(async function main() {
  S.token = $("token").value;
  wireControls();
  await loadIdentity();
  await refreshAll();
})();
