// The page shell: boot, navigation (rail clicks, #hash deep links, history, keyboard), the theme toggle,
// Reset lab, the states shown for engine modules missing from the build, the HXUI component API, reduced
// motion, and the boot failure panel. Also the layout guarantees found in review: the parity grid never
// paints one cell over the next, the top bar title never runs under its actions, a focused tab or control is
// never hidden under a fade or the sticky strip, and blocked copying says what to do. Runs at 1280px and 400px,
// light and dark.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTIONS = ["overview", "compile", "run", "learn", "break", "selftest"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function booted(page) {
  await page.waitForFunction(() => document.getElementById("app")?.dataset.boot !== "pending", null, { timeout: 15000 });
}

function frames(page) {
  return page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
}

/* Parity rows: no cell's content intersects another cell's content; in the four-column grid no cell's content
   passes the left edge of the next cell; no digest paints outside its own cell. */
function parity_geometry(page) {
  return page.evaluate(() => {
    const out = { grid: getComputedStyle(document.querySelector(".ov-checks-head")).display !== "none", problems: [] };
    for (const li of document.querySelectorAll(".ov-check")) {
      const cells = [".ov-check-name", ".ov-check-this", ".ov-check-ref", ".ov-check-result"].map((s) => li.querySelector(s));
      const ext = cells.map((c) => {
        let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
        for (const d of c.querySelectorAll("*")) {
          const x = d.getBoundingClientRect();
          if (!x.width || !x.height || d.closest(".ov-cell-label")) continue;
          l = Math.min(l, x.left); r = Math.max(r, x.right); t = Math.min(t, x.top); b = Math.max(b, x.bottom);
        }
        return { l, r, t, b };
      });
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const a = ext[i], c = ext[j];
        if (a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5) out.problems.push(`${li.dataset.check}: cell ${i} overlaps cell ${j}`);
      }
      if (out.grid) {
        for (let i = 0; i < 3; i++) {
          const next = cells[i + 1].getBoundingClientRect().left;
          if (ext[i].r > next + 0.5) out.problems.push(`${li.dataset.check}: cell ${i} passes the left edge of cell ${i + 1} by ${Math.round(ext[i].r - next)}px`);
        }
      }
      for (const code of li.querySelectorAll(".hx-digest-text")) {
        const cell = code.closest(".ov-check-cell").getBoundingClientRect();
        const x = code.getBoundingClientRect();
        if (x.right > cell.right + 0.5) out.problems.push(`${li.dataset.check}: a digest paints ${Math.round(x.right - cell.right)}px outside its cell`);
      }
    }
    return out;
  });
}

/* The title's glyphs stay inside the brand box (whatever the font metrics) and never meet the top bar actions. */
function topbar_clear(page) {
  return page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".hx-brand-name"));
    const t = range.getBoundingClientRect();
    const brand = document.querySelector(".hx-brand").getBoundingClientRect();
    const a = document.querySelector(".hx-top-actions").getBoundingClientRect();
    return t.right <= brand.right + 0.5 && !(t.left < a.right && a.left < t.right && t.top < a.bottom && a.top < t.bottom);
  });
}

async function expect_active(t, id) {
  const s = await t.page.evaluate((sid) => {
    const sec = document.querySelector(`.hx-section[data-section="${sid}"]`);
    const r = sec ? sec.getBoundingClientRect() : null;
    return {
      visible: [...document.querySelectorAll(".hx-section")].filter((x) => !x.hidden).map((x) => x.dataset.section),
      current: [...document.querySelectorAll(".hx-rail-link[aria-current='page']")].map((a) => a.dataset.section),
      router: globalThis.HXUI.current(),
      state: sec ? sec.dataset.state : null,
      painted: !!r && r.width > 0 && r.height > 0,
      title: sec ? sec.querySelector(".hx-section-title")?.textContent : null,
      scroll_x: document.documentElement.scrollWidth - innerWidth,
    };
  }, id);
  t.assert.deepEqual(s.visible, [id], `only #${id} is visible`);
  t.assert.deepEqual(s.current, [id], `aria-current="page" marks only ${id}`);
  t.assert.equal(s.router, id);
  t.assert.ok(s.painted, `#${id} has a rendered box`);
  t.assert.ok(s.title && s.title.trim().length > 0, `#${id} has a title`);
  t.assert.ok(s.state === "ready" || s.state === "unavailable", `#${id} renders (state ${s.state})`);
  t.assert.ok(s.scroll_x <= 1, `#${id} scrolls the page sideways by ${s.scroll_x}px`);
}

function focus_ring(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, id: el.id, section: el.dataset.section || null,
      outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1,
      shadow: cs.boxShadow && cs.boxShadow !== "none",
    };
  });
}

