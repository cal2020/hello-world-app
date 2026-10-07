// Run workbench (app/30_run.js, 31_scenarios.js, 32_inspector.js): the at-rest state (scenario preselected, no
// environment built until a run starts), the happy path to END_VERIFIED_DRAFT approved by user:bob, the approval
// negative demos (self-approval NOT_AUTHORIZED, tampered scope SCOPE_MISMATCH, user:mallory NOT_FOUND), restart while
// waiting then resume, timeout_after_commit (one ERP draft, EFFECT_UNKNOWN + RECONCILED), a crash at each
// FaultInjector point then Restart worker then completion, cancel, the registry conflict (END_REVIEW), missing
// documents on the refined machine (disabled with a reason until it is admitted; admitted here through the engine
// API exactly as golden/gen_runtime.py's admit_raw does), and Reset lab. Every status shown is compared with the
// engine's own records. Runs at 1280px and 400px, light and dark.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NEEDS = ["env", "service", "kernel", "broker", "store", "policy", "approvals", "fakes", "compile", "registry", "canonical", "catalog", "metrics"];

function refined_json() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "golden", "runtime.json"), "utf8")).refined_json || null; } catch (e) { return null; }
}

/** What the screen shows next to what the engine holds for the selected run. */
async function state(page) {
  return page.evaluate(() => {
    const env = HXUI.lab.env;
    const id = HXUI.lab.selected_run;
    let run = null, cp = null;
    if (env && id) {
      for (const t of ["acme", "globex"]) { run = env.store.get_run(t, id); if (run) break; }
      if (run) cp = env.store.latest_checkpoint(run.tenant_id, id);
    }
    const res = (a) => { const el = document.getElementById("rn-" + a + "-result"); return el && !el.hidden ? { code: el.dataset.code, tone: el.dataset.tone, text: el.textContent } : null; };
    const out = document.getElementById("rn-outcome");
    return {
      shown_status: document.getElementById("rn").dataset.status,
      shown_run: document.getElementById("rn").dataset.run,
      status: run ? run.status : null, state_id: cp ? cp.state_id : null, outcome: cp ? cp.outcome : null,
      sum_state: document.getElementById("rn-sum-state").textContent,
      erp: env ? env.erp.count("acme") : 0,
      sum_erp: Number(document.querySelector("#rn-sum-erp [data-count]").dataset.count),
      drive: res("drive"), human: res("human"), start: res("start"), faults: res("faults"),
      outcome_card: out && !out.hidden ? { terminal: out.dataset.terminal, category: out.dataset.category, status: out.dataset.status } : null,
      approval: !!document.getElementById("rn-approval"), input: !!document.getElementById("rn-input"),
      graph_current: (() => { const v = document.querySelector("#rn-graph [data-status]:not([data-status=''])"); return v ? v.getAttribute("data-status") : null; })(),
      crash: document.getElementById("rn").dataset.crash,
    };
  });
}

const click = (page, id) => page.click("#" + id);
async function disabled(page, id) {
  return page.evaluate((i) => { const b = document.getElementById(i); return { off: b.getAttribute("aria-disabled") === "true", why: b.getAttribute("aria-description") || "" }; }, id);
}

async function start(page, assert, scenario, opts) {
  const o = opts || {};
  if (scenario) await page.check("#rn-sc-" + scenario);
  if (o.initiator) await page.selectOption("#rn-initiator", o.initiator);
  await click(page, "rn-start");
  const s = await state(page);
  assert.equal(s.start && s.start.code, "STARTED", "start result: " + JSON.stringify(s.start));
  assert.ok(s.shown_run && s.shown_run === (await page.evaluate(() => HXUI.lab.selected_run)), "the new run is selected");
  return s.shown_run;
}

async function until(page, assert, expect) {
  await click(page, "rn-until");
  const s = await state(page);
  assert.equal(s.status, expect, "run_until_blocked status (" + JSON.stringify(s.drive) + ")");
  assert.equal(s.shown_status, s.status, "the screen shows the engine's status");
  assert.ok(s.sum_state.indexOf(s.state_id) === 0, "the summary shows the checkpoint state " + s.state_id);
  return s;
}

async function approve(page, assert, who, opts) {
  const o = opts || {};
  await page.selectOption("#rn-approver", who);
  if (o.tamper) await page.check("#rn-tamper"); else if (await page.isChecked("#rn-tamper")) await page.uncheck("#rn-tamper");
  await click(page, o.reject ? "rn-reject" : "rn-approve");
  return state(page);
}

