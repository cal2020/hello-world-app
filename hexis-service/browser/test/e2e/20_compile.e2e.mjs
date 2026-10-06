// Compile section (app/20_compile.js): the live compile run (2 attempts, ORDERING_VIOLATION with its counterexample
// path, then a valid repair), the final artifact hash equal to the Python build, SKILL.md clause spans and the
// coverage table linked by hover and focus, the lab state, Compile again, Reset lab, and admission as user:dana
// (ADMITTED, then CONFLICT on the compare-and-swap) when HX.registry is in the build, its designed disabled state
// otherwise. Runs at 1280px and 400px, light and dark.

async function wait_compiled(page) {
  await page.waitForFunction(() => document.getElementById("cp-summary")?.dataset.status === "validated", null, { timeout: 20000 });
}

export default async function (t) {
  const { page, assert } = t;
  page.on("dialog", (d) => { throw new Error("unexpected dialog: " + d.message()); });
  await t.open();
  const present = await page.evaluate(() => HXUI.engine_missing(["compile", "clauses", "validate", "diff", "fixture", "catalog", "pkg", "efsm", "guards", "data"]));
  await page.evaluate(() => HXUI.go("compile"));
  if (present.length) {
    const state = await page.evaluate(() => document.querySelector('.hx-section[data-section="compile"]').dataset.state);
    assert.equal(state, "unavailable", "without the compiler the section shows its unavailable state");
    return;
  }
  await wait_compiled(page);

  /* ---- attempts: invalid (ORDERING_VIOLATION with paths), then valid */
  const att = await page.evaluate(() => [...document.querySelectorAll(".cp-attempt")].map((a) => ({
    status: a.dataset.status,
    codes: [...a.querySelectorAll(".cp-finding")].map((f) => f.dataset.code),
    paths: [...a.querySelectorAll(".cp-path")].map((p) => [...p.querySelectorAll(".cp-path-state")].map((c) => c.textContent)),
    repair: !!a.querySelector(".cp-diff"),
  })));
  assert.equal(att.length, 2, "two attempts");
  assert.deepEqual(att.map((a) => a.status), ["invalid", "valid"]);
  assert.ok(att[0].codes.length >= 1 && att[0].codes.every((c) => c === "ORDERING_VIOLATION"), "attempt 1 fails only on ordering");
  assert.equal(att[0].paths.length, att[0].codes.length, "each ordering violation shows its counterexample path");
  for (const p of att[0].paths) {
    assert.equal(p[0], "READ_INTAKE", "the path starts at the initial state");
    assert.ok(["PERSIST_DRAFT", "REQUEST_APPROVAL"].includes(p[p.length - 1]), "the path ends at the guarded action: " + p.join(" > "));
    assert.ok(p.includes("REPAIR_DRAFT") && !p.slice(p.indexOf("REPAIR_DRAFT")).includes("VALIDATE_DRAFT"), "the defect: repair goes on without validating again");
  }
  assert.ok(att[1].repair && att[1].codes.length === 0, "attempt 2 is valid and shows what the repair changed");

  /* ---- final hash equals the Python build, computed in this page */
  const hash = await page.evaluate(() => ({
    shown: document.getElementById("cp-hash").textContent,
    ref: document.getElementById("cp-hash-ref").textContent,
    python: HX.data.python_build.initial_artifact_hash,
    live: HX.compile.compile_procurement().package.artifact_hash,
    parity: document.querySelector(".cp-artifact").dataset.parity,
    chip: document.getElementById("cp-parity").textContent,
    lab: HXUI.lab.compile && HXUI.lab.compile.artifact_hash,
  }));
  assert.equal(hash.shown, hash.live, "the shown hash is the engine's");
  assert.equal(hash.shown, hash.python, "the hash equals the Python build's");
  assert.equal(hash.ref, hash.python);
  assert.equal(hash.parity, "equal");
  assert.match(hash.chip, /Equal to the Python build/);
  assert.equal(hash.lab, hash.python, "HXUI.lab.compile holds the result");

  /* ---- SKILL.md clause spans and coverage */
  const cl = await page.evaluate(() => ({
    spans: [...document.querySelectorAll(".cp-clause")].map((s) => s.dataset.clause),
    crit: [...document.querySelectorAll(".cp-clause.is-critical")].map((s) => s.dataset.clause),
    index: HX.clauses.index_clauses(HX.data.skill_md).map((c) => c.id),
    rows: [...document.querySelectorAll("tr[data-row-clause]")].map((r) => r.dataset.rowClause),
    text_ok: [...document.querySelectorAll(".cp-clause")].every((s) => {
      const c = HX.clauses.index_clauses(HX.data.skill_md).find((x) => x.id === s.dataset.clause);
      const shown = [...s.childNodes].filter((n) => !(n.classList && (n.classList.contains("cp-cid") || n.classList.contains("hx-visually-hidden")))).map((n) => n.textContent).join("");
      return shown === c.text.split("**MUST**").join("MUST");
    }),
  }));
  assert.deepEqual(cl.spans, cl.index, "every clause of HX.clauses is wrapped, in order");
  assert.deepEqual(cl.crit, ["S3.1", "S4.1", "S5.1"], "the MUST clauses are marked");
  assert.ok(cl.text_ok, "each span holds exactly its clause text");
  assert.deepEqual(cl.rows.slice().sort(), cl.index.slice().sort(), "the coverage table has one row per clause");

  await page.hover('tr[data-row-clause="S3.1"]');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".cp-clause.is-lit")].map((s) => s.dataset.clause)), ["S3.1"], "hovering a row highlights its clause");
  await page.mouse.move(0, 0);
  await page.focus("#cp-cov-S4-1");
  await page.waitForFunction(() => document.querySelector('.cp-clause[data-clause="S4.1"]').classList.contains("is-lit"));
  const vis = await page.evaluate(() => {
    const pane = document.getElementById("cp-source").getBoundingClientRect();
    return new Promise((res) => setTimeout(() => {
      const s = document.querySelector('.cp-clause[data-clause="S4.1"]').getBoundingClientRect();
      const p = document.getElementById("cp-source").getBoundingClientRect();
      res({ inside: s.top >= p.top - 1 && s.top <= p.bottom, pane });
    }, 700));
  });
  assert.ok(vis.inside, "focusing a clause id scrolls the skill pane to the clause");
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0; });
  assert.ok(ring, "the focused clause id is visibly outlined");

  /* ---- Compile again: runs the engine again, same result */
  await page.click("#cp-compile");
  await page.waitForFunction(() => /\(run 2\)/.test(document.getElementById("cp-timing")?.textContent || ""));
  await wait_compiled(page);
  assert.equal(await page.evaluate(() => document.getElementById("cp-hash").textContent), hash.python);

  /* ---- admission */
  const has_registry = await page.evaluate(() => HXUI.engine_missing(["registry", "store", "policy"]).length === 0);
  if (has_registry) {
    await page.click("#cp-admit");
    await page.waitForSelector("#cp-admission");
    const a1 = await page.evaluate(() => ({
      status: document.getElementById("cp-admission").dataset.status,
      version: document.getElementById("cp-admit-version")?.textContent,
      key: document.getElementById("cp-admit-key")?.textContent,
      lab: HXUI.lab.compile.admission && HXUI.lab.compile.admission.status,
    }));
    assert.equal(a1.status, "ADMITTED", "dana admits the compiled package");
    assert.ok(a1.version && a1.key, "the result shows the archive version and the signature key id");
    assert.equal(a1.lab, "ADMITTED");
    await page.click("#cp-admit");
    await page.waitForFunction(() => document.getElementById("cp-admission")?.dataset.status === "CONFLICT");
  } else {
    const btn = await page.evaluate(() => {
      const b = document.getElementById("cp-admit");
      return { disabled: b.getAttribute("aria-disabled"), why: b.getAttribute("aria-description") || "", reason: document.getElementById("cp-admit-reason")?.textContent || "" };
    });
    assert.equal(btn.disabled, "true", "admission is disabled without the registry");
    assert.ok(btn.why.includes("HX.registry") && btn.reason.includes("HX.registry"), "the disabled control names the missing module");
    await page.click("#cp-admit");
    assert.equal(await page.evaluate(() => document.getElementById("cp-admission")), null, "a disabled admit does nothing");
  }

  /* ---- Reset lab while on Compile: the at-rest state comes back, computed again */
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  await wait_compiled(page);
  const after = await page.evaluate(() => ({
    lab: HXUI.lab.compile && HXUI.lab.compile.artifact_hash,
    admission: document.getElementById("cp-admission"),
    timing: document.getElementById("cp-timing").textContent,
  }));
  assert.equal(after.lab, hash.python, "the reset lab gets a fresh compile");
  assert.equal(after.admission, null, "the admission result is cleared");
  assert.ok(!/run 2/.test(after.timing), "the run counter restarts");
}
