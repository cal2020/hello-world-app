#!/usr/bin/env node
// Playwright E2E runner for the bundled page (dist/hexis-lab.local.html, strict CSP, no network).
// Each test/e2e/*.e2e.mjs exports `default async function (t)` where t = { page, assert, log, open() }.
// The runner fails a test on any uncaught page error or console error (CSP violations included), and
// blocks every network request except Google Fonts (which it fulfils with an empty response).
//   node test/e2e/run.mjs [filter...]      (build first: python3 build.py)
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// HX_PAGE overrides the page under test (e.g. a parallel build written with `python build.py --out dist-x`).
const PAGE = process.env.HX_PAGE ? path.resolve(ROOT, process.env.HX_PAGE) : path.join(ROOT, "dist", "hexis-lab.local.html");
const SHOTS = path.dirname(PAGE);
const filters = process.argv.slice(2);
if (!fs.existsSync(PAGE)) { console.error(`missing ${PAGE}: run python3 build.py`); process.exit(2); }

const files = fs.readdirSync(path.join(ROOT, "test", "e2e")).filter((f) => f.endsWith(".e2e.mjs")).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));
const browser = await chromium.launch();
let passed = 0, failed = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(ROOT, "test", "e2e", f)).href);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 400, height: 860 }]) {
    for (const scheme of ["light", "dark"]) {
      if (mod.matrix === "single" && (viewport.width !== 1280 || scheme !== "light")) continue;
      const ctx = await browser.newContext({ viewport, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push("pageerror: " + (e.stack || e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
      await page.route("**/*", (route) => {
        const u = route.request().url();
        if (u.startsWith("file://")) return route.continue();
        if (u.startsWith("https://fonts.googleapis.com") || u.startsWith("https://fonts.gstatic.com")) {
          return route.fulfill({ status: 200, body: "", contentType: u.includes("css") ? "text/css" : "font/woff2" });
        }
        errors.push("network request attempted: " + u);
        return route.abort();
      });
      const label = `${f} [${viewport.width}px ${scheme}]`;
      const t = {
        page, assert, log: (...a) => console.log("   ", ...a), viewport, scheme,
        open: async () => {
          await page.goto(pathToFileURL(PAGE).href);
          await page.waitForFunction(() => document.getElementById("app")?.dataset.boot !== "pending", null, { timeout: 15000 });
        },
      };
      try {
        await mod.default(t);
        const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(scrollW <= 1, `page scrolls horizontally by ${scrollW}px`);
        assert.deepEqual(errors, [], "page errors");
        passed++;
        console.log(`ok   ${label}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${label}\n${(e && e.stack) || e}\n${errors.join("\n")}`);
        try { await page.screenshot({ path: path.join(SHOTS, `fail-${f}-${viewport.width}-${scheme}.png`), fullPage: true }); } catch {}
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
