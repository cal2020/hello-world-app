// End-to-end check of the browser build: serve it under a GitHub-Pages-style subpath, start it in headless
// Chromium, and drive the five-minute flow through the real UI controls (plus the fault steps through the
// same fetch() path the UI uses). Usage: node browser/e2e.cjs <build dir>
const http = require("http");
const fs = require("fs");
const path = require("path");
const PW = process.env.LWB_PLAYWRIGHT || "/opt/node22/lib/node_modules/playwright";
const { chromium } = require(PW);

const dir = path.resolve(process.argv[2]);
const PREFIX = "/hello-world-app/integration-workbench/app/";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".zip": "application/zip", ".whl": "application/zip" };

function check(cond, msg) { if (!cond) throw new Error("FAILED: " + msg); console.log("ok  " + msg); }

(async () => {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!u.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
    let f = path.join(dir, u.slice(PREFIX.length) || "index.html");
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}${PREFIX}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept("e2e check"));
  try {
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForSelector("#lb-overlay", { state: "hidden", timeout: 180000 });
    check(true, `started in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const body = () => page.textContent("body");
    const waitText = async (sel, text, ms = 20000) => page.waitForFunction(([s, t]) =>
      (document.querySelector(s) || {}).textContent?.includes(t), [sel, text], { timeout: ms });

    await page.click("#import-buttons button:has-text('model/A_initial')");
    await waitText("#model-body", "accepted_head");
    check(true, "UI: import A -> accepted_head");
    await page.waitForFunction(() => [...document.querySelectorAll("#proj-approved option")].some((o) => o.value.includes("1.0.0")));
    await page.selectOption("#proj-approved", { label: /1\.0\.0/ }).catch(async () => {
      const v = await page.$eval("#proj-approved", (s) => [...s.options].find((o) => o.value.includes("1.0.0")).value);
      await page.selectOption("#proj-approved", v);
    });
    await page.click("#btn-build");
    await page.waitForFunction(() => document.querySelector("#release-select").options.length > 0 && document.querySelector("#release-select").value);
    await page.click("#btn-checks");
    await waitText("#release-body", "tested_pass", 60000);
    check(true, "UI: build 1.0.0 and consumer checks -> tested_pass");
    await page.click("#btn-activate");
    await waitText("#lb-cons", "7c1e9a", 20000);
    check(true, "UI: activate -> consumer dashboard pinned to 7c1e9a");

    const r = await page.evaluate(async () => {
      const call = async (method, p, body, token = "demo-carol", headers = {}) => {
        const res = await fetch(p, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
        return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json() };
      };
      const out = {};
      const fx = await (await fetch("/web/fixtures/model/B_rename_gateway.json")).text();
      out.b = (await call("POST", "/manage/projects/ehm/imports", fx)).body.outcome;
      const run = (await call("POST", "/manage/projects/ehm/proposal-runs", { method: "model", mode: "fixture" }, "demo-alice")).body;
      out.proposals = run.proposals.length;
      out.live = (await call("POST", "/manage/projects/ehm/proposal-runs", { method: "model", mode: "live" }, "demo-alice")).body.status;
      const rel = (await call("POST", "/manage/projects/ehm/releases", { projection_id: "equipment-health", version: "1.0.0" })).body.release_id;
      out.checks = (await call("POST", `/manage/releases/${rel}/consumer-checks`)).body.status;
      const active = (await call("GET", "/api/projects/ehm/releases")).body.active_release_id;
      await call("POST", "/manage/projects/ehm/outbox/deliver");
      await call("POST", "/manage/projects/ehm/outbox/pause");
      await call("POST", "/manage/consumer/faults", { drop_ack_after_commit: 1 });
      const body = { expected_active_release_id: active, reason: "e2e" };
      const act = await call("POST", `/manage/releases/${rel}/activate`, body, "demo-carol", { "Idempotency-Key": "e2e-1" });
      out.d1 = (await call("POST", "/manage/projects/ehm/outbox/deliver")).body.outcomes.map((o) => o.outcome);
      out.d2 = (await call("POST", "/manage/projects/ehm/outbox/deliver")).body.outcomes.map((o) => o.outcome);
      await call("POST", "/manage/projects/ehm/outbox/resume");
      const again = await call("POST", `/manage/releases/${rel}/activate`, body, "demo-carol", { "Idempotency-Key": "e2e-1" });
      out.replay = again.headers["idempotent-replay"];
      const st = (await (await fetch("/consumer/state")).json());
      const ev = st.received_events.find((e) => e.event_id === act.body.event.event_id);
      out.deliveries = ev.deliveries; out.effects = st.effect_count_by_event[ev.event_id]; out.rev = st.stream.pinned_revision;
      return out;
    });
    check(r.b === "accepted_head", "import B -> accepted_head");
    check(r.proposals === 10, "fixture proposal run -> 10 proposals");
    check(r.live === "failed", "live-model run fails visibly (no API access)");
    check(r.checks === "tested_pass", "second release passes consumer checks");
    check(JSON.stringify(r.d1) === '["no_acknowledgment"]' && JSON.stringify(r.d2) === '["acknowledged"]', "lost acknowledgment, then acknowledged on retry");
    check(r.deliveries === 2 && r.effects === 1, "consumer: 2 deliveries, 1 effect");
    check(r.replay === "true", "retried activation replays (Idempotent-Replay: true)");
    check(r.rev === "f02b44", "consumer pinned to the new revision f02b44");
    await page.click("#refresh");
    await page.waitForTimeout(800);
    const toasts = await page.textContent("#toasts");
    check(!/HTTP 5\d\d/.test(toasts), "no server errors shown in the UI");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.screenshot({ path: path.join(dir, "..", "browser-e2e.png") });
    console.log("E2E PASS");
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
