// Guided tour (app/65_tour.js): the Overview's "Start guided demo" drives HX.demo step by step. Each step shows its
// narration lines, opens the section that shows its effect and mirrors the demo's environment into the lab. The final
// summary matches HX.data-independent expectations: the proposal is CANDIDATE then ADMITTED, the shortcut is EXCLUDED,
// exactly one ERP draft, the active version unchanged by step 6b (and the tour says so with the hash).
// Also: an engine error stops the tour with a retry; a change made to the demo's run from the workbench stops it
// with a designed state instead of narrating events that did not happen; Start while running returns to the guide.
// 1280px and 400px, both themes.
const SECTIONS = { "1": "compile", "2": "run", "3": "run", "4": "run", "5": "run", "6a": "learn", "6b": "learn" };

const settled = (page) => page.waitForFunction(() => ["ready", "done", "error", "changed"].includes(document.getElementById("tour")?.dataset.status), null, { timeout: 30000 });

export default async function (t) {
  const { page, assert } = t;
  await t.open();
  const needs = await page.evaluate(() => (HXUI.tour ? HXUI.tour.NEEDS : []));
  const missing = await page.evaluate((n) => HXUI.engine_missing(n), needs);
  if (missing.length) {
    /* the designed unavailable state: a disabled Start with its reason, or a visible panel naming what is missing */
    const disabled = await page.evaluate(() => document.getElementById("ov-demo-start").getAttribute("aria-disabled"));
    if (disabled !== "true") {
      await page.click("#ov-demo-start");
      await page.waitForSelector('#tour[data-status="unavailable"]');
      const txt = await page.evaluate(() => document.getElementById("tour").innerText);
      for (const m of missing) assert.ok(txt.includes(m), "the panel names " + m);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "tour-title");
      await page.click("#tour-end");
      assert.equal(await page.evaluate(() => !!document.getElementById("tour")), false);
    }
    return;
  }

  /* ---- an engine error: the failed step is named and marked, Run the demo again is the primary action */
  await page.click("#ov-demo-start");
  await settled(page);
  assert.equal(await page.evaluate(() => document.getElementById("tour").dataset.step), "1");
  await page.evaluate(() => {
    const d = HXUI.tour.demo();
    d.next = () => { const e = new Error("ix_0000000000000002"); e.code = "ALREADY_ANSWERED"; e.msg = "ix_0000000000000002"; throw e; };
  });
  await page.click("#tour-next");
  await page.waitForFunction(() => document.getElementById("tour").dataset.status === "error");
  const err = await page.evaluate(() => ({
    title: document.getElementById("tour-title").textContent, counter: document.getElementById("tour-counter").textContent,
    failed: [...document.querySelectorAll('.tour-dot[data-state="failed"]')].map((x) => x.lastElementChild.textContent.trim()),
    body: document.getElementById("tour").innerText, restart: !document.getElementById("tour-restart").hidden,
    next: !document.getElementById("tour-next").hidden, focus: document.activeElement && document.activeElement.id,
  }));
  assert.equal(err.title, "Step 2 failed: Run a clean intake");
  assert.equal(err.counter, "Stopped at step 2 of 7");
  assert.deepEqual(err.failed, ["2"], "the failed step is marked");
  assert.ok(/approval was already answered/.test(err.body), "a plain sentence says what went wrong: " + err.body);
  assert.ok(/ALREADY_ANSWERED/.test(err.body), "the engine code follows");
  assert.ok(err.restart && !err.next, "Run the demo again replaces Next");
  assert.equal(err.focus, "tour-restart");
  await page.click("#tour-restart");
  await settled(page);
  assert.equal(await page.evaluate(() => [document.getElementById("tour").dataset.step, HXUI.tour.demo().results.length].join()), "1,1", "a fresh demo");

  /* ---- a change made from the workbench stops the tour before it narrates something that did not happen */
  await page.click("#tour-next");
  await settled(page);
  assert.equal(await page.evaluate(() => document.getElementById("tour").dataset.step), "2");
  const approve = await page.$("#rn-approve");
  if (approve && await approve.isVisible() && await page.evaluate(() => document.getElementById("rn-approve").getAttribute("aria-disabled") !== "true")) {
    await page.selectOption("#rn-approver", "user:bob").catch(() => {});
    await page.click("#rn-approve");
  } else {
    await page.evaluate(() => { HXUI.lab.env.clock.advance(3600); HXUI.lab_changed("env"); });
  }
  /* the guide notices without waiting for Next */
  await page.waitForFunction(() => document.getElementById("tour").dataset.status === "changed", null, { timeout: 5000 });
  const ch = await page.evaluate(() => ({ title: document.getElementById("tour-title").textContent, body: document.getElementById("tour").innerText,
    restart: !document.getElementById("tour-restart").hidden, next: !document.getElementById("tour-next").hidden, results: HXUI.tour.demo().results.length }));
  assert.ok(/changed/.test(ch.title), ch.title);
  assert.ok(!/REFUSED/.test(ch.body), "nothing is narrated as a refusal");
  assert.equal(ch.results, 2, "step 3 did not run");
  assert.ok(ch.restart && !ch.next);
  await page.click("#tour-restart");
  await settled(page);

  /* ---- the whole tour */
  const seen = [];
  for (;;) {
    await settled(page);
    const s = await page.evaluate(() => {
      const tour = document.getElementById("tour");
      const d = HXUI.tour.demo();
      const i = d.results.length - 1;
      return { status: tour.dataset.status, step: tour.dataset.step, section: HXUI.current(), lines: document.querySelectorAll("#tour-lines li").length,
        want_lines: d.results[i].lines.filter((l) => !/^== /.test(l)).length,
        mirrored: HXUI.lab.env === d.ctx.env, runs: HXUI.lab.runs.map((r) => r.run_id), selected: HXUI.lab.selected_run,
        current: [...document.querySelectorAll('.tour-dot[aria-current="step"]')].map((x) => x.lastElementChild.textContent.trim()),
        erp: HXUI.lab.env.erp.count("acme"), text: tour.innerText, active_hash: d.ctx.active_after ? d.ctx.active_after[0] : null,
        error: ["error", "changed"].includes(tour.dataset.status) ? tour.innerText : "" };
    });
    assert.equal(s.error, "", "step " + s.step + " runs");
    seen.push(s.step);
    assert.equal(s.section, SECTIONS[s.step], "step " + s.step + " opens its section");
    assert.equal(s.lines, s.want_lines, "step " + s.step + " shows its narration lines");
    assert.ok(s.mirrored, "the lab shows the demo's environment");
    if (s.step !== "1") assert.ok(s.runs.includes(s.selected), "the demo's run is selected in the lab");
    if (s.step === "4" || s.step === "5") assert.equal(s.erp, 1, "exactly one ERP draft after the timeout after commit (step " + s.step + ")");
    if (s.status === "done") {
      assert.deepEqual(s.current, [], "no step is current once the demo is finished");
      assert.ok(s.text.includes(s.active_hash.slice(0, 23)), "step 6b names the unchanged active hash");
      break;
    }
    assert.deepEqual(s.current, [s.step], "the step shown is the current one");
    if (s.step === "6a" && await page.evaluate(() => !!HXUI.learn)) {
      await page.waitForFunction(() => HXUI.learn.state().store === HXUI.tour.demo().ctx.env.store, null, { timeout: 30000 });
    }
    if (s.step === "3") {
      /* Back to overview keeps the tour; the Overview marks the steps in text, not only color */
      await page.click("#tour-back");
      await page.waitForFunction(() => HXUI.current() === "overview");
      const ov = await page.evaluate(() => [1, 2, 3, 4].map((n) => {
        const li = document.getElementById("ov-step-" + n);
        return [li.dataset.status, li.getAttribute("aria-current") || "", (li.querySelector(".tour-ov-mark") || { textContent: "" }).textContent.trim()].join("|");
      }));
      assert.deepEqual(ov, ["done||Done", "done||Done", "active|step|Current", "idle||"]);
      assert.ok(await page.evaluate(() => !!document.getElementById("tour")), "the guide stays open");
      /* Start while the tour runs returns to the guide; it does not discard it */
      assert.equal(await page.evaluate(() => document.querySelector("#ov-demo-start .hx-btn-label").textContent), "Continue guided demo");
      await page.click("#ov-demo-start");
      assert.equal(await page.evaluate(() => HXUI.tour.demo().results.length + "|" + (document.activeElement && document.activeElement.id)), "3|tour-title");
    }
    await page.click("#tour-next");
  }
  assert.deepEqual(seen, ["1", "2", "3", "4", "5", "6a", "6b"]);
  const sum = await page.evaluate(() => {
    const v = (k) => document.getElementById("tour-sum-" + k).dataset.value;
    const d = HXUI.tour.demo();
    const env = HXUI.lab.env;
    const body = document.querySelector(".tour-body");
    return { proposal: v("proposal"), admission: v("admission"), shortcut: v("shortcut"), drafts: v("drafts"), active: v("active"),
      selfapp: v("self-approval"), erp: env.erp.count("acme"),
      active_hash: env.store.get_active("sandbox", d.ctx.refined.machine.skill_id)[0], refined: d.ctx.refined.artifact_hash,
      first: d.results[5].facts.proposal, summary_text: document.getElementById("tour-summary").innerText,
      summary_first: body.firstElementChild && body.firstElementChild.id, last_open: document.querySelector(".tour-last").open,
      focus: document.activeElement && document.activeElement.id, lab_log: (HXUI.lab.log || []).filter((x) => x.source === "tour").map((x) => x.step) };
  });
  assert.equal(sum.first, "CANDIDATE");
  assert.equal(sum.proposal, "CANDIDATE");
  assert.equal(sum.admission, "ADMITTED");
  assert.equal(sum.shortcut, "EXCLUDED");
  assert.equal(sum.drafts, "1");
  assert.equal(sum.selfapp, "true");
  assert.equal(sum.active, "true", "step 6b leaves the active version unchanged");
  assert.equal(sum.active_hash, sum.refined, "the refined machine stays active");
  assert.equal(sum.erp, 2, "one draft from the clean intake plus one from the refined machine's run");
  assert.ok(/Lines equal the Python CLI/.test(sum.summary_text), "the narration equals the Python CLI's output");
  assert.equal(sum.summary_first, "tour-summary", "the summary comes before the last step's detail");
  assert.equal(sum.last_open, false, "step 6b's detail starts closed");
  assert.equal(sum.focus, "tour-summary-title", "focus moves to the summary");
  assert.deepEqual(sum.lab_log, ["6a", "6b"], "the tour publishes its learning results");
  /* the Run workbench lists the demo's runs, with the selected one shown */
  await page.evaluate(() => HXUI.go("run"));
  await page.waitForFunction(() => HXUI.current() === "run");
  const run = await page.evaluate(() => ({ text: document.getElementById("sec-run").innerText, sel: HXUI.lab.selected_run,
    collapsed: document.getElementById("tour").dataset.collapsed }));
  assert.ok(run.text.includes(run.sel), "the Run workbench shows the selected demo run");
  assert.ok(/Guided demo/.test(run.text), "the Run workbench names the demo's runs");
  assert.equal(run.collapsed, "true", "away from Learn, the finished guide is one line");
  await page.click("#tour-expand");
  assert.ok(await page.evaluate(() => !!document.getElementById("tour-summary")), "Show summary expands it");
  /* Reset lab ends the tour */
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  await page.waitForFunction(() => !document.getElementById("tour"));
  assert.equal(await page.evaluate(() => HXUI.tour.active()), false);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".tour-ov-mark").length), 0, "the Overview marks are cleared");
}
