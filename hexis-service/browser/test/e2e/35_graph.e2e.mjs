// HXUI.graph (app/35_graph.js): layout invariants on both Python-built machines, run marking from the Python run
// snapshots in golden/ui_fixtures.json, highlight(), keyboard selection, the text alternative and sideways scrolling.
// Works with a graph-only build (no boot script: python build.py --app-prefixes 00,35) and with the full app.
import fs from "node:fs";
import path from "node:path";
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
  mount(machine, opts) {
    const host = document.createElement("div");
    host.className = "hxg-test-host";
    this.root().appendChild(host);
    const calls = [];
    const o = Object.assign({}, opts || {});
    if (o.select) { delete o.select; o.on_select = (id) => calls.push(id); }
    const view = HXUI.graph.create(host, machine, o);
    this.views.push({ view, host, calls });
    return this.views.length - 1;
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
    const nodes = [...svg.querySelectorAll(".hxg-node")].map((g) => {
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
};
`;

function problems(geo, name) {
  const out = [];
  const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (b, p, m) => p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m;
  const within = (b, vb) => b.x >= vb.x - 0.5 && b.y >= vb.y - 0.5 && b.x + b.w <= vb.x + vb.w + 0.5 && b.y + b.h <= vb.y + vb.h + 0.5;
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
  // edges: inside the viewBox, never through a node other than their own two ends
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
    // it leaves its source at the border and ends at its target's border
    const first = e.pts[0], last = e.pts[e.pts.length - 1];
    const onBorder = (b, p) => inside(b, p, 1.5) && !inside(b, p, -1.5);
    if (!onBorder(src.box, first)) out.push(`${name}: edge ${e.key} does not start on ${nm(src)}'s border`);
    if (!onBorder(dst.box, last)) out.push(`${name}: edge ${e.key} does not end on ${nm(dst)}'s border`);
  }
  // labels: inside the viewBox, clear of every node and of each other, text inside the label
  for (let i = 0; i < geo.labels.length; i++) {
    const l = geo.labels[i];
    if (!within(l.box, geo.vb)) out.push(`${name}: label ${l.key} lies outside the viewBox`);
    for (const n of geo.nodes) if (ov(l.box, n.box)) out.push(`${name}: label ${l.key} overlaps node ${nm(n)}`);
    for (let j = i + 1; j < geo.labels.length; j++) if (ov(l.box, geo.labels[j].box)) out.push(`${name}: labels ${l.key} and ${geo.labels[j].key} overlap`);
    if (l.text.x < l.box.x - 0.5 || l.text.x + l.text.w > l.box.x + l.box.w + 0.5) out.push(`${name}: label ${l.key} text is wider than its box`);
  }
  return out;
}

