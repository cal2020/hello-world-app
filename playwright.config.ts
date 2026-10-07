import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dataDir = path.join(os.tmpdir(), `lattice-e2e-${Date.now()}`);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4319",
    // Uses the system Chromium when PLAYWRIGHT_CHROMIUM is set (e.g. a pre-installed browser).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run build && NODE_ENV=production PORT=4319 LATTICE_DATA=${dataDir} npx tsx server/index.ts`,
    url: "http://127.0.0.1:4319/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
