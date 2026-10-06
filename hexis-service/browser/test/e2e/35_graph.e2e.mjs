// HXUI.graph (app/35_graph.js): layout invariants on both Python-built machines (and stress variants), run marking
// from the Python run snapshots in golden/ui_fixtures.json, highlight(), the keyboard model (Tab stops, roving
// focus, Enter / Space / arrows), the text alternative, the "auto" drawing, contrast of the receding marks and
// sideways scrolling. Works with a graph-only build (no boot script: python build.py --app-prefixes 00,35) and with
// the full app.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = process.env.HX_PAGE ? path.resolve(ROOT, process.env.HX_PAGE) : path.join(ROOT, "dist", "hexis-lab.local.html");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "golden", "ui_fixtures.json"), "utf8"));

/* ------------------------------------------------------------------ in-page helpers (serialized into the page) */
const IN_PAGE = String.raw`
globalThis.__hxgt = globalThis.__hxgt || {
  views: [],
  root() {
    let r = document.getElementById("hxg-test-root");
    if (!r) {
      r = document.createElement("section");
      r.id = "hxg-test-root";
      r.setAttribute("aria-label", "Graph test");
      r.style.cssText = "display:block;box-sizing:border-box;width:100%;max-width:100%;padding:16px;";
      document.body.appendChild(r);
    }
    return r;
  },
  /** Mount a view in its own host, between two buttons (for Tab order checks). */
  mount(machine, opts, host_style) {
    const i = this.views.length;
    const host = document.createElement("div");
    host.className = "hxg-test-host";
    const before = document.createElement("button");
    before.type = "button"; before.id = "hxgt-before-" + i; before.textContent = "Before graph " + i;
    const after = document.createElement("button");
    after.type = "button"; after.id = "hxgt-after-" + i; after.textContent = "After graph " + i;
    const gh = document.createElement("div");
    gh.className = "hxg-test-graph";
    if (host_style) gh.style.cssText = host_style;
    host.append(before, gh, after);
    this.root().appendChild(host);
    const calls = [];
    const o = Object.assign({}, opts || {});
    if (o.select) { delete o.select; o.on_select = (id) => calls.push(id); }
    const view = HXUI.graph.create(gh, machine, o);
    this.views.push({ view, host, gh, calls });
    return i;
  },
  frames(n) {
    return new Promise((res) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : setTimeout(res, 30)); step(n || 3); });
  },
  boxOf(g) {
    const r = g.querySelector(".hxg-box");
    const b = r.getBBox();
    const m = g.transform.baseVal.consolidate();
    const e = m ? m.matrix.e : 0, f = m ? m.matrix.f : 0;
    return { x: b.x + e, y: b.y + f, w: b.width, h: b.height };
  },
  geometry(i) {
    const { view } = this.views[i];
    const svg = view.root.querySelector("svg.hxg-svg");
    const vb = svg.viewBox.baseVal;
    const nodes = [...svg.querySelectorAll(".hxg-nodes > .hxg-node")].map((g) => {
      const m = g.transform.baseVal.consolidate();
      const e = m ? m.matrix.e : 0, f = m ? m.matrix.f : 0;
      return {
        state: g.getAttribute("data-state"), copy: g.getAttribute("data-copy"),
        edges: (g.getAttribute("data-edges") || "").split(" ").filter(Boolean), box: this.boxOf(g),
        texts: [...g.querySelectorAll("text")].map((t) => { const b = t.getBBox(); return { x: b.x + e, y: b.y + f, w: b.width, h: b.height, s: t.textContent }; }),
      };
    });
    const edges = [...svg.querySelectorAll(".hxg-edge")].map((g) => {
      const p = g.querySelector(".hxg-line");
      const len = p.getTotalLength();
      const pts = [];
      for (let d = 0; d <= len; d += 2) { const q = p.getPointAtLength(d); pts.push({ x: q.x, y: q.y }); }
      const q = p.getPointAtLength(len);
      pts.push({ x: q.x, y: q.y });
      return { key: g.getAttribute("data-key"), from: g.getAttribute("data-from"), to: g.getAttribute("data-to"), pts };
    });
    const labels = [...svg.querySelectorAll(".hxg-label")].map((g) => {
      const r = g.querySelector(".hxg-label-bg").getBBox();
      const t = g.querySelector(".hxg-label-text").getBBox();
      return { key: g.getAttribute("data-key"), box: { x: r.x, y: r.y, w: r.width, h: r.height }, text: { x: t.x, y: t.y, w: t.width, h: t.height } };
    });
    return { vb: { x: vb.x, y: vb.y, w: vb.width, h: vb.height }, nodes, edges, labels };
  },
  /** What has focus, in words: an element id, or the graph part (state / canvas / svg). */
  focused() {
    const e = document.activeElement;
    if (!e || e === document.body) return { what: "body" };
    if (e.id) return { what: "id", id: e.id };
    const cls = e.getAttribute("class") || "";
    if (/\bhxg-node\b/.test(cls)) return { what: "state", state: e.getAttribute("data-state"), role: e.getAttribute("role") };
    if (/\bhxg-canvas\b/.test(cls)) return { what: "canvas", role: e.getAttribute("role"), label: e.getAttribute("aria-label") };
    return { what: e.tagName.toLowerCase(), cls };
  },
};
`;

