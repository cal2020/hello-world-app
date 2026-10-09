import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

// The in-browser build: the Python backend runs in a Web Worker (Pyodide) and data is saved
// in IndexedDB. Every test gets a fresh browser context, so it starts with no saved data.
const FIXTURES = fileURLToPath(new URL('../../backend/tests/fixtures/', import.meta.url))
const MINUS = '−'
const BOOT = 120_000
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

async function boot(page: Page) {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: /See where your agent’s money goes/ })).toBeVisible({ timeout: BOOT })
}

async function bootWithDemo(page: Page) {
  await boot(page)
  await page.getByRole('button', { name: 'Explore the demo' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (baseline)' })).toBeVisible()
}

async function accessibilityViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE_SOURCE })
  return page.evaluate(async () => {
    const { axe } = window as unknown as { axe: typeof import('axe-core') }
    const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags } })
    return result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  })
}

test.describe('in-browser build', () => {
  // axe-core is injected as an inline script, which the page's CSP rightly blocks.
  test.use({ bypassCSP: true })

  test('starts the engine in the page, then shows the app with no server', async ({ page }) => {
    const apiRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url())
    })
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Starting the analysis engine' })).toBeVisible()
    await expect(page.getByText('Files you import are analyzed on this device and never uploaded.')).toBeVisible()
    await expect(page.getByRole('heading', { name: /See where your agent’s money goes/ })).toBeVisible({ timeout: BOOT })
    await expect(page.getByText('Runs in your browser').first()).toBeVisible()
    expect(apiRequests, 'API calls must never reach the network').toEqual([])
    expect(await accessibilityViolations(page), 'welcome screen').toEqual([])
  })

  test('the demo, evidence and a dismissal note survive a reload', async ({ page }) => {
    await bootWithDemo(page)
    await expect(page.getByText('$0.09912').first()).toBeVisible()
    await page.getByRole('button', { name: /2 repeated model call\(s\) in one run/ }).click()
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector.getByText('What the analyzer saw')).toBeVisible()
    await expect(inspector.getByText('Matching counters are not proof')).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Affected calls (2)' })).toBeVisible()
    expect(await accessibilityViolations(page), 'run with a finding open').toEqual([])

    await inspector.getByRole('textbox').fill('Intentional retry after a provider timeout')
    await inspector.getByRole('button', { name: 'Dismiss finding' }).click()
    await expect(page.getByText('Finding dismissed')).toBeVisible()

    await page.reload()
    await expect(page.getByText('Dismissed (1)')).toBeVisible({ timeout: BOOT })
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByText('Intentional retry after a provider timeout')).toBeVisible()
  })

  test('compares runs, saves the comparison and exports reports', async ({ page }) => {
    await bootWithDemo(page)
    await page.getByRole('button', { name: 'Compare this run with another' }).click()
    await page.getByRole('combobox', { name: 'Candidate run' }).click()
    await page.getByRole('option', { name: /T-4821 \(after changes\)/ }).click()
    await page.getByRole('radio', { name: /Same task and input/ }).click()
    await expect(page.getByText('Measured change', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`${MINUS}$0.0264`).first()).toBeVisible()
    await expect(page.getByText(`${MINUS}26.63%`).first()).toBeVisible()
    await page.getByLabel(/^Note/).fill('Deduplicated classification')
    await page.getByRole('button', { name: 'Save comparison' }).click()
    await expect(page.getByText('Comparison saved')).toBeVisible()

    await page.getByRole('navigation', { name: 'Imports and runs' }).getByRole('button', { name: /T-4821 \(baseline\)/ }).click()
    await page.getByRole('button', { name: 'Export report' }).click()
    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /HTML report/ }).click()])
    expect(html.suggestedFilename()).toBe('support-agent-before-cost-report.html')
    const htmlText = readFileSync(await html.path(), 'utf-8')
    expect(htmlText).toContain('Resolve billing ticket T-4821 (baseline)')
    expect(htmlText).toContain('Deduplicated classification')
    expect(htmlText).not.toContain('<script')

    await page.getByRole('button', { name: 'Export report' }).click()
    const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /JSON report/ }).click()])
    const report = JSON.parse(readFileSync(await json.path(), 'utf-8')) as {
      observed: { spend: { by_currency: { amount: string }[] } }
      findings: unknown[]
      comparisons: unknown[]
    }
    expect(report.observed.spend.by_currency[0]?.amount).toBe('0.09912')
    expect(report.findings).toHaveLength(13)
    expect(report.comparisons).toHaveLength(1)
  })

  test('rejects an invalid file by line and imports a valid one', async ({ page }) => {
    await boot(page)
    await page.getByRole('button', { name: 'Import telemetry' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Import telemetry' })
    const good = readFileSync(`${FIXTURES}kora-doctor/simple.jsonl`, 'utf-8').split('\n')[0] ?? ''
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'broken.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(`${good}\n{"spec_version": "1.0.0",\n${good.replace('"input_tokens":500', '"input_tokens":-5')}\n`),
    })
    await dialog.getByRole('button', { name: 'Import file' }).click()
    await expect(dialog.getByText('Nothing was imported.', { exact: false })).toBeVisible()
    await expect(dialog.getByText('Line 2')).toBeVisible()
    await expect(dialog.getByText('`usage.llm.input_tokens` must be at least 0 (found -5).')).toBeVisible()

    await dialog.locator('input[type=file]').setInputFiles(`${FIXTURES}kora-doctor/inefficient_agent.jsonl`)
    await dialog.getByRole('button', { name: 'Import file' }).click()
    await expect(page.getByText('Imported inefficient_agent.jsonl')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'inefficient_agent.jsonl' })).toBeVisible()
    await expect(page.getByText('$0.1050').first()).toBeVisible()
  })

  test('reads a Claude Code transcript in the page and prices it at list prices', async ({ page }) => {
    await boot(page)
    await page.getByRole('button', { name: 'Import transcripts' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import telemetry' })
    await dialog.locator('input[type=file]').setInputFiles(`${FIXTURES}claude-code/session.jsonl`)
    await dialog.getByRole('button', { name: 'Import transcript' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Claude Code – 2 sessions' })).toBeVisible()
    await expect(page.getByText('Estimated spend', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('$0.10235').first()).toBeVisible()
    await expect(page.getByText('Where the cost goes')).toBeVisible()
    await expect(page.getByText(/Claude Code's own cost figure for the one session that records it/)).toBeVisible()
    expect(await accessibilityViolations(page)).toEqual([])
  })

  test('clearing saved data starts over', async ({ page }) => {
    await bootWithDemo(page)
    await page.getByRole('button', { name: 'Clear data saved in this browser' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm.getByText(/permanently removes every import/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete everything' }).click()
    await expect(page.getByRole('button', { name: 'Explore the demo' })).toBeVisible({ timeout: BOOT })
    const nav = page.getByRole('navigation', { name: 'Imports and runs' })
    await expect(nav.getByRole('button', { name: 'Load demo runs' })).toBeVisible()
    await expect(nav.getByRole('button', { name: /support-agent-before\.jsonl/ })).toHaveCount(0)
  })

  test('only one tab uses the saved data at a time', async ({ page, context }) => {
    await boot(page)
    const second = await context.newPage()
    await second.goto('./')
    await expect(second.getByRole('heading', { name: 'Already open in another tab' })).toBeVisible({ timeout: 30_000 })
    expect(await accessibilityViolations(second), 'tab-in-use screen').toEqual([])
    await page.close()
    await second.getByRole('button', { name: 'Reload' }).click()
    await expect(second.getByRole('heading', { name: /See where your agent’s money goes/ })).toBeVisible({ timeout: BOOT })
  })

  test('works on a phone-sized screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Starting the analysis engine' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await expect(page.getByRole('button', { name: 'Explore the demo' })).toBeVisible({ timeout: BOOT })
    await page.getByRole('button', { name: 'Explore the demo' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (baseline)' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})
