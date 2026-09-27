"""Regression tests for web UI findings (cluster C5). Each test names the finding index it covers.

The UI is driven in headless Chromium through Node Playwright against a fresh stack on ephemeral ports. The tests
are skipped when node or the Playwright package is not installed (set LWB_PLAYWRIGHT to its directory)."""
import json
import os
import shutil
import subprocess
import unittest

from tests.helpers import StackCase

NODE = shutil.which("node")
PLAYWRIGHT = os.environ.get("LWB_PLAYWRIGHT", "/opt/node22/lib/node_modules/playwright")
CODE = "ui-test-code"

# Shared by every scenario: launch Chromium, and wait until a page has no request in flight.
PRELUDE = r"""
const { chromium } = require(process.env.LWB_PLAYWRIGHT);
const BASE = process.env.WB_URL;
const out = { errors: [] };
const inflight = new Map();
function track(page) {
  inflight.set(page, 0);
  const add = (n) => () => inflight.set(page, inflight.get(page) + n);
  page.on("request", add(1));
  page.on("requestfinished", add(-1));
  page.on("requestfailed", add(-1));
  page.on("pageerror", (e) => out.errors.push(String(e)));
  page.on("dialog", (d) => d.accept("reviewed in UI test"));
  return page;
}
async function idle(page, quietMs = 300, maxMs = 15000) {
  let quiet = 0;
  for (let t = 0; t < maxMs; t += 50) {
    quiet = inflight.get(page) ? 0 : quiet + 50;
    if (quiet >= quietMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("page did not go idle");
}
const summary = (page) => page.textContent("#lr-summary");
(async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = track(await ctx.newPage());
    await page.goto(BASE + "/");
    await idle(page);
    await scenario(ctx, page);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
"""


@unittest.skipUnless(NODE and os.path.isdir(PLAYWRIGHT), "needs node and the Playwright package")
class UiFixes(StackCase):
    def run_ui(self, scenario):
        path = os.path.join(self.var, "ui_scenario.js")
        with open(path, "w") as f:
            f.write(PRELUDE + "\n" + scenario)
        env = dict(os.environ, WB_URL=self.stack.wb_url, LWB_PLAYWRIGHT=PLAYWRIGHT)
        p = subprocess.run([NODE, path], env=env, capture_output=True, text=True, timeout=90)
        self.assertEqual(p.returncode, 0, p.stderr[-3000:])
        out = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertEqual(out.pop("errors"), [])
        return out

    def test_f46_refresh_after_a_mutation_during_a_running_refresh_shows_that_mutation(self):
        # The pause's refresh gets its GET /history answered (paused), then is held until the resume has been
        # answered too. A refresh that only joins the running one would leave the panel on "paused".
        out = self.run_ui(r"""
async function scenario(ctx, page) {
  let armed = false, answered, release;
  const fetched = new Promise((r) => (answered = r));
  const held = new Promise((r) => (release = r));
  await page.route("**/api/projects/ehm/history", async (route) => {
    if (!armed) return route.continue();
    armed = false;
    const resp = await route.fetch();  // the server answers now, before the second mutation
    answered();
    await held;
    await route.fulfill({ response: resp });
  });
  armed = true;
  await page.click('button[data-outbox="pause"]');
  await fetched;
  await page.click('button[data-outbox="resume"]');
  await page.waitForFunction(() => /outbox\/resume → HTTP 200/.test(document.getElementById("lr-summary").textContent));
  release();
  await idle(page);
  out.summary = await summary(page);
  out.panel = (await page.textContent("#history-body")).match(/Outbox worker: (running|paused)/)[1];
}
""")
        self.assertIn("/outbox/resume → HTTP 200", out["summary"])
        self.assertEqual(self.ok(self.carol.get("/api/projects/ehm/history"))["outbox_worker"], "running")
        self.assertEqual(out["panel"], "running")

    def test_f47_register_and_approve_selects_the_new_version_for_build(self):
        self.ok(self.imp("model/A_initial.json"))
        out = self.run_ui(r"""
async function scenario(ctx, page) {
  await page.click("#refresh");
  await idle(page);
  out.before = await page.inputValue("#proj-approved");
  await page.selectOption("#proj-fixture", "equipment-health_1.1.0.json");
  await Promise.all([page.waitForResponse((r) => /\/1\.1\.0\/review$/.test(r.url())), page.click("#btn-register")]);
  await idle(page);
  out.after = await page.inputValue("#proj-approved");
  await Promise.all([page.waitForResponse((r) => /\/releases$/.test(r.url()) && r.request().method() === "POST"),
    page.click("#btn-build")]);
  await idle(page);
}
""")
        self.assertEqual(out["before"], "equipment-health@1.0.0")
        self.assertEqual(out["after"], "equipment-health@1.1.0")
        releases = self.ok(self.carol.get("/api/projects/ehm/releases"))["releases"]
        self.assertEqual([r["projection_version"] for r in releases], ["1.1.0"])

    def test_f48_expired_gate_login_goes_to_login_page_and_dashboard_says_so(self):
        os.environ["LWB_ACCESS_CODE"] = CODE
        os.environ["LWB_COOKIE_SECURE"] = "0"
        self.addCleanup(os.environ.pop, "LWB_ACCESS_CODE", None)
        self.addCleanup(os.environ.pop, "LWB_COOKIE_SECURE", None)
        out = self.run_ui(r"""
async function scenario(ctx, page) {
  // The first load was answered with the login form.
  await page.fill('input[name="code"]', "%s");
  await Promise.all([page.waitForURL(BASE + "/"), page.click('button[type="submit"]')]);
  await idle(page);
  out.loggedIn = await page.inputValue("#project");
  const dash = track(await ctx.newPage());
  await dash.goto(BASE + "/consumer/");
  await dash.waitForFunction(() => /updated/.test(document.getElementById("status").textContent));
  await ctx.clearCookies();  // the 12 h login cookie expired
  await page.click("#refresh");
  await page.waitForURL("**/login", { timeout: 5000 }).catch(() => {});
  out.path = new URL(page.url()).pathname;
  await dash.waitForFunction(() => /failed/.test(document.getElementById("status").textContent), null, { timeout: 6000 });
  out.dash = await dash.textContent("#error");
}
""".replace("%s", CODE))
        self.assertEqual(out["loggedIn"], "ehm")
        self.assertEqual(out["path"], "/login")
        self.assertIn("log in again", out["dash"])
        self.assertNotIn("JSON", out["dash"])


if __name__ == "__main__":
    unittest.main()
