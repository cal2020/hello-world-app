// Compile section (app/20_compile.js): the live compile run (2 attempts, ORDERING_VIOLATION with its counterexample
// path, then a valid repair), the final artifact hash equal to the Python build, SKILL.md clause spans and the
// coverage table linked by hover and focus, the lab state, Compile again, Reset lab, and admission as user:dana
// (ADMITTED, then CONFLICT on the compare-and-swap, both kept in the history) when HX.registry is in the build,
// its designed disabled state otherwise. Clause ids navigate to the clause when the skill pane is off screen,
// with a way back. Every control has a stable id. Runs at 1280px and 400px, light and dark.

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
  /* the page shows exactly what the engine computes */
  const eng = await page.evaluate(() => {
    const r = HX.compile.compile_procurement();
    return {
      attempts: r.attempts.map((a) => ({ status: a.status, codes: (a.findings || []).map((f) => f.code),
        paths: (a.findings || []).filter((f) => f.detail && Array.isArray(f.detail.path) && f.detail.path.length).map((f) => f.detail.path) })),
      coverage: r.coverage.map((c) => [c.clause, c.classification, c.critical ? "yes" : "no"]).sort(),
    };
  });
  assert.deepEqual(att.map((a) => ({ status: a.status, codes: a.codes, paths: a.paths })), eng.attempts, "attempts, findings and paths equal HX.compile's");
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
    cov: [...document.querySelectorAll("tr[data-row-clause]")].map((r) => [r.dataset.rowClause, r.dataset.classification, r.dataset.critical]).sort(),
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
  assert.deepEqual(cl.cov, eng.coverage, "each row's classification and criticality equal HX.compile's coverage");

  /* stable ids: every control in the section has an author-given id (no auto ids from HXUI.uid) */
  const ids = await page.evaluate(() => [...document.querySelectorAll('.hx-section[data-section="compile"] button, .hx-section[data-section="compile"] a[href], .hx-section[data-section="compile"] [tabindex="0"]:not(.hx-table-scroll)')]
    .filter((el) => !el.closest("[hidden]")).map((el) => el.id || el.outerHTML.slice(0, 60)));
  assert.deepEqual(ids.filter((id) => !id || /^hx-(copy|field)-\d+$/.test(id) || id.startsWith("<")), [], "every control has a stable id");

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

  /* selecting a clause id below the two columns goes to the clause, and Back returns */
  await page.evaluate(() => document.getElementById("cp-cov-S5-1").scrollIntoView({ block: "center" }));
  await page.click("#cp-cov-S5-1");
  await page.waitForFunction(() => document.activeElement?.id === "cp-clause-S5.1");
  await page.waitForFunction(() => { const r = document.getElementById("cp-clause-S5.1").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, null, { timeout: 3000 });
  const back = await page.evaluate(() => ({ lit: document.getElementById("cp-clause-S5.1").classList.contains("is-lit"), text: document.getElementById("cp-skill-back").textContent, hidden: document.getElementById("cp-skill-back").hidden }));
  assert.ok(back.lit && !back.hidden, "the clause is lit and a way back is offered");
  assert.match(back.text, /Back to coverage of S5\.1/);
  await page.click("#cp-skill-back");
  await page.waitForFunction(() => document.activeElement?.id === "cp-cov-S5-1");
  await page.waitForFunction(() => { const r = document.getElementById("cp-cov-S5-1").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById("cp-skill-back").hidden), true, "Back hides once used");

  /* ---- Compile again: runs the engine again, same result */
  await page.click("#cp-compile");
  await page.waitForFunction(() => /\(run 2\)/.test(document.getElementById("cp-timing")?.textContent || ""));
  await wait_compiled(page);
  assert.equal(await page.evaluate(() => document.getElementById("cp-hash").textContent), hash.python);

  /* ---- admission */
  const admit_missing = await page.evaluate(() => HXUI.engine_missing(["registry", "store", "policy"]));
  const history = (p) => p.evaluate(() => [...document.querySelectorAll("#cp-admissions .cp-admission")].map((a) => [a.id, a.dataset.status]));
  if (!admit_missing.length) {
    await page.click("#cp-admit");
    await page.waitForSelector("#cp-admissions");
    const a1 = await page.evaluate(() => ({
      status: document.getElementById("cp-admissions").dataset.latest,
      version: document.getElementById("cp-admit-1-version")?.textContent,
      key: document.getElementById("cp-admit-1-key")?.textContent,
      at: document.querySelector("#cp-admission-1 time")?.getAttribute("datetime"),
      lab: HXUI.lab.compile.admission && HXUI.lab.compile.admission.status,
    }));
    assert.equal(a1.status, "ADMITTED", "dana admits the compiled package");
    assert.ok(a1.version && a1.key, "the result shows the archive version and the signature key id");
    assert.match(a1.at || "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "admitted_at is shown as a UTC time");
    assert.equal(a1.lab, "ADMITTED");
    await page.click("#cp-admit");
    await page.waitForFunction(() => document.getElementById("cp-admissions")?.dataset.latest === "CONFLICT");
    assert.deepEqual(await history(page), [["cp-admission-2", "CONFLICT"], ["cp-admission-1", "ADMITTED"]], "the history keeps version 1 under the conflict");
    assert.match(await page.evaluate(() => document.querySelector("#cp-admission-2 .cp-admission-note").textContent), /already has version 1 active/);
  } else {
    const btn = await page.evaluate(() => {
      const b = document.getElementById("cp-admit");
      return { disabled: b.getAttribute("aria-disabled"), why: b.getAttribute("aria-description") || "", reason: document.getElementById("cp-admit-reason")?.textContent || "" };
    });
    assert.equal(btn.disabled, "true", "admission is disabled without " + admit_missing.join(", "));
    for (const n of admit_missing) assert.ok(btn.why.includes(n) && btn.reason.includes(n.replace(/^HX\./, "")), "the disabled control names " + n);
    await page.click("#cp-admit", { force: true });
    assert.equal(await page.evaluate(() => document.getElementById("cp-admissions")), null, "a disabled admit does nothing");
  }
  if (admit_missing.length === 1 && /registry$/.test(admit_missing[0])) {
    /* the wiring, against a stand-in registry that records its call (the real one replaces it once ported) */
    const p2 = await page.context().newPage();
    const errs = [];
    p2.on("pageerror", (e) => errs.push(String(e)));
    await p2.route("**/*", (r) => (r.request().url().startsWith("file://") ? r.continue() : r.fulfill({ status: 200, body: "" })));
    await p2.addInitScript(() => {
      const HX = (globalThis.HX = globalThis.HX || {});
      globalThis.__admits = [];
      HX.registry = {
        admit(store, pkg, catalog, o) {
          globalThis.__admits.push({ store: !!store, hash: pkg.artifact_hash, parent: o.expected_parent_hash, approver: o.approver.id,
            roles: o.approver.roles.slice(), env: o.environment, skill: o.skill_text === HX.data.skill_md, policy: !!o.deployment_policy, now: o.now });
          return globalThis.__admits.length === 1
            ? { status: "ADMITTED", artifact_hash: pkg.artifact_hash, reasons: [], archive_version: 1,
                record: { key_id: "insecure-demo-key", approver: o.approver.id, environment: o.environment, admitted_at: "2026-09-21T13:46:40.250000+00:00", signature: "hmac-sha256:" + "a".repeat(64), validation_report_digest: "sha256:" + "b".repeat(64) } }
            : { status: "CONFLICT", artifact_hash: pkg.artifact_hash, reasons: ["active version is " + pkg.artifact_hash + ", expected None"], record: null, archive_version: null };
        },
      };
    });
    await p2.setViewportSize(t.viewport);
    await p2.goto(page.url().split("#")[0] + "#compile");
    await wait_compiled(p2);
    await p2.click("#cp-admit");
    await p2.waitForSelector("#cp-admissions");
    const s1 = await p2.evaluate(() => ({ status: document.getElementById("cp-admissions").dataset.latest, version: document.getElementById("cp-admit-1-version").textContent,
      key: document.getElementById("cp-admit-1-key").textContent, call: globalThis.__admits[0], label: document.getElementById("cp-admit").textContent,
      python: HX.data.python_build.initial_artifact_hash }));
    assert.deepEqual([s1.status, s1.version, s1.key], ["ADMITTED", "1", "insecure-demo-key"]);
    assert.deepEqual(s1.call, { store: true, hash: s1.python, parent: null, approver: "user:dana", roles: s1.call.roles, env: "sandbox", skill: true, policy: true, now: 1790000000.25 });
    assert.ok(s1.call.roles.includes("artifact_admin"), "dana is authenticated with the admin role");
    assert.equal(s1.label, "Admit again");
    await p2.click("#cp-admit");
    await p2.waitForFunction(() => document.getElementById("cp-admissions")?.dataset.latest === "CONFLICT");
    assert.match(await p2.evaluate(() => document.querySelector("#cp-admission-2 .cp-reasons").textContent), /expected None/);
    assert.deepEqual(await history(p2), [["cp-admission-2", "CONFLICT"], ["cp-admission-1", "ADMITTED"]]);
    assert.deepEqual(errs, []);
    await p2.close();
  }

  /* ---- Reset lab while on Compile: the at-rest state comes back, computed again */
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  await wait_compiled(page);
  const after = await page.evaluate(() => ({
    lab: HXUI.lab.compile && HXUI.lab.compile.artifact_hash,
    admission: document.getElementById("cp-admissions"),
    timing: document.getElementById("cp-timing").textContent,
  }));
  assert.equal(after.lab, hash.python, "the reset lab gets a fresh compile");
  assert.equal(after.admission, null, "the admission result is cleared");
  assert.ok(!/run 2/.test(after.timing), "the run counter restarts");
}
