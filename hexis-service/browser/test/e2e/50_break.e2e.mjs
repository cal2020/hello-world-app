// Break it (app/50_break.js, app/52_mutations.js): every mutation, validated live in the page, is rejected with
// exactly the error codes the Python reference produced for the same mutation (golden/validate_conformance.json,
// production profile with skill text and deployment policy) and the resealed artifact hash Python computed; the
// Python test's own assertions hold. The guard playground proves VALIDATE_DRAFT's guards disjoint, finds the A08
// overlap with its counterexample, and rejects malicious guards without executing them. 1280px and 400px, both themes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, "golden", "validate_conformance.json"), "utf8"));
const VARIANT = GOLDEN.variants.findIndex((v) => v.profile === "production" && v.skill && v.policy);

function frames(page) {
  return page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
}

export default async function (t) {
  const { page, assert } = t;
  page.on("dialog", (d) => { throw new Error("unexpected dialog: " + d.message()); });
  await t.open();
  const missing = await page.evaluate(() => HXUI.engine_missing(["guards", "validate", "compile", "pkg", "catalog", "fixture", "data", "efsm", "clauses", "diff"]));
  await page.evaluate(() => HXUI.go("break"));
  if (missing.length) {
    const st = await page.evaluate(() => document.querySelector('.hx-section[data-section="break"]').dataset.state);
    if (missing.some((n) => /guards$/.test(n))) {
      assert.equal(st, "unavailable", "without HX.guards the whole section is unavailable");
      return;
    }
    /* the guard playground works on its own; the mutation lab shows what it is missing */
    assert.equal(st, "ready");
    const lab = await page.evaluate(() => ({
      missing: document.querySelector(".br-lab .hx-unavailable")?.dataset.missing || "",
      text: document.querySelector(".br-lab .hx-unavailable")?.textContent || "",
    }));
    for (const n of missing) assert.ok(lab.missing.split(" ").includes(n) && lab.text.includes(n), "the mutation lab names the missing " + n);
    await page.waitForFunction(() => !!document.getElementById("br-g-out")?.dataset.status);
    await page.fill("#br-guards", "validation_status == 'pass'\nvalidation_status == 'repairable' and repair_count < 2");
    await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "PROVEN");
    return;
  }

  /* ---- scoreboard: every mutation caught, as in Python */
  await page.waitForFunction(() => document.getElementById("br-score")?.dataset.done === "yes", null, { timeout: 30000 });
  const board = await page.evaluate(() => ({
    n: HXUI.mutations.list.length,
    states: [...document.querySelectorAll(".br-mut")].map((b) => [b.dataset.mutation, b.dataset.state]),
    score: document.getElementById("br-score").textContent,
  }));
  assert.ok(board.n >= 25, "the catalog covers the conformance mutations");
  assert.deepEqual(board.states.filter(([, s]) => s !== "caught"), [], "every mutation is caught as in Python");
  assert.ok(board.score.includes(board.n + " of " + board.n + " caught"), board.score);

  /* ---- each mutation, through the picker, against the golden written by the Python reference */
  const ids = await page.evaluate(() => HXUI.mutations.list.map((m) => ({ id: m.id, case: m.python.case })));
  const wide = t.viewport.width >= 1000;
  for (const { id, case: name } of ids) {
    const gc = GOLDEN.cases.find((c) => c.name === name);
    assert.ok(gc, `golden case ${name} exists`);
    const want = gc.runs[gc.variants.indexOf(VARIANT)];
    if (wide) await page.click(`#br-mut-${id}`);
    else await page.selectOption("#br-mut-select", id);
    await page.waitForFunction((id) => document.getElementById("br-detail")?.dataset.mutation === id, id);
    const got = await page.evaluate(() => ({
      state: document.getElementById("br-detail").dataset.state,
      codes: [...document.querySelectorAll("#br-codes .hx-chip")].map((c) => c.textContent),
      findings: [...document.querySelectorAll("#br-findings > .cp-finding")].map((f) => f.dataset.code),
      located: [...document.querySelectorAll("#br-findings > .cp-finding")].map((f) => [f.dataset.code, f.dataset.state || null, f.dataset.edge === "" || f.dataset.edge === undefined ? null : Number(f.dataset.edge), f.dataset.variable || null]),
      digest: document.getElementById("br-findings")?.dataset.digest || "",
      asserts: [...document.querySelectorAll("#br-asserts .br-assert")].map((a) => a.classList.contains("is-ok")),
      hash: document.getElementById("br-hash")?.getAttribute("title") || document.getElementById("br-hash")?.textContent,
      diffs: document.querySelectorAll(".br-diff .br-line.is-add, .br-diff .br-line.is-del").length,
      pressed: document.querySelector('.br-mut[aria-pressed="true"]')?.dataset.mutation,
    }));
    assert.equal(got.state, "caught", `${id}: caught`);
    assert.deepEqual(got.codes, want.codes, `${id}: the page's codes equal Python's`);
    assert.deepEqual([...new Set(got.findings)].sort(), want.codes, `${id}: the findings list shows those codes`);
    const nul = (v) => (v === undefined ? null : v);
    assert.deepEqual(got.located, want.findings.map((f) => [f.code, nul(f.state), nul(f.edge), nul(f.variable)]), `${id}: each finding's code, state, edge and variable equal Python's, in order`);
    assert.equal(got.digest, want.digest, `${id}: the report digest equals Python's`);
    assert.ok(got.asserts.length && got.asserts.every(Boolean), `${id}: the Python test's assertions hold`);
    assert.equal(got.hash || "none", gc.hash || "none", `${id}: mutated artifact hash equals Python's`);
    assert.ok(got.diffs > 0, `${id}: the before/after view shows the change`);
    assert.equal(got.pressed, id, `${id}: the picker marks the selection`);
  }

  /* ---- guard playground: VALIDATE_DRAFT's guards are disjoint */
  await page.selectOption("#br-guard-source", "VALIDATE_DRAFT");
  await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "PROVEN");
  const vd = await page.evaluate(() => ({
    guards: document.getElementById("br-guards").value.split("\n"),
    machine: HX.efsm.ordered_transitions(HX.compile.compile_procurement().package.machine.states.VALIDATE_DRAFT).filter((x) => x.if).map((x) => x.if),
    ok: document.querySelectorAll("#br-guard-results .br-guard.is-ok").length,
    verdict: document.getElementById("br-verdict")?.textContent || "",
    evals: [...document.querySelectorAll("#br-eval-results .br-guard")].map((g) => g.dataset.value),
  }));
  assert.deepEqual(vd.guards, vd.machine, "pre-filled with VALIDATE_DRAFT's guards");
  assert.equal(vd.ok, vd.machine.length, "both guards type-check");
  assert.deepEqual(vd.evals, ["false", "true"], "evaluated with the pre-filled environment");
  assert.match(vd.verdict, /edge #1 to REPAIR_DRAFT/);

  /* overlap: the analysis finds a counterexample that makes both guards true */
  await page.selectOption("#br-guard-source", "ex-overlap");
  await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "COUNTEREXAMPLE");
  const cx = await page.evaluate(() => [...document.querySelectorAll(".br-cx-table tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)));
  assert.ok(cx.some(([k, v]) => k === "validation_status" && v === "'pass'"), "counterexample sets validation_status to 'pass': " + JSON.stringify(cx));

  /* a variable comparison is undecided: fails closed */
  await page.selectOption("#br-guard-source", "ex-unknown");
  await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "UNKNOWN");

  /* malicious guards are rejected, never executed */
  await page.selectOption("#br-guard-source", "ex-malicious");
  await page.waitForFunction(() => document.querySelectorAll("#br-guard-results .br-guard").length >= 4);
  const mal = await page.evaluate(() => ({
    n: document.querySelectorAll("#br-guard-results .br-guard").length,
    bad: document.querySelectorAll("#br-guard-results .br-guard.is-bad").length,
    errors: [...document.querySelectorAll("#br-guard-results .br-guard-errors")].map((e) => e.textContent),
    pwned: typeof globalThis.__hx_pwned,
  }));
  assert.equal(mal.bad, mal.n, "every malicious guard is rejected");
  assert.ok(mal.errors.every((e) => e.length > 5), "each rejection says why");
  assert.equal(mal.pwned, "undefined", "nothing in a guard ran");
  assert.equal(await page.evaluate(() => document.getElementById("br-g-out").dataset.status), "GUARDS_REJECTED", "rejected guards are not analysed further");
  assert.equal(await page.evaluate(() => !!document.getElementById("br-allowed")), true, "a rejection says what a guard may contain");
  /* typed by hand, live */
  await page.fill("#br-guards", "__import__('os').system('rm -rf /') == 0\nconstructor.constructor('globalThis.__hx_pwned=2')() == 1");
  await page.waitForFunction(() => document.querySelectorAll("#br-guard-results .br-guard.is-bad").length === 2);
  assert.equal(await page.evaluate(() => typeof globalThis.__hx_pwned), "undefined");

  /* errors in the editors say what to fix */
  await page.selectOption("#br-guard-source", "VALIDATE_DRAFT");
  await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "PROVEN");
  await page.fill("#br-types", "{\"repair_count\": \"int\"}");
  await page.waitForFunction(() => !document.getElementById("br-types-error")?.hidden);
  assert.match(await page.evaluate(() => document.getElementById("br-types-error").textContent), /Use one of string, integer/);
  const gated = await page.evaluate(() => ({ status: document.getElementById("br-g-out").dataset.status, results: !!document.getElementById("br-guard-results"),
    text: document.getElementById("br-g-out").textContent, hint: document.getElementById("br-types-hint").textContent }));
  assert.equal(gated.status, "TYPES_INVALID", "invalid types stop the check");
  assert.ok(!gated.results && !/undeclared variable/.test(gated.text), "no cascade of guard rejections from the empty type map");
  assert.match(gated.text, /Fix the variable types above/);
  assert.match(gated.hint, /^Edited\./, "the hint says the types were edited");
  await page.fill("#br-env", "{\"a\": 1,");
  await page.waitForFunction(() => !document.getElementById("br-env-error")?.hidden);
  const env = await page.evaluate(() => ({ env: document.getElementById("br-env").getAttribute("aria-invalid"), types: document.getElementById("br-types").getAttribute("aria-invalid"), text: document.getElementById("br-env-error").textContent }));
  assert.deepEqual([env.env, env.types], ["true", "true"], "both editors are marked invalid");
  assert.ok(!/invalid JSON/i.test(env.text), "the environment error does not repeat itself: " + env.text);
  /* loading guards again restores the machine's types */
  await page.selectOption("#br-guard-source", "READ_BACK");
  await page.waitForFunction(() => document.getElementById("br-g-out")?.dataset.status === "PROVEN");
  assert.equal(await page.evaluate(() => document.getElementById("br-types").getAttribute("aria-invalid")), null);
  await frames(page);

  /* the mutation picker is one Tab stop; the arrow keys move inside it (wide layout) */
  if (wide) {
    await page.focus("#br-mut-a17-shortcut");
    await page.keyboard.press("ArrowDown");
    const next = await page.evaluate(() => document.activeElement.id);
    assert.notEqual(next, "br-mut-a17-shortcut", "ArrowDown moves to the next mutation");
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.id), await page.evaluate(() => [...document.querySelectorAll(".br-mut")].pop().id));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.br-mut[tabindex="0"]').length), 1, "one Tab stop in the list");
  }

  /* Reset lab on Break it: everything is checked again and caught again */
  await page.evaluate(() => HXUI.lab_reset());
  await page.waitForFunction(() => document.getElementById("br-score")?.dataset.done === "yes", null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".br-mut")].filter((b) => b.dataset.state !== "caught").map((b) => b.id)), [], "after a reset every mutation is caught again");
  assert.equal(await page.evaluate(() => document.getElementById("br-detail")?.dataset.mutation), "a17-shortcut", "the reset lab opens on its default mutation");
}
