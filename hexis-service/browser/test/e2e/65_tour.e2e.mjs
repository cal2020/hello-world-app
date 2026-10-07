// Guided tour (app/65_tour.js): the Overview's "Start guided demo" drives HX.demo step by step. Each step shows its
// narration lines, opens the section that shows its effect and mirrors the demo's environment into the lab. The final
// summary matches HX.data-independent expectations: the proposal is CANDIDATE then ADMITTED, the shortcut is EXCLUDED,
// one ERP draft, the active version unchanged by step 6b. 1280px and 400px, both themes.
const SECTIONS = { "1": "compile", "2": "run", "3": "run", "4": "run", "5": "run", "6a": "learn", "6b": "learn" };

export default async function (t) {
  const { page, assert } = t;
  await t.open();
  const missing = await page.evaluate(() => HXUI.engine_missing(["demo", "env", "service", "registry", "update", "reference", "traces", "normalize", "replay", "compile"]));
  if (missing.length) {
    assert.equal(await page.evaluate(() => document.getElementById("ov-demo-start").getAttribute("aria-disabled")), "true");
    return;
  }
  await page.click("#ov-demo-start");
  const seen = [];
  for (;;) {
    await page.waitForFunction(() => ["ready", "done", "error"].includes(document.getElementById("tour")?.dataset.status), null, { timeout: 30000 });
    const s = await page.evaluate(() => {
      const tour = document.getElementById("tour");
      const d = HXUI.tour.demo();
      return { status: tour.dataset.status, step: tour.dataset.step, section: HXUI.current(), lines: document.querySelectorAll("#tour-lines li").length,
        mirrored: HXUI.lab.env === d.ctx.env, runs: HXUI.lab.runs.map((r) => r.run_id), selected: HXUI.lab.selected_run,
        error: tour.dataset.status === "error" ? tour.innerText : "" };
    });
    assert.equal(s.status === "error" ? s.error : "", "", "step " + s.step + " runs");
    seen.push(s.step);
    assert.equal(s.section, SECTIONS[s.step], "step " + s.step + " opens its section");
    assert.ok(s.lines >= 1, "step " + s.step + " shows its narration lines");
    assert.ok(s.mirrored, "the lab shows the demo's environment");
    if (s.step !== "1") assert.ok(s.runs.includes(s.selected), "the demo's run is selected in the lab");
    if (s.status === "done") break;
    if (s.step === "3") {
      /* Back to overview keeps the tour; the Overview marks the steps */
      await page.click("#tour-back");
      await page.waitForFunction(() => HXUI.current() === "overview");
      const ov = await page.evaluate(() => [1, 2, 3, 4].map((n) => document.getElementById("ov-step-" + n).dataset.status));
      assert.deepEqual(ov, ["done", "done", "active", "idle"]);
      assert.ok(await page.evaluate(() => !!document.getElementById("tour")), "the guide stays open");
    }
    await page.click("#tour-next");
  }
  assert.deepEqual(seen, ["1", "2", "3", "4", "5", "6a", "6b"]);
  const sum = await page.evaluate(() => {
    const v = (k) => document.getElementById("tour-sum-" + k).dataset.value;
    const d = HXUI.tour.demo();
    const env = HXUI.lab.env;
    return { proposal: v("proposal"), admission: v("admission"), shortcut: v("shortcut"), drafts: v("drafts"), active: v("active"),
      selfapp: v("self-approval"), erp: env.erp.count("acme"),
      active_hash: env.store.get_active("sandbox", d.ctx.refined.machine.skill_id)[0], refined: d.ctx.refined.artifact_hash,
      first: d.results[5].facts.proposal, summary_text: document.getElementById("tour-summary").innerText,
      focus: document.activeElement && document.activeElement.id };
  });
  assert.equal(sum.first, "CANDIDATE");
  assert.equal(sum.proposal, "CANDIDATE");
  assert.equal(sum.admission, "ADMITTED");
  assert.equal(sum.shortcut, "EXCLUDED");
  assert.equal(sum.drafts, "1");
  assert.equal(sum.selfapp, "true");
  assert.equal(sum.active, "true", "step 6b leaves the active version unchanged");
  assert.equal(sum.active_hash, sum.refined, "the refined machine stays active");
  assert.ok(sum.erp >= 1);
  assert.ok(/Lines equal the Python CLI/.test(sum.summary_text), "the narration equals the Python CLI's output");
  assert.equal(sum.focus, "tour-summary-title", "focus moves to the summary");
  /* the Run workbench lists the demo's runs */
  await page.evaluate(() => HXUI.go("run"));
  await page.waitForFunction(() => HXUI.current() === "run");
  /* Reset lab ends the tour */
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  await page.waitForFunction(() => !document.getElementById("tour"));
  assert.equal(await page.evaluate(() => HXUI.tour.active()), false);
}
