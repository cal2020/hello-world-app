import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";

// The suite runs against a live e2e environment (python -m agenthorizon.testing.e2e_server) described by AH_E2E.
const info = JSON.parse(readFileSync(process.env.AH_E2E ?? "/tmp/ah-e2e/e2e.json", "utf8"));

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: info.url, trace: "off", screenshot: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } } },
  ],
});