export default async function (t) {
  const { page, assert } = t;
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForFunction(() => globalThis.HXUI && HXUI.graph && typeof HXUI.graph.create === "function", null, { timeout: 15000 });
  // with the full app in the build, let boot finish first so it never races the checks below
  const booting = await page.evaluate(() => !!document.querySelector('script[data-hx-module="app/90_boot.js"]'));
  if (booting) await page.waitForFunction(() => document.getElementById("app")?.dataset.boot !== "pending", null, { timeout: 15000 });
  await page.evaluate(IN_PAGE);

  const machines = { initial: FX.packages.initial.machine, refined: FX.packages.refined.machine };

  /* ---------------- layout: pure, deterministic, independent of key order, API shape */
  for (const [name, m] of Object.entries(machines)) {
    const r = await page.evaluate((m) => {
      const a = HXUI.graph.layout(m), b = HXUI.graph.layout(JSON.parse(JSON.stringify(m)));
      const rev = JSON.parse(JSON.stringify(m));
      rev.states = Object.fromEntries(Object.entries(rev.states).reverse());
      const c = HXUI.graph.layout(rev);
      return { a, same: JSON.stringify(a) === JSON.stringify(b), keyfree: JSON.stringify(a) === JSON.stringify(c), untouched: JSON.stringify(m) };
    }, m);
    assert.ok(r.same, `${name}: two layout() calls differ`);
    assert.ok(r.keyfree, `${name}: layout() depends on the key order of machine.states`);
    assert.equal(r.untouched, JSON.stringify(m), `${name}: layout() modified the machine`);
    const L = r.a;
    assert.ok(L.width > 0 && L.height > 0, `${name}: empty layout`);
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
    }
    // the main success path runs down one straight column
    const spine = L.spine.map((id) => L.nodes.find((n) => n.id === id));
    assert.equal(L.spine[0], m.initial, `${name}: the spine starts at the initial state`);
    assert.equal(L.spine[L.spine.length - 1], "END_VERIFIED_DRAFT", `${name}: the spine ends at the verified terminal`);
    for (const n of spine) assert.ok(Math.abs(n.x + n.w / 2 - (spine[0].x + spine[0].w / 2)) < 0.6, `${name}: ${n.id} is off the main column`);
  }

  /* ---------------- drawing: geometry invariants on the rendered SVG, both machines, normal and compact */
  const views = {};
  for (const [name, m] of Object.entries(machines)) {
    for (const compact of [false, true]) {
      const i = await page.evaluate(({ m, compact }) => __hxgt.mount(m, { title: "Graph test", compact }), { m, compact });
      const geo = await page.evaluate((i) => __hxgt.geometry(i), i);
      const tag = `${name}${compact ? " (compact)" : ""}`;
      assert.deepEqual(problems(geo, tag), [], `${tag}: layout invariants`);
      assert.ok(geo.labels.length >= (compact ? 0 : 12), `${tag}: guard labels are drawn`);
      if (!compact) views[name] = i;
      else {
        const hidden = await page.evaluate((i) => {
          const r = __hxgt.views[i].view.root;
          return [...r.querySelectorAll(".hxg-label")].every((l) => getComputedStyle(l).visibility === "hidden");
        }, i);
        assert.ok(hidden, `${tag}: compact hides edge labels at rest`);
      }
    }
  }
  // a stress machine: a back edge, a shortcut into the verified terminal and a dangling target still route cleanly
  {
    const m = JSON.parse(JSON.stringify(machines.initial));
    m.states.READ_BACK.transitions.splice(2, 0, { if: "readback_status == 'stale'", to: "VALIDATE_DRAFT", inc: null, support: 0, origin: "" });
    m.states.LOOKUP_SUPPLIER.transitions.splice(1, 0, { if: "lookup_status == 'vip'", to: "END_VERIFIED_DRAFT", inc: null, support: 0, origin: "" });
    m.states.REPAIR_DRAFT.transitions.push({ if: "", to: "NOT_A_STATE", inc: null, support: 0, origin: "" });
    m.states.REPAIR_DRAFT.transitions[0].if = "draft != None";
    const i = await page.evaluate((m) => __hxgt.mount(m, {}), m);
    const geo = await page.evaluate((i) => __hxgt.geometry(i), i);
    assert.deepEqual(problems(geo, "mutated"), [], "mutated machine: layout invariants");
  }

  /* ---------------- update(): current state, visited edges numbered in order, terminal colored by category */
  const css = await page.evaluate(() => {
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    document.querySelector(".hxg-svg").appendChild(probe);
    const out = {};
    for (const v of ["ok", "warn", "crit", "accent", "accent-tint", "graph-edge-faint", "focus"]) {
      probe.style.fill = `var(--${v})`;
      out[v] = getComputedStyle(probe).fill;
    }
    probe.remove();
    return out;
  });
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
      const tags = [...svg.querySelectorAll(".hxg-tag text")].map((g) => g.textContent.trim());
      const alt = r.querySelector(".hxg-sr .hxg-alt-run").textContent;
      return { badges, nodes, edges, tags, alt, active: r.classList.contains("is-active"), vb: { w: vb.width, h: vb.height } };
    }, { i: viewIndex, snap });
  }
  function checkRun(name, r, snap) {
    const keys = snap.transitions.map((x) => `${x.from}#${x.edge}`);
    assert.ok(r.active, `${name}: graph shows a run`);
    // every visited transition is solid accent; the rest is faint
    for (const e of r.edges) {
      if (keys.includes(e.key)) {
        assert.ok(e.visited, `${name}: ${e.key} should be marked visited`);
        assert.equal(e.stroke, css.accent, `${name}: visited ${e.key} is drawn in the accent color`);
        assert.ok(e.dash === "none" || e.dash === "", `${name}: visited ${e.key} is solid`);
      } else {
        assert.ok(!e.visited, `${name}: ${e.key} should not be marked visited`);
        assert.equal(e.stroke, css["graph-edge-faint"], `${name}: unvisited ${e.key} is faint`);
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
        assert.ok(r.tags.length === 1 && /current|waiting/.test(r.tags[0]), `${name}: status tag, got ${r.tags}`);
      }
    }
    assert.ok(r.alt.includes(snap.state), `${name}: text alternative names the current state`);
    return marked[0];
  }

  // happy path, waiting for approval
  const hp = FX.runs.happy_path.snapshots;
  const wait = hp.find((s) => s.status === "WAITING_FOR_APPROVAL");
  checkRun("happy_path (waiting)", await show(views.initial, wait), wait);
  // happy path, completed: the verified terminal is filled in its category color
  {
    const end = hp[hp.length - 1];
    const m = checkRun("happy_path (completed)", await show(views.initial, end), end);
    assert.match(m.cls, /\bis-reached\b/, "verified terminal is reached");
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
        marked: r.querySelectorAll(".is-current, .is-reached, .is-visited, .is-faint").length };
    }, views.initial);
    assert.deepEqual(rest, { active: false, badges: 0, marked: 0 }, "update() with an empty run clears the marking");
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

  /* ---------------- highlight() */
  {
    await page.evaluate((i) => __hxgt.views[i].view.highlight(["VALIDATE_DRAFT", "REPAIR_DRAFT", "END_UNVERIFIED"]), views.initial);
    await page.waitForTimeout(300);
    const r = await page.evaluate((i) => {
      const { view } = __hxgt.views[i];
      const root = view.root;
      const on = [...root.querySelectorAll(".hxg-node.is-highlight")].map((g) => g.getAttribute("data-state"));
      const has = root.classList.contains("has-highlight");
      const ring = getComputedStyle(root.querySelector('.hxg-node[data-state="VALIDATE_DRAFT"] .hxg-ring')).stroke;
      view.highlight([]);
      return { on, has, ring, after: root.querySelectorAll(".hxg-node.is-highlight").length, hasAfter: root.classList.contains("has-highlight") };
    }, views.initial);
    assert.ok(r.has, "highlight() marks the graph");
    assert.deepEqual([...new Set(r.on)].sort(), ["END_UNVERIFIED", "REPAIR_DRAFT", "VALIDATE_DRAFT"], "highlight() marks exactly the given states");
    assert.equal(r.on.filter((x) => x === "END_UNVERIFIED").length, 5, "every drawn copy of a terminal is highlighted");
    assert.equal(r.ring, css.accent, "highlighted states get an accent ring");
    assert.equal(r.after, 0, "highlight([]) clears");
    assert.ok(!r.hasAfter, "highlight([]) clears the graph mark");
  }

  /* ---------------- selection: focusable nodes, aria-labels, Enter / Space / arrows, text alternative */
  {
    const i = await page.evaluate((m) => __hxgt.mount(m, { title: "Selectable", select: true }), machines.refined);
    const info = await page.evaluate((i) => {
      const r = __hxgt.views[i].view.root;
      const svg = r.querySelector(".hxg-svg");
      const buttons = [...svg.querySelectorAll('.hxg-node[role="button"]')];
      const alt = document.getElementById(svg.getAttribute("aria-describedby"));
      return {
        n: buttons.length, states: buttons.map((b) => b.getAttribute("data-state")),
        tabbable: buttons.filter((b) => b.getAttribute("tabindex") === "0").length,
        focusable: buttons.every((b) => b.hasAttribute("tabindex")),
        labels: buttons.map((b) => b.getAttribute("aria-label") || ""),
        copiesHidden: [...svg.querySelectorAll(".hxg-node[data-copy]")].filter((g) => g.getAttribute("data-copy") !== "0").every((g) => g.getAttribute("aria-hidden") === "true"),
        altItems: alt ? [...alt.querySelectorAll("li")].map((li) => li.textContent) : [],
        altHidden: alt ? getComputedStyle(alt).clipPath !== "none" || alt.getBoundingClientRect().width <= 1 : false,
      };
    }, i);
    const ids = Object.keys(machines.refined.states);
    assert.equal(info.n, ids.length, "one button per state (terminal copies share one)");
    assert.deepEqual([...info.states].sort(), [...ids].sort(), "every state is selectable");
    assert.equal(info.tabbable, 1, "one tab stop into the graph (roving tabindex)");
    assert.ok(info.focusable, "every state is focusable");
    assert.ok(info.copiesHidden, "extra terminal copies are hidden from assistive technology");
    const ri = info.labels[info.states.indexOf("READ_INTAKE")];
    assert.match(ri, /READ_INTAKE/, "aria-label names the state");
    assert.match(ri, /documents\.read/, "aria-label names the action");
    assert.match(ri, /initial state/, "aria-label says it is the initial state");
    assert.match(ri, /docs_status == 'available'/, "aria-label lists the guards");
    assert.match(info.labels[info.states.indexOf("END_UNVERIFIED")], /unverified/, "terminal aria-label names its category");
    assert.equal(info.altItems.length, ids.length, "text alternative lists every state");
    assert.ok(info.altItems.some((s) => /VALIDATE_DRAFT/.test(s) && /repair_count < 2/.test(s) && /REPAIR_DRAFT/.test(s)), "text alternative lists transitions with guards");
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
  }

  /* ---------------- the graph scrolls inside its own container; the page never does */
  {
    const r = await page.evaluate((i) => {
      const c = __hxgt.views[i].view.root.querySelector(".hxg-canvas");
      return { sw: c.scrollWidth, cw: c.clientWidth, ox: getComputedStyle(c).overflowX, page: document.documentElement.scrollWidth - window.innerWidth };
    }, views.initial);
    assert.ok(r.page <= 1, `page scrolls sideways by ${r.page}px`);
    assert.equal(r.ox, "auto", "the canvas scrolls sideways");
    if (t.viewport.width <= 400) assert.ok(r.sw > r.cw + 1, `at ${t.viewport.width}px the graph scrolls inside its container (${r.sw} vs ${r.cw})`);
    else assert.ok(r.sw <= r.cw + 1, `at ${t.viewport.width}px the graph fits its container (${r.sw} vs ${r.cw})`);
  }

  /* ---------------- destroy() */
  {
    const r = await page.evaluate(() => {
      const v = __hxgt.views.at(-1);
      v.view.destroy();
      return v.host.children.length;
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
