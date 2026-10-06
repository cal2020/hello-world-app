/* HEXIS Runtime Lab: the live state-machine graph (HXUI.graph).

   Self-contained: it needs no other app file. Three parts:
   * layout(machine, opts?)  pure and deterministic. It does not depend on the key order of machine.states.
     The main success path (initial -> verified terminal) runs down one straight column, the "spine". Side
     states such as REPAIR_DRAFT sit one row below the state that enters them, to the left, and their loop is
     drawn as a U-turn. Self-loops curl out to the left. Every edge into a terminal state is drawn as a small
     pill ("stub") right next to its source, in a lane to the right. Only the spine's own last edge reaches the
     drawn terminal at the bottom. Everything else is routed through the free channels between columns.
   * create(container, machine, opts) draws the layout as inline SVG with a text alternative.
   * view.update(run) restyles the existing drawing in place on every step: no redraw, no flash. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* ================================================================== metrics */
  // Monospace advance is 0.6em in IBM Plex Mono and in every fallback of --font-mono, so mono text is measured
  // exactly. Sans text (kind words, terminal categories, tags) uses a conservative average.
  const MONO_EM = 0.6;
  const SANS_EM = 0.6;
  const GUARD_MAX = 34; // characters per guard line on an edge (about 30); the full text is in a <title>
  const GUARD_LINES = 3;
  const ID_MAX = 30;
  const FS = { id: 13, sub: 12, label: 12, cat: 12, tag: 12, badge: 12 };

  const SIZES = {
    normal: {
      nh: 46, gap_y: 50, gap_x: 84, pad: 12, min_w: 150, max_w: 340, sh: 22, sgap: 84, spad: 10, stack: 4,
      port_v: 24, port_h: 56, loop: 54, radius: 10, margin: 16, start: 30, base1: 19, base2: 35, lh: 15,
      lpad_x: 5, lpad_y: 3, badge_first: 16, badge_step: 22, tag_w: 92, sub: true,
    },
    // Compact (Overview): one line per state (the action is in the tooltip and the text alternative), tight
    // spacing, edge labels only on hover or focus. The view scales it down to fit its column (to 75%).
    compact: {
      nh: 30, gap_y: 28, gap_x: 44, pad: 10, min_w: 110, max_w: 280, sh: 20, sgap: 34, spad: 8, stack: 4,
      port_v: 12, port_h: 40, loop: 36, radius: 8, margin: 10, start: 22, base1: 19.5, base2: 19.5, lh: 15,
      lpad_x: 5, lpad_y: 3, badge_first: 11, badge_step: 20, tag_w: 0, sub: false,
    },
  };

  const CATEGORY_TONE = { verified: "ok", unverified: "warn", fallback: "crit" };

  /* ================================================================== small helpers */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const r1 = (v) => Math.round(v * 10) / 10;
  const chars = (s) => Array.from(String(s)).length;
  const mono_w = (s, fs) => Math.ceil(chars(s) * fs * MONO_EM);
  const sans_w = (s, fs) => Math.ceil(chars(s) * fs * SANS_EM);
  function clip_text(s, n) {
    const a = Array.from(String(s));
    return a.length > n ? a.slice(0, n - 1).join("").replace(/\s+$/, "") + "\u2026" : a.join("");
  }
  /** Word-wrap one clause of a guard at spaces outside quotes; continuation lines are indented by two spaces. */
  function wrap_words(text) {
    const out = [];
    let rest = text;
    while (chars(rest) > GUARD_MAX) {
      let quote = "", cut = -1;
      for (let i = 0; i < rest.length && i <= GUARD_MAX; i++) {
        const c = rest[i];
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === "'" || c === '"') quote = c;
        else if (c === " " && i > 0) cut = i;
      }
      if (cut <= 0) break;
      out.push(rest.slice(0, cut));
      rest = "  " + rest.slice(cut + 1);
    }
    out.push(rest);
    return out;
  }
  /** A guard as display lines: split at top-level " and " / " or " (outside quotes and brackets), packed into
      lines of at most GUARD_MAX characters; anything longer is clipped with an ellipsis. */
  function guard_lines(cond) {
    const parts = [];
    let depth = 0, quote = "", start = 0;
    for (let i = 0; i < cond.length; i++) {
      const c = cond[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') quote = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      else if (depth === 0 && c === " ") {
        const m = /^ (and|or) /.exec(cond.slice(i, i + 5));
        if (m) { parts.push(cond.slice(start, i)); start = i + 1; }
      }
    }
    parts.push(cond.slice(start));
    const lines = [];
    for (const part of parts.map((x) => x.trim()).filter(Boolean)) {
      const last = lines.length ? lines[lines.length - 1] : null;
      if (last !== null && chars(last) + 1 + chars(part) <= GUARD_MAX) lines[lines.length - 1] = last + " " + part;
      else lines.push(...wrap_words(part));
    }
    const out = lines.slice(0, GUARD_LINES).map((x) => clip_text(x, GUARD_MAX));
    if (lines.length > GUARD_LINES) out[GUARD_LINES - 1] = clip_text(out[GUARD_LINES - 1] + " \u2026", GUARD_MAX);
    return out;
  }
  function overlaps(a, b, m) {
    m = m || 0;
    return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  }
  function contains(b, p, m) {
    m = m || 0;
    return p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m;
  }
  const pt = (x, y) => ({ x, y });

  /* ================================================================== paths */
  // A path is a list of segments {k: "L"|"Q"|"C", p: [points]}; consecutive segments share end points.
  function seg_at(s, u) {
    const p = s.p, v = 1 - u;
    if (s.k === "L") return pt(p[0].x * v + p[1].x * u, p[0].y * v + p[1].y * u);
    if (s.k === "Q") {
      return pt(v * v * p[0].x + 2 * v * u * p[1].x + u * u * p[2].x, v * v * p[0].y + 2 * v * u * p[1].y + u * u * p[2].y);
    }
    const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    return pt(a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x, a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y);
  }
  function seg_len(s) {
    if (s.k === "L") return Math.hypot(s.p[1].x - s.p[0].x, s.p[1].y - s.p[0].y);
    let n = 0, prev = s.p[0];
    for (let i = 1; i <= 24; i++) {
      const q = seg_at(s, i / 24);
      n += Math.hypot(q.x - prev.x, q.y - prev.y);
      prev = q;
    }
    return n;
  }
  /** Points every ~step px along the path, each with its distance from the start. */
  function sample(segs, step) {
    const out = [];
    let d0 = 0;
    segs.forEach((s, i) => {
      const len = seg_len(s);
      const n = Math.max(2, Math.ceil(len / step));
      for (let j = i === 0 ? 0 : 1; j <= n; j++) {
        const q = seg_at(s, j / n);
        out.push({ x: q.x, y: q.y, d: d0 + (len * j) / n });
      }
      d0 += len;
    });
    return out;
  }
  function path_length(segs) { return segs.reduce((n, s) => n + seg_len(s), 0); }
  function point_at(samples, d) {
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].d >= d) {
        const a = samples[i - 1], b = samples[i];
        const u = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
        return pt(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
      }
    }
    const z = samples[samples.length - 1];
    return pt(z.x, z.y);
  }
  function path_d(segs) {
    if (!segs.length) return "";
    const f = (q) => r1(q.x) + " " + r1(q.y);
    let d = "M" + f(segs[0].p[0]);
    for (const s of segs) {
      if (s.k === "L") d += " L" + f(s.p[1]);
      else if (s.k === "Q") d += " Q" + f(s.p[1]) + " " + f(s.p[2]);
      else d += " C" + f(s.p[1]) + " " + f(s.p[2]) + " " + f(s.p[3]);
    }
    return d;
  }
  const line = (a, b) => [{ k: "L", p: [a, b] }];
  const cubic = (a, c1, c2, b) => [{ k: "C", p: [a, c1, c2, b] }];
  /** Orthogonal polyline with rounded corners. */
  function ortho(pts, radius) {
    const P = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 0.01);
    const segs = [];
    let cur = P[0];
    for (let i = 1; i < P.length; i++) {
      const p = P[i];
      if (i < P.length - 1) {
        const n = P[i + 1];
        const lin = Math.hypot(p.x - P[i - 1].x, p.y - P[i - 1].y), lout = Math.hypot(n.x - p.x, n.y - p.y);
        const r = Math.min(radius, lin / 2, lout / 2);
        const a = pt(p.x - ((p.x - P[i - 1].x) / lin) * r, p.y - ((p.y - P[i - 1].y) / lin) * r);
        const b = pt(p.x + ((n.x - p.x) / lout) * r, p.y + ((n.y - p.y) / lout) * r);
        if (Math.hypot(a.x - cur.x, a.y - cur.y) > 0.01) segs.push({ k: "L", p: [cur, a] });
        segs.push({ k: "Q", p: [a, p, b] });
        cur = b;
      } else if (Math.hypot(p.x - cur.x, p.y - cur.y) > 0.01) {
        segs.push({ k: "L", p: [cur, p] });
      }
    }
    return segs;
  }
  function shift_segs(segs, dx, dy) {
    return segs.map((s) => ({ k: s.k, p: s.p.map((q) => pt(q.x + dx, q.y + dy)) }));
  }

  /* ================================================================== reading the machine */
  function read_machine(machine) {
    const m = machine && typeof machine === "object" ? machine : {};
    const raw = m.states && typeof m.states === "object" ? m.states : {};
    const cats = {};
    for (const t of Array.isArray(m.terminals) ? m.terminals : []) {
      if (t && typeof t.id === "string") cats[t.id] = typeof t.kind === "string" ? t.kind : "";
    }
    const entries = Array.isArray(raw)
      ? raw.filter((s) => s && typeof s.id === "string").map((s) => [s.id, s])
      : Object.keys(raw).map((k) => [k, raw[k]]);
    entries.sort((a, b) => cmp(a[0], b[0]));
    const S = {};
    for (const [id, s0] of entries) {
      if (Object.prototype.hasOwnProperty.call(S, id)) continue;
      const s = s0 && typeof s0 === "object" ? s0 : {};
      const a = s.action && typeof s.action === "object" ? s.action : {};
      const kind = typeof a.kind === "string" ? a.kind : "unknown";
      const trans = (Array.isArray(s.transitions) ? s.transitions : []).map((t0, i) => {
        const t = t0 && typeof t0 === "object" ? t0 : {};
        const cond = typeof t.if === "string" ? t.if : typeof t.cond === "string" ? t.cond : "";
        return { index: i, cond: cond.trim() ? cond : "", to: String(t.to), inc: typeof t.inc === "string" && t.inc ? t.inc : null };
      });
      const term = kind === "end" ? (typeof a.terminal === "string" ? a.terminal : id) : null;
      S[id] = {
        id, kind, action: a, trans, clause: typeof s.clause === "string" ? s.clause : "",
        terminal: term, category: term === null ? null : (Object.prototype.hasOwnProperty.call(cats, term) ? cats[term] : ""),
      };
    }
    const ghost = (id) => ({ id, kind: "missing", action: {}, trans: [], clause: "", terminal: null, category: null });
    for (const id of Object.keys(S).sort(cmp)) for (const t of S[id].trans) if (!S[t.to]) S[t.to] = ghost(t.to);
    let initial = typeof m.initial === "string" && m.initial ? m.initial : null;
    if (initial && !S[initial]) S[initial] = ghost(initial);
    if (!initial) initial = Object.keys(S).sort(cmp)[0] || null;
    return {
      S, initial, skill_id: typeof m.skill_id === "string" ? m.skill_id : "", version: typeof m.version === "string" ? m.version : "",
      fallback: typeof m.fallback === "string" ? m.fallback : null,
    };
  }

  /** Kernel priority: guarded edges in declaration order, then the default (empty guard) edges. */
  function ordered(st) { return st.trans.filter((t) => t.cond).concat(st.trans.filter((t) => !t.cond)); }

  function bfs_order(S, root) {
    const seen = new Set(), out = [];
    const run = (start) => {
      const q = [start];
      seen.add(start);
      while (q.length) {
        const id = q.shift();
        out.push(id);
        for (const t of ordered(S[id])) if (!seen.has(t.to)) { seen.add(t.to); q.push(t.to); }
      }
    };
    if (root && S[root]) run(root);
    for (const id of Object.keys(S).sort(cmp)) if (!seen.has(id)) run(id);
    return out;
  }

  /** The main success path: the first path (kernel priority order) from the initial state to a verified terminal;
      without one, the longest chain of first-priority edges through non-terminal states. */
  function find_spine(S, root) {
    if (!root || !S[root]) return { nodes: [], edges: [] };
    if (S[root].kind === "end" || S[root].kind === "missing") return { nodes: [root], edges: [] };
    const path = [root], edges = [], on = new Set([root]);
    let budget = 5000;
    const dfs = (id) => {
      for (const t of ordered(S[id])) {
        const n = S[t.to];
        if (on.has(t.to) || n.kind === "missing") continue;
        if (n.kind === "end") {
          if (n.category === "verified") { path.push(t.to); edges.push(t); return true; }
          continue;
        }
        if (--budget < 0) return false;
        path.push(t.to); edges.push(t); on.add(t.to);
        if (dfs(t.to)) return true;
        path.pop(); edges.pop(); on.delete(t.to);
      }
      return false;
    };
    if (dfs(root)) return { nodes: path, edges };
    const p = [root], e = [], o = new Set([root]);
    for (;;) {
      const st = S[p[p.length - 1]];
      const t = ordered(st).find((x) => !o.has(x.to) && S[x.to].kind !== "end" && S[x.to].kind !== "missing");
      if (!t) break;
      p.push(t.to); e.push(t); o.add(t.to);
    }
    return { nodes: p, edges: e };
  }

  /* ================================================================== node text */
  function describe(st, interactions) {
    const a = st.action || {};
    const writes = Array.isArray(a.writes) ? a.writes.filter((w) => typeof w === "string") : [];
    switch (st.kind) {
      case "tool":
        return { kind: "tool", lead: "", detail: typeof a.name === "string" && a.name ? a.name : "?", mono: true };
      case "model":
        return { kind: "model", lead: "writes ", detail: writes.join(", ") || "nothing", mono: writes.length > 0 };
      case "judge":
        return { kind: "judge", lead: "writes ", detail: writes.join(", ") || "nothing", mono: writes.length > 0 };
      case "user": {
        const ix = interactions && interactions[st.id];
        let type = ix && typeof ix.type === "string" ? ix.type : "";
        if (!type) type = writes.some((w) => /decision|approv/i.test(w)) ? "approval" : "input";
        return { kind: "user", lead: "", detail: type, mono: false };
      }
      case "end":
        return { kind: "end", lead: "", detail: st.category || "terminal", mono: false };
      case "missing":
        return { kind: "missing", lead: "", detail: "not in this machine", mono: false };
      default:
        return { kind: st.kind, lead: "", detail: "", mono: false };
    }
  }
  function sublabel_of(d) { return d.detail ? d.kind + " · " + d.lead + d.detail : d.kind; }

  /* ================================================================== layout */
  function layout(machine, opts) {
    opts = opts || {};
    const Z = opts.compact ? SIZES.compact : SIZES.normal;
    const M = read_machine(machine);
    const S = M.S;
    const order = bfs_order(S, M.initial);
    const rank = new Map(order.map((id, i) => [id, i]));
    const spine = find_spine(S, M.initial);
    const spine_set = new Set(spine.nodes);
    const spine_end = spine.nodes.length && S[spine.nodes[spine.nodes.length - 1]].kind === "end"
      ? spine.nodes[spine.nodes.length - 1] : null;
    const spine_edge_keys = new Set();
    spine.edges.forEach((t, i) => spine_edge_keys.add(spine.nodes[i] + "#" + t.index));
    const final_key = spine_end ? spine.nodes[spine.nodes.length - 2] + "#" + spine.edges[spine.edges.length - 1].index : null;

    // ---- every transition, in reading order
    const all = [];
    for (const id of order) for (const t of S[id].trans) all.push({ from: id, t });
    const preds = {};
    for (const id of order) preds[id] = [];
    for (const e of all) preds[e.t.to].push(e.from);

    // ---- terminals drawn as stubs: every edge into an end state except the spine's own final edge
    const is_stub_edge = (from, t) => S[t.to].kind === "end" && from !== t.to && (from + "#" + t.index) !== final_key;

    // ---- rows and columns
    const pos = {};
    const cell = new Set();
    spine.nodes.forEach((id, i) => { pos[id] = { row: i, col: 0 }; cell.add(i + ":0"); });
    let max_row = spine.nodes.length - 1;
    for (const id of order) {
      if (pos[id]) continue;
      const st = S[id];
      if (st.kind === "end" && all.some((e) => e.t.to === id && is_stub_edge(e.from, e.t))) continue;
      const placed = preds[id].filter((p) => p !== id && pos[p]).map((p) => pos[p].row);
      let row;
      if (placed.length) row = Math.min(...placed) + 1;
      else {
        const succ = st.trans.map((t) => pos[t.to]).filter(Boolean).map((p) => p.row);
        row = succ.length ? Math.max(0, Math.min(...succ) - 1) : max_row + 1;
      }
      let col = -1;
      while (cell.has(row + ":" + col)) col--;
      pos[id] = { row, col };
      cell.add(row + ":" + col);
      max_row = Math.max(max_row, row);
    }

    // ---- node text and widths
    const info = {};
    for (const id of order) {
      const st = S[id];
      const d = describe(st, opts.interactions);
      const label = clip_text(id, ID_MAX);
      const sub = sublabel_of(d);
      let w;
      if (st.kind === "end") {
        w = Z.sub ? Math.max(mono_w(label, FS.id), sans_w(d.detail, FS.sub)) + 2 * Z.pad + 16 : sans_w(d.detail, FS.cat) + 2 * Z.pad + 12;
      } else if (!Z.sub) {
        w = mono_w(label, FS.id) + 2 * Z.pad;
      } else {
        const sw = sans_w(d.kind + " · " + d.lead, FS.sub) + (d.mono ? mono_w(d.detail, FS.sub) : sans_w(d.detail, FS.sub));
        w = Math.max(mono_w(label, FS.id) + 8 + Z.tag_w, d.detail ? sw : sans_w(d.kind, FS.sub)) + 2 * Z.pad;
      }
      info[id] = { d, label, sub, w: Math.min(Z.max_w, Math.max(Z.min_w, w)) };
    }
    const cols = Array.from(new Set(Object.values(pos).map((p) => p.col))).sort((a, b) => b - a); // 0, -1, -2...
    const col_w = {};
    for (const c of cols) col_w[c] = Math.max(...Object.keys(pos).filter((id) => pos[id].col === c).map((id) => info[id].w));
    const col_cx = {};
    cols.forEach((c, i) => {
      col_cx[c] = i === 0 ? 0 : col_cx[cols[i - 1]] - col_w[cols[i - 1]] / 2 - Z.gap_x - col_w[c] / 2;
    });
    const row_top = (r) => r * (Z.nh + Z.gap_y);

    const boxes = {}; // box id -> {id, state, x, y, w, h, kind: "node"|"stub", ...}
    const node_box = {};
    for (const id of Object.keys(pos)) {
      const { row, col } = pos[id];
      const w = col_w[col];
      const b = { bid: id, state: id, x: col_cx[col] - w / 2, y: row_top(row), w, h: Z.nh, row, col, stub: false };
      boxes[id] = b;
      node_box[id] = b;
    }

    // ---- stubs: one per (source, terminal) pair, beside the source
    const stub_text = {};
    const by_cat = {};
    for (const id of order) if (S[id].kind === "end") (by_cat[S[id].category] = by_cat[S[id].category] || []).push(id);
    for (const id of order) {
      if (S[id].kind !== "end") continue;
      const c = S[id].category;
      stub_text[id] = c && by_cat[c].length === 1 ? c : clip_text(id, 22);
    }
    const stub_w = Math.max(64, ...Object.values(stub_text).map((s) => sans_w(s, FS.cat) + 2 * Z.spad));
    const stubs = []; // {bid, state, source, x, y, w, h}
    const stub_of = {}; // "from>to" -> stub
    for (const id of order) {
      if (!node_box[id]) continue;
      const targets = [];
      for (const t of S[id].trans) if (is_stub_edge(id, t) && !targets.includes(t.to)) targets.push(t.to);
      if (!targets.length) continue;
      const nb = node_box[id];
      const right = nb.col === 0;
      const k = targets.length;
      const total = k * Z.sh + (k - 1) * Z.stack;
      targets.forEach((to, i) => {
        const y = nb.y + nb.h / 2 - total / 2 + i * (Z.sh + Z.stack);
        const x = right ? nb.x + nb.w + Z.sgap : nb.x - Z.sgap - stub_w;
        const sb = { bid: "stub:" + id + ">" + to, state: to, source: id, x, y, w: stub_w, h: Z.sh, stub: true, edges: [] };
        stubs.push(sb);
        stub_of[id + ">" + to] = sb;
        boxes[sb.bid] = sb;
      });
    }
    const all_boxes = () => Object.values(boxes);

    // ---- edge classification and port attachments
    const att = new Map(); // "bid|side" -> [{e, end, key}]
    const attach = (bid, side, e, end, key) => {
      const k = bid + "|" + side;
      if (!att.has(k)) att.set(k, []);
      att.get(k).push({ e, end, key, n: att.get(k).length });
    };
    const cxo = (b) => b.x + b.w / 2, cyo = (b) => b.y + b.h / 2;
    const edges = [];
    for (const { from, t } of all) {
      const key = from + "#" + t.index;
      const e = {
        key, from, to: t.to, index: t.index, cond: t.cond, inc: t.inc, kind: "", src: null, dst: null,
        main: spine_edge_keys.has(key), sides: {}, segs: null,
      };
      const sb = node_box[from];
      if (!sb) continue; // a terminal has no outgoing edges
      e.src = sb;
      if (is_stub_edge(from, t)) {
        const st = stub_of[from + ">" + t.to];
        e.kind = "stub";
        e.dst = st;
        st.edges.push(key);
        const out = sb.col === 0 ? "right" : "left";
        e.sides = { src: out, dst: out === "right" ? "left" : "right" };
        attach(sb.bid, out, e, "src", cyo(st));
        attach(st.bid, e.sides.dst, e, "dst", 0);
      } else if (t.to === from) {
        e.kind = "self";
        e.dst = sb;
        const side = sb.col === 0 ? "left" : "left";
        e.sides = { src: side, dst: side };
        attach(sb.bid, side, e, "src", -1e6 + 2 * edges.length);
        attach(sb.bid, side, e, "dst", -1e6 + 2 * edges.length + 1);
      } else {
        const tb = node_box[t.to];
        e.dst = tb;
        const dr = tb.row - sb.row, dc = tb.col - sb.col;
        if (dc === 0 && dr === 1) {
          e.kind = "down";
          e.sides = { src: "bottom", dst: "top" };
          attach(sb.bid, "bottom", e, "src", cxo(tb));
          attach(tb.bid, "top", e, "dst", cxo(sb));
        } else if (Math.abs(dc) === 1 && dr === 1) {
          e.kind = "drop";
          const side = dc < 0 ? "left" : "right";
          e.sides = { src: side, dst: "top" };
          attach(sb.bid, side, e, "src", tb.y - 0.5);
          attach(tb.bid, "top", e, "dst", (dc < 0 ? sb.x : sb.x + sb.w) + (dc < 0 ? -0.5 : 0.5));
        } else if (Math.abs(dc) === 1 && dr === -1) {
          e.kind = "rise";
          const side = dc > 0 ? "left" : "right";
          e.sides = { src: "top", dst: side };
          attach(sb.bid, "top", e, "src", (dc > 0 ? tb.x : tb.x + tb.w) + (dc > 0 ? 0.5 : -0.5));
          attach(tb.bid, side, e, "dst", sb.y + 0.5);
        } else if (dr === 0 && Math.abs(dc) === 1) {
          e.kind = "across";
          e.sides = dc > 0 ? { src: "right", dst: "left" } : { src: "left", dst: "right" };
          attach(sb.bid, e.sides.src, e, "src", cyo(tb));
          attach(tb.bid, e.sides.dst, e, "dst", cyo(sb));
        } else if (dc === 0 && dr === -1) {
          e.kind = "cside";
          e.sides = { src: "left", dst: "left" };
          attach(sb.bid, "left", e, "src", cyo(tb) + 0.25);
          attach(tb.bid, "left", e, "dst", cyo(sb) - 0.25);
        } else {
          e.kind = "channel";
          let s_side, t_side;
          if (dc === 0) { s_side = "left"; t_side = "left"; }
          else if (dc < 0) { s_side = "left"; t_side = "right"; }
          else { s_side = "right"; t_side = "left"; }
          e.sides = { src: s_side, dst: t_side };
          attach(sb.bid, s_side, e, "src", cyo(tb));
          attach(tb.bid, t_side, e, "dst", cyo(sb));
        }
      }
      edges.push(e);
    }

    // ---- port positions
    const port = new Map(); // e.key + ":" + end -> point
    for (const [k, list] of att) {
      const [bid, side] = k.split("|");
      const b = boxes[bid];
      list.sort((p, q) => p.key - q.key || p.n - q.n);
      const n = list.length;
      list.forEach((a, i) => {
        let q;
        if (side === "left" || side === "right") {
          const span = b.stub ? 0 : Math.min(Z.port_v, n > 1 ? (b.h - 12) / (n - 1) : 0);
          let y = cyo(b) + (i - (n - 1) / 2) * span;
          if (a.e.kind === "stub" && a.end === "src") {
            const st = a.e.dst;
            const sy = cyo(st);
            if (sy >= b.y + 6 && sy <= b.y + b.h - 6 && n === list.filter((x) => x.e.kind === "stub").length) y = sy;
          }
          q = pt(side === "left" ? b.x : b.x + b.w, y);
        } else {
          const span = Math.min(Z.port_h, n > 1 ? (b.w - 32) / (n - 1) : 0);
          q = pt(cxo(b) + (i - (n - 1) / 2) * span, side === "top" ? b.y : b.y + b.h);
        }
        port.set(a.e.key + ":" + a.end, q);
      });
    }

    // ---- channels between columns (tracks keep parallel vertical runs apart)
    const col_left = (c) => col_cx[c] - col_w[c] / 2, col_right = (c) => col_cx[c] + col_w[c] / 2;
    const tracks = new Map();
    function track(id, base, lo, hi, step) {
      if (!tracks.has(id)) tracks.set(id, []);
      const used = tracks.get(id);
      for (let k = 0; k < 40; k++) {
        const off = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * step;
        if (!used.some((u) => u.off === off && u.lo < hi + 8 && lo < u.hi + 8)) {
          used.push({ off, lo, hi });
          return base + off;
        }
      }
      return base;
    }
    function channel_x(c, side) {
      if (side === "left") return col_left(c) - Z.gap_x / 2;
      return c === 0 ? col_right(0) + Z.sgap / 2 : col_right(c) + Z.gap_x / 2;
    }
    function route_channel(e) {
      const sb = e.src, tb = e.dst;
      const sp = port.get(e.key + ":src"), tp = port.get(e.key + ":dst");
      const s_side = e.sides.src, t_side = e.sides.dst;
      const ax_id = "c" + sb.col + s_side;
      const bx_id = "c" + tb.col + t_side;
      const same = (s_side === "left" && t_side === "right" && tb.col === sb.col - 1) ||
        (s_side === "right" && t_side === "left" && tb.col === sb.col + 1) || (sb.col === tb.col && s_side === t_side);
      const ax_base = channel_x(sb.col, s_side);
      if (same) {
        const x = track(ax_id, ax_base, Math.min(sp.y, tp.y), Math.max(sp.y, tp.y), 10);
        return ortho([sp, pt(x, sp.y), pt(x, tp.y), tp], Z.radius);
      }
      const down = tb.row > sb.row;
      const gy_base = down ? tb.y - Z.gap_y / 2 : tb.y + tb.h + Z.gap_y / 2;
      const ax = track(ax_id, ax_base, Math.min(sp.y, gy_base), Math.max(sp.y, gy_base), 10);
      const bx_base = channel_x(tb.col, t_side);
      const gy = track("g" + (down ? tb.row : tb.row + 1), gy_base, Math.min(ax, bx_base), Math.max(ax, bx_base), 8);
      const bx = track(bx_id, bx_base, Math.min(gy, tp.y), Math.max(gy, tp.y), 10);
      return ortho([sp, pt(ax, sp.y), pt(ax, gy), pt(bx, gy), pt(bx, tp.y), tp], Z.radius);
    }

    // ---- paths
    function build(e) {
      const sp = port.get(e.key + ":src"), tp = port.get(e.key + ":dst");
      switch (e.kind) {
        case "down": {
          if (Math.abs(sp.x - tp.x) < 0.5) return line(sp, tp);
          const my = (sp.y + tp.y) / 2;
          return cubic(sp, pt(sp.x, my), pt(tp.x, my), tp);
        }
        case "stub": {
          const tq = pt(e.sides.dst === "left" ? e.dst.x : e.dst.x + e.dst.w, cyo(e.dst));
          if (Math.abs(sp.y - tq.y) < 0.5) return line(sp, tq);
          const mx = (sp.x + tq.x) / 2;
          return cubic(sp, pt(mx, sp.y), pt(mx, tq.y), tq);
        }
        case "self": {
          const dir = e.sides.src === "left" ? -1 : 1;
          const L = Z.loop;
          return cubic(sp, pt(sp.x + dir * L, sp.y - L * 0.42), pt(tp.x + dir * L, tp.y + L * 0.42), tp);
        }
        case "drop": return ortho([sp, pt(tp.x, sp.y), tp], Z.radius);
        case "rise": return ortho([sp, pt(sp.x, tp.y), tp], Z.radius);
        case "across": {
          if (Math.abs(sp.y - tp.y) < 0.5) return line(sp, tp);
          const mx = (sp.x + tp.x) / 2;
          return cubic(sp, pt(mx, sp.y), pt(mx, tp.y), tp);
        }
        case "cside": {
          const K = Z.gap_x * 0.55;
          return cubic(sp, pt(sp.x - K, sp.y), pt(tp.x - K, tp.y), tp);
        }
        default: return route_channel(e);
      }
    }
    function crosses(segs, e) {
      const pts = sample(segs, 3);
      for (const b of all_boxes()) {
        if (b === e.src || b === e.dst) continue;
        if (pts.some((q) => contains(b, q, 2))) return true;
      }
      // the path may touch its own boxes only at its ends
      const inner = pts.slice(2, -2);
      for (const b of [e.src, e.dst]) if (inner.some((q) => contains(b, q, -1.5))) return true;
      return false;
    }
    for (const e of edges) {
      let segs = build(e);
      if (e.kind !== "channel" && e.kind !== "stub" && crosses(segs, e)) {
        e.kind = "channel";
        segs = route_channel(e);
      }
      e.segs = segs;
      e.samples = sample(segs, 4);
      e.length = path_length(segs);
    }

    // ---- badge slots: numbered step badges sit on the path near its start
    for (const e of edges) {
      e.badge_slots = [];
      for (let k = 0; k < 4; k++) {
        const d = Z.badge_first + k * Z.badge_step;
        if (d > e.length - 13 && k > 0) break;
        e.badge_slots.push(point_at(e.samples, Math.min(d, Math.max(4, e.length / 2))));
      }
    }

    // ---- start marker above the initial state
    let start = null;
    const ib = node_box[M.initial];
    if (ib) {
      const tops = (att.get(ib.bid + "|top") || []).map((a) => port.get(a.e.key + ":" + a.end).x);
      let x = cxo(ib);
      if (tops.some((tx) => Math.abs(tx - x) < 14)) x = ib.x + 18;
      const y0 = ib.y - Z.start;
      start = { x, y: y0, segs: line(pt(x, y0 + 5), pt(x, ib.y)), box: { x: x - 7, y: y0 - 7, w: 54, h: Z.start + 7 } };
    }

    // ---- edge labels
    const placed = [];
    const node_list = all_boxes();
    const slot_r = 10;
    function label_text(e) {
      const st = S[e.from];
      const guarded = st.trans.some((t) => t.cond);
      const lines = [];
      if (opts.compact) {
        // compact labels appear only on hover or focus: one clipped line, the full guard is in the tooltip
        if (e.cond) lines.push(clip_text(e.cond, 22));
        else if (guarded || e.kind === "stub") lines.push("else");
        else if (e.inc) lines.push("+1 " + e.inc);
        return lines;
      }
      if (e.cond) lines.push(...guard_lines(e.cond));
      else if (guarded || e.kind === "stub") lines.push("else");
      if (e.inc) lines.push("+1 " + e.inc);
      return lines;
    }
    function score(bx, e, anchor, pen, on_line) {
      for (const b of node_list) if (overlaps(bx, b, 4)) return Infinity;
      for (const l of placed) if (overlaps(bx, l, 4)) return Infinity;
      if (start && overlaps(bx, start.box, 2)) return Infinity;
      let s = pen;
      for (const o of edges) {
        if (o === e && on_line) continue;
        const hit = o.samples.filter((q) => contains(bx, q, o === e ? 2 : 3)).length;
        if (hit) s += (o === e ? 25 : 70) * hit;
        for (const q of o.badge_slots.slice(0, 2)) {
          if (q.x > bx.x - slot_r && q.x < bx.x + bx.w + slot_r && q.y > bx.y - slot_r && q.y < bx.y + bx.h + slot_r) s += 45;
        }
      }
      const cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
      s += 0.12 * Math.hypot(cx - anchor.x, cy - anchor.y);
      const out = Math.max(0, core.x0 - bx.x) + Math.max(0, bx.x + bx.w - core.x1) + Math.max(0, core.y0 - bx.y) + Math.max(0, bx.y + bx.h - core.y1);
      if (opts.compact && out > 0.5) return Infinity; // compact labels never widen the drawing
      s += 0.15 * out;
      return s;
    }
    function candidates(e, w, h) {
      const out = [];
      const sp = e.segs[0].p[0];
      const ep = e.segs[e.segs.length - 1].p[e.segs[e.segs.length - 1].p.length - 1];
      const mid = point_at(e.samples, e.length / 2);
      const add = (x, y, pen, anchor, on_line) => out.push({ x, y, pen, anchor: anchor || mid, on_line: !!on_line });
      if (e.kind === "down") {
        const ym = (sp.y + ep.y) / 2;
        add(mid.x + 13, ym - h / 2, 0);
        add(mid.x - 13 - w, ym - h / 2, 6);
      } else if (e.kind === "stub") {
        // on the line, between the first badge slot and the stub: "-- (n) -- else --> (unverified)"
        const dir = ep.x >= sp.x ? 1 : -1;
        const bx0 = sp.x + dir * (Z.badge_first + 12);
        if (Math.abs(ep.y - sp.y) < 0.5) add(dir > 0 ? bx0 : bx0 - w, sp.y - h / 2, 0, pt(dir > 0 ? bx0 + w / 2 : bx0 - w / 2, sp.y), true);
        const xm = (sp.x + ep.x) / 2;
        for (const g of [4, 8, 12]) {
          add(xm - w / 2, sp.y - g - h, 6 + g);
          add(xm - w / 2, sp.y + g, 8 + g);
        }
      } else if (e.kind === "self") {
        const apex = e.samples.reduce((a, q) => (e.sides.src === "left" ? (q.x < a.x ? q : a) : (q.x > a.x ? q : a)), e.samples[0]);
        const left = e.sides.src === "left";
        add(left ? apex.x - 8 - w : apex.x + 8, apex.y - h / 2, 0, apex);
        add(left ? apex.x - w + 20 : apex.x - 20, apex.y - 28 - h, 8, apex);
        add(left ? apex.x - w + 20 : apex.x - 20, apex.y + 28, 8, apex);
      } else if (e.kind === "drop") {
        // caption above the horizontal run, kept clear of the badge slots next to the source
        const run_y = sp.y, x1 = Math.min(sp.x, e.segs[e.segs.length - 1].p[0].x), x2 = Math.max(sp.x, e.segs[e.segs.length - 1].p[0].x);
        const toward_left = e.sides.src === "left";
        for (const g of [5, 8, 12, 16, 22]) {
          if (toward_left) {
            add(sp.x - 2 * Z.badge_step - 12 - w, run_y - g - h, g, pt((x1 + x2) / 2, run_y));
            add(sp.x - 10 - w, run_y - g - h, g + 2, pt((x1 + x2) / 2, run_y));
          } else {
            add(sp.x + 2 * Z.badge_step + 12, run_y - g - h, g, pt((x1 + x2) / 2, run_y));
            add(sp.x + 10, run_y - g - h, g + 2, pt((x1 + x2) / 2, run_y));
          }
        }
      } else if (e.kind === "rise" || e.kind === "cside" || e.kind === "across") {
        add(mid.x + 10, mid.y - h / 2, 0);
        add(mid.x - 10 - w, mid.y - h / 2, 2);
        add(mid.x - w / 2, mid.y - 8 - h, 3);
        add(mid.x - w / 2, mid.y + 8, 4);
      }
      // generic: around points along the path
      for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const q = point_at(e.samples, e.length * f);
        for (const g of [8, 20, 40]) {
          const pen = 10 + g / 2 + Math.abs(f - 0.5) * 20;
          add(q.x + g, q.y - h / 2, pen, q);
          add(q.x - g - w, q.y - h / 2, pen, q);
          add(q.x - w / 2, q.y - g - h, pen, q);
          add(q.x - w / 2, q.y + g, pen, q);
        }
      }
      return out;
    }
    const core = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const b of node_list) { core.x0 = Math.min(core.x0, b.x); core.y0 = Math.min(core.y0, b.y); core.x1 = Math.max(core.x1, b.x + b.w); core.y1 = Math.max(core.y1, b.y + b.h); }
    for (const e of edges) for (const q of e.samples) { core.x0 = Math.min(core.x0, q.x); core.y0 = Math.min(core.y0, q.y); core.x1 = Math.max(core.x1, q.x); core.y1 = Math.max(core.y1, q.y); }
    const label_rank = { down: 0, drop: 1, self: 2, rise: 3, across: 3, cside: 3, channel: 4, stub: 5 };
    const labelled = edges.slice().sort((a, b) => (label_rank[a.kind] - label_rank[b.kind]) || (rank.get(a.from) - rank.get(b.from)) || (a.index - b.index));
    for (const e of labelled) {
      const lines = label_text(e);
      if (!lines.length) { e.label = null; continue; }
      const w = Math.max(...lines.map((s) => mono_w(s, FS.label))) + 2 * Z.lpad_x;
      const h = lines.length * Z.lh + 2 * Z.lpad_y;
      let best = null, best_s = Infinity;
      for (const c of candidates(e, w, h)) {
        const bx = { x: c.x, y: c.y, w, h };
        const s = score(bx, e, c.anchor, c.pen, c.on_line);
        if (s < best_s) { best_s = s; best = bx; }
      }
      if (!best && opts.compact) { e.label = null; continue; } // the caption under the canvas shows it instead
      if (!best) {
        // nothing fits near the edge: walk outward until a spot clear of nodes and labels is found
        const mid = point_at(e.samples, e.length / 2);
        for (let g = 60; g < 2000 && !best; g += 30) {
          for (const bx of [{ x: mid.x + g, y: mid.y - h / 2, w, h }, { x: mid.x - g - w, y: mid.y - h / 2, w, h },
            { x: mid.x - w / 2, y: mid.y + g, w, h }, { x: mid.x - w / 2, y: mid.y - g - h, w, h }]) {
            if (score(bx, e, mid, 0) < Infinity) { best = bx; break; }
          }
        }
      }
      e.label = { x: best.x, y: best.y, w, h, text: lines[0], lines };
      placed.push(e.label);
    }

    // ---- status tag ("current", "waiting", ...): inside the state at the top right, on the id's baseline.
    // The spine's terminal pill carries it outside, to its right (nothing else is there).
    const TAG = { w: Z.tag_w, h: 18 };
    for (const b of node_list) {
      if (!Z.tag_w || b.stub) { b.tag = null; continue; }
      if (S[b.state].kind === "end") b.tag = { x: b.w + 8, y: b.h / 2 - TAG.h / 2, outside: true };
      else b.tag = { x: b.w - Z.pad + 4, y: Z.base1 - 13, outside: false, align: "end" };
    }

    // ---- bounds and translation into the viewBox
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
    for (const b of node_list) { grow(b.x, b.y, b.w, b.h); if (b.tag && b.tag.outside) grow(b.x + b.tag.x, b.y + b.tag.y, TAG.w, TAG.h); }
    for (const l of placed) grow(l.x, l.y, l.w, l.h);
    for (const e of edges) {
      for (const q of e.samples) grow(q.x - 5, q.y - 5, 10, 10);
      for (const q of e.badge_slots) grow(q.x - slot_r - 2, q.y - slot_r, 2 * slot_r + 4, 2 * slot_r);
    }
    if (start) grow(start.box.x, start.box.y, start.box.w, start.box.h);
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 120; y1 = 60; }
    const dx = Z.margin - x0, dy = Z.margin - y0;
    const W = Math.ceil(x1 - x0 + 2 * Z.margin), H = Math.ceil(y1 - y0 + 2 * Z.margin);
    const tb = (b) => ({ x: r1(b.x + dx), y: r1(b.y + dy), w: r1(b.w), h: r1(b.h) });

    // ---- output
    const out_nodes = [];
    for (const id of order) {
      const st = S[id];
      const inf = info[id];
      const copies = stubs.filter((s) => s.state === id);
      const own = node_box[id];
      const prim = own || copies[0];
      if (!prim) continue;
      const n = Object.assign(tb(prim), {
        id, kind: st.kind, terminal_kind: st.kind === "end" ? st.category : null, terminal: st.terminal,
        label: inf.label, sublabel: own ? inf.sub : stub_text[id], initial: id === M.initial,
        row: own ? own.row : null, col: own ? own.col : null, spine: spine_set.has(id),
        kind_text: inf.d.kind, lead: inf.d.lead, detail: inf.d.detail, detail_mono: inf.d.mono, clause: st.clause,
        tag: own && own.tag ? Object.assign({}, own.tag) : null,
        copies: own ? null : copies.map((c) => Object.assign(tb(c), {
          source: c.source, edges: c.edges.slice(), text: stub_text[id], tag: null,
        })),
      });
      out_nodes.push(n);
    }
    const out_edges = edges.map((e) => {
      const segs = shift_segs(e.segs, dx, dy);
      return {
        key: e.key, from: e.from, to: e.to, index: e.index, cond: e.cond, inc: e.inc, kind: e.kind, main: e.main,
        path: path_d(segs), length: r1(e.length),
        label: e.label ? { x: r1(e.label.x + dx), y: r1(e.label.y + dy), w: e.label.w, h: e.label.h, text: e.label.text, lines: e.label.lines } : null,
        src: tb(e.src), dst: tb(e.dst), dst_stub: e.kind === "stub",
        badges: e.badge_slots.map((q) => ({ x: r1(q.x + dx), y: r1(q.y + dy) })),
      };
    });
    return {
      width: W, height: H, compact: !!opts.compact, initial: M.initial, skill_id: M.skill_id, version: M.version,
      spine: spine.nodes.slice(), nodes: out_nodes, edges: out_edges,
      start: start ? { x: r1(start.x + dx), y: r1(start.y + dy), path: path_d(shift_segs(start.segs, dx, dy)) } : null,
      metrics: { node_h: Z.nh, label_line: Z.lh, label_pad_x: Z.lpad_x, label_pad_y: Z.lpad_y, base1: Z.base1, base2: Z.base2, pad: Z.pad, tag: TAG, sub: Z.sub },
    };
  }

  /* ================================================================== DOM helpers */
  function sv(tag, attrs, ...kids) {
    const n = document.createElementNS(SVG_NS, tag);
    set_attrs(n, attrs);
    append(n, kids);
    return n;
  }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    set_attrs(n, attrs);
    append(n, kids);
    return n;
  }
  function set_attrs(n, attrs) {
    if (!attrs) return;
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
  }
  function append(n, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      n.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
    }
  }

  function reduced_motion() {
    try { return globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (err) { return false; }
  }

  /* ================================================================== text alternative */
  function edge_sentence(e, S_nodes) {
    const to = S_nodes[e.to];
    const target = to && to.kind === "end" ? e.to + " (terminal" + (to.terminal_kind ? ", " + to.terminal_kind : "") + ")" : e.to;
    const when = e.cond ? "if " + e.cond : "otherwise";
    return when + ", go to " + target + (e.inc ? " and add 1 to " + e.inc : "");
  }
  function node_sentence(n) {
    if (n.kind === "end") return "terminal state, " + (n.terminal_kind || "no category") + (n.terminal && n.terminal !== n.id ? " (terminal " + n.terminal + ")" : "");
    if (n.kind === "missing") return "missing: a transition points to a state that does not exist";
    return n.kind_text + " action" + (n.detail ? ", " + n.lead + n.detail : "");
  }

  /* ================================================================== view */
  let SEQ = 0;
  const STATUS_TAG = {
    READY: ["current", "accent"], RUNNING: ["current", "accent"], WAITING_FOR_APPROVAL: ["waiting", "accent"],
    WAITING_FOR_INPUT: ["waiting", "accent"], RECONCILING: ["reconciling", "warn"], FAILED: ["failed", "crit"],
    CANCELLED: ["cancelled", "neutral"], COMPLETED: ["completed", "ok"],
  };

  function create(container, machine, opts) {
    opts = opts || {};
    if (!container || typeof container.appendChild !== "function") throw new TypeError("HXUI.graph.create needs a container element");
    const compact = !!opts.compact;
    const on_select = typeof opts.on_select === "function" ? opts.on_select : null;
    const L = layout(machine, { compact, interactions: opts.interactions });
    const uid = "hxg" + (++SEQ);
    const by_id = {};
    for (const n of L.nodes) by_id[n.id] = n;
    const n_states = L.nodes.length, n_edges = L.edges.length;
    const title = typeof opts.title === "string" && opts.title ? opts.title : "";
    const name = title || (L.skill_id ? "State machine " + L.skill_id : "State machine");

    // ---- header: title, size, legend
    const meta_text = n_states + " states · " + n_edges + " transitions" + (L.initial ? " · starts at " + L.initial : "");
    const head = compact && !title ? null : el("div", { class: "hxg-head" },
      el("div", { class: "hxg-heading" },
        title ? el("p", { class: "hxg-title", id: uid + "-title", text: title }) : null,
        el("p", { class: "hxg-meta", text: meta_text })),
      compact ? null : el("ul", { class: "hxg-legend", "aria-hidden": "true" },
        el("li", null, el("span", { class: "hxg-sw hxg-sw--current" }), "current state"),
        el("li", null, el("span", { class: "hxg-sw hxg-sw--step", text: "1" }), "transition taken, in order"),
        el("li", null, el("span", { class: "hxg-sw hxg-sw--faint" }), "not taken")));

    // ---- svg
    const svg = sv("svg", {
      class: "hxg-svg", width: L.width, height: L.height, viewBox: "0 0 " + L.width + " " + L.height,
      role: on_select ? "group" : "img", "aria-label": name + ": " + meta_text, "aria-describedby": uid + "-alt",
      focusable: "false",
    });
    const markers = {};
    const defs = sv("defs", null,
      sv("pattern", { id: uid + "-grid", width: 16, height: 16, patternUnits: "userSpaceOnUse" },
        sv("circle", { class: "hxg-dot", cx: 1, cy: 1, r: 0.9 })));
    for (const style of ["base", "faint", "visited"]) {
      const m = sv("marker", {
        id: uid + "-m-" + style, class: "hxg-marker hxg-marker--" + style, viewBox: "0 0 10 10", refX: 9.2, refY: 5,
        markerWidth: 8, markerHeight: 8, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse",
      }, sv("path", { d: "M0.5 0.8 L9.5 5 L0.5 9.2 Z" }));
      markers[style] = "url(#" + uid + "-m-" + style + ")";
      defs.appendChild(m);
    }
    svg.appendChild(defs);
    svg.appendChild(sv("rect", { class: "hxg-bg", x: 0, y: 0, width: L.width, height: L.height, fill: "url(#" + uid + "-grid)" }));

    // edges
    const g_edges = sv("g", { class: "hxg-edges" });
    const edge_el = {};
    for (const e of L.edges) {
      const full = e.from + " to " + e.to + (e.cond ? " if " + e.cond : " otherwise (default edge)") + (e.inc ? "; adds 1 to " + e.inc : "");
      const g = sv("g", { class: "hxg-edge hxg-edge--" + e.kind + (e.main ? " is-main" : ""), "data-key": e.key, "data-from": e.from, "data-to": e.to },
        sv("title", { text: full }),
        sv("path", { class: "hxg-hit", d: e.path }),
        sv("path", { class: "hxg-line", d: e.path, "marker-end": markers.base }));
      edge_el[e.key] = { g, line: g.lastChild, e };
      g_edges.appendChild(g);
    }
    svg.appendChild(g_edges);

    // start marker
    if (L.start) {
      svg.appendChild(sv("g", { class: "hxg-start", "aria-hidden": "true" },
        sv("circle", { cx: L.start.x, cy: L.start.y, r: 4.5 }),
        sv("path", { class: "hxg-start-line", d: L.start.path, "marker-end": markers.base }),
        sv("text", { x: L.start.x + 10, y: L.start.y + 4, text: "start" })));
    }

    // nodes
    const g_nodes = sv("g", { class: "hxg-nodes" });
    const node_els = {}; // id -> [{g, copy, box}]
    const focusables = [];
    const Mt = L.metrics;
    function node_label(n) {
      const parts = [n.id, node_sentence(n)];
      if (n.initial) parts.push("initial state");
      const outs = L.edges.filter((e) => e.from === n.id);
      if (outs.length) parts.push(outs.length + (outs.length === 1 ? " transition: " : " transitions: ") + outs.map((e) => edge_sentence(e, by_id)).join("; "));
      const ins = L.edges.filter((e) => e.to === n.id && e.from !== n.id);
      if (n.kind === "end" && ins.length) parts.push("reached from " + Array.from(new Set(ins.map((e) => e.from))).join(", "));
      return parts.join(". ");
    }
    function draw_node(n, bx, copy) {
      const term = n.kind === "end";
      const tone = term ? (CATEGORY_TONE[n.terminal_kind] || "neutral") : null;
      const g = sv("g", {
        class: "hxg-node" + (term ? " hxg-term" : "") + (copy !== null ? " hxg-stub" : "") + (n.kind === "missing" ? " hxg-missing" : "") + (n.spine ? " is-spine" : ""),
        "data-state": n.id, "data-kind": n.kind, "data-copy": copy === null ? null : copy, "data-tone": tone,
        "data-edges": copy === null ? null : (bx.edges || []).join(" "),
        transform: "translate(" + bx.x + " " + bx.y + ")",
      });
      const rx = term ? bx.h / 2 : 6;
      g.appendChild(sv("title", { text: n.id + " · " + (term ? (n.terminal_kind || "terminal") + (n.terminal !== n.id ? " (terminal " + n.terminal + ")" : "") : n.sublabel) + (n.clause ? " · clause " + n.clause : "") }));
      g.appendChild(sv("rect", { class: "hxg-ring", x: -4, y: -4, width: bx.w + 8, height: bx.h + 8, rx: rx + 4 }));
      g.appendChild(sv("rect", { class: "hxg-box", x: 0, y: 0, width: bx.w, height: bx.h, rx }));
      if (copy !== null) {
        g.appendChild(sv("text", { class: "hxg-cat", x: bx.w / 2, y: bx.h / 2 + 4.2, "text-anchor": "middle", text: bx.text }));
      } else if (term && !Mt.sub) {
        g.appendChild(sv("text", { class: "hxg-cat", x: bx.w / 2, y: bx.h / 2 + 4.2, "text-anchor": "middle", text: n.terminal_kind || "terminal" }));
      } else if (term) {
        g.appendChild(sv("text", { class: "hxg-id", x: bx.w / 2, y: Mt.base1, "text-anchor": "middle", text: n.label }));
        g.appendChild(sv("text", { class: "hxg-cat", x: bx.w / 2, y: Mt.base2, "text-anchor": "middle", text: n.terminal_kind || "terminal" }));
      } else if (!Mt.sub) {
        g.appendChild(sv("text", { class: "hxg-id", x: Mt.pad, y: Mt.base1, text: n.label }));
      } else {
        g.appendChild(sv("text", { class: "hxg-id", x: Mt.pad, y: Mt.base1, text: n.label }));
        const sub = sv("text", { class: "hxg-sub", x: Mt.pad, y: Mt.base2 });
        sub.appendChild(sv("tspan", { class: "hxg-kind", text: n.kind_text + (n.detail ? " · " + n.lead : "") }));
        if (n.detail) sub.appendChild(sv("tspan", { class: n.detail_mono ? "hxg-detail is-mono" : "hxg-detail", text: n.detail }));
        g.appendChild(sub);
      }
      (node_els[n.id] = node_els[n.id] || []).push({ g, copy, box: bx });
      if (on_select) {
        g.classList.add("is-interactive");
        if (copy === null || copy === 0) {
          g.setAttribute("role", "button");
          g.setAttribute("tabindex", "-1");
          g.setAttribute("aria-label", node_label(n));
          focusables.push(g);
        } else {
          g.setAttribute("aria-hidden", "true");
        }
      }
      g_nodes.appendChild(g);
    }
    for (const n of L.nodes) {
      if (n.copies) n.copies.forEach((c, i) => draw_node(n, c, i));
      else draw_node(n, n, null);
    }
    svg.appendChild(g_nodes);

    // labels
    const g_labels = sv("g", { class: "hxg-labels" });
    const label_el = {};
    for (const e of L.edges) {
      if (!e.label) continue;
      const lb = e.label;
      const t = sv("text", { class: "hxg-label-text", x: lb.x + Mt.label_pad_x, y: lb.y + Mt.label_pad_y + 11.5 });
      lb.lines.forEach((s, i) => {
        t.appendChild(sv("tspan", { x: lb.x + Mt.label_pad_x, dy: i === 0 ? 0 : Mt.label_line, class: i > 0 || s === "else" ? "hxg-label-aux" : null, text: s }));
      });
      const g = sv("g", { class: "hxg-label", "data-key": e.key },
        sv("title", { text: e.cond ? e.cond + (e.inc ? " (then +1 " + e.inc + ")" : "") : "default edge, taken when no guard above it holds" + (e.inc ? " (then +1 " + e.inc + ")" : "") }),
        sv("rect", { class: "hxg-label-bg", x: lb.x, y: lb.y, width: lb.w, height: lb.h, rx: 3 }), t);
      label_el[e.key] = g;
      g_labels.appendChild(g);
    }
    svg.appendChild(g_labels);
    const g_badges = sv("g", { class: "hxg-badges", "aria-hidden": "true" });
    const g_tags = sv("g", { class: "hxg-tags", "aria-hidden": "true" });
    svg.appendChild(g_badges);
    svg.appendChild(g_tags);

    // ---- canvas and text alternative
    const canvas = el("div", { class: "hxg-canvas" }, svg);
    if (!on_select) {
      canvas.setAttribute("tabindex", "0");
      canvas.setAttribute("role", "region");
      canvas.setAttribute("aria-label", name + " (scrolls sideways when wider than the screen)");
    }
    const alt_run = el("p", { class: "hxg-alt-run", text: "No run is shown on this graph." });
    const alt = el("div", { class: "hxg-sr", id: uid + "-alt" },
      el("p", { text: name + ". " + meta_text + "." + (on_select ? " Use the arrow keys to move between states and Enter or Space to select one." : "") }),
      el("ol", null, L.nodes.map((n) => {
        const outs = L.edges.filter((e) => e.from === n.id);
        return el("li", { text: n.id + ": " + node_sentence(n) + (n.initial ? "; initial state" : "") + "." +
          (outs.length ? " Transitions: " + outs.map((e, i) => (i + 1) + ") " + edge_sentence(e, by_id)).join("; ") + "." : "") });
      })),
      alt_run);
    // compact drawings have no room for every guard or a status tag: one caption line under the canvas shows what
    // is hovered or focused, and the run status (assistive technology reads the text alternative instead)
    const caption = compact ? el("p", { class: "hxg-caption", "aria-hidden": "true" }) : null;
    const root = el("figure", { class: "hxg" + (compact ? " is-compact" : "") + (on_select ? " is-selectable" : ""), "data-hxg": uid }, head, canvas, caption, alt);
    if (title) root.setAttribute("aria-labelledby", uid + "-title");
    else root.setAttribute("aria-label", name);
    container.appendChild(root);

    // ---- interaction
    const state = { current: null, visited: [], status: null, terminal: null, highlight: [] };
    let roving = focusables.length ? focusables[0] : null;
    if (roving) roving.setAttribute("tabindex", "0");
    const listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };
    const node_of = (t) => (t && t.closest ? t.closest(".hxg-node") : null);
    const edge_of = (t) => (t && t.closest ? t.closest(".hxg-edge") : null);
    function set_roving(g) {
      if (roving && roving !== g) roving.setAttribute("tabindex", "-1");
      roving = g;
      g.setAttribute("tabindex", "0");
    }
    function primary(g) {
      const id = g.getAttribute("data-state");
      const list = node_els[id] || [];
      const p = list.find((x) => x.copy === null || x.copy === 0);
      return p ? p.g : g;
    }
    function edge_text(e) {
      return e.from + " → " + e.to + (e.cond ? " if " + e.cond : " otherwise") + (e.inc ? ", then +1 " + e.inc : "");
    }
    function node_text(n) {
      if (n.kind === "end") return n.id + " · terminal, " + (n.terminal_kind || "no category");
      return n.id + " · " + n.sublabel + " · " + L.edges.filter((e) => e.from === n.id).length + " transitions";
    }
    function caption_default() {
      if (!caption) return;
      if (state.current || state.terminal || state.visited.length) {
        const where = state.terminal || state.current;
        caption.textContent = (state.terminal ? "Ended in " : "Current state ") + where + (state.status ? " · " + state.status : "") +
          " · " + state.visited.length + (state.visited.length === 1 ? " step" : " steps");
      } else caption.textContent = "Hover over or focus a state or a transition to read it here.";
    }
    function hover_node(id, on) {
      for (const e of L.edges) {
        if (e.from !== id) continue;
        edge_el[e.key].g.classList.toggle("is-hover", on);
        if (label_el[e.key]) label_el[e.key].classList.toggle("is-shown", on);
      }
      if (caption) { if (on && by_id[id]) caption.textContent = node_text(by_id[id]); else caption_default(); }
    }
    function hover_edge(key, on) {
      const x = edge_el[key];
      if (!x) return;
      x.g.classList.toggle("is-hover", on);
      if (label_el[key]) label_el[key].classList.toggle("is-shown", on);
      if (caption) { if (on) caption.textContent = edge_text(x.e); else caption_default(); }
    }
    if (on_select) {
      listen(svg, "click", (ev) => {
        const g = node_of(ev.target);
        if (!g) return;
        set_roving(primary(g));
        on_select(g.getAttribute("data-state"));
      });
      listen(svg, "keydown", (ev) => {
        const g = node_of(ev.target);
        if (!g) return;
        const i = focusables.indexOf(g);
        let next = null;
        if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
          ev.preventDefault();
          on_select(g.getAttribute("data-state"));
          return;
        }
        if (ev.key === "ArrowDown" || ev.key === "ArrowRight") next = focusables[Math.min(focusables.length - 1, i + 1)];
        else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") next = focusables[Math.max(0, i - 1)];
        else if (ev.key === "Home") next = focusables[0];
        else if (ev.key === "End") next = focusables[focusables.length - 1];
        if (next) {
          ev.preventDefault();
          set_roving(next);
          next.focus();
          reveal(next.getAttribute("data-state"));
        }
      });
    }
    listen(svg, "focusin", (ev) => { const g = node_of(ev.target); if (g) hover_node(g.getAttribute("data-state"), true); });
    listen(svg, "focusout", (ev) => { const g = node_of(ev.target); if (g) hover_node(g.getAttribute("data-state"), false); });
    listen(svg, "mouseover", (ev) => {
      const g = node_of(ev.target);
      if (g) { hover_node(g.getAttribute("data-state"), true); return; }
      const eg = edge_of(ev.target);
      if (eg) hover_edge(eg.getAttribute("data-key"), true);
    });
    listen(svg, "mouseout", (ev) => {
      const g = node_of(ev.target);
      if (g) { hover_node(g.getAttribute("data-state"), false); return; }
      const eg = edge_of(ev.target);
      if (eg) hover_edge(eg.getAttribute("data-key"), false);
    });

    // ---- size: natural (1 unit = 1px, scrolls sideways when wider); compact scales down to fit, to 75%
    let scale = 1;
    function fit() {
      if (!compact) return;
      const host = root.parentElement;
      if (!host) return;
      let pad = 0;
      try { const cs = getComputedStyle(host); pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); } catch (err) { pad = 0; }
      const avail = host.clientWidth - pad - 2;
      if (!(avail > 0)) return;
      const k = Math.max(0.75, Math.min(1, avail / L.width));
      if (Math.abs(k - scale) < 0.002 && svg.getAttribute("width")) return;
      scale = k;
      svg.setAttribute("width", String(Math.floor(L.width * k)));
      svg.setAttribute("height", String(Math.floor(L.height * k)));
    }

    // ---- keep the interesting part visible when the canvas scrolls sideways
    let user_scrolled = false, last_auto = null;
    listen(canvas, "scroll", () => { if (last_auto === null || Math.abs(canvas.scrollLeft - last_auto) > 2) user_scrolled = true; });
    function scroll_to_x(cx, force) {
      const cw = canvas.clientWidth;
      if (!cw || canvas.scrollWidth <= cw + 1) return;
      const svg_left = svg.getBoundingClientRect().left - canvas.getBoundingClientRect().left + canvas.scrollLeft;
      const x = svg_left + cx * scale;
      const visible = x - 40 >= canvas.scrollLeft && x + 40 <= canvas.scrollLeft + cw;
      if (visible && !force) return;
      const target = Math.max(0, Math.min(canvas.scrollWidth - cw, x - cw / 2));
      last_auto = target;
      canvas.scrollLeft = target;
      last_auto = canvas.scrollLeft;
    }
    function reveal(id) {
      const list = node_els[id];
      if (!list || !list.length) return;
      const b = list[0].box;
      scroll_to_x(b.x + b.w / 2, false);
    }
    function center_spine() {
      if (user_scrolled) return;
      const sp = L.spine.length ? by_id[L.spine[0]] : L.nodes[0];
      if (sp) scroll_to_x(sp.x + sp.w / 2, true);
    }
    let ro = null;
    if (typeof ResizeObserver === "function") {
      let seen = "";
      ro = new ResizeObserver(() => {
        fit();
        const key = canvas.clientWidth + "x" + (root.parentElement ? root.parentElement.clientWidth : 0);
        if (canvas.clientWidth && key !== seen) {
          seen = key;
          if (state.current) reveal(state.current); else center_spine();
        }
      });
      ro.observe(canvas);
      if (root.parentElement) ro.observe(root.parentElement);
    }
    fit();
    caption_default();

    // ---- run state
    function resolve_edge(v) {
      if (!v || typeof v !== "object") return null;
      let idx = v.edge;
      if (idx && typeof idx === "object") idx = idx.index;
      if (typeof idx === "number" && Number.isInteger(idx)) {
        const k = v.from + "#" + idx;
        if (edge_el[k] && (v.to === undefined || v.to === null || edge_el[k].e.to === v.to)) return k;
        if (edge_el[k] && v.to === undefined) return k;
      }
      if (idx === undefined) {
        const e = L.edges.find((x) => x.from === v.from && x.to === v.to);
        return e ? e.key : null;
      }
      return null;
    }
    function to_state_id(id) {
      if (!id) return null;
      if (by_id[id]) return id;
      const n = L.nodes.find((x) => x.kind === "end" && x.terminal === id);
      return n ? n.id : null;
    }
    function badge(x, y, text, title, key, step) {
      const w = Math.max(18, text.length * 7.4 + 8);
      return sv("g", { class: "hxg-badge", transform: "translate(" + x + " " + y + ")", "data-key": key, "data-step": step },
        title ? sv("title", { text: title }) : null,
        sv("rect", { x: -w / 2, y: -9, width: w, height: 18, rx: 9 }),
        sv("text", { x: 0, y: 4.3, "text-anchor": "middle", text }));
    }
    function tag(n_box, tag_pos, text, tone) {
      const w = Math.min(L.metrics.tag.w, Math.ceil(text.length * FS.tag * SANS_EM) + 12);
      const x = n_box.x + tag_pos.x - (tag_pos.align === "end" ? w : 0);
      return sv("g", { class: "hxg-tag", "data-tone": tone, transform: "translate(" + x + " " + (n_box.y + tag_pos.y) + ")" },
        sv("rect", { x: 0, y: 0, width: w, height: L.metrics.tag.h, rx: 3 }),
        sv("text", { x: w / 2, y: 13, "text-anchor": "middle", text }));
    }

    function update(run) {
      run = run || {};
      const current = to_state_id(run.current);
      const visited = Array.isArray(run.visited) ? run.visited : [];
      const status = typeof run.status === "string" ? run.status : null;
      const terminal = to_state_id(run.terminal);
      state.current = current; state.visited = visited; state.status = status; state.terminal = terminal;
      const steps = new Map(); // edge key -> [step numbers]
      const seen_nodes = new Set();
      const jumps = [];
      let last_edge_into = {}; // state id -> edge key of the latest visited edge into it
      visited.forEach((v, i) => {
        if (!v || typeof v !== "object") return;
        const k = resolve_edge(v);
        if (v.from) seen_nodes.add(v.from);
        if (v.to) seen_nodes.add(v.to);
        if (k) {
          if (!steps.has(k)) steps.set(k, []);
          steps.get(k).push(i + 1);
          last_edge_into[edge_el[k].e.to] = k;
        } else if (v.from && v.to) {
          jumps.push({ from: v.from, to: to_state_id(v.to) || v.to, n: i + 1 });
        }
      });
      if (current) seen_nodes.add(current);
      if (terminal) seen_nodes.add(terminal);
      const active = !!(current || visited.length || terminal);
      root.classList.toggle("is-active", active);

      // nodes and terminal copies
      const done = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
      for (const id of Object.keys(node_els)) {
        const list = node_els[id];
        const n = by_id[id];
        let mark = null; // the copy that carries the current / reached marking
        if (id === current || id === terminal) {
          if (list.length === 1) mark = list[0];
          else {
            const k = last_edge_into[id];
            mark = (k && list.find((x) => x.box.edges && x.box.edges.includes(k))) || null;
            if (!mark) {
              const j = jumps.filter((x) => x.to === id).pop();
              mark = (j && list.find((x) => x.box.source === j.from)) || list[0];
            }
          }
        }
        for (const x of list) {
          const via = x.box.edges ? x.box.edges.some((k) => steps.has(k)) : false;
          const visited_here = x.copy === null ? seen_nodes.has(id) : via || x === mark;
          x.g.classList.toggle("is-visited", active && visited_here);
          x.g.classList.toggle("is-faint", active && !visited_here);
          const is_mark = x === mark;
          const reached = is_mark && n.kind === "end" && (id === terminal || (status === "COMPLETED" && id === current));
          x.g.classList.toggle("is-reached", reached);
          x.g.classList.toggle("is-current", is_mark && !reached && id === current && !done);
          x.g.classList.toggle("is-stopped", is_mark && !reached && id === current && done);
          x.g.setAttribute("data-status", is_mark ? (status || "") : "");
        }
        if (on_select) {
          const p = list.find((x) => x.copy === null || x.copy === 0);
          if (p) {
            let extra = "";
            if (id === current || id === terminal) extra = id === terminal || (n.kind === "end" && status === "COMPLETED") ? ". Run ended here" : ". Current state" + (status ? ", run " + status.toLowerCase().replace(/_/g, " ") : "");
            else if (active && seen_nodes.has(id)) extra = ". Visited";
            p.g.setAttribute("aria-label", node_label(n) + extra);
          }
        }
      }

      // edges, labels and step badges
      g_badges.replaceChildren();
      for (const k of Object.keys(edge_el)) {
        const x = edge_el[k];
        const nums = steps.get(k) || [];
        const on = nums.length > 0;
        x.g.classList.toggle("is-visited", on);
        x.line.setAttribute("marker-end", on ? markers.visited : active ? markers.faint : markers.base);
        if (label_el[k]) label_el[k].classList.toggle("is-visited", on);
        if (!on) continue;
        const slots = x.e.badges;
        const title = "Step" + (nums.length > 1 ? "s " : " ") + nums.join(", ") + ": " + x.e.from + " to " + x.e.to;
        if (nums.length <= slots.length) nums.forEach((num, i) => g_badges.appendChild(badge(slots[i].x, slots[i].y, String(num), title, k, num)));
        else {
          slots.slice(0, -1).forEach((q, i) => g_badges.appendChild(badge(q.x, q.y, String(nums[i]), title, k, nums[i])));
          const q = slots[slots.length - 1];
          g_badges.appendChild(badge(q.x, q.y, "+" + (nums.length - slots.length + 1), title, k, nums.slice(slots.length - 1).join(" ")));
        }
      }

      // the status tag on the current state, and a tag on each state that failed into fallback
      g_tags.replaceChildren();
      const marked = (id) => {
        const list = node_els[id] || [];
        return list.find((x) => x.g.classList.contains("is-current") || x.g.classList.contains("is-reached") || x.g.classList.contains("is-stopped"));
      };
      const cur = marked(current || terminal);
      if (cur && cur.box.tag) {
        const [text, tone] = STATUS_TAG[status] || (cur.g.classList.contains("is-reached") ? ["completed", "ok"] : ["current", "accent"]);
        if (cur.copy === null) g_tags.appendChild(tag(cur.box, cur.box.tag, text, tone));
      }
      for (const j of jumps) {
        const src = (node_els[j.from] || [])[0];
        if (src && src.copy === null && src.box.tag && !(cur && cur === src)) {
          g_tags.appendChild(tag(src.box, src.box.tag, "to " + (by_id[j.to] && by_id[j.to].terminal_kind ? by_id[j.to].terminal_kind : "fallback"), "crit"));
          src.g.classList.add("is-failed-out");
        }
      }
      for (const id of Object.keys(node_els)) {
        if (!jumps.some((j) => j.from === id)) for (const x of node_els[id]) x.g.classList.remove("is-failed-out");
      }

      // text alternative
      if (!active) alt_run.textContent = "No run is shown on this graph.";
      else {
        const parts = [];
        if (status) parts.push("Run status: " + status + ".");
        if (current) parts.push("Current state: " + current + ".");
        if (terminal) parts.push("Ended in " + terminal + (by_id[terminal] && by_id[terminal].terminal_kind ? " (" + by_id[terminal].terminal_kind + ")" : "") + ".");
        parts.push(visited.length ? "Steps taken: " + visited.map((v, i) => (i + 1) + ". " + v.from + " to " + v.to + (resolve_edge(v) ? "" : " (fallback, not an edge)")).join("; ") + "." : "No transition taken yet.");
        alt_run.textContent = parts.join(" ");
      }
      caption_default();
      if (current && current !== last_current) reveal(current);
      last_current = current;
    }
    let last_current = null;

    function highlight(ids) {
      const set = new Set((Array.isArray(ids) ? ids : []).map(to_state_id).filter(Boolean));
      state.highlight = Array.from(set);
      root.classList.toggle("has-highlight", set.size > 0);
      for (const id of Object.keys(node_els)) for (const x of node_els[id]) x.g.classList.toggle("is-highlight", set.has(id));
      if (set.size) reveal(Array.from(set)[0]);
    }

    function destroy() {
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
      listeners.length = 0;
      if (ro) ro.disconnect();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    // first paint: a ready drawing with the spine in view
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(center_spine);

    return {
      root, svg, layout: L, update, highlight, destroy,
      get state() { return { current: state.current, visited: state.visited.slice(), status: state.status, terminal: state.terminal, highlight: state.highlight.slice() }; },
      reduced_motion,
    };
  }

  HXUI.graph = { layout, create, version: 1 };
})();
