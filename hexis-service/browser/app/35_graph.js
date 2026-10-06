/* HEXIS Runtime Lab: the live state-machine graph (HXUI.graph).

   Self-contained: it needs no other app file. Three parts:
   * layout(machine, opts?)  pure and deterministic. It does not depend on the key order of machine.states.
     The main success path (initial -> verified terminal) runs down one straight column, the "spine". Side
     states such as REPAIR_DRAFT sit one row below the state that enters them, to the left, and their loop is
     drawn as a U-turn. Self-loops curl out to the left. Every edge into a terminal state is drawn as a small
     pill ("stub") right next to its source, in a lane to the right. Only the spine's own last edge reaches the
     drawn terminal at the bottom. Everything else is routed through the free channels between columns.
     A guard label sits within 20px of its own edge and never covers a node, another label or another edge.
     When no such spot exists the label is left out of the full drawing (the edge's tooltip and the text
     alternative still carry the guard); the compact drawing opens its rows up until every label has a spot.
   * create(container, machine, opts) draws the layout as inline SVG with a text alternative.
   * view.update(run) restyles the existing drawing in place on every step: no redraw, no flash.

   API (specs/UI.md "State graph API"), with the extensions marked +:
     HXUI.graph.layout(machine, {compact, interactions}?) -> {width, height, nodes, edges, spine, start, jumps, ...}
       nodes[i]: {id, x, y, w, h (top-left box), kind, terminal_kind, label, sublabel, initial, spine,
                  + own (has its own box), + copies: [{x, y, w, h, source, edges}] | null (terminal stubs)}
       edges[i]: {key: "FROM#i", from, to, index, cond, inc, path, label: {x, y, w, h, text, lines} | null,
                  + kind, + main, + src / dst boxes, + badges: [{x, y}] (step badge slots near the start)}
       A sole unconditional edge has no label; a default edge next to guarded ones is labelled "else".
     const view = HXUI.graph.create(container, machine, {title, on_select(state_id), compact,
                                                         + interactions: package.contracts.interactions})
       compact: true      the compact drawing (the Overview): one line per state, edge labels on hover or focus
                          (every guarded edge gets a spot: the rows open up when one would not fit), and a
                          caption bar at the bottom of the frame, sticky so it stays on screen. It fits about
                          360px at full size and scales down to 90% below that.
                false     the full drawing at its natural size. It scrolls sideways inside its canvas when it
                          is wider than the container; the canvas edges fade on the side that has more.
                + "auto"  (the default when compact is left out) the full drawing while it fits the container,
                          the compact one when it does not (phones). Crossing the threshold redraws once and
                          keeps the run, the highlight and keyboard focus.
     view.update({current, visited: [{from, to, edge}], status, terminal})
       edge = the transition index (or the kernel's {index, ...} object). An entry whose edge is null or
       missing and that matches no transition (the kernel's FALLBACK_ENTERED event) is drawn as a fallback
       jump: + optional "reason" is shown in its tooltip. terminal and current accept a state id or a terminal id.
       update({}) returns the drawing to rest. The legend is shown only while a run is on the graph; its first entry
       names the mark drawn now: "current state", "reached outcome" (after the run ended in a terminal, in its
       category's color) or "run stopped here" (failed or cancelled), followed by "transition taken", "not taken".
     view.highlight(state_ids)   [] clears. The other states and the edges step back in color (never opacity:
                                 every text stays at 4.5:1 or better).
     view.destroy()
     + view.root, + view.svg and view.layout (the drawing shown now), + view.compact, + view.state (a snapshot of
       the last update and highlight)
   Keyboard and assistive technology:
     * Only the figure is named (the title, or "State machine <skill_id>"). A visually hidden text alternative
       inside the canvas lists every state with its transitions; update() adds the run to it.
     * States are focusable when the graph is selectable (on_select: role button, Enter or Space selects) and in
       the compact drawing (role img: focus shows the state's transitions and fills the caption). That is one
       Tab stop (roving tabindex); arrow keys, Home and End move between states. Focus listeners sit on the HTML
       canvas, never on the <svg>, so the drawing itself is never a Tab stop.
     * A drawing without focusable states is hidden from assistive technology (the text alternative stands in
       for it). Its canvas becomes a focusable, labelled region only while it overflows, so it can be scrolled
       from the keyboard. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* ================================================================== metrics */
  // Mono advance is 0.6em in IBM Plex Mono and in every fallback of --font-mono, so mono text is measured exactly
  // (the drawing uses text-rendering: geometricPrecision, so scaled text keeps those advances).
  // Sans text (kind words, terminal categories, tags) is measured with a per-character table: the widest advance
  // among IBM Plex Sans 400/500 and the fallbacks DejaVu Sans, Liberation Sans and FreeSans (measured in
  // Chromium), plus 3%, in hundredths of an em for ASCII 32..126. Any other character counts 1.03em.
  const MONO_EM = 0.6;
  const SANS_ASCII = ("33 42 48 87 66 98 81 29 41 41 53 87 33 42 33 44 66 66 66 66 66 66 66 66 66 66 35 35 87 87 87 58 " +
    "105 71 71 75 80 69 63 81 78 43 55 70 58 89 78 82 69 82 75 69 66 76 71 102 71 70 71 41 44 41 87 59 " +
    "62 64 66 57 66 64 37 66 66 29 29 60 30 101 66 64 66 66 43 54 41 66 61 85 61 61 55 66 37 66 87").split(" ").map(Number);
  const SANS_OTHER = { "·": 36 };
  const GUARD_MAX = 34; // characters per guard line on an edge (about 30); the full text is in a <title>
  const GUARD_LINES = 3;
  const ID_MAX = 28;     // state id characters shown in a node (the full id is in its <title> and aria-label)
  const DETAIL_MAX = 34; // tool name / written variables shown in a node
  const FS = { sub: 12, label: 12, cat: 12, tag: 12, badge: 12 }; // the id size is per drawing (SIZES.*.fs_id)
  const LABEL_REACH = 20; // a guard label is never further than this from its own edge
  const SCALE_MIN = 0.9;  // the compact drawing never shrinks text below 90%; the canvas scrolls the rest
  const AUTO_SLACK = 24;  // "auto": back to the full drawing only with this much room to spare (no flip-flop)
  const FADE = 16;        // px: the edge fade of an overflowing canvas (app/35_graph.css, 1rem)

  const SIZES = {
    normal: {
      fs_id: 13, nh: 46, gap_y: 50, gap_x: 84, pad: 12, slack: 0, min_w: 150, max_w: 400, sh: 22, sgap: 84, spad: 10,
      stack: 4, port_v: 24, port_h: 56, loop: 54, radius: 10, margin: 16, start: 30, base1: 19, base2: 35, lh: 15,
      lpad_x: 5, lpad_y: 3, badge_first: 16, badge_step: 22, tag_w: 92, sub: true,
    },
    // Compact (Overview, phones): one line per state in 12px mono (the action is in the tooltip, the caption and the
    // text alternative), tight spacing, edge labels only on hover or focus. Both fixture machines fit about 360px.
    compact: {
      fs_id: 12, nh: 30, gap_y: 30, gap_x: 10, pad: 6, slack: 3, min_w: 64, max_w: 260, sh: 20, sgap: 28, spad: 6,
      stack: 4, port_v: 12, port_h: 36, loop: 36, radius: 8, margin: 4, start: 22, base1: 19.2, base2: 19.2, lh: 15,
      lpad_x: 5, lpad_y: 3, badge_first: 11, badge_step: 20, tag_w: 0, sub: false,
    },
  };

  const CATEGORY_TONE = { verified: "ok", unverified: "warn", fallback: "crit" };

  /* ================================================================== small helpers */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const r1 = (v) => Math.round(v * 10) / 10;
  const chars = (s) => Array.from(String(s)).length;
  const mono_w = (s, fs) => Math.ceil(chars(s) * fs * MONO_EM);
  function sans_em(s) {
    let n = 0;
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      n += c >= 32 && c < 127 ? SANS_ASCII[c - 32] : (SANS_OTHER[ch] || 103);
    }
    return n / 100;
  }
  const sans_w = (s, fs) => Math.ceil(sans_em(s) * fs);
  function clip_text(s, n) {
    const a = Array.from(String(s));
    return a.length > n ? a.slice(0, n - 1).join("").replace(/\s+$/, "") + "…" : a.join("");
  }
  /** Word-wrap one clause of a guard at spaces outside quotes; continuation lines are indented by two spaces.
      Every cut consumes text: a continuation line is never cut inside its indent, and a chunk with no space to
      cut at stays whole (guard_lines() clips it). */
  function wrap_words(text) {
    const out = [];
    let rest = text, from = 1;
    while (chars(rest) > GUARD_MAX) {
      let quote = "", cut = -1;
      for (let i = 0; i < rest.length && i <= GUARD_MAX; i++) {
        const c = rest[i];
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === "'" || c === '"') quote = c;
        else if (c === " " && i >= from) cut = i;
      }
      if (cut < from) break;
      out.push(rest.slice(0, cut));
      rest = "  " + rest.slice(cut + 1);
      from = 3;
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
    if (lines.length > GUARD_LINES) out[GUARD_LINES - 1] = clip_text(out[GUARD_LINES - 1] + " …", GUARD_MAX);
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
  /** Distance from point p to the box b (0 inside). */
  function box_dist(b, p) {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    return Math.hypot(dx, dy);
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
        return { kind: "tool", lead: "", detail: clip_text(typeof a.name === "string" && a.name ? a.name : "?", DETAIL_MAX), mono: true };
      case "model":
        return { kind: "model", lead: "writes ", detail: clip_text(writes.join(", ") || "nothing", DETAIL_MAX), mono: writes.length > 0 };
      case "judge":
        return { kind: "judge", lead: "writes ", detail: clip_text(writes.join(", ") || "nothing", DETAIL_MAX), mono: writes.length > 0 };
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
  /** Compact edge labels are shown one state at a time, but each must still have a spot: when the tight row gap leaves
      a label without one, the rows open up a little (deterministically) until every label is placed. */
  const COMPACT_GAPS = [30, 36, 44, 56];
  function layout(machine, opts) {
    opts = opts || {};
    if (!opts.compact) return layout_at(machine, opts, SIZES.normal);
    let L = null;
    for (const gap_y of COMPACT_GAPS) {
      L = layout_at(machine, opts, Object.assign({}, SIZES.compact, { gap_y }));
      if (!L.unlabelled) break;
    }
    return L;
  }
  function layout_at(machine, opts, Z) {
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
    // (an end state can be the initial state: then the spine is that one state and has no last edge)
    const final_key = spine_end && spine.edges.length
      ? spine.nodes[spine.nodes.length - 2] + "#" + spine.edges[spine.edges.length - 1].index : null;

    // ---- every transition, in reading order
    const all = [];
    for (const id of order) for (const t of S[id].trans) all.push({ from: id, t });
    const preds = {};
    for (const id of order) preds[id] = [];
    for (const e of all) preds[e.t.to].push(e.from);

    // ---- terminals drawn as stubs: every edge into an end state except the spine's own final edge
    const is_stub_edge = (from, t) => S[t.to].kind === "end" && from !== t.to && (from + "#" + t.index) !== final_key;

    // ---- edge label text
    function label_lines(from, t, stub) {
      const guarded = S[from].trans.some((x) => x.cond);
      if (opts.compact) {
        // compact labels appear only on hover or focus: one clipped line, the full guard is in the tooltip
        if (t.cond) return [clip_text(t.cond, 22)];
        if (guarded || stub) return ["else"];
        if (t.inc) return ["+1 " + t.inc];
        return [];
      }
      const lines = [];
      if (t.cond) lines.push(...guard_lines(t.cond));
      else if (guarded || stub) lines.push("else");
      if (t.inc) lines.push("+1 " + t.inc);
      return lines;
    }
    const label_w = (lines) => Math.max(...lines.map((s) => mono_w(s, FS.label))) + 2 * Z.lpad_x;

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
        w = Z.sub ? Math.max(mono_w(label, Z.fs_id), sans_w(d.detail, FS.sub)) + 2 * Z.pad + 16 : sans_w(d.detail, FS.cat) + 2 * Z.pad + 12;
      } else if (!Z.sub) {
        w = mono_w(label, Z.fs_id) + 2 * Z.pad + Z.slack;
      } else {
        const sw = sans_w(d.kind + " · " + d.lead, FS.sub) + (d.mono ? mono_w(d.detail, FS.sub) : sans_w(d.detail, FS.sub));
        w = Math.max(mono_w(label, Z.fs_id) + 8 + Z.tag_w, d.detail ? sw : sans_w(d.kind, FS.sub)) + 2 * Z.pad + Z.slack;
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

    // ---- stubs: one per (source, terminal) pair, beside the source. A source whose stub edges carry a guard gets a
    // wider gap, so each guard sits on its own line between the step badge and the pill.
    const stub_text = {};
    const by_cat = {};
    for (const id of order) if (S[id].kind === "end") (by_cat[S[id].category] = by_cat[S[id].category] || []).push(id);
    for (const id of order) {
      if (S[id].kind !== "end") continue;
      const c = S[id].category;
      stub_text[id] = c && by_cat[c].length === 1 ? c : clip_text(id, 22);
    }
    const stub_w = Math.max(64, ...Object.values(stub_text).map((s) => sans_w(s, FS.cat) + 2 * Z.spad));
    const stub_gap = {};
    for (const id of order) {
      let g = Z.sgap;
      if (!opts.compact) {
        for (const t of S[id].trans) {
          if (!is_stub_edge(id, t)) continue;
          const lines = label_lines(id, t, true);
          if (lines.length) g = Math.max(g, Z.badge_first + 12 + label_w(lines) + 14);
        }
      }
      stub_gap[id] = g;
    }
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
        const x = right ? nb.x + nb.w + stub_gap[id] : nb.x - stub_gap[id] - stub_w;
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
        const side = "left"; // the stub lane is on the right of the spine; left of a side column is free
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
    function route_channel(e, sp, tp) {
      const sb = e.src, tb = e.dst;
      sp = sp || port.get(e.key + ":src");
      tp = tp || port.get(e.key + ":dst");
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
        // the direct shape would cut through a state: route through the free channels instead, from the sides
        // that face the target (fresh ports, a little off the side's centre to stay clear of the regular ones)
        const sb = e.src, tb = e.dst;
        const s_side = tb.col > sb.col ? "right" : "left", t_side = tb.col < sb.col ? "right" : "left";
        e.kind = "channel";
        e.sides = { src: s_side, dst: t_side };
        segs = route_channel(e, pt(s_side === "left" ? sb.x : sb.x + sb.w, cyo(sb) + 6), pt(t_side === "left" ? tb.x : tb.x + tb.w, cyo(tb) - 6));
      }
      e.segs = segs;
      e.samples = sample(segs, 4);
      e.length = path_length(segs);
      e.bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const q of e.samples) { e.bb.x0 = Math.min(e.bb.x0, q.x); e.bb.y0 = Math.min(e.bb.y0, q.y); e.bb.x1 = Math.max(e.bb.x1, q.x); e.bb.y1 = Math.max(e.bb.y1, q.y); }
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

    // ---- fallback jumps. A tool, model or judge state whose observation fails jumps to machine.fallback
    // (kernel FALLBACK_ENTERED: no transition edge). Where the stub lane beside a spine state is free, a
    // fallback pill is reserved there and drawn only when a run makes that jump; a state that already has a
    // stub for the fallback terminal reuses it. Other states fall back to a tag on the failing state.
    const fb = M.fallback && S[M.fallback] && S[M.fallback].kind === "end" ? M.fallback : null;
    const jump_slots = {};
    if (fb) {
      for (const id of order) {
        const st = S[id], nb = node_box[id];
        if (!nb || !["tool", "model", "judge"].includes(st.kind)) continue;
        const existing = stub_of[id + ">" + fb];
        if (existing) {
          const e = edges.find((x) => x.from === id && x.to === fb && x.kind === "stub");
          if (e) jump_slots[id] = { reuse: existing, edge: e };
          continue;
        }
        if (nb.col !== 0 || stubs.some((x) => x.source === id) || (att.get(nb.bid + "|right") || []).length) continue;
        const box = { x: nb.x + nb.w + Z.sgap, y: nb.y + nb.h / 2 - Z.sh / 2, w: stub_w, h: Z.sh };
        if (all_boxes().some((b) => overlaps(b, box, 4))) continue;
        const segs = line(pt(nb.x + nb.w, nb.y + nb.h / 2), pt(box.x, nb.y + nb.h / 2));
        const samples = sample(segs, 4);
        if (edges.some((e) => e.samples.some((q) => contains(box, q, 3)))) continue;
        jump_slots[id] = { box, segs, samples, badge: point_at(samples, Z.badge_first) };
      }
    }
    const reserved = Object.values(jump_slots).filter((j) => j.box).map((j) => j.box);

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

    // ---- edge labels. Hard rules: clear of every node, reserved pill, other label and the start marker (4px),
    // never over another edge (1.5px), and within LABEL_REACH of the label's own edge. Compact labels also stay
    // inside the drawing; they are shown one state at a time (on hover or focus), so they only have to keep clear
    // of the labels and edges shown with them, those of the same source state (other edges only cost). Among the
    // spots that pass, the cheapest wins: near the preferred anchor, off its own line, away from step badge slots.
    const placed = [];
    const node_list = all_boxes();
    const slot_r = 10;
    const core = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const b of node_list) { core.x0 = Math.min(core.x0, b.x); core.y0 = Math.min(core.y0, b.y); core.x1 = Math.max(core.x1, b.x + b.w); core.y1 = Math.max(core.y1, b.y + b.h); }
    for (const e of edges) for (const q of e.samples) { core.x0 = Math.min(core.x0, q.x); core.y0 = Math.min(core.y0, q.y); core.x1 = Math.max(core.x1, q.x); core.y1 = Math.max(core.y1, q.y); }
    function own_dist(bx, e) {
      let best = Infinity;
      for (const q of e.samples) { const d = box_dist(bx, q); if (d < best) best = d; }
      return best;
    }
    let may_grow = false;
    function score(bx, e, anchor, pen, on_line) {
      for (const b of node_list) if (overlaps(bx, b, 4)) return Infinity;
      for (const b of reserved) if (overlaps(bx, b, 4)) return Infinity;
      for (const l of placed) if ((!opts.compact || l.from === e.from) && overlaps(bx, l, 4)) return Infinity;
      if (start && overlaps(bx, start.box, 2)) return Infinity;
      const out_x = Math.max(0, core.x0 - bx.x) + Math.max(0, bx.x + bx.w - core.x1);
      const out = out_x + Math.max(0, core.y0 - bx.y) + Math.max(0, bx.y + bx.h - core.y1);
      // compact labels never widen the drawing; as a last resort one may make it a little taller
      if (opts.compact && out > 0.5 && (!may_grow || out_x > 0.5)) return Infinity;
      if (own_dist(bx, e) > LABEL_REACH) return Infinity;
      let s = pen + 0.15 * out;
      for (const o of edges) {
        // an edge whose samples and badge slots all lie further than slot_r from the box cannot touch it
        if (o.bb.x1 < bx.x - slot_r || o.bb.x0 > bx.x + bx.w + slot_r || o.bb.y1 < bx.y - slot_r || o.bb.y0 > bx.y + bx.h + slot_r) continue;
        if (o === e) {
          if (on_line) continue; // the on-line spot is laid out around this edge's own line and first badge slot
          for (const q of o.samples) if (contains(bx, q, 2)) s += 25;
        } else {
          const together = !opts.compact || o.from === e.from; // drawn (or, compact, shown) at the same time
          for (const q of o.samples) {
            if (contains(bx, q, 1.5)) { if (together) return Infinity; s += 70; } // a label never hides another edge
            else if (contains(bx, q, 4)) s += 20;
          }
        }
        for (const q of o.badge_slots.slice(0, 2)) {
          if (q.x > bx.x - slot_r && q.x < bx.x + bx.w + slot_r && q.y > bx.y - slot_r && q.y < bx.y + bx.h + slot_r) s += 45;
        }
      }
      const cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
      s += 0.12 * Math.hypot(cx - anchor.x, cy - anchor.y);
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
        // on the line, between the first badge slot and the stub: "-- (n) -- else --> (unverified)"; else just
        // above or below the line in the same stretch
        const dir = ep.x >= sp.x ? 1 : -1;
        const bx0 = sp.x + dir * (Z.badge_first + 12);
        const lx = dir > 0 ? bx0 : bx0 - w;
        if (Math.abs(ep.y - sp.y) < 0.5) add(lx, sp.y - h / 2, 0, pt(lx + w / 2, sp.y), true);
        const xm = (sp.x + ep.x) / 2;
        for (const g of [3, 6, 10, 14]) {
          add(lx, sp.y - g - h, 4 + g, pt(lx + w / 2, sp.y));
          add(lx, sp.y + g, 6 + g, pt(lx + w / 2, sp.y));
          add(xm - w / 2, sp.y - g - h, 6 + g);
          add(xm - w / 2, sp.y + g, 8 + g);
        }
      } else if (e.kind === "self") {
        const apex = e.samples.reduce((a, q) => (e.sides.src === "left" ? (q.x < a.x ? q : a) : (q.x > a.x ? q : a)), e.samples[0]);
        const left = e.sides.src === "left";
        add(left ? apex.x - 8 - w : apex.x + 8, apex.y - h / 2, 0, apex);
        add(left ? apex.x - w + 20 : apex.x - 20, apex.y - 16 - h, 8, apex);
        add(left ? apex.x - w + 20 : apex.x - 20, apex.y + 16, 8, apex);
      } else if (e.kind === "drop") {
        // caption above the horizontal run, kept clear of the badge slots next to the source
        const run_y = sp.y, x1 = Math.min(sp.x, e.segs[e.segs.length - 1].p[0].x), x2 = Math.max(sp.x, e.segs[e.segs.length - 1].p[0].x);
        const toward_left = e.sides.src === "left";
        for (const g of [5, 8, 12, 16]) {
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
        for (const g of [8, 14, 20]) {
          const pen = 10 + g / 2 + Math.abs(f - 0.5) * 20;
          add(q.x + g, q.y - h / 2, pen, q);
          add(q.x - g - w, q.y - h / 2, pen, q);
          add(q.x - w / 2, q.y - g - h, pen, q);
          add(q.x - w / 2, q.y + g, pen, q);
        }
      }
      return out;
    }
    /** Every spot hugging the path (every ~8px, on all sides): tried only when the preferred spots all fail. */
    function dense_candidates(e, w, h) {
      const out = [];
      const step = Math.max(8, e.length / 60);
      for (let d = 0; d <= e.length; d += step) {
        const q = point_at(e.samples, d);
        for (const g of [4, 10, 16]) {
          const pen = 30 + g;
          for (const [x, y] of [[q.x + g, q.y - h / 2], [q.x - g - w, q.y - h / 2], [q.x - w / 2, q.y - g - h], [q.x - w / 2, q.y + g],
            [q.x - 8, q.y - g - h], [q.x - w + 8, q.y - g - h], [q.x - 8, q.y + g], [q.x - w + 8, q.y + g]]) {
            out.push({ x, y, pen, anchor: q, on_line: false });
          }
        }
      }
      return out;
    }
    let unlabelled = 0;
    const label_rank = { down: 0, drop: 1, self: 2, rise: 3, across: 3, cside: 3, channel: 4, stub: 5 };
    const labelled = edges.slice().sort((a, b) => (label_rank[a.kind] - label_rank[b.kind]) || (rank.get(a.from) - rank.get(b.from)) || (a.index - b.index));
    for (const e of labelled) {
      const lines = label_lines(e.from, e, e.kind === "stub");
      if (!lines.length) { e.label = null; continue; }
      const w = label_w(lines);
      const h = lines.length * Z.lh + 2 * Z.lpad_y;
      let best = null, best_s = Infinity;
      const passes = opts.compact ? [[candidates, false], [dense_candidates, false], [candidates, true], [dense_candidates, true]] : [[candidates, false], [dense_candidates, false]];
      for (const [pass, grow_ok] of passes) {
        may_grow = grow_ok;
        for (const c of pass(e, w, h)) {
          const bx = { x: c.x, y: c.y, w, h };
          const s = score(bx, e, c.anchor, c.pen, c.on_line);
          if (s < best_s) { best_s = s; best = bx; }
        }
        if (best) break;
      }
      // no spot near the edge: leave the label out (its tooltip, the caption and the text alternative carry it)
      if (!best) { e.label = null; unlabelled++; continue; }
      e.label = { x: best.x, y: best.y, w, h, text: lines[0], lines };
      placed.push({ x: best.x, y: best.y, w, h, from: e.from });
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
    for (const b of reserved) grow(b.x, b.y, b.w, b.h);
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
        own: !!own,
        copies: copies.length ? copies.map((c) => Object.assign(tb(c), {
          source: c.source, edges: c.edges.slice(), text: stub_text[id], tag: null,
        })) : null,
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
      width: W, height: H, compact: !!opts.compact, unlabelled, initial: M.initial, skill_id: M.skill_id, version: M.version,
      spine: spine.nodes.slice(), nodes: out_nodes, edges: out_edges,
      start: start ? { x: r1(start.x + dx), y: r1(start.y + dy), path: path_d(shift_segs(start.segs, dx, dy)) } : null,
      fallback: fb,
      jumps: Object.fromEntries(Object.entries(jump_slots).map(([id, j]) => [id, j.reuse
        ? { to: fb, reuse_edge: j.edge.key, box: null, path: null, badge: null }
        : { to: fb, reuse_edge: null, box: tb(j.box), path: path_d(shift_segs(j.segs, dx, dy)), badge: { x: r1(j.badge.x + dx), y: r1(j.badge.y + dy) } }])),
      metrics: {
        node_h: Z.nh, label_line: Z.lh, label_pad_x: Z.lpad_x, label_pad_y: Z.lpad_y, base1: Z.base1, base2: Z.base2, pad: Z.pad,
        tag: TAG, sub: Z.sub, fs_id: Z.fs_id,
      },
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
  /** True when the primary pointer can hover (a mouse or trackpad); phones and tablets answer false. */
  function can_hover() {
    try { return typeof matchMedia !== "function" || matchMedia("(hover: hover)").matches; } catch (err) { return true; }
  }

  function create(container, machine, opts) {
    opts = opts || {};
    if (!container || typeof container.appendChild !== "function") throw new TypeError("HXUI.graph.create needs a container element");
    const mode = opts.compact === true ? "compact" : opts.compact === false ? "normal" : "auto";
    const on_select = typeof opts.on_select === "function" ? opts.on_select : null;
    const layouts = {};
    function layout_of(compact) {
      const k = compact ? "compact" : "normal";
      if (!layouts[k]) layouts[k] = layout(machine, { compact, interactions: opts.interactions });
      return layouts[k];
    }
    const uid = "hxg" + (++SEQ);
    const L0 = layout_of(mode === "compact");
    const n_states = L0.nodes.length, n_edges = L0.edges.length;
    const title = typeof opts.title === "string" && opts.title ? opts.title : "";
    const name = title || (L0.skill_id ? "State machine " + L0.skill_id : "State machine");
    const code = (t) => el("code", { class: "hxg-code", text: t });
    const count_text = n_states + (n_states === 1 ? " state" : " states") + " · " + n_edges + (n_edges === 1 ? " transition" : " transitions");
    const meta_text = count_text + (L0.initial ? " · starts at " + L0.initial : "");

    // ---- header: title, size, and (during a run) the legend
    // the first entry names the mark that is drawn: the current state, the outcome the run reached, or where it stopped
    const legend_sw = el("span", { class: "hxg-sw hxg-sw--current" });
    const legend_mark = el("span", { class: "hxg-legend-mark", text: "current state" });
    const legend = mode === "compact" ? null : el("ul", { class: "hxg-legend", "aria-hidden": "true", hidden: true },
      el("li", { class: "hxg-legend-first" }, legend_sw, legend_mark),
      el("li", null, el("span", { class: "hxg-sw hxg-sw--step", text: "1" }), "transition taken, in order"),
      el("li", null, el("span", { class: "hxg-sw hxg-sw--faint" }), "not taken"));
    const head = mode === "compact" && !title ? null : el("div", { class: "hxg-head" },
      el("div", { class: "hxg-heading" },
        title ? el("p", { class: "hxg-title", id: uid + "-title", text: title }) : null,
        el("p", { class: "hxg-meta" }, count_text, L0.initial ? [" · starts at ", code(L0.initial)] : null)),
      legend);

    // ---- text alternative (inside the canvas, so the canvas region, when it is one, has content)
    const by_id0 = {};
    for (const n of L0.nodes) by_id0[n.id] = n;
    const alt_intro = el("p");
    const alt_run = el("p", { class: "hxg-alt-run", text: "No run is shown on this graph." });
    const alt = el("div", { class: "hxg-sr", id: uid + "-alt" },
      alt_intro,
      el("ol", null, L0.nodes.map((n) => {
        const outs = L0.edges.filter((e) => e.from === n.id);
        return el("li", { text: n.id + ": " + node_sentence(n) + (n.initial ? "; initial state" : "") + "." +
          (outs.length ? " Transitions: " + outs.map((e, i) => (i + 1) + ") " + edge_sentence(e, by_id0)).join("; ") + "." : "") });
      })),
      alt_run);

    // ---- frame (border, fill) > canvas (scrolls sideways) > drawing; the caption line under compact drawings
    // The caption is the frame's bottom bar. It is sticky, so on a short window it stays at the bottom of the screen
    // while any of the drawing is in view (a state tapped near the top still shows its details). It reserves room
    // for the longest state reading (the state, then one line per transition), so pointing never moves the page.
    const canvas = el("div", { class: "hxg-canvas" }, alt);
    const caption = mode === "normal" ? null : el("p", { class: "hxg-caption", "aria-hidden": "true", hidden: true });
    if (caption) {
      const most = Math.max(1, ...L0.nodes.map((n) => L0.edges.filter((e) => e.from === n.id).length));
      caption.style.setProperty("--hxg-cap-lines", String(Math.min(5, most + 1)));
    }
    const frame = el("div", { class: "hxg-frame" }, canvas, caption);
    const root = el("figure", { class: "hxg" + (on_select ? " is-selectable" : ""), "data-hxg": uid }, head, frame);
    if (title) root.setAttribute("aria-labelledby", uid + "-title");
    else root.setAttribute("aria-label", name);
    container.appendChild(root);

    // ---- state that outlives a redraw
    const state = { current: null, visited: [], status: null, terminal: null, highlight: [] };
    let D = null;          // the drawing shown now (see draw())
    let draw_seq = 0;
    let scale = 1;
    let last_current = null;
    let user_scrolled = false, last_auto = null;
    let destroyed = false;

    /** Width the figure may use: the host's content box, less the frame's border. */
    function avail_width() {
      const host = root.parentElement;
      if (!host) return 0;
      let pad = 0;
      try { const cs = getComputedStyle(host); pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); } catch (err) { pad = 0; }
      return host.clientWidth - pad - 2;
    }

    /* ---------------------------------------------------------------- drawing */
    function draw(compact) {
      const L = layout_of(compact);
      const did = uid + "-" + (++draw_seq);
      const by_id = {};
      for (const n of L.nodes) by_id[n.id] = n;
      const focusable = !!on_select || compact;
      const svg = sv("svg", { class: "hxg-svg", width: L.width, height: L.height, viewBox: "0 0 " + L.width + " " + L.height });
      // states are focusable (role group of buttons or images), or the drawing is hidden from assistive technology
      // and the text alternative stands in for it
      if (focusable) svg.setAttribute("role", "group");
      else svg.setAttribute("aria-hidden", "true");
      const markers = {};
      const defs = sv("defs", null,
        sv("pattern", { id: did + "-grid", width: 16, height: 16, patternUnits: "userSpaceOnUse" },
          sv("circle", { class: "hxg-dot", cx: 1, cy: 1, r: 0.9 })));
      for (const style of ["base", "faint", "visited", "jump"]) {
        const m = sv("marker", {
          id: did + "-m-" + style, class: "hxg-marker hxg-marker--" + style, viewBox: "0 0 10 10", refX: 9.2, refY: 5,
          markerWidth: 8, markerHeight: 8, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse",
        }, sv("path", { d: "M0.5 0.8 L9.5 5 L0.5 9.2 Z" }));
        markers[style] = "url(#" + did + "-m-" + style + ")";
        defs.appendChild(m);
      }
      svg.appendChild(defs);
      svg.appendChild(sv("rect", { class: "hxg-bg", x: 0, y: 0, width: L.width, height: L.height, fill: "url(#" + did + "-grid)" }));

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
      const base_label = {}; // id -> aria-label without the run (update() appends "Current state", "Visited", ...)
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
        if (on_select) g.classList.add("is-interactive");
        if (focusable) {
          if (copy === null || (copy === 0 && !n.own)) {
            base_label[n.id] = node_label(n);
            g.setAttribute("role", on_select ? "button" : "img");
            g.setAttribute("tabindex", "-1");
            g.setAttribute("aria-label", base_label[n.id]);
            focusables.push(g);
          } else {
            g.setAttribute("aria-hidden", "true");
          }
        }
        g_nodes.appendChild(g);
      }
      // drawn (and focused) in visual reading order: top to bottom, then left to right
      const drawn = [];
      for (const n of L.nodes) {
        if (n.own) drawn.push([n, n, null]);
        if (n.copies) n.copies.forEach((c, i) => drawn.push([n, c, i]));
      }
      drawn.sort((a, b) => (Math.round(a[1].y + a[1].h / 2) - Math.round(b[1].y + b[1].h / 2)) || (a[1].x - b[1].x));
      for (const [n, bx, copy] of drawn) draw_node(n, bx, copy);
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
          sv("title", { text: e.cond ? e.cond + (e.inc ? " (then +1 " + e.inc + ")" : "") : "default edge: taken when none of this state's guards holds" + (e.inc ? " (then +1 " + e.inc + ")" : "") }),
          sv("rect", { class: "hxg-label-bg", x: lb.x, y: lb.y, width: lb.w, height: lb.h, rx: 3 }), t);
        label_el[e.key] = g;
        g_labels.appendChild(g);
      }
      svg.appendChild(g_labels);
      const g_jumps = sv("g", { class: "hxg-jumps", "aria-hidden": "true" });
      const g_badges = sv("g", { class: "hxg-badges", "aria-hidden": "true" });
      const g_tags = sv("g", { class: "hxg-tags", "aria-hidden": "true" });
      svg.appendChild(g_jumps);
      svg.appendChild(g_badges);
      svg.appendChild(g_tags);

      const d = { L, compact, svg, by_id, node_els, edge_el, label_el, focusables, base_label, g_badges, g_jumps, g_tags, markers, focusable, roving: null };
      if (focusables.length) { d.roving = focusables[0]; d.roving.setAttribute("tabindex", "0"); }
      return d;
    }

    /** Show drawing d in the canvas (replacing the previous one) and set everything that depends on its kind. */
    function mount(d) {
      if (D && D.svg.parentNode === canvas) canvas.replaceChild(d.svg, D.svg);
      else canvas.appendChild(d.svg);
      D = d;
      scale = 1;
      root.classList.toggle("is-compact", d.compact);
      if (caption) caption.hidden = !d.compact;
      const hint = !d.focusable ? "" : on_select
        ? "Tab to the graph, use the arrow keys to move between states, and press Enter or Space to select one."
        : "Tab to the graph and use the arrow keys to move between states.";
      alt_intro.textContent = [head ? "" : meta_text + ".", hint, "Each state and its transitions:"].filter(Boolean).join(" ");
    }

    /* ---------------------------------------------------------------- interaction */
    const listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };
    const node_of = (t) => (t && t.closest && D && D.svg.contains(t) ? t.closest(".hxg-node") : null);
    const edge_of = (t) => (t && t.closest && D && D.svg.contains(t) ? t.closest(".hxg-edge") : null);
    function set_roving(g) {
      if (!D || D.focusables.indexOf(g) < 0) return;
      if (D.roving && D.roving !== g) D.roving.setAttribute("tabindex", "-1");
      D.roving = g;
      g.setAttribute("tabindex", "0");
    }
    function primary(g) {
      const id = g.getAttribute("data-state");
      const list = D.node_els[id] || [];
      const p = list.find((x) => x.copy === null) || list.find((x) => x.copy === 0);
      return p ? p.g : g;
    }
    // caption parts: strings in sans, [text] in mono (ids and guards), "\n" starts a new line
    function set_caption(parts) {
      if (!caption) return;
      const kids = [];
      for (const p of parts) {
        if (p === null || p === "") continue;
        kids.push(p === "\n" ? el("br") : Array.isArray(p) ? code(p[0]) : p);
      }
      caption.replaceChildren(...kids);
    }
    function edge_caption(e) {
      return [[e.from], " → ", [e.to], e.cond ? " if " : " otherwise", e.cond ? [e.cond] : null, e.inc ? ", then +1 " : null, e.inc ? [e.inc] : null];
    }
    /** The state on one line, then one line per transition with its guard (hover, keyboard focus or a tap). */
    function node_caption(n) {
      if (n.kind === "end") return [[n.id], ": terminal, " + (n.terminal_kind || "no category")];
      const outs = D.L.edges.filter((e) => e.from === n.id);
      const parts = [[n.id], ": " + n.kind_text + (n.detail ? " · " + n.lead : ""), n.detail ? (n.detail_mono ? [n.detail] : n.detail) : null];
      if (!outs.length) return parts.concat(" · no transitions");
      for (const e of outs) {
        parts.push("\n", "→ ", [e.to], e.cond ? " if " : " otherwise", e.cond ? [e.cond] : null, e.inc ? ", then +1 " : null, e.inc ? [e.inc] : null);
      }
      return parts;
    }
    function caption_default() {
      if (!caption) return;
      if (state.current || state.terminal || state.visited.length) {
        const where = state.terminal || state.current;
        set_caption([state.terminal ? "Ended in " : "Current state ", [where || "none"],
          state.status ? " · " + state.status.toLowerCase().replace(/_/g, " ") : null,
          " · " + state.visited.length + (state.visited.length === 1 ? " step" : " steps")]);
      } else if (can_hover()) {
        set_caption(["Hover over a state or Tab to it to read it here. The arrow keys move between states."]);
      } else {
        set_caption(["Tap a state to read it here."]);
      }
    }
    // what the pointer is over and which state has focus; the marks and the caption follow from them
    const pointer = { state: null, edge: null };
    let focused = null;
    function refresh_marks() {
      if (!D) return;
      for (const e of D.L.edges) {
        const on = e.from === pointer.state || e.from === focused || e.key === pointer.edge;
        D.edge_el[e.key].g.classList.toggle("is-hover", on);
        if (D.label_el[e.key]) D.label_el[e.key].classList.toggle("is-shown", on);
      }
      if (pointer.edge && D.edge_el[pointer.edge]) set_caption(edge_caption(D.edge_el[pointer.edge].e));
      else if (pointer.state && D.by_id[pointer.state]) set_caption(node_caption(D.by_id[pointer.state]));
      else if (focused && D.by_id[focused]) set_caption(node_caption(D.by_id[focused]));
      else caption_default();
    }
    // every listener sits on the HTML canvas: focus listeners on an <svg> would make the drawing itself a Tab stop
    listen(canvas, "click", (ev) => {
      if (!on_select) return;
      const g = node_of(ev.target);
      if (!g) return;
      set_roving(primary(g));
      on_select(g.getAttribute("data-state"));
    });
    listen(canvas, "keydown", (ev) => {
      const g = node_of(ev.target);
      if (!g) return;
      const i = D.focusables.indexOf(g);
      if (i < 0) return;
      if (on_select && (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar")) {
        ev.preventDefault();
        on_select(g.getAttribute("data-state"));
        return;
      }
      let next = null;
      if (ev.key === "ArrowDown" || ev.key === "ArrowRight") next = D.focusables[Math.min(D.focusables.length - 1, i + 1)];
      else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") next = D.focusables[Math.max(0, i - 1)];
      else if (ev.key === "Home") next = D.focusables[0];
      else if (ev.key === "End") next = D.focusables[D.focusables.length - 1];
      if (next) {
        ev.preventDefault();
        set_roving(next);
        next.focus();
        reveal(next.getAttribute("data-state"));
      }
    });
    listen(canvas, "focusin", (ev) => {
      const g = node_of(ev.target);
      if (!g) return;
      set_roving(g);
      focused = g.getAttribute("data-state");
      refresh_marks();
    });
    listen(canvas, "focusout", (ev) => {
      const g = node_of(ev.target);
      if (!g || focused !== g.getAttribute("data-state")) return;
      focused = null;
      refresh_marks();
    });
    listen(canvas, "mouseover", (ev) => {
      const g = node_of(ev.target), eg = g ? null : edge_of(ev.target);
      pointer.state = g ? g.getAttribute("data-state") : null;
      pointer.edge = eg ? eg.getAttribute("data-key") : null;
      refresh_marks();
    });
    listen(canvas, "mouseout", (ev) => {
      const to = ev.relatedTarget;
      if (to && (node_of(to) || edge_of(to))) return; // the mouseover that follows sets the new target
      pointer.state = null;
      pointer.edge = null;
      refresh_marks();
    });

    /* ---------------------------------------------------------------- size, overflow and scrolling */
    // natural size (1 unit = 1px; the full drawing scrolls sideways when wider); compact scales down to fit, to 90%
    function fit() {
      if (!D) return;
      let k = 1;
      if (D.compact) {
        const avail = avail_width();
        if (!(avail > 0)) return;
        k = Math.max(SCALE_MIN, Math.min(1, avail / D.L.width));
      }
      if (Math.abs(k - scale) < 0.002 && D.svg.getAttribute("width")) return;
      scale = k;
      D.svg.setAttribute("width", String(Math.floor(D.L.width * k)));
      D.svg.setAttribute("height", String(Math.floor(D.L.height * k)));
    }
    /** Edge fades on the side that has more, and (only while it overflows and holds no focusable state) the canvas
        is a focusable region so the keyboard can scroll it. */
    function sync_overflow() {
      if (!D) return;
      const cw = canvas.clientWidth, sw = canvas.scrollWidth;
      const over = cw > 0 && sw > cw + 1;
      if (over) {
        canvas.setAttribute("data-scroll-start", canvas.scrollLeft > 1 ? "more" : "edge");
        canvas.setAttribute("data-scroll-end", canvas.scrollLeft + cw < sw - 1 ? "more" : "edge");
      } else {
        canvas.removeAttribute("data-scroll-start");
        canvas.removeAttribute("data-scroll-end");
      }
      canvas.classList.toggle("is-overflowing", over);
      if (over && !D.focusable) {
        canvas.setAttribute("tabindex", "0");
        canvas.setAttribute("role", "region");
        canvas.setAttribute("aria-label", "Graph drawing, scrolls sideways");
      } else if (canvas.hasAttribute("tabindex")) {
        canvas.removeAttribute("tabindex");
        canvas.removeAttribute("role");
        canvas.removeAttribute("aria-label");
      }
    }
    listen(canvas, "scroll", () => {
      if (last_auto === null || Math.abs(canvas.scrollLeft - last_auto) > 2) user_scrolled = true;
      sync_overflow();
    });
    function set_scroll(target) {
      const cw = canvas.clientWidth;
      target = Math.max(0, Math.min(canvas.scrollWidth - cw, target));
      last_auto = target;
      canvas.scrollLeft = target;
      last_auto = canvas.scrollLeft;
      sync_overflow();
    }
    function svg_left() { return D.svg.getBoundingClientRect().left - canvas.getBoundingClientRect().left + canvas.scrollLeft; }
    /** Scroll sideways as little as needed to show x..x+w (drawing units) with a margin; when it cannot all be
        shown, show its start. */
    function reveal_box(x, w) {
      const cw = canvas.clientWidth;
      if (!cw || canvas.scrollWidth <= cw + 1) return;
      const a = svg_left() + (x - 12) * scale, b = svg_left() + (x + w + 12) * scale;
      if (a >= canvas.scrollLeft && b <= canvas.scrollLeft + cw) return;
      set_scroll(b - a > cw || a < canvas.scrollLeft ? a : b - cw);
    }
    /** Show a state: its box (and status tag), plus its terminal pills and guard labels when they fit too. */
    function reveal(id) {
      const list = D.node_els[id];
      if (!list || !list.length) return;
      const m = list.find((x) => /\bis-(current|reached|stopped)\b/.test(x.g.getAttribute("class"))) ||
        list.find((x) => x.copy === null) || list[0];
      const tag_out = m.box.tag && m.box.tag.outside ? m.box.tag.x - m.box.w + D.L.metrics.tag.w : 0;
      let x0 = m.box.x, x1 = m.box.x + m.box.w + tag_out;
      if (m.copy === null) {
        let u0 = x0, u1 = x1;
        for (const n of D.L.nodes) for (const c of n.copies || []) if (c.source === id) { u0 = Math.min(u0, c.x); u1 = Math.max(u1, c.x + c.w); }
        for (const e of D.L.edges) if (e.from === id && e.label) { u0 = Math.min(u0, e.label.x); u1 = Math.max(u1, e.label.x + e.label.w); }
        if ((u1 - u0 + 24) * scale <= canvas.clientWidth) { x0 = u0; x1 = u1; }
      }
      reveal_box(x0, x1 - x0);
    }
    /** At rest: the spine column starts at the left edge, just inside the 16px edge fade (its guards and the
        outcome lane are to its right). */
    function rest_scroll() {
      if (user_scrolled || !D) return;
      const cw = canvas.clientWidth;
      const sp = D.L.spine.length ? D.by_id[D.L.spine[0]] : D.L.nodes[0];
      if (!sp || !cw || canvas.scrollWidth <= cw + 1) { sync_overflow(); return; }
      set_scroll(svg_left() + sp.x * scale - FADE);
    }
    function show_focus_target() {
      if (state.current || state.terminal) reveal(state.current || state.terminal);
      else if (state.highlight.length) reveal(state.highlight[0]);
      else rest_scroll();
    }

    /* ---------------------------------------------------------------- the drawing to show ("auto") */
    function want_compact() {
      if (mode !== "auto") return mode === "compact";
      const avail = avail_width();
      if (!(avail > 0)) return D ? D.compact : false;
      const full = layout_of(false).width;
      return D && D.compact ? avail < full + AUTO_SLACK : avail < full;
    }
    function redraw(compact) {
      const active = document.activeElement;
      const had_focus = D && active && D.svg.contains(active) ? active.getAttribute("data-state") : null;
      mount(draw(compact));
      // the old drawing is gone (removing a focused element fires no focusout): start the tracking afresh
      pointer.state = null; pointer.edge = null; focused = null;
      last_current = null;
      user_scrolled = false;
      fit();
      apply(state);
      if (state.highlight.length) highlight(state.highlight);
      if (had_focus) {
        const list = D.node_els[had_focus] || [];
        const p = (list.find((x) => x.copy === null) || list.find((x) => x.copy === 0) || {}).g;
        if (p && D.focusables.indexOf(p) >= 0) {
          set_roving(p);
          try { p.focus({ preventScroll: true }); } catch (err) { p.focus(); }
        }
      }
      sync_overflow();
    }

    let ro = null, frame_req = 0, seen = "";
    function on_resize() {
      frame_req = 0;
      if (destroyed) return;
      const c = want_compact();
      if (D && c !== D.compact) redraw(c);
      fit();
      sync_overflow();
      const key = canvas.clientWidth + "x" + (root.parentElement ? root.parentElement.clientWidth : 0);
      if (canvas.clientWidth && key !== seen) {
        seen = key;
        show_focus_target();
      }
    }
    if (typeof ResizeObserver === "function") {
      // resizing the drawing changes what is observed, so the work waits for the next frame (no observer loop)
      ro = new ResizeObserver(() => {
        if (frame_req) return;
        if (typeof requestAnimationFrame === "function") frame_req = requestAnimationFrame(on_resize);
        else on_resize();
      });
      ro.observe(canvas);
      if (root.parentElement) ro.observe(root.parentElement);
    }

    /* ---------------------------------------------------------------- run state */
    function resolve_edge(v) {
      if (!v || typeof v !== "object") return null;
      let idx = v.edge;
      if (idx && typeof idx === "object") idx = idx.index;
      if (typeof idx === "number" && Number.isInteger(idx)) {
        const k = v.from + "#" + idx;
        if (D.edge_el[k] && (v.to === undefined || v.to === null || D.edge_el[k].e.to === v.to)) return k;
      }
      if (idx === undefined) {
        const e = D.L.edges.find((x) => x.from === v.from && x.to === v.to);
        return e ? e.key : null;
      }
      return null;
    }
    function to_state_id(id) {
      if (!id || typeof id !== "string") return null;
      if (D.by_id[id]) return id;
      const n = D.L.nodes.find((x) => x.kind === "end" && x.terminal === id);
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
      const w = Math.min(D.L.metrics.tag.w, sans_w(text, FS.tag) + 12);
      const x = n_box.x + tag_pos.x - (tag_pos.align === "end" ? w : 0);
      return sv("g", { class: "hxg-tag", "data-tone": tone, transform: "translate(" + x + " " + (n_box.y + tag_pos.y) + ")" },
        sv("rect", { x: 0, y: 0, width: w, height: D.L.metrics.tag.h, rx: 3 }),
        sv("text", { x: w / 2, y: 13, "text-anchor": "middle", text }));
    }

    function apply(run) {
      run = run || {};
      const { by_id, node_els, edge_el, label_el, g_badges, g_jumps, g_tags, markers, L } = D;
      const current = to_state_id(run.current);
      const visited = Array.isArray(run.visited) ? run.visited : [];
      const status = typeof run.status === "string" ? run.status : null;
      const terminal = to_state_id(run.terminal);
      state.current = current; state.visited = visited; state.status = status; state.terminal = terminal;
      const steps = new Map(); // edge key -> [step numbers]
      const seen_nodes = new Set();
      const jumps = [];
      const last_edge_into = {}; // state id -> edge key of the latest visited edge into it
      visited.forEach((v, i) => {
        if (!v || typeof v !== "object") return;
        const k = resolve_edge(v);
        if (typeof v.from === "string" && v.from) seen_nodes.add(v.from);
        if (typeof v.to === "string" && v.to) seen_nodes.add(v.to);
        if (k) {
          if (!steps.has(k)) steps.set(k, []);
          steps.get(k).push(i + 1);
          last_edge_into[edge_el[k].e.to] = k;
        } else if (v.from && v.to) {
          jumps.push({ from: v.from, to: to_state_id(v.to) || v.to, n: i + 1, reason: typeof v.reason === "string" ? v.reason : "" });
        }
      });
      if (current) seen_nodes.add(current);
      if (terminal) seen_nodes.add(terminal);
      const active = !!(current || visited.length || terminal);
      root.classList.toggle("is-active", active);
      if (legend) legend.hidden = !active;

      // nodes and terminal copies
      const done = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
      for (const id of Object.keys(node_els)) {
        const list = node_els[id];
        const n = by_id[id];
        let mark = null; // the drawn box that carries the current / reached marking
        if (id === current || id === terminal) {
          const k = last_edge_into[id];
          const kn = k ? Math.max(...steps.get(k)) : 0;
          const j = jumps.filter((x) => x.to === id).pop();
          if (j && j.n > kn) {
            // the run arrived here by a fallback jump, not by an edge
            const slot = L.jumps && L.jumps[j.from];
            if (slot && slot.box) j.marks = true; // the jump pill drawn below carries the marking
            else {
              mark = (slot && slot.reuse_edge && list.find((x) => x.box.edges && x.box.edges.includes(slot.reuse_edge))) ||
                list.find((x) => x.box.source === j.from) || list.find((x) => x.copy === null) || list[0];
            }
          } else if (list.length === 1) mark = list[0];
          else mark = (k && list.find((x) => x.box.edges && x.box.edges.includes(k))) || list.find((x) => x.copy === null) || list[0];
        }
        for (const x of list) {
          const via = x.box.edges ? x.box.edges.some((k) => steps.has(k)) : false;
          // a terminal's own box counts as visited only when a non-stub edge reached it
          const own_hit = n.copies ? L.edges.some((e) => e.to === id && !e.dst_stub && steps.has(e.key)) : seen_nodes.has(id);
          const visited_here = x.copy === null ? own_hit || x === mark : via || x === mark;
          x.g.classList.toggle("is-visited", active && visited_here);
          x.g.classList.toggle("is-faint", active && !visited_here);
          const is_mark = x === mark;
          const reached = is_mark && n.kind === "end" && (id === terminal || (status === "COMPLETED" && id === current));
          x.g.classList.toggle("is-reached", reached);
          x.g.classList.toggle("is-current", is_mark && !reached && id === current && !done);
          x.g.classList.toggle("is-stopped", is_mark && !reached && id === current && done);
          x.g.setAttribute("data-status", is_mark ? (status || "") : "");
        }
        if (D.focusable && D.base_label[id] !== undefined) {
          const p = list.find((x) => x.copy === null) || list.find((x) => x.copy === 0);
          if (p) {
            let extra = "";
            if (id === current || id === terminal) extra = id === terminal || (n.kind === "end" && status === "COMPLETED") ? ". Run ended here" : ". Current state" + (status ? ", run " + status.toLowerCase().replace(/_/g, " ") : "");
            else if (active && seen_nodes.has(id)) extra = ". Visited";
            p.g.setAttribute("aria-label", D.base_label[id] + extra);
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
        // several numbers on one edge read in page order (left to right, top to bottom), whatever the edge's direction
        const slots = nums.length > 1
          ? x.e.badges.slice(0, Math.min(nums.length, x.e.badges.length)).sort((a, b) => (Math.round(a.y) - Math.round(b.y)) || (a.x - b.x))
          : x.e.badges;
        const title = "Step" + (nums.length > 1 ? "s " : " ") + nums.join(", ") + ": " + x.e.from + " to " + x.e.to;
        if (nums.length <= slots.length) nums.forEach((num, i) => g_badges.appendChild(badge(slots[i].x, slots[i].y, String(num), title, k, num)));
        else {
          slots.slice(0, -1).forEach((q, i) => g_badges.appendChild(badge(q.x, q.y, String(nums[i]), title, k, nums[i])));
          const q = slots[slots.length - 1];
          g_badges.appendChild(badge(q.x, q.y, "+" + (nums.length - slots.length + 1), title, k, nums.slice(slots.length - 1).join(" ")));
        }
      }

      // fallback jumps: a dashed connector to the fallback pill beside the failing state, numbered like a step
      g_jumps.replaceChildren();
      for (const j of jumps) {
        const slot = L.jumps && L.jumps[j.from];
        if (!slot || slot.to !== j.to || !(slot.box || slot.reuse_edge)) continue;
        j.drawn = true;
        const reuse = slot.reuse_edge ? edge_el[slot.reuse_edge].e : null;
        const why = "Step " + j.n + ": " + j.from + " failed" + (j.reason ? " (" + j.reason + ")" : "") + " and the run entered " + j.to;
        g_jumps.appendChild(sv("g", { class: "hxg-jump" },
          sv("title", { text: why }),
          sv("path", { class: "hxg-jump-line", d: reuse ? reuse.path : slot.path, "marker-end": markers.jump })));
        if (slot.box) {
          const term = by_id[j.to];
          const tone = CATEGORY_TONE[term && term.terminal_kind] || "neutral";
          const reached = j.marks && (j.to === terminal || status === "COMPLETED");
          const cls = "hxg-node hxg-term hxg-stub hxg-jump " + (!j.marks ? "is-visited" : reached ? "is-reached" : done ? "is-stopped" : "is-current");
          g_jumps.appendChild(sv("g", { class: cls, "data-state": j.to, "data-tone": tone, "data-status": j.marks ? (status || "") : "",
            "data-jump": j.from, transform: "translate(" + slot.box.x + " " + slot.box.y + ")" },
          sv("rect", { class: "hxg-box", x: 0, y: 0, width: slot.box.w, height: slot.box.h, rx: slot.box.h / 2 }),
          sv("text", { class: "hxg-cat", x: slot.box.w / 2, y: slot.box.h / 2 + 4.2, "text-anchor": "middle", text: (term && term.terminal_kind) || j.to })));
        }
        const q = slot.box ? slot.badge : reuse.badges[0];
        const jb = badge(q.x, q.y, String(j.n), why, "jump:" + j.from, j.n);
        jb.classList.add("is-jump");
        g_badges.appendChild(jb);
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
        if (j.drawn) continue;
        if (src && src.copy === null && src.box.tag && !(cur && cur === src)) {
          g_tags.appendChild(tag(src.box, src.box.tag, "to " + (by_id[j.to] && by_id[j.to].terminal_kind ? by_id[j.to].terminal_kind : "fallback"), "crit"));
          src.g.classList.add("is-failed-out");
        }
      }
      for (const id of Object.keys(node_els)) {
        if (!jumps.some((j) => j.from === id && !j.drawn)) for (const x of node_els[id]) x.g.classList.remove("is-failed-out");
      }

      // the legend's first entry follows the mark drawn now
      if (legend) {
        const mk = D.svg.querySelector(".hxg-node.is-current, .hxg-node.is-reached, .hxg-node.is-stopped");
        const kind = !mk ? "none" : mk.classList.contains("is-reached") ? "reached" : mk.classList.contains("is-stopped") ? "stopped" : "current";
        legend_sw.className = "hxg-sw hxg-sw--" + kind;
        if (kind === "reached") legend_sw.setAttribute("data-tone", mk.getAttribute("data-tone") || "neutral");
        else legend_sw.removeAttribute("data-tone");
        legend_mark.textContent = kind === "reached" ? "reached outcome" : kind === "stopped" ? "run stopped here" : "current state";
        legend_mark.parentNode.hidden = kind === "none";
      }

      // text alternative
      if (!active) alt_run.textContent = "No run is shown on this graph.";
      else {
        const parts = [];
        if (status) parts.push("Run status: " + status + ".");
        if (current) parts.push("Current state: " + current + ".");
        if (terminal) parts.push("Ended in " + terminal + (by_id[terminal] && by_id[terminal].terminal_kind ? " (" + by_id[terminal].terminal_kind + ")" : "") + ".");
        parts.push(visited.length ? "Steps taken: " + visited.map((v, i) => (i + 1) + ". " + (v && v.from) + " to " + (v && v.to) + (resolve_edge(v) ? "" : " (fallback, not an edge)")).join("; ") + "." : "No transition taken yet.");
        alt_run.textContent = parts.join(" ");
      }
      refresh_marks();
      const target = current || terminal;
      if (target && target !== last_current) {
        const jp = g_jumps.querySelector(".hxg-node.hxg-jump.is-reached, .hxg-node.hxg-jump.is-current, .hxg-node.hxg-jump.is-stopped");
        const slot = jp ? L.jumps[jp.getAttribute("data-jump")] : null;
        if (slot && slot.box) reveal_box(slot.box.x, slot.box.w);
        else reveal(target);
      }
      last_current = target;
    }

    function highlight(ids) {
      const set = new Set((Array.isArray(ids) ? ids : []).map(to_state_id).filter(Boolean));
      state.highlight = Array.from(set);
      root.classList.toggle("has-highlight", set.size > 0);
      for (const id of Object.keys(D.node_els)) for (const x of D.node_els[id]) x.g.classList.toggle("is-highlight", set.has(id));
      if (set.size) reveal(Array.from(set)[0]);
    }

    function destroy() {
      destroyed = true;
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
      listeners.length = 0;
      if (ro) ro.disconnect();
      if (frame_req && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame_req);
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    // first paint: the drawing that fits, at rest, with the spine in view
    mount(draw(want_compact()));
    fit();
    refresh_marks();
    sync_overflow();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (!destroyed) { sync_overflow(); rest_scroll(); } });

    return {
      root, update: apply, highlight, destroy,
      get svg() { return D.svg; },
      get layout() { return D.L; },
      get compact() { return D.compact; },
      get state() { return { current: state.current, visited: state.visited.slice(), status: state.status, terminal: state.terminal, highlight: state.highlight.slice() }; },
    };
  }

  HXUI.graph = { layout, create, version: 2 };
})();
