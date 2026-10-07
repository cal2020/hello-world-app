// Self-test (app/60_selftest.js, app/62_checks.js, golden/selftest.json): the first visit runs every check in the page,
// streaming results in chunks; with the full engine and the embedded golden sample, every check passes (no failures,
// no skips). Checks for missing engine modules are skipped with the designed reason. 1280px and 400px, both themes.
export default async function (t) {
  const { page, assert } = t;
  await t.open();
  await page.evaluate(() => HXUI.go("selftest"));
  /* streaming: the run is in progress and the page still answers between checks */
  await page.waitForFunction(() => ["running", "done"].includes(document.getElementById("st-root")?.dataset.runState));
  const mid = await page.evaluate(() => ({ state: document.getElementById("st-root").dataset.runState, disabled: document.getElementById("st-run").getAttribute("aria-disabled") }));
  if (mid.state === "running") assert.equal(mid.disabled, "true", "Run all checks is disabled while a run is in progress");
  await page.waitForFunction(() => document.getElementById("st-root").dataset.runState === "done", null, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const root = document.getElementById("st-root");
    const rows = [...document.querySelectorAll("tr[data-check]")].map((tr) => ({ key: tr.dataset.check, status: tr.dataset.status, text: tr.innerText }));
    const res = HXUI.selftest.results();
    const missing = HXUI.engine_missing(["demo", "env", "service", "kernel", "update", "replay", "traces", "reference", "compile", "guards", "canonical"]);
    return { pass: +root.dataset.pass, fail: +root.dataset.fail, skip: +root.dataset.skip, total: +root.dataset.total, rows, res, missing,
      embed: !!HXUI.checks.embed(), ids: HXUI.checks.list().map((c) => c.id) };
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