export default async function (t) {
  const { page, assert } = t;

  /* ---- boot */
  await t.open();
  assert.equal(await page.getAttribute("#app", "data-boot"), "ready", "boot reaches ready");
  const url = page.url().split("#")[0];
  assert.deepEqual(await page.evaluate(() => HXUI.sections().map((s) => s.id)), SECTIONS, "sections in navigation order");
  assert.equal(await page.locator("#app > .hx-skip").count(), 1, "skip link");
  assert.equal(await page.locator("header.hx-top h1").textContent(), "HEXIS Runtime Lab");
  assert.equal(await page.locator("nav.hx-rail[aria-label]").count(), 1, "labelled section nav");
  assert.equal(await page.locator("main#hx-main").count(), 1, "main landmark");
  assert.equal(await page.getAttribute("#hx-live", "aria-live"), "polite", "polite live region");
  await expect_active(t, "overview");
  assert.equal(await page.evaluate(() => location.hash), "#overview", "the URL names the section on screen");

  /* ---- top bar: the title never runs under Reset lab or the theme toggle; the toggle says what it sets */
  const toggle = () => page.evaluate(() => {
    const label = document.querySelector("#hx-theme-toggle .hx-theme-label");
    return { text: label.textContent, shown: getComputedStyle(label).display !== "none", aria: document.getElementById("hx-theme-toggle").getAttribute("aria-label") };
  });
  if (t.viewport.width < 600) {
    for (let w = 360; w <= 420; w += 4) {
      await page.setViewportSize({ width: w, height: t.viewport.height });
      await frames(page);
      assert.ok(await topbar_clear(page), `at ${w}px the title fits its box and stays clear of the top bar actions`);
    }
    await page.setViewportSize(t.viewport);
    await frames(page);
    const tg = await toggle();
    assert.ok(!tg.shown && /^Theme: System\./.test(tg.aria), "phones show the theme icon only, with the full name for assistive technology");
  } else {
    assert.ok(await topbar_clear(page), "the title and the top bar actions do not overlap");
    const tg = await toggle();
    assert.deepEqual([tg.text, tg.shown], ["Theme: System", true], "the theme toggle's visible label says what it controls");
  }

  /* ---- the rail: click every section (at 400px the rail is a horizontal tab strip) */
  const strip = await page.evaluate(() => {
    const list = document.querySelector(".hx-rail-list");
    return { dir: getComputedStyle(list).flexDirection, overflow: getComputedStyle(list).overflowX };
  });
  if (t.viewport.width < 600) assert.deepEqual(strip, { dir: "row", overflow: "auto" }, "tab strip on narrow screens");
  else assert.equal(strip.dir, "column", "left rail on wide screens");
  for (const id of [...SECTIONS.slice(1), "overview"]) {
    await page.click(`.hx-rail-link[data-section="${id}"]`);
    await expect_active(t, id);
    assert.equal(await page.evaluate(() => location.hash), "#" + id, "the hash follows the rail");
  }
  if (t.viewport.width < 600) {
    /* a tab reached with the keyboard, or made active, is scrolled clear of the strip's faded edges (the fade
       width is the one the mask uses, --hx-rail-fade) */
    const strip_state = (which) => page.evaluate((which) => {
      const l = document.querySelector(".hx-rail-list");
      const a = which === "active" ? l.querySelector('[aria-current="page"]') : document.activeElement;
      const raw = getComputedStyle(l).getPropertyValue("--hx-rail-fade").trim();
      const fade = parseFloat(raw) * (raw.endsWith("rem") ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 1);
      const lb = l.getBoundingClientRect();
      const ab = a.getBoundingClientRect();
      return {
        section: a.dataset.section, start: l.dataset.scrollStart, end: l.dataset.scrollEnd, wide: l.scrollWidth > l.clientWidth + 1, fade,
        clear_left: ab.left >= lb.left + (l.dataset.scrollStart === "more" ? fade : 0) - 0.5,
        clear_right: ab.right <= lb.right - (l.dataset.scrollEnd === "more" ? fade : 0) + 0.5,
      };
    }, which);
    await page.focus('.hx-rail-link[data-section="break"]');
    await page.keyboard.press("Tab");
    let s = await strip_state();
    assert.equal(s.section, "selftest");
    assert.ok(s.fade >= 24, `the strip fades its edges (${s.fade}px)`);
    assert.ok(s.clear_left && s.clear_right, `the focused last tab is clear of the faded edges: ${JSON.stringify(s)}`);
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Tab");
    s = await strip_state();
    assert.equal(s.section, "overview");
    assert.ok(s.clear_left && s.clear_right, `the focused first tab is clear of the faded edges: ${JSON.stringify(s)}`);
    if (!s.wide) assert.deepEqual([s.start, s.end], ["edge", "edge"], "no fade when every tab fits");
    /* narrower phones (the review found tabs under the fade below 400px): every tab, focused or active, stays clear */
    for (const w of [t.viewport.width, 375, 360, 320]) {
      await page.setViewportSize({ width: w, height: t.viewport.height });
      await frames(page);
      for (const id of SECTIONS) {
        await page.focus(`.hx-rail-link[data-section="${id}"]`);
        await frames(page);
        s = await strip_state();
        assert.ok(s.section === id && s.clear_left && s.clear_right, `at ${w}px the focused ${id} tab is clear of the faded edges: ${JSON.stringify(s)}`);
      }
      for (const id of [...SECTIONS.slice(1).reverse(), "overview", "learn"]) {
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.evaluate((id) => HXUI.go(id), id);
        await frames(page);
        s = await strip_state("active");
        assert.ok(s.section === id && s.clear_left && s.clear_right, `at ${w}px the active ${id} tab is clear of the faded edges: ${JSON.stringify(s)}`);
      }
    }
    await page.setViewportSize(t.viewport);
    await page.evaluate(() => HXUI.go("overview"));
    await frames(page);
  }

  /* ---- #hash deep links: fresh loads, in-place hash changes, unknown hashes */
  for (const id of SECTIONS) {
    await page.goto("about:blank");
    await page.goto(url + "#" + id);
    await booted(page);
    await expect_active(t, id);
  }
  await page.evaluate(() => { location.hash = "break"; });
  await page.waitForFunction(() => HXUI.current() === "break");
  await expect_active(t, "break");
  await page.goBack();
  await page.waitForFunction(() => HXUI.current() === "selftest");
  await expect_active(t, "selftest");
  await page.goto("about:blank");
  await page.goto(url + "#no-such-section");
  await booted(page);
  await expect_active(t, "overview");
  assert.equal(await page.evaluate(() => location.hash), "#overview", "an unknown hash at boot is replaced by the section shown");
  await page.evaluate(() => HXUI.go("run"));
  await page.evaluate(() => { location.hash = "nope"; });
  await page.waitForFunction(() => location.hash === "#run");
  await expect_active(t, "run");

  /* ---- keyboard: Tab reaches the rail, focus is visibly outlined, Enter activates */
  await page.goto("about:blank");
  await page.goto(url);
  await booted(page);
  let ring = null;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    ring = await focus_ring(page);
    assert.ok(ring && (ring.outline || ring.shadow), `focus on ${ring && (ring.id || ring.tag)} is visibly outlined`);
    if (ring.section) break;
  }
  assert.equal(ring && ring.section, "overview", "Tab reaches the first rail item");
  await page.keyboard.press("Tab");
  ring = await focus_ring(page);
  assert.equal(ring.section, "compile", "Tab moves along the rail");
  assert.ok(ring.outline || ring.shadow, "rail focus is visibly outlined");
  await page.keyboard.press("Enter");
  await expect_active(t, "compile");
  assert.equal((await focus_ring(page)).section, "compile", "focus stays on the activated rail item");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect_active(t, "run");

  /* ---- theme toggle: system -> light -> dark -> system */
  const theme = () => page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    mode: document.getElementById("hx-theme-toggle").dataset.mode,
    bg: getComputedStyle(document.body).backgroundColor,
    stored: (() => { try { return localStorage.getItem("hexis-lab.theme"); } catch (e) { return "blocked"; } })(),
  }));
  const sys = await theme();
  assert.deepEqual([sys.attr, sys.mode, sys.stored], [null, "system", null], "starts in system mode");
  await page.click("#hx-theme-toggle");
  const light = await theme();
  assert.deepEqual([light.attr, light.mode, light.stored], ["light", "light", "light"]);
  await page.click("#hx-theme-toggle");
  const dark = await theme();
  assert.deepEqual([dark.attr, dark.mode, dark.stored], ["dark", "dark", "dark"]);
  assert.notEqual(light.bg, dark.bg, "body background differs between light and dark");
  assert.equal(sys.bg, t.scheme === "dark" ? dark.bg : light.bg, "system mode follows the OS color scheme");
  await page.click("#hx-theme-toggle");
  const back = await theme();
  assert.deepEqual([back.attr, back.mode, back.stored], [null, "system", null], "cycles back to system");
  assert.equal(back.bg, sys.bg);
  await page.click("#hx-theme-toggle"); /* light, then reload: the choice is remembered */
  await page.reload();
  await booted(page);
  const kept = await theme();
  assert.deepEqual([kept.attr, kept.mode], ["light", "light"], "theme choice survives a reload");
  await page.click("#hx-theme-toggle");
  await page.click("#hx-theme-toggle");
  assert.equal((await theme()).attr, null);

  /* ---- Reset lab: Escape and Cancel keep the lab, Reset rebuilds it in place */
  await page.evaluate(() => {
    globalThis.__resets = 0;
    globalThis.__lab = HXUI.lab;
    HXUI.bus.on("lab:reset", () => { globalThis.__resets += 1; });
    HXUI.lab.runs.push({ run_id: "run-1" });
    HXUI.lab.selected_run = "run-1";
    HXUI.lab.compile = { status: "validated" };
    HXUI.lab.packages.initial = { artifact_hash: "sha256:x" };
    HXUI.lab.archive.push({ trace_id: "t" });
    HXUI.lab.log.push("note");
  });
  const pop = () => page.evaluate(() => ({
    hidden: document.getElementById("hx-reset-pop").hidden,
    expanded: document.getElementById("hx-reset").getAttribute("aria-expanded"),
    focus: document.activeElement && document.activeElement.id,
    resets: globalThis.__resets,
    runs: HXUI.lab.runs.length,
  }));
  await page.click("#hx-reset");
  assert.deepEqual(await pop(), { hidden: false, expanded: "true", focus: "hx-reset-cancel", resets: 0, runs: 1 }, "confirmation opens");
  if (t.viewport.width < 600) {
    const edges = await page.evaluate(() => {
      const p = document.getElementById("hx-reset-pop").getBoundingClientRect();
      const top = document.querySelector(".hx-top").getBoundingClientRect();
      return [Math.round(p.left - top.left), Math.round(top.right - p.right)];
    });
    assert.deepEqual(edges, [0, 0], "on a phone the confirmation spans the top bar, edge to edge with the content column");
  }
  await page.keyboard.press("Escape");
  assert.deepEqual(await pop(), { hidden: true, expanded: "false", focus: "hx-reset", resets: 0, runs: 1 }, "Escape keeps the lab");
  await page.click("#hx-reset");
  await page.click("#hx-reset-cancel");
  assert.deepEqual(await pop(), { hidden: true, expanded: "false", focus: "hx-reset", resets: 0, runs: 1 }, "Cancel keeps the lab");
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  const after = await page.evaluate(() => ({
    resets: globalThis.__resets,
    same: globalThis.__lab === HXUI.lab,
    lab: JSON.parse(JSON.stringify(HXUI.lab)),
    hidden: document.getElementById("hx-reset-pop").hidden,
    label: document.getElementById("hx-reset").textContent,
  }));
  assert.equal(after.resets, 1, "lab:reset emitted once");
  assert.ok(after.same, "HXUI.lab keeps its identity");
  assert.deepEqual(after.lab, { env: null, packages: { initial: null, refined: null }, compile: null, runs: [], selected_run: null, archive: [], log: [] });
  assert.ok(after.hidden, "confirmation closes");
  assert.equal(after.label, "Lab reset", "the control says what happened");
  await page.waitForFunction(() => /Lab reset/.test(document.getElementById("hx-live").textContent));

  /* ---- unavailable states: every section and overview part renders, never throws */
  await page.goto("about:blank");
  await page.goto(url);
  await booted(page);
  const sections = await page.evaluate(() => HXUI.sections().map((s) => ({ id: s.id, missing: HXUI.engine_missing(s.needs) })));
  for (const s of sections) {
    await page.evaluate((id) => HXUI.go(id), s.id);
    await expect_active(t, s.id);
    const shown = await page.evaluate((id) => {
      const sec = document.querySelector(`.hx-section[data-section="${id}"]`);
      const box = sec.querySelector(".hx-unavailable");
      return {
        state: sec.dataset.state, text: box ? box.textContent : "", about: sec.querySelectorAll(".hx-about-list li").length,
        title: box ? box.querySelector(".hx-unavailable-title").textContent : null,
        about_level: sec.querySelector(".hx-about .hx-label") ? sec.querySelector(".hx-about .hx-label").tagName : null,
      };
    }, s.id);
    if (s.missing.length) {
      assert.equal(shown.state, "unavailable", `${s.id} shows the unavailable state`);
      for (const name of s.missing) assert.ok(shown.text.includes(name), `${s.id} names the missing ${name}`);
      assert.ok(shown.about >= 2, `${s.id} still says what it lets you do`);
      assert.ok(["Not in this build", "Failed to load in this build"].includes(shown.title), `${s.id} unavailable title: ${shown.title}`);
      assert.equal(shown.about_level, "H3", `${s.id}: "What you can do here" sits one level under the section title`);
    } else {
      assert.equal(shown.state, "ready", `${s.id} mounts when its modules are present`);
    }
  }
  const base_only = await page.evaluate(() => ["guards", "efsm", "pkg", "catalog", "compile", "kernel", "service", "update"].every((n) => !(n in HX)));
  if (base_only) {
    for (const id of ["compile", "run", "learn", "break"]) {
      assert.ok(sections.find((s) => s.id === id).missing.length > 0, `${id} needs modules beyond 00-15`);
    }
  }
  await page.evaluate(() => HXUI.go("overview"));
  await page.waitForFunction(() => document.querySelector(".ov-parity")?.dataset.parityState === "done", null, { timeout: 30000 });
  const ov = await page.evaluate(() => ({
    checks: [...document.querySelectorAll(".ov-check")].map((li) => ({ id: li.dataset.check, state: li.dataset.state })),
    graph: document.querySelector(".ov-machine").dataset.graph,
    has_compile: !!(globalThis.HX && HX.compile),
    has_graph: !!HXUI.graph,
    demo_disabled: document.getElementById("ov-demo-start").getAttribute("aria-disabled"),
    demo_reason: document.getElementById("ov-demo-start").getAttribute("aria-description"),
  }));
  assert.deepEqual(ov.checks.map((c) => c.id), ["initial", "refined", "catalog"]);
  for (const c of ov.checks) assert.ok(["match", "unavailable"].includes(c.state), `parity check ${c.id} is ${c.state}`);
  if (ov.has_compile) assert.equal(ov.checks[0].state, "match", "the initial artifact hash equals the Python build");
  if (!ov.has_compile || !ov.has_graph) assert.equal(ov.graph, "unavailable", "graph panel shows its unavailable state");
  else assert.equal(ov.graph, "ready", "the compiled machine is drawn");
  if (ov.demo_disabled === "true") assert.ok(ov.demo_reason && ov.demo_reason.length > 10, "disabled control explains why");

  /* ---- parity rows never paint one cell over the next (the review found overlaps at 770-860 and 1070-1215px) */
  const widths = t.viewport.width < 600 ? [t.viewport.width, 360] : [1100, 1180, 1240, 1300, 860, t.viewport.width];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: t.viewport.height });
    await frames(page);
    const g = await parity_geometry(page);
    assert.deepEqual(g.problems, [], `parity rows at ${w}px (${g.grid ? "four columns" : "stacked"})`);
  }
  await page.setViewportSize(t.viewport);
  await frames(page);

  /* ---- blocked clipboard: the full value is selected and a visible note says what to do */
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")) }, configurable: true }));
  await page.click("#ov-initial-ref-copy");
  await page.waitForSelector(".hx-copy-note");
  const note = await page.evaluate(() => {
    const n = document.querySelector(".hx-copy-note");
    const b = document.getElementById("ov-initial-ref-copy");
    const r = n.getBoundingClientRect();
    const code = document.getElementById("ov-initial-ref");
    return {
      text: n.textContent, shown: r.width > 0 && r.height > 0, described: b.getAttribute("aria-describedby") === n.id, state: b.dataset.state,
      selected: String(getSelection()) === code.textContent && code.textContent.length > 64,
    };
  });
  assert.ok(note.shown && /Ctrl\+C or Cmd\+C/.test(note.text) && note.described && note.state === "selected" && note.selected,
    `blocked copy shows a visible note and selects the full value: ${JSON.stringify(note)}`);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => !document.querySelector(".hx-copy-note") && !document.getElementById("ov-initial-ref-copy").dataset.state);
  /* on a touch screen (pointer: coarse) the note says to long-press instead of naming keyboard shortcuts */
  await page.evaluate(() => {
    const real = globalThis.matchMedia.bind(globalThis);
    globalThis.__real_mm = real;
    const coarse = (q) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
    globalThis.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? coarse(q) : real(q));
  });
  await page.click("#ov-initial-ref-copy");
  await page.waitForSelector(".hx-copy-note");
  const touch_note = await page.evaluate(() => document.querySelector(".hx-copy-note").textContent);
  assert.ok(/long-press/i.test(touch_note) && !/Ctrl\+C/.test(touch_note), `touch users are told to long-press: ${touch_note}`);
  await page.evaluate(() => { globalThis.matchMedia = globalThis.__real_mm; getSelection().removeAllRanges(); });
  await page.waitForFunction(() => !document.querySelector(".hx-copy-note") && !document.getElementById("ov-initial-ref-copy").dataset.state);

  /* ---- phones: Shift+Tab never leaves the focused control under the sticky section strip (WCAG 2.4.11) */
  if (t.viewport.width < 600) {
    await page.evaluate(() => {
      const main = document.getElementById("hx-main");
      const all = [...main.querySelectorAll("a[href], button, [tabindex='0'], input, select, textarea, summary")]
        .filter((e) => !e.closest("[hidden]") && e.getBoundingClientRect().width > 0);
      scrollTo(0, document.documentElement.scrollHeight);
      all[all.length - 1].focus({ preventScroll: true });
    });
    const covered = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Shift+Tab");
      const r = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !document.getElementById("hx-main").contains(el)) return null;
        const b = el.getBoundingClientRect();
        const strip = document.querySelector(".hx-rail").getBoundingClientRect();
        return { name: el.id || el.getAttribute("aria-label") || el.textContent.trim().slice(0, 40), px: Math.round(Math.max(0, Math.min(b.bottom, strip.bottom) - Math.max(b.top, strip.top))) };
      });
      if (!r) break;
      if (r.px > 0) covered.push(r);
    }
    assert.deepEqual(covered, [], "no control focused with Shift+Tab sits under the sticky section strip");
    /* the review's case, built on purpose: a link scrolled to 10px from the top (under the strip) gets focus
       with Shift+Tab from the next link, and must be scrolled clear of the strip */
    for (const i of [2, 4]) {
      const r = await page.evaluate((i) => {
        const el = document.querySelector(`#ov-step-${i} .ov-step-link`);
        scrollBy(0, el.getBoundingClientRect().top - 10);
        document.querySelector(`#ov-step-${i + 1} .ov-step-link`).focus({ preventScroll: true });
        return Math.round(el.getBoundingClientRect().top);
      }, i);
      assert.equal(r, 10, "set-up: the link starts under the strip");
      await page.keyboard.press("Shift+Tab");
      const after = await page.evaluate((i) => {
        const el = document.activeElement;
        return { same: el === document.querySelector(`#ov-step-${i} .ov-step-link`), top: el.getBoundingClientRect().top, strip: document.querySelector(".hx-rail").getBoundingClientRect().bottom };
      }, i);
      assert.ok(after.same && after.top >= after.strip, `step ${i} link focused with Shift+Tab is clear of the strip: ${JSON.stringify(after)}`);
    }
  }

  await page.evaluate(() => HXUI.go("selftest"));
  const inv = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".st-modules tbody tr")].map((tr) => ({ module: tr.dataset.module, status: tr.dataset.status })),
    expected: HXUI.engine_inventory().map((m) => ({ module: m.prefix, status: m.status })),
    canonical: HXUI.engine_inventory().find((m) => m.prefix === "10").status,
  }));
  assert.deepEqual(inv.rows, inv.expected, "Self-test lists every engine module with its status");
  assert.equal(inv.canonical, "loaded");
  await frames(page);
  const st = await page.evaluate(() => {
    const wrap = document.querySelector(".st-modules").closest(".hx-table-wrap");
    const sc = wrap.querySelector(".hx-table-scroll");
    return {
      folded: wrap.classList.contains("is-folded"), overflow: sc.scrollWidth - sc.clientWidth,
      about_level: document.querySelector("#sec-selftest .hx-about .hx-label").tagName,
      caption_hidden: document.querySelector(".st-modules caption").classList.contains("hx-visually-hidden"),
    };
  });
  assert.equal(st.about_level, "H4", "the runner list label sits one level under its panel title");
  assert.ok(st.caption_hidden, "the panel heading labels the module table; its caption is kept for assistive technology");
  if (t.viewport.width < 600) assert.ok(st.folded && st.overflow <= 1, `on a phone the module table folds its detail columns and fits: ${JSON.stringify(st)}`);
  const junk = await page.evaluate(() => /\b(undefined|NaN)\b|\[object Object\]/.exec(document.getElementById("app").innerText));
  assert.equal(junk, null, "no undefined, NaN or [object Object] in the page text");

  /* ---- the HXUI component API that every section builds on */
  const api = await page.evaluate(() => {
    const out = {};
    const { h } = HXUI;
    const host = h("div", { id: "e2e-host" });
    document.querySelector(".hx-section:not([hidden]) .hx-section-body").appendChild(host);
    let clicks = 0;
    const el = h("p", { class: ["a", null, "b"], dataset: { k: "v" }, style: { marginTop: "3px", "--x": "1" }, "aria-hidden": false, on: { click: () => { clicks += 1; } } },
      "x", 2, null, false, [h("b", null, "y"), ["z"]]);
    el.click();
    out.h = { cls: el.className, k: el.dataset.k, mt: el.style.marginTop, x: el.style.getPropertyValue("--x"), aria: el.getAttribute("aria-hidden"), text: el.textContent, clicks };
    try { h("div", { html: "<b>no</b>" }); out.html = "allowed"; } catch (e) { out.html = "refused"; }
    /* markup strings, inline handlers and script URLs never reach the DOM; a string style gets a clear error */
    const refuse = (fn) => { try { fn(); return "allowed"; } catch (e) { return e.message; } };
    globalThis.__fired = 0;
    out.refusals = {
      onclick: refuse(() => h("button", { onclick: "globalThis.__fired = 1" })),
      onMouseOver: refuse(() => h("div", { onMouseOver: "x" })),
      innerHTML: refuse(() => h("div", { innerHTML: "<b>x</b>" })),
      outerHTML: refuse(() => h("div", { outerHTML: "<b>x</b>" })),
      srcdoc: refuse(() => h("div", { srcdoc: "<b>x</b>" })),
      href_js: refuse(() => h("a", { href: "javascript:void(0)" })),
      href_js_tab: refuse(() => h("a", { href: " java\tscript:void(0)" })),
      svg_href_js: refuse(() => HXUI.s("a", { href: "JavaScript:void(0)" })),
      style_string: refuse(() => h("div", { style: "color: red" })),
      href_ok: refuse(() => h("a", { href: "#compile" })),
      on_ok: refuse(() => h("button", { on: { click: () => {} } })),
    };
    out.fired = globalThis.__fired;
    const sel = HXUI.select("e2e-sel", [{ value: "a", label: "A" }, { value: "b", label: "B" }], { value: "b", on_change: (v) => { out.changed = v; } });
    host.appendChild(HXUI.field("Pick one", sel, { hint: "A hint", error: "An error" }));
    sel.value = "a";
    sel.dispatchEvent(new Event("change"));
    out.field = {
      for: host.querySelector("label").htmlFor, described: sel.getAttribute("aria-describedby"), invalid: sel.getAttribute("aria-invalid"),
      hint: document.getElementById(sel.id + "-hint").textContent, error: document.getElementById(sel.id + "-error").textContent,
    };
    let pressed = 0;
    const btn = HXUI.button("Approve", { id: "e2e-btn", variant: "primary", disabled: true, disabled_reason: "Pick an approver first.", on_click: () => { pressed += 1; } });
    host.appendChild(btn);
    btn.click();
    out.disabled = { pressed, aria: btn.getAttribute("aria-disabled"), title: btn.title, desc: btn.getAttribute("aria-description"), focusable: btn.tabIndex === 0 };
    HXUI.set_disabled(btn, false);
    btn.click();
    out.enabled = { pressed, aria: btn.getAttribute("aria-disabled"), desc: btn.getAttribute("aria-description") };
    const dg = HXUI.digest("sha256:" + "ab".repeat(32), { short: 14 });
    host.appendChild(dg);
    out.digest = { text: dg.querySelector("code").textContent, title: dg.querySelector("code").title, copy: !!dg.querySelector("button.hx-copy") };
    out.chip = HXUI.chip("VERIFIED", "ok").className;
    out.notice = HXUI.notice("crit", "T", "B").className;
    const tbl = HXUI.table({ caption: "Rows", columns: [{ key: "n", label: "N", align: "right" }, { key: "s", label: "S", mono: true, render: (r) => r.s.toUpperCase() }], rows: [{ n: 1, s: "a" }, { n: 2, s: "b" }] });
    const empty = HXUI.table({ columns: [{ key: "n", label: "N" }], rows: [], empty: "Nothing yet." });
    host.append(tbl, empty);
    out.table = {
      caption: tbl.querySelector("caption").textContent, cells: [...tbl.querySelectorAll("tbody td")].map((td) => td.textContent),
      right: tbl.querySelector("td").classList.contains("hx-al-right"), mono: tbl.querySelectorAll("td.is-mono").length, empty: empty.querySelector("td").textContent,
    };
    const jv = HXUI.json_view({ a: 1, b: { c: [true, null, "s"] } }, { open_depth: 1 });
    host.appendChild(jv);
    out.json = { details: jv.querySelectorAll("details").length, open: [...jv.querySelectorAll("details")].map((d) => d.open), text: jv.textContent.replace(/\s+/g, " ") };
    host.appendChild(HXUI.code("x".repeat(400)));
    let seen = null;
    const fn = HXUI.bus.on("e2e:ping", (p) => { seen = p; });
    HXUI.bus.emit("e2e:ping", { n: 1 });
    HXUI.bus.off("e2e:ping", fn);
    HXUI.bus.emit("e2e:ping", { n: 2 });
    out.bus = seen;
    out.missing = HXUI.engine_missing(["canonical", "HX.data", "no_such_module"]);
    HXUI.announce("E2E announcement");
    host.appendChild(HXUI.tabs("e2e-tabs", [
      { id: "one", label: "One", render: () => h("p", null, "first") },
      { id: "two", label: "Two", render: () => h("p", null, "second") },
      { id: "three", label: "Three", render: () => h("p", null, "third") },
    ], { label: "E2E tabs", on_change: (id) => { globalThis.__tab_changed = id; } }));
    return out;
  });
  assert.deepEqual(api.h, { cls: "a b", k: "v", mt: "3px", x: "1", aria: "false", text: "x2yz", clicks: 1 });
  assert.equal(api.html, "refused", "h() refuses an html attribute");
  const refused = api.refusals;
  assert.match(refused.onclick, /on: \{click: fn\}/, "h() refuses an inline onclick and points to on: {click}");
  assert.match(refused.onMouseOver, /not allowed/, "h() refuses inline handlers in any case");
  for (const k of ["innerHTML", "outerHTML", "srcdoc"]) assert.match(refused[k], /not supported/, `h() refuses ${k}`);
  for (const k of ["href_js", "href_js_tab", "svg_href_js"]) assert.match(refused[k], /javascript:/, `h() refuses a script URL (${k})`);
  assert.match(refused.style_string, /style takes an object/, "a string style gets a clear error");
  assert.deepEqual([refused.href_ok, refused.on_ok, api.fired], ["allowed", "allowed", 0]);
  assert.equal(api.changed, "a", "select on_change");
  assert.equal(api.field.for, "e2e-sel");
  assert.equal(api.field.described, "e2e-sel-hint e2e-sel-error");
  assert.equal(api.field.invalid, "true");
  assert.deepEqual([api.field.hint, api.field.error], ["A hint", "An error"]);
  assert.deepEqual(api.disabled, { pressed: 0, aria: "true", title: "Pick an approver first.", desc: "Pick an approver first.", focusable: true }, "a disabled button explains why and stays focusable");
  assert.deepEqual(api.enabled, { pressed: 1, aria: null, desc: null });
  assert.equal(api.digest.text, "sha256:abababa…");
  assert.equal(api.digest.title, "sha256:" + "ab".repeat(32));
  assert.ok(api.digest.copy, "digest has a copy button");
  assert.ok(api.chip.includes("hx-tone-ok") && api.notice.includes("hx-tone-crit"));
  assert.deepEqual(api.table, { caption: "Rows", cells: ["1", "A", "2", "B"], right: true, mono: 2, empty: "Nothing yet." });
  assert.equal(api.json.details, 3);
  assert.deepEqual(api.json.open, [true, false, false], "json_view opens to open_depth");
  assert.ok(api.json.text.includes('"a": 1') && api.json.text.includes('"s"'), api.json.text);
  assert.deepEqual(api.bus, { n: 1 }, "bus delivers until off()");
  assert.deepEqual(api.missing, ["HX.no_such_module"]);
  await page.waitForFunction(() => document.getElementById("hx-live").textContent === "E2E announcement");
  /* tabs: ARIA wiring and arrow-key navigation */
  const tabs = () => page.evaluate(() => ({
    selected: [...document.querySelectorAll("#e2e-tabs [role=tab]")].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.tab),
    tabindex: [...document.querySelectorAll("#e2e-tabs [role=tab]")].map((t) => t.tabIndex),
    panels: [...document.querySelectorAll("#e2e-tabs [role=tabpanel]")].filter((p) => !p.hidden).map((p) => p.textContent),
    focus: document.activeElement && document.activeElement.dataset.tab,
    list: document.querySelector("#e2e-tabs [role=tablist]").getAttribute("aria-label"),
  }));
  assert.deepEqual(await tabs(), { selected: ["one"], tabindex: [0, -1, -1], panels: ["first"], focus: undefined, list: "E2E tabs" });
  await page.focus("#e2e-tabs-tab-one");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await tabs(), { selected: ["two"], tabindex: [-1, 0, -1], panels: ["second"], focus: "two", list: "E2E tabs" });
  await page.keyboard.press("End");
  assert.equal((await tabs()).focus, "three");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual((await tabs()).selected, ["one"], "arrow keys wrap around");
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual((await tabs()).panels, ["third"]);
  assert.equal(await page.evaluate(() => globalThis.__tab_changed), "three", "on_change reports the selected tab");
  /* a horizontal tablist leaves ArrowUp / ArrowDown to the page */
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  assert.deepEqual((await tabs()).selected, ["three"], "ArrowUp and ArrowDown do not switch horizontal tabs");
  assert.equal(await page.getAttribute("#e2e-tabs [role=tablist]", "aria-orientation"), "horizontal");
  await page.evaluate(() => document.getElementById("e2e-host").remove());

  /* ---- reduced motion disables transitions */
  const durations = () => page.evaluate(() => [".hx-rail-link", ".hx-btn", "#hx-theme-toggle"].map((sel) =>
    getComputedStyle(document.querySelector(sel)).transitionDuration));
  const zero = (list) => list.every((d) => d.split(",").every((x) => parseFloat(x) === 0));
  assert.ok(!zero(await durations()), "transitions are on by default");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.ok(zero(await durations()), "prefers-reduced-motion: reduce turns transitions off");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  /* ---- Overview: the machine panel beside the steps never leaves the window when a state takes focus. Its
     caption grows by a line per transition; the sticky decision must already count that, or the panel flips to
     static and jumps off screen (the review saw it end at y=-124 at 1440x790). The build may not have the
     compiler yet, so this page compiles to the Python-built package from golden/ui_fixtures.json. */
  if (t.viewport.width >= 1200 && await page.evaluate(() => !!(HXUI.graph && HXUI.graph.create))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "golden", "ui_fixtures.json"), "utf8")).packages.initial;
    const p2 = await page.context().newPage();
    const errs = [];
    p2.on("pageerror", (e) => errs.push("pageerror: " + (e.stack || e)));
    p2.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    /* the same network rules as the runner: fonts answer empty, anything else is an error */
    await p2.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith("file://")) return route.continue();
      if (u.startsWith("https://fonts.googleapis.com") || u.startsWith("https://fonts.gstatic.com")) {
        return route.fulfill({ status: 200, body: "", contentType: u.includes("css") ? "text/css" : "font/woff2" });
      }
      errs.push("network request attempted: " + u);
      return route.abort();
    });
    await p2.addInitScript((pkg) => {
      const HX = (globalThis.HX = globalThis.HX || {});
      const hash = () => HX.data.python_build.initial_artifact_hash;
      HX.compile = { compile_procurement: () => ({ status: "valid", attempts: [], package: Object.assign({}, pkg, { artifact_hash: hash() }) }) };
      if (!HX.catalog) HX.catalog = { load_catalog: (x) => x, digest: () => HX.data.python_build.catalog_digest };
      if (!HX.validate) HX.validate = {};
    }, pkg);
    for (const [w, hgt] of [[1440, 790], [1440, 820], [1440, 900], [1280, 800], [1280, 840], [1280, 1000]]) {
      await p2.setViewportSize({ width: w, height: hgt });
      await p2.goto(url + "#overview");
      await booted(p2);
      await p2.waitForFunction(() => document.querySelector(".ov-machine")?.dataset.graph === "ready", null, { timeout: 15000 });
      await frames(p2);
      const res = await p2.evaluate(async () => {
        const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const panel = document.querySelector(".ov-machine");
        const split = panel.parentNode.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        /* scroll into the stretch where a sticky panel is held at the top of the window */
        scrollTo(0, scrollY + pr.top - 16 + Math.max(0, Math.min(60, split.height - pr.height - 4)));
        await tick();
        const fit = panel.dataset.fit;
        const at_rest = panel.getBoundingClientRect();
        const at_rest_doc = at_rest.top + scrollY;
        const bad = [];
        for (const g of panel.querySelectorAll(".hxg-canvas g[data-state][tabindex]")) {
          g.focus({ preventScroll: true });
          await tick();
          const r = panel.getBoundingClientRect();
          const id = g.getAttribute("data-state");
          if (panel.dataset.fit !== fit) bad.push(`${id}: fit ${fit} -> ${panel.dataset.fit}`);
          /* a panel that fits stays put on screen; a taller one may scroll the page, but only to clear the caption bar
             from the focused state: in the document it never moves (no sticky flip, no reflow above it) */
          if (fit === "yes" && Math.abs(r.top - at_rest.top) > 1) bad.push(`${id}: panel moved from ${Math.round(at_rest.top)} to ${Math.round(r.top)}`);
          if (Math.abs(r.top + scrollY - at_rest_doc) > 1) bad.push(`${id}: panel moved in the document from ${Math.round(at_rest_doc)} to ${Math.round(r.top + scrollY)}`);
          const cap = panel.querySelector(".hxg-caption"), gr = g.getBoundingClientRect(), cr = cap ? cap.getBoundingClientRect() : null;
          if (cr && gr.bottom > cr.top + 0.5 && gr.top < cr.bottom - 0.5) bad.push(`${id}: the focused state is under the caption bar`);
          if (fit === "yes" && (r.top < 0 || r.bottom > innerHeight + 0.5)) bad.push(`${id}: sticky panel spans ${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerHeight}`);
        }
        const n = panel.querySelectorAll(".hxg-canvas g[data-state][tabindex]").length;
        document.activeElement.blur();
        return { fit, top: at_rest.top, bad, n, sticky: getComputedStyle(panel).position };
      });
      assert.ok(res.n > 3, `the overview graph has focusable states at ${w}x${hgt}`);
      assert.deepEqual(res.bad, [], `at ${w}x${hgt} (fit ${res.fit}) focusing a state keeps the machine panel in place`);
      if (res.fit === "yes") assert.ok(res.sticky === "sticky" && Math.abs(res.top - 16) <= 1, `at ${w}x${hgt} the panel that fits is held 16px from the top`);
    }
    assert.ok(errs.length === 0, `overview sticky page errors: ${errs.join("; ")}`);
    await p2.close();
  }

  /* ---- a boot failure shows a readable error panel and sets data-boot="failed" (no uncaught error) */
  await page.addInitScript(() => {
    const target = {};
    globalThis.HXUI = new Proxy(target, {
      set(t, key, value) {
        t[key] = key === "attach_shell" ? () => { throw new Error("injected boot failure"); } : value;
        return true;
      },
    });
  });
  await page.goto("about:blank");
  await page.goto(url);
  await booted(page);
  const failed = await page.evaluate(() => {
    const app = document.getElementById("app");
    const panel = app.querySelector(".hx-boot-error[role=alert]");
    return { boot: app.dataset.boot, title: panel && panel.querySelector("h1").textContent, detail: panel && panel.querySelector("pre").textContent };
  });
  assert.equal(failed.boot, "failed");
  assert.equal(failed.title, "The lab could not start");
  assert.ok(failed.detail.includes("injected boot failure"), "the panel says what failed");
}