/* ------------------------------------------------------------------ colors (computed values: rgb() or color(srgb ...)) */
function rgb(s) {
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) return m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((v) => Number(v) / 255);
  m = /^color\(srgb ([^)]+)\)$/.exec(s);
  if (m) return m[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map(Number);
  throw new Error("cannot parse the color " + s);
}
function luminance(c) {
  const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ------------------------------------------------------------------ geometry invariants */
function problems(geo, name, compact = false) {
  const out = [];
  const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (b, p, m) => p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m;
  const within = (b, vb) => b.x >= vb.x - 0.5 && b.y >= vb.y - 0.5 && b.x + b.w <= vb.x + vb.w + 0.5 && b.y + b.h <= vb.y + vb.h + 0.5;
  const dist = (b, p) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));
  const nm = (n) => n.state + (n.copy === null ? "" : "[" + n.copy + "]");
  // nodes: no overlap, inside the viewBox, their text inside the box
  for (let i = 0; i < geo.nodes.length; i++) {
    const a = geo.nodes[i];
    if (!within(a.box, geo.vb)) out.push(`${name}: node ${nm(a)} lies outside the viewBox`);
    for (const t of a.texts) {
      if (t.x < a.box.x - 0.5 || t.x + t.w > a.box.x + a.box.w + 0.5) out.push(`${name}: text "${t.s}" overflows node ${nm(a)} (${t.w.toFixed(1)}px in ${a.box.w}px)`);
    }
    for (let j = i + 1; j < geo.nodes.length; j++) if (ov(a.box, geo.nodes[j].box)) out.push(`${name}: nodes ${nm(a)} and ${nm(geo.nodes[j])} overlap`);
  }
  // edges: inside the viewBox, never through a node other than their own two ends, and never back through those
  for (const e of geo.edges) {
    if (e.pts.some((p) => p.x < geo.vb.x - 0.5 || p.y < geo.vb.y - 0.5 || p.x > geo.vb.x + geo.vb.w + 0.5 || p.y > geo.vb.y + geo.vb.h + 0.5)) {
      out.push(`${name}: edge ${e.key} leaves the viewBox`);
    }
    const src = geo.nodes.find((n) => n.state === e.from && n.copy === null);
    const dst = geo.nodes.find((n) => n.copy !== null && n.edges.includes(e.key)) || geo.nodes.find((n) => n.state === e.to && n.copy === null);
    if (!src || !dst) { out.push(`${name}: edge ${e.key} has no drawn end`); continue; }
    for (const n of geo.nodes) {
      if (n === src || n === dst) continue;
      const hit = e.pts.find((p) => inside(n.box, p, 1));
      if (hit) out.push(`${name}: edge ${e.key} passes through ${nm(n)} at ${hit.x.toFixed(1)},${hit.y.toFixed(1)}`);
    }
    const inner = e.pts.slice(3, -3);
    for (const b of src === dst ? [src] : [src, dst]) {
      const hit = inner.find((p) => inside(b.box, p, -1.5));
      if (hit) out.push(`${name}: edge ${e.key} cuts back through its own end ${nm(b)} at ${hit.x.toFixed(1)},${hit.y.toFixed(1)}`);
    }
    // it leaves its source at the border and ends at its target's border
    const first = e.pts[0], last = e.pts[e.pts.length - 1];
    const onBorder = (b, p) => inside(b, p, 1.5) && !inside(b, p, -1.5);
    if (!onBorder(src.box, first)) out.push(`${name}: edge ${e.key} does not start on ${nm(src)}'s border`);
    if (!onBorder(dst.box, last)) out.push(`${name}: edge ${e.key} does not end on ${nm(dst)}'s border`);
  }
  // labels: inside the viewBox, clear of every node and of each other, text inside the label, next to their own
  // edge (24px at most) and never hiding another edge (at most one 2px sample point of it under the halo). A compact
  // drawing shows labels one state at a time, so there only the labels and edges of the same state count.
  const source = (key) => key.slice(0, key.lastIndexOf("#"));
  const together = (a, b) => !compact || source(a) === source(b);
  for (let i = 0; i < geo.labels.length; i++) {
    const l = geo.labels[i];
    if (!within(l.box, geo.vb)) out.push(`${name}: label ${l.key} lies outside the viewBox`);
    for (const n of geo.nodes) if (ov(l.box, n.box)) out.push(`${name}: label ${l.key} overlaps node ${nm(n)}`);
    for (let j = i + 1; j < geo.labels.length; j++) {
      if (together(l.key, geo.labels[j].key) && ov(l.box, geo.labels[j].box)) out.push(`${name}: labels ${l.key} and ${geo.labels[j].key} overlap`);
    }
    if (l.text.x < l.box.x - 0.5 || l.text.x + l.text.w > l.box.x + l.box.w + 0.5) out.push(`${name}: label ${l.key} text is wider than its box`);
    const own = geo.edges.find((e) => e.key === l.key);
    if (!own) out.push(`${name}: label ${l.key} has no edge`);
    else {
      const d = Math.min(...own.pts.map((p) => dist(l.box, p)));
      if (d > 24) out.push(`${name}: label ${l.key} is ${d.toFixed(0)}px from its own edge`);
    }
    for (const e of geo.edges) {
      if (e.key === l.key || !together(l.key, e.key)) continue;
      const n = e.pts.filter((p) => inside(l.box, p, -0.5)).length;
      if (n > 1) out.push(`${name}: label ${l.key} hides ${n} points of edge ${e.key}`);
    }
  }
  return out;
}

/** The E2E stress machine: a back edge, a guarded shortcut into the verified terminal and a dangling target. */
function stress_machine(m0) {
  const m = JSON.parse(JSON.stringify(m0));
  m.states.READ_BACK.transitions.splice(2, 0, { if: "readback_status == 'stale'", to: "VALIDATE_DRAFT", inc: null, support: 0, origin: "" });
  m.states.LOOKUP_SUPPLIER.transitions.splice(1, 0, { if: "lookup_status == 'vip'", to: "END_VERIFIED_DRAFT", inc: null, support: 0, origin: "" });
  m.states.REPAIR_DRAFT.transitions.push({ if: "", to: "NOT_A_STATE", inc: null, support: 0, origin: "" });
  m.states.REPAIR_DRAFT.transitions[0].if = "draft != None";
  return m;
}
/** Denser still: every tool state gets two more guarded edges, back to READ_INTAKE and to EXTRACT_DRAFT. */
function dense_machine(m0) {
  const m = stress_machine(m0);
  for (const [id, st] of Object.entries(m.states)) {
    if (st.action.kind !== "tool") continue;
    st.transitions.splice(0, 0, { if: "retry_count < 3 and " + id.toLowerCase() + "_status == 'retry'", to: "READ_INTAKE", inc: "retry_count", support: 0, origin: "" },
      { if: id.toLowerCase() + "_status == 'reextract'", to: "EXTRACT_DRAFT", inc: null, support: 0, origin: "" });
  }
  return m;
}

