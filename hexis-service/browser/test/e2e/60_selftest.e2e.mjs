// Self-test (app/60_selftest.js, app/62_checks.js, golden/selftest.json): the first visit runs every check in the page,
// streaming results in chunks; with the full engine and the embedded golden sample, every check passes (no failures,
// no skips). Checks for missing engine modules are skipped with the designed reason. 1280px and 400px, both themes.
export default async function (t) {
  const { page, assert } = t;
  await t.open();
  await page.evaluate(() => HXUI.go("selftest"));
  /* streaming: while the run is in progress some rows have passed and others still wait, and the page answers */
  await page.waitForFunction(() => {
    const root = document.getElementById("st-root");
    if (!root || root.dataset.runState !== "running") return false;
    const st = [...document.querySelectorAll("tr[data-check]")].map((tr) => tr.dataset.status);
    return st.some((x) => x === "pass" || x === "skip") && st.some((x) => x === "pending");
  }, null, { timeout: 60000, polling: 5 });
  assert.equal(await page.evaluate(() => document.getElementById("st-run").getAttribute("aria-disabled")), "true", "Run all checks is disabled while a run is in progress");
  await page.waitForFunction(() => document.getElementById("st-root").dataset.runState === "done", null, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const root = document.getElementById("st-root");
    const rows = [...document.querySelectorAll("tr[data-check]")].map((tr) => ({ key: tr.dataset.check, status: tr.dataset.status, text: tr.innerText }));
    const res = HXUI.selftest.results();
    const missing = HXUI.engine_missing(["demo", "env", "service", "kernel", "update", "replay", "traces", "reference", "compile", "guards", "canonical"]);
    return { pass: +root.dataset.pass, fail: +root.dataset.fail, skip: +root.dataset.skip, total: +root.dataset.total, rows, res, missing,
      embed: !!HXUI.checks.embed(), ids: HXUI.checks.list().map((c) => c.id),
      embed_listed: /"selftest"/.test((document.getElementById("hx-embed") || { textContent: "" }).textContent.slice(0, 4000)),
      modules: [...document.querySelectorAll(".st-modules tr[data-module]")].map((tr) => ({ prefix: tr.dataset.module, status: tr.dataset.status })),
      inventory: HXUI.engine_inventory().map((m) => ({ prefix: m.prefix, present: m.ns.every((n) => globalThis.HX && HX[n] !== undefined && HX[n] !== null) })),
      p1: (document.querySelector('tr[data-check="p-initial"] .hx-digest') || { dataset: {} }).dataset.full || null,
      p1_want: HX.data && HX.data.python_build ? HX.data.python_build.initial_artifact_hash : null,
      groups: [...document.querySelectorAll("details.st-group")].map((g) => ({ open: g.open, problems: g.querySelectorAll('tr[data-status="fail"], tr[data-status="skip"]').length })) };
  });
  const failures = r.res.filter((x) => x.status === "fail").map((x) => x.id + " " + x.name + ": " + x.message);
  assert.deepEqual(failures, [], "no check fails");
  assert.equal(r.fail, 0);
  assert.equal(r.pass + r.skip, r.total);
  assert.equal(r.rows.length, r.total, "one row per check");
  assert.ok(r.total >= 60, "parity, golden and acceptance checks: " + r.total);
  for (let n = 1; n <= 32; n++) {
    const id = "A" + String(n).padStart(2, "0");
    assert.ok(r.ids.includes(id), "an acceptance check for " + id);
  }
  if (r.embed_listed) assert.ok(r.embed, "the golden sample in #hx-embed parses");
  /* the engine inventory lists every module, loaded where its namespaces are present */
  assert.ok(r.modules.length >= 20, "the engine inventory lists the modules");
  const inv = await page.evaluate(() => ({ n: HXUI.engine_inventory().length, scripts: document.querySelectorAll("script[data-hx-module^='src/']").length,
    rail: (document.querySelector(".hx-rail-note .hx-link") || {}).textContent || "", extras: HXUI.engine_extras() }));
  assert.equal(inv.n, inv.scripts, "the inventory has one row per engine script in the build");
  assert.ok(!inv.extras.includes("eval"), "HX.eval is an inventory module, not an extra namespace");
  assert.match(inv.rail, new RegExp("of " + inv.scripts + " modules loaded"), "the rail counts every engine module: " + inv.rail);
  /* the shared summary strip opens the section with the counts */
  const strip = await page.evaluate(() => [...document.querySelectorAll("#st-summary .hx-sum-item")].map((x) => x.id));
  assert.deepEqual(strip, ["st-sum-passed", "st-sum-failed", "st-sum-skipped", "st-sum-time"], "Self-test opens with its summary strip");
  for (const m of r.inventory) {
    const row = r.modules.find((x) => x.prefix === m.prefix);
    assert.ok(row, "inventory row for module " + m.prefix);
    if (m.present) assert.equal(row.status, "loaded", "module " + m.prefix + " is loaded");
  }
  if (r.p1_want && r.res.find((x) => x.key === "p-initial").status === "pass") assert.equal(r.p1, r.p1_want, "P1 shows the full digest");
  /* groups at rest: closed when every check passed, open when one failed or was skipped */
  for (const g of r.groups) assert.equal(g.open, g.problems > 0, "a group is open exactly when it has problems");
  if (!r.missing.length && r.embed) {
    assert.equal(r.skip, 0, "nothing is skipped with the full engine and the golden sample");
    assert.equal(r.pass, r.total);
  }
  for (const x of r.res.filter((y) => y.status === "skip")) assert.ok(/Needs/.test(x.message), "a skip says what it needs: " + x.message);
  const text = await page.evaluate(() => document.querySelector(".st-headline").textContent);
  assert.ok(/passed/.test(text), "the headline reports the result: " + text);

  /* the filter shows only failed and skipped checks */
  await page.check("#st-problems-only");
  const shown = await page.evaluate(() => document.querySelectorAll("tr[data-check]").length);
  assert.equal(shown, r.fail + r.skip, "only problems are listed");
  const note = await page.evaluate(() => { const n = document.getElementById("st-filter-note"); return n.hidden ? "" : n.innerText; });
  if (r.fail + r.skip === 0) assert.ok(/No failed or skipped checks/.test(note), "one notice when nothing failed: " + note);
  else assert.equal(note, "", "no all-clear notice while there are problems");
  await page.uncheck("#st-problems-only");
  assert.equal(await page.evaluate(() => document.querySelectorAll("tr[data-check]").length), r.total);

  /* run again from the button (keyboard) */
  await page.focus("#st-run");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("st-root").dataset.runState === "running");
  await page.waitForFunction(() => document.getElementById("st-root").dataset.runState === "done", null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => +document.getElementById("st-root").dataset.fail), 0, "the second run passes too");
  const junk = await page.evaluate(() => /\b(undefined|NaN)\b|\[object Object\]/.exec(document.getElementById("sec-selftest").innerText));
  assert.equal(junk, null, "no undefined, NaN or [object Object] in the section");
}
