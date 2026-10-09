import { defineConfig, devices } from '@playwright/test'

// End-to-end tests for the in-browser build (`make browser`): the static files are served
// from a subfolder, as on GitHub Pages, and no Python server runs. Set E2E_BROWSER_URL to
// run the same suite against a deployed copy instead.
const PORT = Number(process.env.E2E_BROWSER_PORT ?? 8797)
const LIVE = process.env.E2E_BROWSER_URL

export default defineConfig({
  testDir: './e2e-browser',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: LIVE ?? `http://127.0.0.1:${PORT}/ai-cost-inspector/`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: LIVE
    ? undefined
    : {
        command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ../browser/dist`,
        url: `http://127.0.0.1:${PORT}/ai-cost-inspector/build-manifest.json`,
        reuseExistingServer: false,
        timeout: 30_000,
      },
})
