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
    assert.ok(["unavailable", "ready"].includes(st), "Break it renders without the full engine");
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
      asserts: [...document.querySelectorAll("#br-asserts .br-assert")].map((a) => a.classList.contains("is-ok")),
      hash: document.getElementById("br-hash")?.getAttribute("title") || document.getElementById("br-hash")?.textContent,
      diffs: document.querySelectorAll(".br-diff .br-line.is-add, .br-diff .br-line.is-del").length,
      pressed: document.querySelector('.br-mut[aria-pressed="true"]')?.dataset.mutation,
    }));
    assert.equal(got.state, "caught", `${id}: caught`);
    assert.deepEqual(got.codes, want.codes, `${id}: the page's codes equal Python's`);
    assert.deepEqual([...new Set(got.findings)].sort(), want.codes, `${id}: the findings list shows those codes`);
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
  /* typed by hand, live */
  await page.fill("#br-guards", "__import__('os').system('rm -rf /') == 0\nconstructor.constructor('globalThis.__hx_pwned=2')() == 1");
  await page.waitForFunction(() => document.querySelectorAll("#br-guard-results .br-guard.is-bad").length === 2);
  assert.equal(await page.evaluate(() => typeof globalThis.__hx_pwned), "undefined");

  /* errors in the editors say what to fix */
  await page.fill("#br-types", "{\"repair_count\": \"int\"}");
  await page.waitForFunction(() => !document.getElementById("br-types-error")?.hidden);
  assert.match(await page.evaluate(() => document.getElementById("br-types-error").textContent), /Use one of string, integer/);
  await page.fill("#br-env", "{\"a\": 1,");
  await page.waitForFunction(() => !document.getElementById("br-env-error")?.hidden);
  assert.equal(await page.evaluate(() => document.getElementById("br-types").getAttribute("aria-invalid")), "true");
  await frames(page);
}