export default async function (t) {
  const { page, assert } = t;
  page.on("dialog", (d) => { throw new Error("unexpected dialog: " + d.message()); });
  await t.open();
  const missing = await page.evaluate((n) => HXUI.engine_missing(n), NEEDS);
  await page.evaluate(() => HXUI.go("run"));
  await page.waitForFunction(() => HXUI.current() === "run");
  if (missing.length) {
    const st = await page.evaluate(() => document.querySelector('.hx-section[data-section="run"]').dataset.state);
    assert.equal(st, "unavailable", "without the runtime modules the section shows its unavailable state");
    return;
  }

  /* ---- at rest: complete and ready, nothing built yet */
  const rest = await page.evaluate(() => ({
    state: document.querySelector('.hx-section[data-section="run"]').dataset.state,
    checked: document.querySelector("input[name=rn-scenario]:checked").value,
    env: HXUI.lab.env,
    status: document.getElementById("rn").dataset.status,
    graph: !!document.querySelector("#rn-graph svg"),
    start_off: document.getElementById("rn-start").getAttribute("aria-disabled"),
    step_why: document.getElementById("rn-step").getAttribute("aria-description"),
    md_disabled: document.getElementById("rn-sc-missing-docs").disabled,
    md_reason: document.getElementById("rn-sc-missing-docs-reason").textContent,
    ids_ok: [...document.querySelectorAll("#rn input, #rn select, #rn textarea")].every((c) => c.id && (c.labels && c.labels.length || c.closest("label"))),
    buttons_ok: [...document.querySelectorAll("#rn button")].every((b) => b.id || b.closest(".hx-tablist") || b.classList.contains("hx-copy") || b.closest(".hxg")),
  }));
  assert.equal(rest.state, "ready");
  assert.equal(rest.checked, "clean", "clean intake is preselected");
  assert.equal(rest.env, null, "no environment is built until a run starts");
  assert.equal(rest.status, "idle");
  assert.ok(rest.graph, "the machine is drawn at rest");
  assert.equal(rest.start_off, null, "Start run is ready");
  assert.match(rest.step_why, /Start a run first/, "Step explains why it is disabled");
  assert.ok(rest.md_disabled && /refined machine/.test(rest.md_reason), "missing documents is disabled with a reason until refined is admitted");
  assert.ok(rest.ids_ok, "every form control has an id and a label");
  assert.ok(rest.buttons_ok, "every workbench button has a stable id");

  /* ---- happy path with the approval negative demos */
  const r1 = await start(page, assert, "clean");
  assert.equal(r1, "run_0000000000000001", "deterministic ids: the first run id equals the Python reference's");
  await click(page, "rn-step");
  let s = await state(page);
  assert.equal(s.status, "RUNNING");
  assert.equal(s.state_id, "LOOKUP_SUPPLIER", "one step: READ_INTAKE -> LOOKUP_SUPPLIER");
  s = await until(page, assert, "WAITING_FOR_APPROVAL");
  assert.equal(s.state_id, "REQUEST_APPROVAL");
  assert.ok(s.approval, "the approval panel appears");
  assert.equal(s.erp, 0, "nothing is written before approval");
  const scope = await page.evaluate(() => {
    const env = HXUI.lab.env;
    const id = HXUI.lab.selected_run;
    const cp = env.store.latest_checkpoint("acme", id);
    const ix = env.store.interaction_for_revision("acme", id, cp.revision);
    return { shown: document.getElementById("rn-scope-digest").getAttribute("title"), engine: ix.scope_digest,
      args: document.getElementById("rn-scope-args").getAttribute("title"), engine_args: ix.scope.args_digest };
  });
  assert.equal(scope.shown, scope.engine, "the scope digest shown is the interaction's");
  assert.equal(scope.args, scope.engine_args);
  s = await approve(page, assert, "user:alice");
  assert.equal(s.human.code, "NOT_AUTHORIZED", "self-approval is refused with a code");
  assert.match(s.human.text, /user:bob/, "the error says how to fix it");
  s = await approve(page, assert, "user:bob", { tamper: true });
  assert.equal(s.human.code, "SCOPE_MISMATCH", "a tampered scope digest is refused");
  s = await approve(page, assert, "user:mallory");
  assert.equal(s.human.code, "NOT_FOUND", "another tenant cannot even see the run");
  assert.equal(s.status, "WAITING_FOR_APPROVAL", "refused approvals change nothing");
  s = await approve(page, assert, "user:bob");
  assert.equal(s.human.code, "APPROVED");
  assert.equal(s.status, "RUNNING");
  assert.equal(s.state_id, "PERSIST_DRAFT");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "rn-until", "focus moves to the next action when the approval panel closes");
  s = await until(page, assert, "COMPLETED");
  assert.deepEqual([s.outcome.terminal, s.outcome.category], ["END_VERIFIED_DRAFT", "verified"]);
  assert.deepEqual(s.outcome_card, { terminal: "END_VERIFIED_DRAFT", category: "verified", status: "COMPLETED" }, "the outcome card shows the engine's outcome");
  assert.equal(s.erp, 1);
  assert.equal(s.sum_erp, 1);
  assert.equal((await disabled(page, "rn-step")).off, true, "Step is disabled once the run has finished");
  /* inspector: timeline, variables, ledger, evidence, ERP and metrics all read from the engine */
  const insp = await page.evaluate(async () => {
    const env = HXUI.lab.env;
    const id = HXUI.lab.selected_run;
    const ins = env.service.inspect_run(id, env.principal("user:alice"));
    const tab = (x) => document.getElementById("rn-insp-tab-" + x).click();
    const out = {};
    out.events = document.querySelectorAll("#rn-timeline .rn-ev").length;
    out.engine_events = ins.events.filter((e) => e.type !== "TIMING").length;
    tab("variables"); out.vars = document.querySelectorAll(".rn-vars tbody tr").length; out.engine_vars = Object.keys(ins.checkpoint.variables).length;
    tab("ledger"); out.receipts = document.querySelectorAll(".rn-receipts tbody tr").length; out.engine_receipts = ins.action_receipts.length;
    tab("evidence"); out.invalid = document.querySelectorAll('.rn-evidence tr[data-valid="0"]').length; out.engine_invalid = ins.evidence.filter((e) => e.invalidated_at !== null).length;
    tab("erp"); out.erp = Number(document.getElementById("rn-erp-count").dataset.count);
    tab("metrics"); out.metrics = HX.metrics ? !!document.querySelector(".rn-split-legend") : !!document.querySelector("#rn-insp-panel-metrics .hx-unavailable");
    tab("timeline");
    return out;
  });
  assert.equal(insp.events, insp.engine_events, "timeline lists every non-timing event");
  assert.equal(insp.vars, insp.engine_vars);
  assert.equal(insp.receipts, insp.engine_receipts);
  assert.equal(insp.invalid, insp.engine_invalid);
  assert.ok(insp.invalid >= 1, "the repair invalidated the first validation receipt");
  assert.equal(insp.erp, 1);
  assert.ok(insp.metrics, "metrics render from HX.metrics.collect (or its unavailable state without HX.metrics)");

  /* ---- restart while waiting, then resume */
  await start(page, assert, "clean");
  await until(page, assert, "WAITING_FOR_APPROVAL");
  const env_before = await page.evaluate(() => { globalThis.__env = HXUI.lab.env; return true; });
  assert.ok(env_before);
  await click(page, "rn-restart");
  s = await state(page);
  assert.equal(s.drive.code, "RESTARTED");
  assert.equal(await page.evaluate(() => HXUI.lab.env !== globalThis.__env), true, "the lab keeps the restarted env");
  assert.equal(s.status, "WAITING_FOR_APPROVAL", "the run survives the restart");
  s = await approve(page, assert, "user:bob");
  assert.equal(s.human.code, "APPROVED");
  s = await until(page, assert, "COMPLETED");
  assert.equal(s.outcome.terminal, "END_VERIFIED_DRAFT");
  assert.equal(s.erp, 2);

  /* ---- timeout after commit: one draft, reconciled */
  await start(page, assert, "clean");
  await until(page, assert, "WAITING_FOR_APPROVAL");
  await approve(page, assert, "user:bob");
  await page.selectOption("#rn-fault", "timeout_after_commit");
  await click(page, "rn-fault-arm");
  s = await state(page);
  assert.equal(s.faults.code, "ARMED");
  assert.match(await page.evaluate(() => document.getElementById("rn-armed").dataset.armed), /timeout_after_commit/);
  s = await until(page, assert, "COMPLETED");
  assert.equal(s.outcome.terminal, "END_VERIFIED_DRAFT");
  assert.equal(s.erp, 3, "exactly one more ERP draft");
  const kinds = await page.evaluate(() => [...document.querySelectorAll("#rn-timeline .rn-ev")].map((e) => e.dataset.type));
  assert.ok(kinds.includes("EFFECT_UNKNOWN") && kinds.includes("RECONCILED"), "the timeline shows EFFECT_UNKNOWN and RECONCILED");

  /* ---- a crash at each FaultInjector point, restart, completion */
  const points = await page.evaluate(() => HX.broker.FaultInjector.POINTS.slice());
  let drafts = s.erp;
  for (const point of points) {
    await start(page, assert, "clean");
    await until(page, assert, "WAITING_FOR_APPROVAL");
    await approve(page, assert, "user:bob");
    await page.selectOption("#rn-fault", point);
    await click(page, "rn-fault-arm");
    await click(page, "rn-until");
    s = await state(page);
    assert.equal(s.drive && s.drive.code, "SIMULATED_CRASH", point + ": the crash is shown inline");
    assert.match(s.drive.text, new RegExp("Worker crashed at " + point));
    assert.equal(s.crash, point);
    const why = await disabled(page, "rn-step");
    assert.ok(why.off && /Restart the worker/.test(why.why), point + ": Step waits for a restart");
    await click(page, "rn-crash-restart");
    s = await state(page);
    assert.equal(s.crash, "", point + ": the restart clears the crash");
    s = await until(page, assert, "COMPLETED");
    assert.equal(s.outcome.terminal, "END_VERIFIED_DRAFT", point + ": completes after the restart");
    drafts += 1;
    assert.equal(s.erp, drafts, point + ": never a duplicate write");
  }

  /* ---- cancel */
  await start(page, assert, "clean");
  await click(page, "rn-step");
  await click(page, "rn-cancel");
  s = await state(page);
  /* worker-1 still holds the lease, so the canceller records the request and the worker finishes it (as in Python) */
  assert.equal(s.drive.code, "CANCEL_REQUESTED");
  assert.match(s.drive.text, /another worker holds the lease/);
  await click(page, "rn-step");
  s = await state(page);
  assert.equal(s.status, "CANCELLED");
  assert.equal(s.outcome_card && s.outcome_card.status, "CANCELLED");

  /* ---- registry conflict */
  await start(page, assert, "registry-conflict");
  s = await until(page, assert, "COMPLETED");
  assert.deepEqual([s.outcome.terminal, s.outcome.category], ["END_REVIEW", "fallback"], "the registry conflict stops for review");
  assert.equal(s.erp, drafts, "nothing written");

  /* ---- custom JSON: errors are inline and block Start */
  await page.check("#rn-sc-custom");
  await page.fill("#rn-custom", "{\"supplier_ref\": 1.0}");
  await page.waitForTimeout(350);
  const custom = await page.evaluate(() => ({ err: document.getElementById("rn-custom-error").hidden ? "" : document.getElementById("rn-custom-error").textContent,
    off: document.getElementById("rn-start").getAttribute("aria-disabled") }));
  assert.ok(custom.err.length > 10 && custom.off === "true", "invalid task JSON is reported inline and Start is disabled: " + custom.err);
  await page.check("#rn-sc-clean");

  /* ---- missing documents on the refined machine */
  const text = refined_json();
  const admitted = await page.evaluate((txt) => {
    if (HX.update && HX.reference) {
      const env = HXUI.lab.env;
      const pkg = HXUI.lab.packages.initial;
      const R = HX.reference;
      const trace = R.missing_docs_trace();
      const prop = HX.update.propose_update(pkg, trace, [], [], env.catalog, new R.FixtureAligner(), HX.env.skill_source().text);
      const adm = HX.registry.admit(env.store, prop.candidate, env.catalog, { expected_parent_hash: pkg.artifact_hash,
        approver: env.principal("user:dana"), environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(),
        protected: [trace], negative: [], now: env.clock(), skill_text: HX.env.skill_source().text });
      HXUI.lab.packages.refined = prop.candidate;
      HXUI.lab_changed("packages");
      return adm.status;
    }
    if (!txt) return "no refined package";
    /* golden/gen_runtime.py admit_raw: validation, signed record, atomic publish (the archive gates need HX.update) */
    const env = HXUI.lab.env;
    const pkg = HX.pkg.normalize_package(HX.canonical.strict_loads(txt));
    const rep = HX.validate.validate_package(pkg, env.catalog, "production", { skill_text: HX.env.skill_source().text, deployment_policy: HX.fixture.deployment_policy() });
    if (!rep.passed) return "refined package does not validate";
    const rj = rep.to_json();
    const [key_id, key] = HX.registry.signing_key();
    const now = env.clock();
    const man = HX.registry._manifest_of([], []);
    const rec = HX.pkg.sign_admission({ artifact_hash: pkg.artifact_hash, environment: "sandbox", approver: "user:dana",
      admitted_at: HX.registry._utc_isoformat(now), validation_report_digest: rj.report_digest,
      replay_archive_digest: HX.canonical.digest(man), key_id }, key);
    HX.registry.register(env.store, pkg, "user:dana", now);
    const active = env.store.get_active("sandbox", pkg.machine.skill_id);
    const cur = env.store.archive(pkg.machine.skill_id) || {};
    env.store.publish_admission({ environment: "sandbox", skill_id: pkg.machine.skill_id, artifact_hash: pkg.artifact_hash,
      expected_parent_hash: active ? active[0] : null, gated_archive_version: Object.prototype.hasOwnProperty.call(cur, "version") ? cur.version : null,
      traces: [], record: rec, report: rj, env_key: pkg.artifact_hash + "@sandbox", actor: "user:dana", manifest: man, now });
    HXUI.lab.packages.refined = pkg;
    HXUI.lab_changed("packages");
    return HX.registry.is_admitted_in(env.store, pkg.artifact_hash, "sandbox") ? "ADMITTED" : "not admitted";
  }, text);
  assert.equal(admitted, "ADMITTED", "the refined package is admitted in the lab env");
  const md = await page.evaluate(() => ({ off: document.getElementById("rn-sc-missing-docs").disabled, ref: document.getElementById("rn-machine-refined").disabled,
    hash: HXUI.lab.packages.refined.artifact_hash, python: HX.data.python_build.refined_artifact_hash }));
  assert.equal(md.off, false, "missing documents is enabled once refined is admitted");
  assert.equal(md.ref, false);
  assert.equal(md.hash, md.python, "the refined package is the Python build's");
  await start(page, assert, "missing-docs");
  assert.equal(await page.evaluate(() => document.getElementById("rn-machine-refined").checked), true, "the scenario selects the refined machine");
  s = await until(page, assert, "WAITING_FOR_INPUT");
  assert.ok(s.input, "the input form appears");
  assert.equal(await page.inputValue("#rn-docs"), "DOC-LATE-40002");
  await click(page, "rn-input-send");
  s = await state(page);
  assert.equal(s.human.code, "ANSWERED");
  s = await until(page, assert, "WAITING_FOR_APPROVAL");
  s = await approve(page, assert, "user:bob");
  s = await until(page, assert, "COMPLETED");
  assert.equal(s.outcome.terminal, "END_VERIFIED_DRAFT", "the refined machine completes after input and approval");

  /* ---- runs list: every run, selectable */
  const runs = await page.evaluate(() => [...document.querySelectorAll(".rn-runs-table tbody tr[data-run]")].map((r) => [r.dataset.run, r.dataset.status]));
  const engine_runs = await page.evaluate(() => HXUI.lab.env.store.list_runs("acme").map((id) => [id, HXUI.lab.env.store.get_run("acme", id).status]).reverse());
  assert.deepEqual(runs, engine_runs, "the runs list is the store's, newest first");
  await click(page, "rn-run-" + r1);
  s = await state(page);
  assert.equal(s.shown_run, r1, "a click inspects an earlier run");
  assert.equal(s.outcome_card.terminal, "END_VERIFIED_DRAFT");

  /* ---- Reset lab returns to rest */
  await page.click("#hx-reset");
  await page.click("#hx-reset-confirm");
  const after = await page.evaluate(() => ({ env: HXUI.lab.env, status: document.getElementById("rn").dataset.status,
    rows: document.querySelectorAll(".rn-runs-table tbody tr[data-run]").length, checked: document.querySelector("input[name=rn-scenario]:checked").value }));
  assert.deepEqual(after, { env: null, status: "idle", rows: 0, checked: "clean" }, "Reset lab returns the workbench to rest");
}
