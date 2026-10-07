// Learn from traces (app/40_learn.js): the at-rest state (archive seeded as the demo does, the missing-documents
// proposal, the shortcut check and the evaluation all computed in the page), enroll (one finished run ADMITTED,
// one in-flight run skipped with a reason), propose with every development trace, admit (ADMITTED, the active
// pointer moves), the A18 race (one ADMITTED, one CONFLICT, the loser rebases to NO_CHANGE), the shortcut
// (EXCLUDED, the candidate's gates fail with an ORDERING_VIOLATION path, active version unchanged) and the
// evaluation tables. Every status on screen is compared with what the engine's store holds.

async function goto_learn(t) {
  await t.open();
  await t.page.evaluate(() => HXUI.go("learn"));
  await t.page.waitForFunction(() => {
    const el = document.getElementById("ln");
    return el && (el.dataset.init === "done" || el.dataset.init === "error");
  }, null, { timeout: 30000 });
  const init = await t.page.evaluate(() => document.getElementById("ln").dataset.init);
  t.assert.equal(init, "done", "the at-rest sequence finished");
}

/** what the store holds now */
function engine(page) {
  return page.evaluate(() => {
    const env = HXUI.lab.env;
    const skill = HXUI.lab.packages.initial.machine.skill_id;
    const a = env.store.archive(skill);
    return { active: env.store.get_active("sandbox", skill), protected: a.protected.map((e) => e.trace_id), version: a.version,
      negative: a.negative.map((e) => e.trace_id), refined: HX.data.python_build.refined_artifact_hash,
      initial: HX.data.python_build.initial_artifact_hash };
  });
}

async function wait_idle(page) {
  await page.waitForFunction(() => Object.values(HXUI.learn.state().busy).every((v) => !v));
}

async function click(page, id) {
  await page.click("#" + id);
  await wait_idle(page);
}

