// End-to-end test of the static browser build (build/web), driven through the real UI.
// Usage: serve build/web (or a copy under a sub-path) and run
//   NODE_PATH=$(npm root -g) node tests/web_e2e.cjs http://127.0.0.1:8822/hello-world-app/dmmc-workbench/app/
// Every request to another origin is blocked: the build must be self-contained.
"use strict";
const { chromium } = require("playwright");

const URL_ = process.argv[2];
const results = [];
let failures = 0;

function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, acceptDownloads: true });
  const external = [];
  const origin = new URL(URL_).origin;
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    if (!u.startsWith(origin)) { external.push(u); return r.abort(); }
    return r.continue();
  });
  const errors = [];
  const watch = (pg) => {
    pg.on("pageerror", (e) => errors.push(e.message));
    pg.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));
    return pg;
  };
  let p = watch(await ctx.newPage());

  const msg = async () => (await p.locator(".msg").first().textContent({ timeout: 2000 }).catch(() => "")) || "";
  // The shell counts completed renders (html[data-renders]) and in-flight worker calls (html[data-pending]).
  const renders = () => p.evaluate(() => Number(document.documentElement.dataset.renders || 0));
  const waitIdle = async () => { await p.waitForFunction(() => (document.documentElement.dataset.pending || "0") === "0", null, { timeout: 180000 }); };
  const act = async (fn) => {
    const before = await renders();
    await fn();
    await p.waitForFunction((n) => Number(document.documentElement.dataset.renders || 0) > n
      && (document.documentElement.dataset.pending || "0") === "0", before, { timeout: 180000 });
  };
  const click = (label, scope = p) => act(() => scope.getByRole("button", { name: label, exact: true }).first().click());
  const nav = (label) => act(() => p.locator("nav").getByRole("link", { name: label, exact: true }).click());
  const as = (actor) => act(() => p.selectOption("#actor-select", actor));
  const goto = (hashPath) => act(() => p.evaluate((h) => { location.hash = h; }, hashPath));
  const rowText = async (rowId) => p.locator("tr", { hasText: rowId }).first().innerText();

  const t0 = Date.now();
  await p.goto(URL_);
  await p.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("starts and renders the dashboard", true, `${Date.now() - t0} ms`);

  // A clean slate regardless of what an earlier run left in IndexedDB.
  await click("Reset demo state");
  check("reset", (await msg()).includes("State reset"));

  // Step 1
  await click("Import model A");
  check("import model A", (await msg()).includes("Imported snap-001-A"), await msg());
  await nav("Dashboard");
  await click("Import evidence set A");
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  check("step 1: 3 of 4 rows current", (await msg()).includes("3 of 4 selected demo obligation rows"), await msg());
  check("step 1: AC-3 PASS via Wasm policy + Wasm tests", /PASS/.test(await rowText("OBL-AC3-API")) && /15 pass \/ 0 fail/.test(await rowText("OBL-AC3-API")));
  check("step 1: inherited SC-8 UNKNOWN", /UNKNOWN/.test(await rowText("OBL-SC8-INHERIT")));
  check("runtime note shown", (await p.locator(".banner").innerText()).includes("Running entirely in this browser tab"));

  // Citation resolves
  await act(() => p.locator("a.mono", { hasText: "check:" }).first().click());
  check("citation resolves", (await p.locator("main").innerText()).includes("Resolves against the immutable version"));

  // Step 2
  await nav("Evidence");
  await act(() => p.locator("tr", { hasText: "ev-tls-portal-api-a1" }).getByRole("button", { name: "Withdraw" }).click());
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  const sc8 = await rowText("OBL-SC8-FLOW::flow:portal-api");
  check("step 2: SC-8 UNKNOWN with design assertion kept", /UNKNOWN/.test(sc8) && /PRESENT TLS/.test(sc8), sc8.slice(0, 120));
  await nav("Dashboard");
  check("step 2: first package STALE", /pkg-001-A[\s\S]*?STALE/.test(await p.locator("table").innerText()));

  // Step 3
  await nav("Evidence");
  await act(() => p.locator("tr", { hasText: "ev-tls-portal-api-a1" }).getByRole("button", { name: "Restore" }).click());
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  const pkg3 = decodeURIComponent(new URL(p.url()).hash.slice(1));
  await p.fill("#reason-input", "bob attempts to review");
  await click("Record decision as current identity");
  check("engineer cannot review (server-side authz)", (await msg()).includes("Denied"), await msg());
  await as("alice");
  await goto(pkg3);
  await p.fill("#reason-input", "Wording accepted for demo; inheritance and parameters remain open.");
  await click("Record decision as current identity");
  check("step 3: reviewer ACCEPT recorded", (await msg()).includes("ACCEPT"), await msg());
  await click("Export as currently reviewed");
  check("step 3: export succeeds", (await msg()).includes("status at export REVIEWED_FOR_DEMO"), await msg());

  // Download one exported file through the in-browser file route
  const dl = p.waitForEvent("download", { timeout: 15000 });
  await p.locator("a", { hasText: "oscal-validation-report.json" }).first().click();
  const d = await dl.catch(() => null);
  let oscalOk = false;
  if (d) { const s = await d.createReadStream(); let buf = ""; for await (const c of s) buf += c; oscalOk = JSON.parse(buf).valid_oscal_claim === true; }
  check("OSCAL export validates in the browser (jsonschema + regex under Pyodide)", oscalOk);

  // Step 4
  await as("bob");
  await nav("Dashboard");
  await click("Import model B");
  await as("alice");
  await goto(pkg3);
  await click("Export as currently reviewed");
  check("step 4: stale export refused", (await msg()).includes("ExportRefused") && (await msg()).includes("STALE"), await msg());
  await nav("Impact");
  const imp = await p.locator("main").innerText();
  check("step 4: impact lists new flow and inapplicable evidence",
    imp.includes("flow:provider-api") && imp.includes("ev-tls-portal-api-a1") && imp.includes("ev-audit-api-a1"));

  // Step 5
  await as("bob");
  await nav("Dashboard");
  await click("Import evidence set B");
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  const ac3 = await rowText("OBL-AC3-API");
  check("step 5: AC-3 FAIL with both mismatches (Wasm decisions)", /FAIL/.test(ac3) && /provider-integration write/.test(ac3) && /maintainer write/.test(ac3));
  check("step 5: provider flow UNKNOWN", /UNKNOWN/.test(await rowText("OBL-SC8-FLOW::flow:provider-api")));

  // Seeded drafter errors
  await nav("Dashboard");
  await click("Build package (seeded drafter errors)");
  check("validator flags the six seeded statements", (await p.locator(".flag").count()) >= 6, String(await p.locator(".flag").count()));

  // Quarantined candidates
  await nav("Dashboard");
  await click("Evaluate generated candidate");
  check("candidate fails 5/15 independent tests in Wasm; enforcement unchanged",
    (await msg()).includes("FAILS_INDEPENDENT_TESTS (10 pass / 5 fail") && (await msg()).includes("unchanged: True"), await msg());
  await click("Evaluate candidate using http.send");
  check("http.send candidate rejected at compile", (await msg()).includes("REJECTED_AT_COMPILE"), await msg());

  // Wrong project
  await as("mallory");
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  check("wrong-project identity denied", (await msg()).includes("wrong project"), await msg());
  await as("bob");

  // Live model: distinct failure, no substitution
  await nav("Dashboard");
  await click("Build package (live model)");
  check("live model mode fails distinctly in the browser", (await msg()).includes("DraftingError"), await msg());

  // Paste-import a custom model: operators may now also write -> AC-3 mismatch computed live
  await nav("Model");
  const custom = JSON.parse(await p.inputValue("#model-json"));
  custom.revision = "C";
  const api = custom.elements.find((e) => e.id === "cmp:api-service");
  api.revision = "a3";
  api.attributes.permissions = [
    { role: "operator", action: "read", resource: "telemetry" },
    { role: "operator", action: "write", resource: "telemetry" },
    { role: "maintainer", action: "read", resource: "telemetry" },
    { role: "maintainer", action: "write", resource: "telemetry" },
  ];
  await p.fill("#model-json", JSON.stringify(custom, null, 2));
  await click("Validate and import");
  check("paste import accepted", (await msg()).includes("Imported snap-003-C"), await msg());
  await nav("Dashboard");
  await click("Build package (fixture drafter)");
  const ac3c = await rowText("OBL-AC3-API");
  check("custom model: operator write mismatch found by live Wasm evaluation", /FAIL/.test(ac3c) && /operator write model=True policy=False/.test(ac3c), ac3c.slice(0, 200));
  await nav("Model");
  await p.fill("#model-json", '{"contract": "wrong"}');
  await click("Validate and import");
  check("invalid model rejected with contract errors", (await msg()).includes("ImportError_"), await msg());

  // Audit chain
  await nav("Audit");
  check("audit chain intact", (await p.locator("main").innerText()).includes("Hash chain: intact"));

  // Persistence across reload (IndexedDB)
  await p.reload();
  await p.waitForFunction(() => Number(document.documentElement.dataset.renders || 0) > 0, null, { timeout: 120000 });
  await waitIdle();
  await nav("Dashboard");
  const dash = await p.locator("main").innerText();
  check("state persists across reload", dash.includes("snap-003-C") && dash.includes("pkg-003-A"));

  // Acceptance suite in the browser
  await nav("Acceptance suite");
  const te = Date.now();
  await click("Run the acceptance suite now");
  const ev = await p.locator("main").innerText();
  const m = ev.match(/(\d+) of (\d+) cases passed/);
  check("acceptance suite runs in the browser: all cases pass", !!m && m[1] === m[2], m ? `${m[0]} in ${Date.now() - te} ms` : ev.slice(0, 300));
  check("suite ran on Pyodide + Wasm backend", ev.includes("emscripten") || ev.includes("Wasm"));
  await nav("Dashboard");
  check("suite did not disturb app state", (await p.locator("main").innerText()).includes("snap-003-C"));

  // About
  await nav("About");
  const about = await p.locator("main").innerText();
  check("about shows wasm backend and code digest", about.includes("wasm") && /Workbench code digest\s+[0-9a-f]{64}/.test(about));

  // Deep links keep their percent-encoding: a citation with an encoded '#' survives a reload.
  await nav("Model");
  await act(() => p.locator("a.mono", { hasText: "model:" }).nth(4).click());
  const citeBefore = await p.locator("main pre").innerText();
  await p.reload();
  await p.waitForFunction(() => Number(document.documentElement.dataset.renders || 0) > 0, null, { timeout: 120000 });
  await waitIdle();
  const citeAfter = await p.locator("main pre").innerText().catch(() => "");
  check("citation deep link survives reload unchanged", citeBefore.length > 0 && citeAfter === citeBefore,
    `${citeBefore.slice(0, 60)} | ${citeAfter.slice(0, 60)}`);

  // A malformed hash does not hang startup.
  await p.evaluate(() => { history.replaceState(null, "", "#/cite?c=100%"); });
  await p.reload();
  await p.waitForFunction(() => Number(document.documentElement.dataset.renders || 0) > 0, null, { timeout: 120000 });
  check("malformed hash still renders a page", (await p.locator("h2").first().innerText()).length > 0);

  // Deeply nested pasted JSON is rejected, not fatal.
  await nav("Model");
  await p.fill("#model-json", "[".repeat(20000) + "]".repeat(20000));
  await click("Validate and import");
  check("deeply nested model rejected cleanly", (await msg()).includes("nests deeper"), await msg());
  await nav("Dashboard");
  check("runtime still healthy after rejected paste", (await p.locator("main").innerText()).includes("snap-003-C"));

  // Two tabs: the second waits; a takeover requested while the first is mid-action must not lose that action.
  const p2 = watch(await ctx.newPage());
  await p2.goto(URL_);
  await p2.waitForSelector("text=The workbench is open in another tab", { timeout: 120000 });
  check("second tab is told the workbench is open elsewhere", true);
  await p2.locator("#wipe").click(); await p2.waitForTimeout(700); await p2.locator("#wipe").click();
  await p2.waitForSelector(".wipe-error", { timeout: 15000 }).catch(() => {});
  check("waiting tab refuses to delete data the other tab is using",
    ((await p2.locator(".wipe-error").innerText().catch(() => "")) || "").includes("open in another tab"));
  await nav("Dashboard");
  const pkgsBefore = await p.locator("a[href^='/package/']").count();
  await p.getByRole("button", { name: "Build package (fixture drafter)", exact: true }).click(); // not awaited
  await p2.getByRole("button", { name: "Use it in this tab instead" }).click();
  await p2.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  const pkgsAfter = await p2.locator("a[href^='/package/']").count();
  check("takeover waits for the other tab's in-flight action and keeps its result", pkgsAfter === pkgsBefore + 1,
    `${pkgsBefore} -> ${pkgsAfter}`);
  check("second tab takes over with the saved state", (await p2.locator("main").innerText()).includes("snap-003-C"));
  await p.waitForSelector("text=moved to another tab", { timeout: 30000 }).catch(() => {});
  check("first tab stops after handing over", (await p.locator("main").innerText()).includes("moved to another tab"));
  // The stopped tab must not delete the data the new holder is using.
  await p.locator("#wipe").click(); await p.waitForTimeout(700); await p.locator("#wipe").click();
  await p.waitForSelector(".wipe-error", { timeout: 15000 }).catch(() => {});
  check("a tab that handed over refuses to delete the data",
    ((await p.locator(".wipe-error").innerText().catch(() => "")) || "").includes("no longer runs the workbench"));
  await p2.locator("nav").getByRole("link", { name: "Audit", exact: true }).click();
  await p2.waitForSelector("text=Hash chain: intact", { timeout: 30000 }).catch(() => {});
  check("the new holder keeps working", (await p2.locator("main").innerText()).includes("Hash chain: intact"));
  await p2.locator("nav").getByRole("link", { name: "Dashboard", exact: true }).click();
  await p2.waitForSelector("h2:has-text('Dashboard')", { timeout: 30000 });
  await p.close();
  p = p2;
  await p2.reload();
  await p2.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("handed-over state persists across reload", (await p2.locator("a[href^='/package/']").count()) === pkgsBefore + 1);

  // A holder busy for longer than the 15 s handover wait: the new tab takes over by force, the busy
  // tab's result is not saved over the new tab's state, and it says so (no uncaught storage error).
  await nav("Model");
  const big = JSON.parse(await p.inputValue("#model-json"));
  big.revision = "BIG";
  const bigApi = big.elements.find((e) => e.id === "cmp:api-service");
  bigApi.revision = "big";
  bigApi.attributes.permissions = Array.from({ length: 4000 }, (_, i) => ({ role: `role${i}`, action: i % 2 ? "read" : "write", resource: "telemetry" }));
  await p.fill("#model-json", JSON.stringify(big));
  await click("Validate and import");
  check("large pasted model accepted", (await msg()).includes("Imported snap-") && (await msg()).includes("BIG"), await msg());
  await nav("Dashboard");
  const pkgsBig = await p.locator("a[href^='/package/']").count();
  await p.getByRole("button", { name: "Build package (fixture drafter)", exact: true }).click(); // ~30 s; not awaited
  await p.waitForTimeout(500);
  const p3 = watch(await ctx.newPage());
  await p3.goto(URL_);
  await p3.waitForSelector("text=The workbench is open in another tab", { timeout: 120000 });
  const tTake = Date.now();
  await p3.getByRole("button", { name: "Use it in this tab instead" }).click();
  await p3.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("an unanswered takeover proceeds after the 15 s wait", Date.now() - tTake >= 14000, `${Date.now() - tTake} ms`);
  await p.waitForSelector("text=opened in another tab", { timeout: 180000 }).catch(() => {});
  check("the busy tab stops and says its unfinished action was not saved",
    /opened in another tab[\s\S]*not saved/.test(await p.locator("main").innerText()), (await p.locator("main").innerText()).slice(0, 200));
  await p.waitForFunction(() => (document.documentElement.dataset.pending || "0") === "0", null, { timeout: 180000 });
  await p3.reload();
  await p3.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("the busy tab's late result did not overwrite the new holder's saved state",
    (await p3.locator("a[href^='/package/']").count()) === pkgsBig, `${pkgsBig} -> ${await p3.locator("a[href^='/package/']").count()}`);
  await p.close();
  p = p3;

  // Delete local data: a double click is not a confirmation; a deliberate second click is.
  await p.locator("#wipe").dblclick();
  await p.waitForTimeout(300);
  check("double click does not delete local data", (await p.locator("#wipe").innerText()).includes("Click again"));
  await p.waitForTimeout(700);
  await Promise.all([p.waitForNavigation({ timeout: 60000 }), p.locator("#wipe").click()]);
  await p.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("confirmed delete starts from an empty state", (await p.locator("main").innerText()).includes("No model imported"));

  // A delete blocked by a connection that does not give way (e.g. a page from an older build) is
  // reported as pending, and the stopped tab gives up the lock at once.
  await click("Import model A");
  check("state to delete", (await msg()).includes("Imported snap-001-A"), await msg());
  const blocker = await ctx.newPage();
  await blocker.goto(new URL("licenses/SOURCES.md", URL_).href);
  await blocker.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open("/persist"); r.onsuccess = () => { window.__db = r.result; res(); }; r.onerror = () => rej(r.error); }));
  await p.locator("#wipe").click(); await p.waitForTimeout(700); await p.locator("#wipe").click();
  await p.waitForSelector("text=Deletion is waiting for another tab", { timeout: 30000 }).catch(() => {});
  check("a blocked delete is reported as pending", (await p.locator("main").innerText()).includes("Deletion is waiting for another tab"));
  await p.waitForTimeout(300);
  const heldAfter = await blocker.evaluate(async () => (await navigator.locks.query()).held.map((l) => l.name));
  check("a stopped tab gives up the single-tab lock", !heldAfter.includes("dmmc-workbench-state"), JSON.stringify(heldAfter));
  await blocker.close(); // the queued delete completes now
  await p.reload();
  await p.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("the pending delete completed once the other page closed", (await p.locator("main").innerText()).includes("No model imported"));

  // Uncaught errors during startup (separate profiles, so each has its own storage and lock).
  const isolated = async () => {
    const c = await browser.newContext();
    await c.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : (external.push(r.request().url()), r.abort())));
    return c;
  };
  // (a) Before the lock: startup fails, deletion is not offered, and no lock is left behind.
  const ectx = await isolated();
  const ep = await ectx.newPage();
  ep.on("worker", (w) => w.evaluate(() => { setTimeout(() => { throw new Error("injected early error"); }, 50); }).catch(() => {}));
  await ep.goto(URL_);
  await ep.waitForSelector("text=could not start", { timeout: 120000 }).catch(() => {});
  const early = await ep.locator("main").innerText();
  check("an early uncaught error is reported as a startup failure",
    early.includes("could not start") && early.includes("injected early error"), early.slice(0, 160));
  check("an early startup failure offers no deletion", (await ep.locator("#wipe-retry").count()) === 0);
  // The failed tab must not go on to take the lock: a second tab, started after it, starts normally.
  const ep2 = await ectx.newPage();
  await ep2.goto(URL_);
  await Promise.race([ep2.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 }),
    ep2.waitForSelector("text=The workbench is open in another tab", { timeout: 120000 })]).catch(() => {});
  check("a tab whose start failed early leaves the lock free for the next tab",
    (await ep2.locator("h2:has-text('Dashboard')").count()) === 1, (await ep2.locator("main").innerText()).slice(0, 120));
  await ectx.close();
  // (b) A saved state that breaks startup: deletion is offered and gets the workbench going again.
  const bctx = await isolated();
  let bp = await bctx.newPage();
  await bp.goto(URL_);
  await bp.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  await bp.getByRole("button", { name: "Import model A", exact: true }).first().click();
  await bp.waitForSelector("text=Imported snap-001-A", { timeout: 60000 });
  await bp.waitForFunction(() => (document.documentElement.dataset.pending || "0") === "0", null, { timeout: 60000 });
  await bp.close();
  const tamper = await bctx.newPage();
  await tamper.goto(new URL("licenses/SOURCES.md", URL_).href);
  await tamper.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open("/persist");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction("FILE_DATA", "readwrite");
      tx.objectStore("FILE_DATA").put({ timestamp: 5, mode: 33188, contents: new Uint8Array([1, 2, 3]) }, "/persist/zzz");
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  }));
  await tamper.close();
  bp = await bctx.newPage();
  await bp.goto(URL_);
  await bp.waitForSelector("#wipe-retry", { timeout: 120000 }).catch(() => {});
  check("a saved state that breaks startup offers deletion", (await bp.locator("#wipe-retry").count()) === 1,
    (await bp.locator("main").innerText()).slice(0, 200));
  if (await bp.locator("#wipe-retry").count()) {
    await Promise.all([bp.waitForNavigation({ timeout: 60000 }), bp.locator("#wipe-retry").click()]);
    await bp.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 }).catch(() => {});
  }
  check("deleting it starts the workbench again", (await bp.locator("main").innerText()).includes("No model imported"));
  await bctx.close();

  // Mobile layout (separate browser profile, so it has its own storage and lock)
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mctx.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : (external.push(r.request().url()), r.abort())));
  const mp = watch(await mctx.newPage());
  await mp.goto(URL_);
  await mp.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("no horizontal page scroll at phone width", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mctx.close();

  check("no requests left the site's origin", external.length === 0, external.slice(0, 3).join(", "));
  check("no uncaught page or worker errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(2); });