export default async function (t) {
  const { page, assert } = t;
  const narrow = t.viewport.width <= 400;
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForFunction(() => globalThis.HXUI && HXUI.graph && typeof HXUI.graph.create === "function", null, { timeout: 15000 });
  // with the full app in the build, let boot finish first so it never races the checks below
  const booting = await page.evaluate(() => !!document.querySelector('script[data-hx-module="app/90_boot.js"]'));
  if (booting) await page.waitForFunction(() => document.getElementById("app")?.dataset.boot !== "pending", null, { timeout: 15000 });
  await page.evaluate(IN_PAGE);
  const frames = (n) => page.evaluate((n) => __hxgt.frames(n), n);

  const machines = { initial: FX.packages.initial.machine, refined: FX.packages.refined.machine };

  /* ---------------- layout: pure, deterministic, independent of key order, API shape */
  for (const [name, m] of Object.entries(machines)) {
    const r = await page.evaluate((m) => {
      const a = HXUI.graph.layout(m), b = HXUI.graph.layout(JSON.parse(JSON.stringify(m)));
      const rev = JSON.parse(JSON.stringify(m));
      rev.states = Object.fromEntries(Object.entries(rev.states).reverse());
      const c = HXUI.graph.layout(rev);
      const cw = HXUI.graph.layout(m, { compact: true }).width;
      return { a, same: JSON.stringify(a) === JSON.stringify(b), keyfree: JSON.stringify(a) === JSON.stringify(c), untouched: JSON.stringify(m), cw };
    }, m);
    assert.ok(r.same, `${name}: two layout() calls differ`);
    assert.ok(r.keyfree, `${name}: layout() depends on the key order of machine.states`);
    assert.equal(r.untouched, JSON.stringify(m), `${name}: layout() modified the machine`);
    const L = r.a;
    assert.ok(L.width > 0 && L.height > 0, `${name}: empty layout`);
    // the compact drawing fits a 400px screen (366px inside the 16px gutters and the frame) at full size
    assert.ok(r.cw <= 366, `${name}: the compact drawing is ${r.cw}px wide, more than the 366px a 400px screen leaves`);
    assert.deepEqual(L.nodes.map((n) => n.id).sort(), Object.keys(m.states).sort(), `${name}: one layout node per state`);
    const nTrans = Object.values(m.states).reduce((n, s) => n + s.transitions.length, 0);
    assert.equal(L.edges.length, nTrans, `${name}: one layout edge per transition`);
    for (const n of L.nodes) {
      for (const k of ["id", "x", "y", "w", "h", "kind", "label", "sublabel"]) assert.ok(k in n, `${name}: node ${n.id} lacks ${k}`);
      assert.ok("terminal_kind" in n, `${name}: node ${n.id} lacks terminal_kind`);
      if (n.kind === "end") {
        const tid = m.states[n.id].action.terminal;
        assert.equal(n.terminal_kind, m.terminals.find((x) => x.id === tid).kind, `${name}: ${n.id} category`);
      }
    }
    for (const e of L.edges) {
      for (const k of ["key", "from", "to", "index", "cond", "inc", "path", "label"]) assert.ok(k in e, `${name}: edge ${e.key} lacks ${k}`);
      assert.equal(e.key, `${e.from}#${e.index}`, `${name}: edge key`);
      const tr = m.states[e.from].transitions[e.index];
      assert.equal(e.to, tr.to, `${name}: ${e.key} target`);
      assert.equal(e.cond, tr.if, `${name}: ${e.key} guard`);
      if (e.label) for (const k of ["x", "y", "w", "h", "text"]) assert.ok(k in e.label, `${name}: ${e.key} label lacks ${k}`);
      // every guarded edge of the shipped machines carries its guard on the drawing
      if (e.cond) assert.ok(e.label, `${name}: the guard of ${e.key} is not drawn`);
    }
    // the main success path runs down one straight column
    const spine = L.spine.map((id) => L.nodes.find((n) => n.id === id));
    assert.equal(L.spine[0], m.initial, `${name}: the spine starts at the initial state`);
    assert.equal(L.spine[L.spine.length - 1], "END_VERIFIED_DRAFT", `${name}: the spine ends at the verified terminal`);
    for (const n of spine) assert.ok(Math.abs(n.x + n.w / 2 - (spine[0].x + spine[0].w / 2)) < 0.6, `${name}: ${n.id} is off the main column`);
  }

  /* ---------------- layout never hangs or throws: long guards, an end state as the initial state, odd input */
  {
    // first in Node, under a timeout, on the graph module exactly as built into the page: a hang fails the test
    // here instead of freezing the browser below
    const html = fs.readFileSync(PAGE, "utf8");
    const m0 = /<script data-hx-module="app\/35_graph\.js">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m0, "the page under test contains app/35_graph.js");
    const ctx = vm.createContext({});
    ctx.globalThis = ctx;
    vm.runInContext(m0[1], ctx);
    const cases = {
      long_literal: { initial: "A", terminals: [{ id: "T", kind: "verified" }], states: {
        A: { action: { kind: "tool", name: "t" }, transitions: [{ if: "review_reason == 'missing tax identification number'", to: "B" }] },
        B: { action: { kind: "end", terminal: "T" }, transitions: [] } } },
      long_identifier: { initial: "A", terminals: [{ id: "T", kind: "verified" }], states: {
        A: { action: { kind: "tool", name: "t" }, transitions: [{ if: "x == 1 and supplier_identification_number_from_registry == 'ACME Holdings International Limited'", to: "B" }] },
        B: { action: { kind: "end", terminal: "T" }, transitions: [] } } },
      end_initial: { initial: "A", terminals: [{ id: "T", kind: "verified" }], states: { A: { action: { kind: "end", terminal: "T" }, transitions: [] } } },
    };
    for (const [name, m] of Object.entries(cases)) {
      for (const compact of [false, true]) {
        ctx.__m = m; ctx.__o = { compact };
        let err = null;
        try { vm.runInContext("HXUI.graph.layout(__m, __o)", ctx, { timeout: 2000 }); } catch (e) { err = e.message; }
        assert.equal(err, null, `layout(${name}${compact ? ", compact" : ""}) must return quickly and not throw`);
      }
    }
  }
  {
    const r = await page.evaluate(() => {
      const two = (guard) => ({ initial: "A", terminals: [{ id: "T", kind: "verified" }, { id: "U", kind: "unverified" }], states: {
        A: { action: { kind: "tool", name: "t" }, transitions: [{ if: guard, to: "B" }, { if: "", to: "C" }] },
        B: { action: { kind: "end", terminal: "T" }, transitions: [] }, C: { action: { kind: "end", terminal: "U" }, transitions: [] } } });
      const guards = [
        "review_reason == 'missing tax identification number'",
        "doc_type == 'application/vnd.openxmlformats-officedocument'",
        "supplier_name == 'ACME Holdings International Limited'",
        "status == 'unbalanced and a very long literal that never closes",
        "a == 1 and " + "x".repeat(90) + " and b == 'c'",
        "x  and  y  or  'z z z z z z z z z z z z z z z z z z z z z z z z z z z z z'",
      ];
      // a seeded sample of odd guards, as in the review fuzzer
      let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const pick = (s) => s[Math.floor(rnd() * s.length)];
      for (let i = 0; i < 40; i++) {
        let g = "";
        const n = 1 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const q = pick("'\"");
          let lit = "";
          for (let j = Math.floor(rnd() * 60); j > 0; j--) lit += rnd() < 0.15 ? " " : pick("abcdefgh/.-_");
          g += (k ? pick([" and ", " or ", " "]) : "") + pick(["status", "x", "a_very_long_variable_name_for_testing"]) + " == " + q + lit + (rnd() < 0.1 ? "" : q);
        }
        guards.push(g);
      }
      // the review's regression case lays out in under 50ms (best of three, so a GC pause cannot fail it); every
      // other guard well under 250ms (a hang is unbounded, so the margin only absorbs a busy machine)
      const slow = [], threw = [];
      guards.forEach((g, gi) => {
        for (const compact of [false, true]) {
          let best = Infinity;
          for (let k = 0; k < (gi === 0 ? 3 : 1); k++) {
            const t0 = performance.now();
            try { HXUI.graph.layout(two(g), { compact }); } catch (e) { threw.push(g + " -> " + e.message); return; }
            best = Math.min(best, performance.now() - t0);
          }
          if (best > (gi === 0 ? 50 : 250)) slow.push(g + " (" + best.toFixed(0) + "ms)");
        }
      });
      const odd = {
        null: null, empty: {}, states_array: { states: [] }, no_action: { initial: "A", states: { A: { transitions: [{ if: "", to: "B" }] } } },
        cycle: { initial: "A", states: { A: { action: { kind: "tool", name: "x" }, transitions: [{ if: "", to: "B" }] }, B: { action: { kind: "tool", name: "y" }, transitions: [{ if: "", to: "A" }] } } },
        end_initial: { initial: "A", states: { A: { action: { kind: "end", terminal: "T" }, transitions: [] } }, terminals: [{ id: "T", kind: "verified" }] },
        missing_initial: { initial: "Z", states: { A: { action: { kind: "tool" }, transitions: [] } } },
        weird_types: { initial: 5, states: { A: { action: { kind: 7, name: {} }, transitions: [null, 3, { to: null, if: 9 }] } }, terminals: "x" },
      };
      const host = document.createElement("div");
      document.body.appendChild(host);
      for (const [k, m] of Object.entries(odd)) {
        for (const compact of [false, true, undefined]) {
          try {
            const v = HXUI.graph.create(host, m, { on_select: () => {}, compact });
            v.update({ current: "A", visited: [null, "x", 3, { from: "A" }, { from: "A", to: "B", edge: { index: 0 } }, { from: "A", to: "Q", edge: null }], status: 5, terminal: {} });
            v.update({});
            v.highlight(["A", null, 3]); v.highlight("A"); v.highlight([]);
            v.destroy();
          } catch (e) { threw.push(k + "/" + compact + " -> " + e.message); }
        }
      }
      host.remove();
      return { n: guards.length, slow, threw };
    });
    assert.deepEqual(r.threw, [], "layout() and create() never throw");
    assert.deepEqual(r.slow, [], "guards lay out quickly (a long literal used to hang the word wrap)");
  }

  /* ---------------- drawing: geometry invariants on the rendered SVG, both machines, normal and compact */
  const views = {};
  for (const [name, m] of Object.entries(machines)) {
    for (const compact of [false, true]) {
      const i = await page.evaluate(({ m, compact }) => __hxgt.mount(m, { title: "Graph test", compact }), { m, compact });
      const geo = await page.evaluate((i) => __hxgt.geometry(i), i);
      const tag = `${name}${compact ? " (compact)" : ""}`;
      assert.deepEqual(problems(geo, tag, compact), [], `${tag}: layout invariants`);
      assert.ok(geo.labels.length >= (compact ? 0 : 12), `${tag}: guard labels are drawn`);
      if (!compact) views[name] = i;
      else {
        views[name + "_compact"] = i;
        const r = await page.evaluate((i) => {
          const v = __hxgt.views[i].view;
          const svg = v.svg;
          return {
            hidden: [...v.root.querySelectorAll(".hxg-label")].every((l) => getComputedStyle(l).visibility === "hidden"),
            drawn_w: +svg.getAttribute("width"), layout_w: v.layout.width,
            id_px: parseFloat(getComputedStyle(svg.querySelector(".hxg-id")).fontSize),
            render: getComputedStyle(svg).textRendering,
          };
        }, i);
        assert.ok(r.hidden, `${tag}: compact hides edge labels at rest`);
        // every edge that has something to say (a guard, "else" beside guarded siblings, "+1 counter") has a placed
        // label in the compact layout, and hovering its state shows exactly that state's labels
        const lab = await page.evaluate(({ i, m }) => {
          const L = HXUI.graph.layout(m, { compact: true });
          const guarded = new Set(L.edges.filter((e) => e.cond).map((e) => e.from));
          const want = L.edges.filter((e) => e.cond || e.inc || guarded.has(e.from)).map((e) => e.key);
          const missing = want.filter((k) => !L.edges.find((e) => e.key === k).label);
          const v = __hxgt.views[i].view;
          const root = v.root;
          const hover = {};
          for (const st of new Set(want.map((k) => k.split("#")[0]))) {
            const g = root.querySelector(`.hxg-node[data-state="${st}"]:not([data-copy]) .hxg-box`);
            g.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            hover[st] = {
              shown: [...root.querySelectorAll(".hxg-label")].filter((l) => getComputedStyle(l).visibility === "visible").map((l) => l.getAttribute("data-key")).sort(),
              caption: root.querySelector(".hxg-caption").textContent,
            };
            g.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
          }
          return { want, missing, hover, edges: L.edges.map((e) => ({ key: e.key, from: e.from, cond: e.cond })) };
        }, { i, m });
        assert.ok(lab.want.length >= 14, `${tag}: guarded edges found (${lab.want.length})`);
        assert.deepEqual(lab.missing, [], `${tag}: every guarded edge has a label in the compact layout`);
        for (const [st, h] of Object.entries(lab.hover)) {
          const own = lab.want.filter((k) => k.startsWith(st + "#")).sort();
          assert.deepEqual(h.shown, own, `${tag}: hovering ${st} shows its guard labels`);
          for (const e of lab.edges.filter((x) => x.from === st && x.cond)) {
            assert.ok(h.caption.includes(e.cond), `${tag}: hovering ${st} lists the guard "${e.cond}" in the caption`);
          }
        }
        // full size at both widths: ids at 12px, pills and labels at 12px, never scaled below the type scale
        assert.equal(r.drawn_w, r.layout_w, `${tag}: the compact drawing is shown at full size (${r.drawn_w} of ${r.layout_w}px)`);
        assert.equal(r.id_px, 12, `${tag}: compact ids are 12px`);
        assert.equal(String(r.render).toLowerCase(), "geometricprecision", `${tag}: text keeps its exact advances when scaled`);
      }
    }
  }
  // stress machines: a back edge, a guarded shortcut into the verified terminal and a dangling target route
  // cleanly, every label sits next to its own edge and none hides another edge
  for (const [name, mk] of [["stress", stress_machine], ["dense", dense_machine]]) {
    const m = mk(machines.initial);
    const i = await page.evaluate((m) => __hxgt.mount(m, { compact: false }), m);
    const geo = await page.evaluate((i) => __hxgt.geometry(i), i);
    assert.deepEqual(problems(geo, name), [], `${name} machine: layout invariants`);
    if (name === "stress") {
      const vip = geo.labels.find((l) => l.key === "LOOKUP_SUPPLIER#1");
      assert.ok(vip, "stress machine: the guarded shortcut into the verified terminal shows its guard");
    }
  }

  /* ---------------- update(): current state, visited edges numbered in order, terminal colored by category */
  const css = await page.evaluate(() => {
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    document.querySelector("#hxg-test-root .hxg-svg").appendChild(probe);
    const out = {};
    for (const v of ["ok", "warn", "crit", "accent", "accent-tint", "graph-edge-faint", "hxg-edge-dim", "focus", "graph-bg", "graph-node", "ink-2", "ink-3"]) {
      probe.style.fill = `var(--${v})`;
      out[v] = getComputedStyle(probe).fill;
    }
    probe.remove();
    return out;
  });
  // the receding "not taken" shade stays visible (about 2.6:1 light, 3.6:1 dark) and well behind the accent path
  assert.ok(contrast(css["hxg-edge-dim"], css["graph-bg"]) >= 2.4, `"not taken" marks are too faint: ${contrast(css["hxg-edge-dim"], css["graph-bg"]).toFixed(2)}:1`);
  assert.ok(contrast(css.accent, css["graph-bg"]) >= 1.8 * contrast(css["hxg-edge-dim"], css["graph-bg"]), "the accent path stands well clear of the receding marks");
  async function show(viewIndex, snap) {
    await page.evaluate(({ i, snap }) => {
      __hxgt.views[i].view.update({ current: snap.state, visited: snap.transitions, status: snap.status, terminal: snap.terminal });
    }, { i: viewIndex, snap });
    await page.waitForTimeout(300); // let the (at most 150ms) style transitions settle
    return page.evaluate(({ i }) => {
      const { view } = __hxgt.views[i];
      const r = view.root;
      const svg = r.querySelector(".hxg-svg");
      const lens = {};
      for (const g of svg.querySelectorAll(".hxg-edge")) lens[g.getAttribute("data-key")] = g.querySelector(".hxg-line");
      const badges = [...svg.querySelectorAll(".hxg-badge")].map((b) => {
        const m = b.transform.baseVal.consolidate().matrix;
        const p = lens[b.getAttribute("data-key")];
        let near = Infinity;
        for (let d = 0, L = p.getTotalLength(); d <= L; d += 1) { const q = p.getPointAtLength(d); near = Math.min(near, Math.hypot(q.x - m.e, q.y - m.f)); }
        return { key: b.getAttribute("data-key"), text: b.querySelector("text").textContent.trim(), step: b.getAttribute("data-step"), near, x: m.e, y: m.f };
      });
      const vb = svg.viewBox.baseVal;
      const nodes = [...svg.querySelectorAll(".hxg-node")].map((g) => ({
        state: g.getAttribute("data-state"), copy: g.getAttribute("data-copy"), cls: g.getAttribute("class"),
        fill: getComputedStyle(g.querySelector(".hxg-box")).fill, stroke: getComputedStyle(g.querySelector(".hxg-box")).stroke,
        edges: (g.getAttribute("data-edges") || "").split(" ").filter(Boolean),
      }));
      const edges = [...svg.querySelectorAll(".hxg-edge")].map((g) => ({
        key: g.getAttribute("data-key"), visited: g.classList.contains("is-visited"), stroke: getComputedStyle(g.querySelector(".hxg-line")).stroke,
        dash: getComputedStyle(g.querySelector(".hxg-line")).strokeDasharray,
      }));
      const faint_marker = getComputedStyle(svg.querySelector(".hxg-marker--faint path")).fill;
      const tags = [...svg.querySelectorAll(".hxg-tag text")].map((g) => g.textContent.trim());
      const alt = r.querySelector(".hxg-sr .hxg-alt-run").textContent;
      const legend = r.querySelector(".hxg-legend");
      const first = legend ? legend.querySelector("li") : null;
      return { badges, nodes, edges, tags, alt, faint_marker, legend: legend ? !legend.hidden && getComputedStyle(legend).display !== "none" : null,
        legend_first: first && !first.hidden ? first.textContent : null,
        legend_sw: first ? getComputedStyle(first.querySelector(".hxg-sw")).backgroundColor : null,
        active: r.classList.contains("is-active"), vb: { w: vb.width, h: vb.height } };
    }, { i: viewIndex, snap });
  }
  function checkRun(name, r, snap, { compact = false } = {}) {
    const keys = snap.transitions.map((x) => `${x.from}#${x.edge}`);
    assert.ok(r.active, `${name}: graph shows a run`);
    if (!compact) {
      assert.equal(r.legend, true, `${name}: the legend is shown during a run`);
      // the legend names the mark that is drawn: never "current state" once the run has ended in an outcome
      assert.equal(r.legend_first, snap.terminal !== null ? "reached outcome" : "current state", `${name}: the legend's first entry`);
    }
    assert.equal(r.faint_marker, css["hxg-edge-dim"], `${name}: arrowheads of edges not taken use the receding shade`);
    // every visited transition is solid accent; the rest recedes
    for (const e of r.edges) {
      if (keys.includes(e.key)) {
        assert.ok(e.visited, `${name}: ${e.key} should be marked visited`);
        assert.equal(e.stroke, css.accent, `${name}: visited ${e.key} is drawn in the accent color`);
        assert.ok(e.dash === "none" || e.dash === "", `${name}: visited ${e.key} is solid`);
      } else {
        assert.ok(!e.visited, `${name}: ${e.key} should not be marked visited`);
        assert.equal(e.stroke, css["hxg-edge-dim"], `${name}: unvisited ${e.key} recedes`);
      }
    }
    // one badge per step, numbered in order, sitting on its transition
    const byStep = new Map(r.badges.map((b) => [b.text, b]));
    keys.forEach((k, i) => {
      const b = byStep.get(String(i + 1));
      assert.ok(b, `${name}: no badge for step ${i + 1}`);
      assert.equal(b.key, k, `${name}: step ${i + 1} badge is on ${b && b.key}, expected ${k}`);
      assert.ok(b.near < 1.5, `${name}: step ${i + 1} badge is ${b.near.toFixed(1)}px off its edge`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x <= r.vb.w && b.y <= r.vb.h, `${name}: badge ${i + 1} outside the viewBox`);
    });
    assert.equal(r.badges.length, keys.length, `${name}: badge count`);
    // the current state (or the reached terminal) is marked
    const done = snap.terminal !== null;
    const marked = r.nodes.filter((n) => /\bis-(current|reached)\b/.test(n.cls));
    assert.ok(marked.length === 1, `${name}: exactly one marked state, got ${marked.map((n) => n.state).join(", ")}`);
    assert.equal(marked[0].state, snap.terminal || snap.state, `${name}: marked state`);
    if (!done) {
      assert.match(marked[0].cls, /\bis-current\b/, `${name}: current state class`);
      if (!/^END|FALLBACK/.test(snap.state)) {
        assert.equal(marked[0].stroke, css.accent, `${name}: current state outlined in accent`);
        assert.equal(marked[0].fill, css["accent-tint"], `${name}: current state filled with accent tint`);
        // (the compact drawing has no room for a tag: its caption line carries the status)
        if (!compact) assert.ok(r.tags.length === 1 && /current|waiting/.test(r.tags[0]), `${name}: status tag, got ${r.tags}`);
      }
    }
    // the outcomes the run did not reach keep a visible outline
    for (const n of r.nodes.filter((x) => /\bhxg-term\b/.test(x.cls) && /\bis-faint\b/.test(x.cls))) {
      assert.equal(n.stroke, css["hxg-edge-dim"], `${name}: unreached outcome ${n.state} keeps the receding outline`);
    }
    assert.ok(r.alt.includes(snap.state), `${name}: text alternative names the current state`);
    return marked[0];
  }

  // at rest: no run marks, and no legend for marks that are not on screen
  {
    const rest = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      const legend = r.querySelector(".hxg-legend");
      const meta = r.querySelector(".hxg-meta");
      return { legend_hidden: legend.hidden && getComputedStyle(legend).display === "none", meta_code: meta.querySelector("code.hxg-code")?.textContent || null, meta: meta.textContent };
    }, views.initial);
    assert.ok(rest.legend_hidden, "the legend is hidden while no run is shown");
    assert.equal(rest.meta_code, machines.initial.initial, "the meta line sets the initial state id in mono");
    assert.match(rest.meta, /^12 states · 18 transitions · starts at READ_INTAKE$/, "meta line text");
  }
  // happy path, waiting for approval
  const hp = FX.runs.happy_path.snapshots;
  const wait = hp.find((s) => s.status === "WAITING_FOR_APPROVAL");
  checkRun("happy_path (waiting)", await show(views.initial, wait), wait);
  // happy path, completed: the verified terminal is filled in its category color
  {
    const end = hp[hp.length - 1];
    const r = await show(views.initial, end);
    const m = checkRun("happy_path (completed)", r, end);
    assert.match(m.cls, /\bis-reached\b/, "verified terminal is reached");
    assert.equal(r.legend_sw, css.ok, "the legend's outcome swatch takes the reached category's color");
    assert.equal(m.fill, css.ok, "verified terminal is colored ok");
  }
  // registry conflict: the fallback stub next to LOOKUP_SUPPLIER is reached, colored crit
  {
    const snaps = FX.runs.registry_conflict.snapshots;
    const end = snaps[snaps.length - 1];
    const m = checkRun("registry_conflict", await show(views.initial, end), end);
    assert.ok(m.edges.includes("LOOKUP_SUPPLIER#1"), "the reached fallback pill is the one next to LOOKUP_SUPPLIER");
    assert.equal(m.fill, css.crit, "fallback terminal is colored crit");
  }
  // repairs exhausted: the repair loop edge is traversed twice and shows both step numbers
  {
    const snaps = FX.runs.repairs_exhausted.snapshots;
    const end = snaps[snaps.length - 1];
    const r = await show(views.initial, end);
    const m = checkRun("repairs_exhausted", r, end);
    assert.equal(m.fill, css.warn, "unverified terminal is colored warn");
    assert.ok(m.edges.includes("VALIDATE_DRAFT#2"), "the reached unverified pill is the one next to VALIDATE_DRAFT");
    const loop = r.badges.filter((b) => b.key === "VALIDATE_DRAFT#1").map((b) => b.text);
    assert.deepEqual(loop, ["4", "6"], "loop edge traversed twice shows both numbers");
  }
  // read-back retry: the self-loop is numbered too
  {
    const snaps = FX.runs.readback_retry.snapshots;
    const mid = snaps.find((s) => s.transitions.some((x) => x.from === "READ_BACK" && x.to === "READ_BACK"));
    const r = await show(views.initial, mid);
    checkRun("readback_retry", r, mid);
  }
  // missing documents on the refined machine: waiting for input, then completed
  {
    const snaps = FX.runs.missing_documents.snapshots;
    const w = snaps.find((s) => s.status === "WAITING_FOR_INPUT");
    checkRun("missing_documents (waiting)", await show(views.refined, w), w);
    const end = snaps[snaps.length - 1];
    checkRun("missing_documents (completed)", await show(views.refined, end), end);
  }
  // the compact drawing shows runs the same way (and its caption names the state)
  {
    const r = await show(views.initial_compact, wait);
    checkRun("happy_path (waiting, compact)", r, wait, { compact: true });
    const cap = await page.evaluate((i) => __hxgt.views[i].view.root.querySelector(".hxg-caption").textContent, views.initial_compact);
    assert.equal(cap, "Current state REQUEST_APPROVAL · waiting for approval · 6 steps", "the compact caption carries the run status");
    await page.evaluate((i) => __hxgt.views[i].view.update({}), views.initial_compact);
  }
  // update() with no run returns the drawing to rest; geometry stays valid with badges drawn
  {
    const end = FX.runs.repairs_exhausted.snapshots.at(-1);
    await show(views.initial, end);
    const geo = await page.evaluate((i) => __hxgt.geometry(i), views.initial);
    assert.deepEqual(problems(geo, "initial during a run"), [], "invariants hold while a run is shown");
    const rest = await page.evaluate((i) => {
      const { view } = __hxgt.views[i];
      view.update({ current: null, visited: [], status: null, terminal: null });
      const r = view.root;
      return { active: r.classList.contains("is-active"), badges: r.querySelectorAll(".hxg-badge").length,
        marked: r.querySelectorAll(".is-current, .is-reached, .is-visited, .is-faint").length, legend: r.querySelector(".hxg-legend").hidden };
    }, views.initial);
    assert.deepEqual(rest, { active: false, badges: 0, marked: 0, legend: true }, "update() with an empty run clears the marking and the legend");
  }

  /* ---------------- motion: transitions are at most 150ms and switch off under reduced motion */
  {
    const durations = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      const out = [];
      for (const sel of [".hxg-line", ".hxg-box", ".hxg-label-text", ".hxg-node"]) {
        const el = r.querySelector(sel);
        for (const d of getComputedStyle(el).transitionDuration.split(",")) out.push(parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000));
      }
      return out;
    }, views.initial);
    assert.ok(durations.every((d) => d <= 150), `transitions longer than 150ms: ${durations}`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      return [".hxg-line", ".hxg-box", ".hxg-node"].map((sel) => getComputedStyle(r.querySelector(sel)).transitionDuration);
    }, views.initial);
    assert.ok(reduced.every((d) => d.split(",").every((x) => parseFloat(x) === 0)), `transitions under reduced motion: ${reduced}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }

  /* ---------------- highlight(): a dashed accent ring; the rest steps back in color, every text stays readable */
  {
    await page.evaluate((i) => __hxgt.views[i].view.highlight(["VALIDATE_DRAFT", "REPAIR_DRAFT", "END_UNVERIFIED"]), views.initial);
    await page.waitForTimeout(300);
    const r = await page.evaluate((i) => {
      const { view } = __hxgt.views[i];
      const root = view.root;
      const on = [...root.querySelectorAll(".hxg-node.is-highlight")].map((g) => g.getAttribute("data-state"));
      const has = root.classList.contains("has-highlight");
      const ring = getComputedStyle(root.querySelector('.hxg-node[data-state="VALIDATE_DRAFT"] .hxg-ring')).stroke;
      const opacities = [...root.querySelectorAll(".hxg-node, .hxg-edge, .hxg-label")].map((g) => getComputedStyle(g).opacity).filter((o) => o !== "1");
      const other = root.querySelector('.hxg-node[data-state="READ_INTAKE"]');
      const texts = {
        id: getComputedStyle(other.querySelector(".hxg-id")).fill,
        kind: getComputedStyle(other.querySelector(".hxg-kind")).fill,
        detail: getComputedStyle(other.querySelector(".hxg-detail")).fill,
        label: getComputedStyle(root.querySelector('.hxg-label[data-key="READ_INTAKE#0"] .hxg-label-text')).fill,
        pill: getComputedStyle(root.querySelector('.hxg-node[data-state="FALLBACK"] .hxg-cat')).fill,
        pill_bg: getComputedStyle(root.querySelector('.hxg-node[data-state="FALLBACK"] .hxg-box')).fill,
        edge: getComputedStyle(root.querySelector('.hxg-edge[data-key="READ_INTAKE#0"] .hxg-line')).stroke,
      };
      view.highlight([]);
      return { on, has, ring, opacities, texts, after: root.querySelectorAll(".hxg-node.is-highlight").length, hasAfter: root.classList.contains("has-highlight") };
    }, views.initial);
    assert.ok(r.has, "highlight() marks the graph");
    assert.deepEqual([...new Set(r.on)].sort(), ["END_UNVERIFIED", "REPAIR_DRAFT", "VALIDATE_DRAFT"], "highlight() marks exactly the given states");
    assert.equal(r.on.filter((x) => x === "END_UNVERIFIED").length, 5, "every drawn copy of a terminal is highlighted");
    assert.equal(r.ring, css.accent, "highlighted states get an accent ring");
    assert.deepEqual(r.opacities, [], "highlight() never dims through opacity");
    assert.equal(r.texts.edge, css["hxg-edge-dim"], "edges step back in color");
    for (const [k, bg] of [["id", "graph-node"], ["kind", "graph-node"], ["detail", "graph-node"], ["label", "graph-bg"]]) {
      const c = contrast(r.texts[k], css[bg]);
      assert.ok(c >= 4.5, `under highlight() the ${k} text of a state that steps back is ${c.toFixed(2)}:1`);
    }
    assert.ok(contrast(r.texts.pill, r.texts.pill_bg) >= 4.5, "under highlight() pill text stays readable");
    assert.equal(r.after, 0, "highlight([]) clears");
    assert.ok(!r.hasAfter, "highlight([]) clears the graph mark");
  }

  /* ---------------- Tab stops: the <svg> is never one; a graph is at most one stop, and only when it does something */
  async function tab_through(i) {
    await page.focus(`#hxgt-before-${i}`);
    const seq = [];
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => __hxgt.focused());
      seq.push(f);
      if (f.what === "id" && f.id === `hxgt-after-${i}`) break;
    }
    return seq;
  }
  {
    // selectable: Tab lands on the roving state, the next Tab leaves the graph
    const i = await page.evaluate((m) => __hxgt.mount(m, { title: "Selectable", select: true }), machines.refined);
    await frames();
    const seq = await tab_through(i);
    assert.equal(seq.length, 2, `selectable graph: two Tabs from the button before reach the button after (${JSON.stringify(seq)})`);
    assert.deepEqual(seq[0], { what: "state", state: "READ_INTAKE", role: "button" }, "selectable graph: Tab lands on the first state");
    // compact, not selectable: the states are still one Tab stop, focus fills the caption and shows the guards
    const c = await page.evaluate((m) => __hxgt.mount(m, { compact: true }), machines.initial);
    await frames();
    const cseq = await tab_through(c);
    assert.equal(cseq.length, 2, `compact graph: one Tab stop (${JSON.stringify(cseq)})`);
    assert.deepEqual(cseq[0], { what: "state", state: "READ_INTAKE", role: "img" }, "compact graph: Tab lands on the first state");
    await page.focus(`#hxgt-after-${c}`);
    await page.keyboard.press("Shift+Tab");
    // reading order: READ_INTAKE, then its "unverified" pill (the stand-in for END_UNVERIFIED), then LOOKUP_SUPPLIER
    await page.keyboard.press("ArrowDown");
    const mid = await page.evaluate(() => document.activeElement.getAttribute("data-state"));
    assert.equal(mid, "END_UNVERIFIED", "compact graph: the arrow keys follow reading order");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300); // let the ring's (at most 150ms) transition settle
    const cf = await page.evaluate((i) => {
      const v = __hxgt.views[i].view;
      const f = document.activeElement;
      return {
        focused: f.getAttribute("data-state"), caption: v.root.querySelector(".hxg-caption").textContent,
        shown: [...v.root.querySelectorAll(".hxg-label.is-shown")].map((l) => l.getAttribute("data-key")),
        ring: getComputedStyle(f.querySelector(".hxg-ring")).stroke, label: f.getAttribute("aria-label"),
      };
    }, c);
    assert.equal(cf.focused, "LOOKUP_SUPPLIER", "compact graph: the arrow keys move between states");
    // focus is a deliberate request: the caption lists every transition with its full guard, one per line
    assert.equal(cf.caption, "LOOKUP_SUPPLIER: tool · supplier.lookup→ EXTRACT_DRAFT if lookup_status in ['new', 'exists_compatible']→ FALLBACK otherwise",
      "compact graph: focus fills the caption with the state's transitions and guards");
    assert.equal(cf.ring, css.focus, "compact graph: the focused state shows a ring in the focus color");
    // the pointer reads the state with its guards too and never pushes the page around (the caption reserves the
    // lines of the longest reading); leaving returns to the focused state
    const hov = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      const cap = r.querySelector(".hxg-caption");
      const g = r.querySelector('.hxg-node[data-state="PERSIST_DRAFT"] .hxg-box');
      const h0 = cap.getBoundingClientRect().height;
      g.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      const over = { text: cap.textContent, h: cap.getBoundingClientRect().height };
      g.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      return { over, back: cap.textContent, h0, line: parseFloat(getComputedStyle(cap).lineHeight) };
    }, c);
    assert.equal(hov.over.text, "PERSIST_DRAFT: tool · erp.create_draft→ READ_BACK if persist_status in ['created', 'existing']→ FALLBACK otherwise",
      "compact graph: hovering a state lists its transitions and guards");
    assert.ok(Math.abs(hov.over.h - hov.h0) < 0.5, `compact graph: hovering does not change the caption's height (${hov.h0} -> ${hov.over.h})`);
    assert.equal(hov.back, cf.caption, "compact graph: when the pointer leaves, the focused state's details return");
    assert.match(cf.label, /lookup_status in \['new', 'exists_compatible'\]/, "compact graph: the focused state's name carries its guards");
    assert.ok(cf.shown.every((k) => k.startsWith("LOOKUP_SUPPLIER#")), "compact graph: only the focused state's guards are shown");
    await page.keyboard.press("Tab");
    // a short window (a phone in landscape, or with the keyboard up): focusing or tapping a state near the top keeps
    // the caption on screen (it is a sticky bar at the bottom of the frame)
    {
      const vp = page.viewportSize();
      await page.setViewportSize({ width: vp.width, height: 420 });
      const s = await page.evaluate((m) => __hxgt.mount(m, { compact: true }), machines.refined);
      await frames();
      const r = await page.evaluate(async (i) => {
        const v = __hxgt.views[i].view;
        v.root.scrollIntoView({ block: "start" });
        const g = v.root.querySelector('.hxg-node[data-state="READ_INTAKE"]');
        g.focus({ preventScroll: true });
        await __hxgt.frames(2);
        const cap = v.root.querySelector(".hxg-caption").getBoundingClientRect();
        const svg = v.svg.getBoundingClientRect();
        const box = g.getBoundingClientRect();
        // the caption bar covers no more than the lower part of the drawing, and never the focused state
        return { cap_top: cap.top, cap_bottom: cap.bottom, vh: innerHeight, svg_bottom: svg.bottom, text: v.root.querySelector(".hxg-caption").textContent,
          box_bottom: box.bottom, bg: getComputedStyle(v.root.querySelector(".hxg-caption")).backgroundColor };
      }, s);
      await page.evaluate((i) => document.activeElement && document.activeElement.blur(), s);
      await page.setViewportSize(vp);
      assert.ok(r.svg_bottom > r.vh, "short window: the compact drawing is taller than the window (the case under test)");
      assert.ok(r.cap_top >= 0 && r.cap_bottom <= r.vh + 0.5, `short window: the caption stays on screen (${r.cap_top}..${r.cap_bottom} of ${r.vh})`);
      assert.ok(r.text.startsWith("READ_INTAKE: tool"), `short window: the caption reads the focused state (${r.text})`);
      assert.ok(r.box_bottom <= r.cap_top, "short window: the caption never covers the focused state");
      assert.equal(r.bg, css["graph-bg"], "short window: the caption bar is opaque (the canvas color)");
    }
    // the full drawing, not selectable: no stop at all while it fits; one stop (the canvas region) while it overflows
    const n = await page.evaluate((m) => __hxgt.mount(m, { compact: false }), machines.initial);
    await frames();
    const nseq = await tab_through(n);
    const over = await page.evaluate((i) => { const c = __hxgt.views[i].view.root.querySelector(".hxg-canvas"); return c.scrollWidth > c.clientWidth + 1; }, n);
    assert.equal(over, narrow, `the full drawing overflows only at 400px`);
    if (!over) assert.deepEqual(nseq, [{ what: "id", id: `hxgt-after-${n}` }], "a full drawing that fits is no Tab stop");
    else {
      assert.equal(nseq.length, 2, `an overflowing full drawing is one Tab stop (${JSON.stringify(nseq)})`);
      assert.deepEqual(nseq[0], { what: "canvas", role: "region", label: "Graph drawing, scrolls sideways" }, "the overflowing canvas is a labelled region");
      await page.keyboard.press("Shift+Tab");
      const ring = await page.evaluate((i) => {
        const fr = __hxgt.views[i].view.root.querySelector(".hxg-frame");
        const cs = getComputedStyle(fr);
        return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, focused: document.activeElement === fr.firstElementChild };
      }, n);
      assert.ok(ring.focused && ring.style === "solid" && ring.width === "2px", `the focused canvas shows a 2px ring on its frame (${JSON.stringify(ring)})`);
      await page.keyboard.press("Tab");
    }
    const svg_focus = await page.evaluate(() => [...document.querySelectorAll(".hxg-svg")].some((s) => s.tabIndex >= 0 || s.matches(":focus")));
    assert.ok(!svg_focus, "no <svg> is focusable");
  }

  /* ---------------- selection: focusable nodes, aria-labels, Enter / Space / arrows, text alternative */
  {
    const i = await page.evaluate((m) => __hxgt.mount(m, { title: "Selectable", select: true, compact: false }), machines.refined);
    const info = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      const svg = r.querySelector(".hxg-svg");
      const buttons = [...svg.querySelectorAll('.hxg-node[role="button"]')];
      const alt = r.querySelector(".hxg-sr");
      const names = [r.getAttribute("aria-label") || (document.getElementById(r.getAttribute("aria-labelledby")) || {}).textContent,
        svg.getAttribute("aria-label"), r.querySelector(".hxg-canvas").getAttribute("aria-label")];
      return {
        n: buttons.length, states: buttons.map((b) => b.getAttribute("data-state")),
        tabbable: buttons.filter((b) => b.getAttribute("tabindex") === "0").length,
        focusable: buttons.every((b) => b.hasAttribute("tabindex")),
        labels: buttons.map((b) => b.getAttribute("aria-label") || ""),
        copiesHidden: [...svg.querySelectorAll(".hxg-node[data-copy]")].filter((g) => g.getAttribute("data-copy") !== "0").every((g) => g.getAttribute("aria-hidden") === "true"),
        altItems: alt ? [...alt.querySelectorAll("li")].map((li) => li.textContent) : [],
        altIntro: alt ? alt.querySelector("p").textContent : "",
        altHidden: alt ? getComputedStyle(alt).clipPath !== "none" || alt.getBoundingClientRect().width <= 1 : false,
        names, role: svg.getAttribute("role"),
      };
    }, i);
    const ids = Object.keys(machines.refined.states);
    assert.equal(info.n, ids.length, "one button per state (terminal copies share one)");
    assert.deepEqual([...info.states].sort(), [...ids].sort(), "every state is selectable");
    assert.equal(info.tabbable, 1, "one tab stop into the graph (roving tabindex)");
    assert.ok(info.focusable, "every state is focusable");
    assert.ok(info.copiesHidden, "extra terminal copies are hidden from assistive technology");
    assert.equal(info.role, "group", "the drawing of a selectable graph is a group of buttons");
    assert.deepEqual(info.names, ["Selectable", null, null], "only the figure is named");
    const ri = info.labels[info.states.indexOf("READ_INTAKE")];
    assert.match(ri, /READ_INTAKE/, "aria-label names the state");
    assert.match(ri, /documents\.read/, "aria-label names the action");
    assert.match(ri, /initial state/, "aria-label says it is the initial state");
    assert.match(ri, /docs_status == 'available'/, "aria-label lists the guards");
    assert.match(info.labels[info.states.indexOf("END_UNVERIFIED")], /unverified/, "terminal aria-label names its category");
    assert.equal(info.altItems.length, ids.length, "text alternative lists every state");
    assert.ok(info.altItems.some((s) => /VALIDATE_DRAFT/.test(s) && /repair_count < 2/.test(s) && /REPAIR_DRAFT/.test(s)), "text alternative lists transitions with guards");
    assert.match(info.altIntro, /arrow keys/, "text alternative explains the keyboard");
    assert.ok(!/Selectable/.test(info.altIntro), "text alternative does not repeat the name");
    assert.ok(info.altHidden, "text alternative is visually hidden");
    // keyboard
    await page.evaluate((i) => __hxgt.views[i].view.root.querySelector('.hxg-node[tabindex="0"]').focus(), i);
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const after = await page.evaluate((i) => {
      const v = __hxgt.views[i];
      const f = document.activeElement;
      return { calls: v.calls.slice(), focused: f && f.getAttribute("data-state"), ring: f ? getComputedStyle(f.querySelector(".hxg-ring")).stroke : "" };
    }, i);
    const order = info.states;
    assert.deepEqual(after.calls, [order[0], order[1], order[order.length - 1]], "Enter and Space select; arrows and End move focus");
    assert.equal(after.focused, order[order.length - 1], "focus follows the arrow keys");
    assert.equal(after.ring, css.focus, "the focused state shows a ring in the focus color");
    // click on a terminal copy selects the terminal state
    await page.evaluate((i) => {
      const g = __hxgt.views[i].view.root.querySelector('.hxg-node[data-state="END_UNVERIFIED"][data-copy="2"]');
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, i);
    const calls = await page.evaluate((i) => __hxgt.views[i].calls.slice(), i);
    assert.equal(calls[calls.length - 1], "END_UNVERIFIED", "clicking any copy of a terminal selects that state");
    // a drawing without focusable states is hidden from assistive technology; the text alternative stands in
    const plain = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      return { hidden: r.querySelector(".hxg-svg").getAttribute("aria-hidden"), alt: !!r.querySelector(".hxg-canvas .hxg-sr li") };
    }, views.initial);
    assert.deepEqual(plain, { hidden: "true", alt: true }, "a plain full drawing is aria-hidden and its canvas holds the text alternative");
  }

  /* ---------------- "auto" (the default): the full drawing while it fits, the compact one when it does not */
  {
    const i = await page.evaluate((m) => __hxgt.mount(m, { title: "Auto", select: true }), machines.initial);
    await frames();
    const r = await page.evaluate((i) => {
      const v = __hxgt.views[i].view;
      const c = v.root.querySelector(".hxg-canvas");
      return { compact: v.compact, over: c.scrollWidth > c.clientWidth + 1, caption: !v.root.querySelector(".hxg-caption").hidden };
    }, i);
    assert.equal(r.compact, narrow, `auto draws ${narrow ? "compact" : "the full machine"} at ${t.viewport.width}px`);
    assert.ok(!r.over, "the auto drawing fits without scrolling");
    assert.equal(r.caption, narrow, "the caption line comes with the compact drawing");
    if (!narrow) {
      // narrowing the host redraws compact and keeps the run, the highlight and keyboard focus; widening returns
      const snap = FX.runs.happy_path.snapshots.find((s) => s.status === "WAITING_FOR_APPROVAL");
      await page.evaluate(({ i, snap }) => {
        const v = __hxgt.views[i].view;
        v.update({ current: snap.state, visited: snap.transitions, status: snap.status, terminal: snap.terminal });
        v.highlight(["REPAIR_DRAFT"]);
        v.root.querySelector('.hxg-node[data-state="REQUEST_APPROVAL"]').focus();
        __hxgt.views[i].gh.style.width = "380px";
      }, { i, snap });
      await frames(4);
      const s = await page.evaluate((i) => {
        const v = __hxgt.views[i].view;
        return { compact: v.compact, badges: v.root.querySelectorAll(".hxg-badge").length, current: v.root.querySelector(".hxg-node.is-current")?.getAttribute("data-state"),
          hl: [...v.root.querySelectorAll(".hxg-node.is-highlight")].map((g) => g.getAttribute("data-state")), focused: document.activeElement.getAttribute("data-state"),
          in_svg: v.svg.contains(document.activeElement), svgs: v.root.querySelectorAll("svg").length };
      }, i);
      assert.deepEqual(s, { compact: true, badges: snap.transitions.length, current: "REQUEST_APPROVAL", hl: ["REPAIR_DRAFT"], focused: "REQUEST_APPROVAL", in_svg: true, svgs: 1 },
        "a narrow host redraws compact with the same run, highlight and focus");
      await page.evaluate((i) => { __hxgt.views[i].gh.style.width = ""; }, i);
      await frames(4);
      const back = await page.evaluate((i) => __hxgt.views[i].view.compact, i);
      assert.equal(back, false, "a wide host returns to the full drawing");
    }
  }

  /* ---------------- the full drawing scrolls inside its own container; the page never does */
  {
    const fresh = await page.evaluate((m) => __hxgt.mount(m, { compact: false }), machines.initial);
    views.fresh = fresh;
    await frames();
    const r = await page.evaluate((i) => {
      const c = __hxgt.views[i].view.root.querySelector(".hxg-canvas");
      return { sw: c.scrollWidth, cw: c.clientWidth, ox: getComputedStyle(c).overflowX, page: document.documentElement.scrollWidth - window.innerWidth,
        start: c.getAttribute("data-scroll-start"), end: c.getAttribute("data-scroll-end"), mask: getComputedStyle(c).maskImage || getComputedStyle(c).webkitMaskImage,
        left: c.scrollLeft };
    }, views.fresh);
    assert.ok(r.page <= 1, `page scrolls sideways by ${r.page}px`);
    assert.equal(r.ox, "auto", "the canvas scrolls sideways");
    if (narrow) {
      assert.ok(r.sw > r.cw + 1, `at ${t.viewport.width}px the full drawing scrolls inside its container (${r.sw} vs ${r.cw})`);
      assert.equal(r.end, "more", "the side with more drawing fades out");
      assert.ok(r.mask && r.mask !== "none", "the fade is drawn");
      // at rest the spine column starts at the left edge, whole, with its guards to its right
      const spine_x = await page.evaluate((i) => { const v = __hxgt.views[i].view; return v.layout.nodes.find((n) => n.id === v.layout.spine[0]).x; }, views.fresh);
      assert.ok(Math.abs(r.left - (spine_x - 16)) <= 1, `at rest the canvas shows the spine just inside its 16px edge fade (scrollLeft ${r.left}, spine at ${spine_x})`);
      await page.evaluate((i) => { const c = __hxgt.views[i].view.root.querySelector(".hxg-canvas"); c.scrollLeft = c.scrollWidth; }, views.fresh);
      await frames(2);
      const e2 = await page.evaluate((i) => { const c = __hxgt.views[i].view.root.querySelector(".hxg-canvas"); return [c.getAttribute("data-scroll-start"), c.getAttribute("data-scroll-end")]; }, views.fresh);
      assert.deepEqual(e2, ["more", "edge"], "scrolled to the end, only the start fades");
    } else {
      assert.ok(r.sw <= r.cw + 1, `at ${t.viewport.width}px the graph fits its container (${r.sw} vs ${r.cw})`);
      assert.deepEqual([r.start, r.end], [null, null], "no fades when the drawing fits");
    }
  }

  /* ---------------- destroy() */
  {
    const r = await page.evaluate(() => {
      const v = __hxgt.views.at(-1);
      v.view.destroy();
      return v.gh.children.length;
    });
    assert.equal(r, 0, "destroy() removes the drawing");
  }

  /* ---------------- source rules: tokens only, no innerHTML, no storage, no network, no dialogs */
  for (const f of ["app/35_graph.js", "app/35_graph.css"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, `${f}: literal hex color`);
    assert.doesNotMatch(src, /\b(rgba?|hsla?|oklch|lab|lch)\(/, `${f}: literal color function`);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${f}: HTML injection`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|\balert\(|\bconfirm\(|\bprompt\(|window\.print/, `${f}: forbidden API`);
    assert.doesNotMatch(src, /\son[a-z]+=/, `${f}: inline event handler attribute`);
  }
}