export default async function (t) {
  const { page, assert } = t;
  await goto_learn(t);

  /* ---- at rest: the archive was seeded as the demo does */
  let e = await engine(page);
  assert.equal(e.protected.length, 2, "two seeded traces in the stored archive");
  assert.equal(await page.getAttribute("#ln-origin", "data-mode"), "seeded");
  assert.equal(await page.getAttribute("#ln-archive-body", "data-count"), "2");
  const rows = await page.$$eval("#ln-archive-body tr[data-trace]", (trs) => trs.map((tr) => tr.dataset.trace));
  assert.deepEqual(rows.slice().sort(), e.protected.slice().sort(), "the table lists the stored archive");
  const terms = await page.$$eval("#ln-archive-body tr[data-trace]", (trs) => trs.map((tr) => tr.textContent));
  assert.ok(terms.some((x) => x.includes("END_VERIFIED_DRAFT")) && terms.some((x) => x.includes("END_REVIEW")), "a verified run and a review run");
  assert.equal(e.active[0], e.initial, "the initial machine is active at rest");

  /* stable, unique ids and a label on every control */
  const dom = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    const unlabeled = Array.from(document.querySelectorAll("#sec-learn select, #sec-learn input, #sec-learn textarea"))
      .filter((c) => !c.id || !document.querySelector("label[for='" + c.id + "']")).map((c) => c.outerHTML.slice(0, 80));
    return { dup, unlabeled };
  });
  assert.deepEqual(dom.dup, [], "duplicate ids");
  assert.deepEqual(dom.unlabeled, [], "controls without a label");

  /* the missing-documents proposal at rest: CANDIDATE, every gate passing, the Python refined hash */
  assert.equal(await page.getAttribute("#ln-proposal", "data-status"), "CANDIDATE");
  const gates = await page.$$eval("#ln-gates tr[data-gate]", (trs) => trs.map((tr) => [tr.dataset.gate, tr.dataset.passed]));
  assert.deepEqual(gates, [["policy_non_widening", "true"], ["static_validation", "true"], ["new_trace_replay", "true"],
    ["protected_replay", "true"], ["negative_corpus", "true"]], "every gate passes");
  assert.match(await page.textContent("#ln-gates tr[data-gate=protected_replay]"), /2 protected traces replayed, 0 failures/);
  assert.equal(await page.getAttribute("#ln-proposal-candidate", "title"), e.refined, "candidate hash equals the Python refined hash");
  assert.match(await page.textContent("#ln-diff"), /REQUEST_INPUT/);

  /* ---- enroll: one finished run, one still waiting */
  const made = await page.evaluate(() => {
    const env = HXUI.lab.env;
    const alice = env.principal("user:alice");
    const hash = HXUI.lab.packages.initial.artifact_hash;
    const done = env.service.start_run(hash, HX.env.task({ supplier_ref: "SUP-55555" }), alice);
    const r1 = env.service.run_until_blocked(done.run_id, alice);
    const wait = env.service.start_run(hash, HX.env.task(), alice);
    const r2 = env.service.run_until_blocked(wait.run_id, alice);
    HXUI.lab_changed("runs");
    return { done: done.run_id, done_status: r1.status, wait: wait.run_id, wait_status: r2.status };
  });
  assert.equal(made.done_status, "COMPLETED");
  assert.equal(made.wait_status, "WAITING_FOR_APPROVAL");
  assert.equal(await page.getAttribute("#ln-enroll", "aria-disabled"), null, "enroll is available with a finished run");
  await click(page, "ln-enroll");
  const enr = await page.$$eval("#ln-enroll-result tr[data-run]", (trs) => trs.map((tr) => [tr.dataset.run, tr.dataset.result, tr.textContent]));
  const by = Object.fromEntries(enr.map((r) => [r[0], r]));
  assert.equal(by[made.done][1], "ADMITTED", "the finished run is enrolled");
  assert.equal(by[made.wait][1], "SKIPPED", "the waiting run is skipped");
  assert.match(by[made.wait][2], /still WAITING_FOR_APPROVAL/);
  e = await engine(page);
  assert.equal(e.protected.length, 3);
  assert.ok(e.protected.includes("trace:" + made.done));
  assert.equal(await page.getAttribute("#ln-archive-body", "data-count"), "3");
  assert.equal(await page.getAttribute("#ln-enroll", "aria-disabled"), "true", "nothing finished is left to enroll");

  /* ---- propose again (now against 3 protected traces), then admit */
  await click(page, "ln-propose");
  assert.equal(await page.getAttribute("#ln-proposal", "data-status"), "CANDIDATE");
  assert.match(await page.textContent("#ln-gates tr[data-gate=protected_replay]"), /3 protected traces replayed, 0 failures/);
  const before = (await engine(page)).active;
  await click(page, "ln-admit");
  assert.equal(await page.getAttribute("#ln-admission", "data-status"), "ADMITTED");
  assert.equal(await page.getAttribute("#ln-admission-pointer", "data-moved"), "true");
  e = await engine(page);
  assert.equal(e.active[0], e.refined, "the active pointer moved to the candidate");
  assert.ok(e.active[1] > before[1], "a new archive version");
  assert.ok(e.protected.includes("dev:missing-docs-then-supplied"), "the originating trace joined the archive");
  assert.equal(await page.getAttribute("#ln", "data-active"), e.refined);
  assert.equal(await page.evaluate(() => HXUI.lab.packages.refined.artifact_hash), e.refined, "the Run workbench sees the refined package");
  assert.equal(await page.getAttribute("#ln-admit", "aria-disabled"), "true", "the active candidate cannot be admitted twice");

  /* proposing the same trace against the new parent: NO_CHANGE, and the race explains why it cannot run */
  await click(page, "ln-propose");
  assert.equal(await page.getAttribute("#ln-proposal", "data-status"), "NO_CHANGE");
  assert.equal(await page.getAttribute("#ln-race", "aria-disabled"), "true");
  assert.match(await page.getAttribute("#ln-race", "aria-description"), /NO_CHANGE/);

  /* ---- the shortcut against the refined machine: EXCLUDED, gates fail with an ORDERING_VIOLATION path, unchanged */
  await click(page, "ln-sc-run");
  const sc = await page.$eval("#ln-shortcut", (el) => ({ ...el.dataset }));
  assert.equal(sc.eligibility, "EXCLUDED");
  assert.equal(sc.passed, "false");
  assert.equal(sc.unchanged, "true");
  const sv = await page.textContent("#ln-sc-gates tr[data-gate=static_validation]");
  assert.match(sv, /ORDERING_VIOLATION/);
  assert.match(sv, /REPAIR_DRAFT\s*→?\s*(then)?\s*REQUEST_APPROVAL/);
  assert.equal(await page.getAttribute("#ln-sc-gates tr[data-gate=static_validation]", "data-passed"), "false");
  assert.equal(await page.getAttribute("#ln-sc-gates tr[data-gate=negative_corpus]", "data-passed"), "false");
  assert.equal(await page.getAttribute("#ln-sc-active", "title"), (await engine(page)).active[0], "the active version shown is the store's");
  assert.equal((await engine(page)).active[0], e.refined, "the shortcut never moved the pointer");

  /* the other development traces */
  await page.selectOption("#ln-trace", "shortcut");
  await click(page, "ln-propose");
  assert.equal(await page.getAttribute("#ln-proposal", "data-status"), "EXCLUDED");
  assert.match(await page.textContent("#ln-proposal-diagnostics"), /ORD-VALIDATE-BEFORE-WRITE/);
  await page.selectOption("#ln-trace", "forbidden-write");
  await click(page, "ln-propose");
  assert.equal(await page.getAttribute("#ln-proposal", "data-status"), "EXCLUDED");
  assert.match(await page.textContent("#ln-proposal-diagnostics"), /ORD-APPROVAL-BEFORE-WRITE/);

  /* ---- evaluation */
  await page.waitForSelector("#ln-eval");
  const ev = await page.evaluate(() => {
    const r = HXUI.learn.state().evaluation.result;
    const cell = (sel, i) => document.querySelectorAll(sel + " td")[i].textContent.trim();
    return {
      shown: [cell("#ln-eval-summary tr[data-metric=business_success]", 1), cell("#ln-eval-summary tr[data-metric=business_success]", 2)],
      want: [HX.eval.fmt2(r.arms.initial_compiled.summary.business_success), HX.eval.fmt2(r.arms.trace_refined.summary.business_success)],
      tasks: document.querySelectorAll("#ln-eval-tasks tr[data-task]").length, rows: r.arms.initial_compiled.rows.length,
      overlap: Array.from(document.querySelectorAll("#ln-eval-tasks tr[data-overlap=yes]")).map((tr) => tr.dataset.task),
      want_overlap: Object.keys(r.dev_overlap), timing: document.getElementById("ln-eval-timing").textContent,
      notrun: document.getElementById("ln-eval-notrun").textContent, heldout: !!document.getElementById("ln-eval-heldout"),
      arts: r.artifacts, pb: HX.data.python_build,
    };
  });
  assert.deepEqual(ev.shown, ev.want, "business_success for both arms");
  assert.equal(ev.tasks, ev.rows);
  assert.deepEqual(ev.overlap, ev.want_overlap, "dev-overlap flags");
  assert.ok(ev.heldout, "strictly held-out table");
  assert.match(ev.timing, new RegExp("Ran 2 × " + ev.rows + " tasks in .+ in this page"));
  assert.match(ev.notrun, /needs a live model/);
  assert.equal(ev.arts.initial, ev.pb.initial_artifact_hash);
  assert.equal(ev.arts.refined, ev.pb.refined_artifact_hash);

  /* ---- A18 on a fresh page: two candidates for one parent, one ADMITTED, one CONFLICT */
  await goto_learn(t);
  const parent = (await engine(page)).active[0];
  await click(page, "ln-race");
  const race = await page.$$eval("#ln-race-result tr[data-race]", (trs) => trs.map((tr) => [tr.dataset.race, tr.dataset.status]));
  assert.deepEqual(race, [["first", "ADMITTED"], ["second", "CONFLICT"]]);
  assert.match(await page.textContent("#ln-race-result tr[data-race=second]"), /rebase onto the new parent/);
  assert.equal(await page.getAttribute("#ln-race-rebase", "data-status"), "NO_CHANGE");
  e = await engine(page);
  assert.notEqual(e.active[0], parent);
  assert.equal(e.active[0], e.refined, "the fixture aligner's candidate won");
  assert.equal(await page.getAttribute("#ln-race-pointer", "data-moved"), "true");

  /* Reset lab starts the section over: seeded again on the initial machine */
  await page.evaluate(() => HXUI.lab_reset());
  await page.waitForFunction(() => document.getElementById("ln").dataset.init === "done", null, { timeout: 30000 });
  e = await engine(page);
  assert.equal(e.active[0], e.initial);
  assert.equal(e.protected.length, 2);
}
