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
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));

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

  // Mobile layout
  const mp = await ctx.newPage();
  await mp.setViewportSize({ width: 390, height: 844 });
  await mp.goto(URL_);
  await mp.waitForSelector("h2:has-text('Dashboard')", { timeout: 120000 });
  check("no horizontal page scroll at phone width", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp.close();

  check("no requests left the site's origin", external.length === 0, external.slice(0, 3).join(", "));
  check("no uncaught page or worker errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(2); });
