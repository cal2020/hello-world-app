import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run the real API and the built frontend against a fresh,
// disposable SQLite database in e2e/.tmp (never your working data).
const PORT = Number(process.env.E2E_PORT ?? 8799)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `rm -rf e2e/.tmp && mkdir -p e2e/.tmp && uv run --project ../backend cost-inspector serve --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/meta`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ACI_DB_PATH: 'e2e/.tmp/e2e.sqlite3',
      ACI_STATIC_DIR: 'dist',
    },
  },
})
