import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

const FIXTURES = fileURLToPath(new URL('../../backend/tests/fixtures/', import.meta.url))
const MINUS = '−'

async function openBaseline(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Imports and runs' }).getByRole('button', { name: /T-4821 \(baseline\)/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (baseline)' })).toBeVisible()
}

test.describe.serial('AI Cost Inspector workflow', () => {
  test('first run shows the welcome screen and loads the labelled demo', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /See where your agent’s money goes/ })).toBeVisible()
    await expect(page.getByText('AUDR v1.0 records')).toBeVisible()
    await page.getByRole('button', { name: 'Explore the demo' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (baseline)' })).toBeVisible()
    await expect(page.getByText('Synthetic demo data').first()).toBeVisible()
    await expect(page.getByText('$0.09912').first()).toBeVisible()
    await expect(page.getByText('All 11 calls report a cost')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Optimization candidates/ })).toBeVisible()
  })

  test('a finding exposes its records, evidence, rule and limits', async ({ page }) => {
    await openBaseline(page)
    await page.getByRole('button', { name: /2 repeated model call\(s\) in one run/ }).click()
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector.getByText('What the analyzer saw')).toBeVisible()
    const signature = inspector.getByRole('table')
    await expect(signature.getByText('claude-sonnet-4-5')).toBeVisible()
    await expect(signature.getByText('1,800')).toBeVisible()
    await expect(signature.getByText('not reported').first()).toBeVisible()
    await expect(inspector.getByText('Matching counters are not proof')).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Affected calls (2)' })).toBeVisible()
    await expect(inspector.getByText('01K6T4821BEF00000000000002')).toBeVisible()
    await expect(inspector.getByText('01K6T4821BEF00000000000008')).toBeVisible()
    await expect(inspector.getByText('Repeated usage signature within a run')).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Limits' })).toBeVisible()
    await expect(inspector.getByText(/Estimate · not measured/)).toBeVisible()
    // Timeline emphasises exactly the finding's calls plus its reference call.
    await expect(page.getByRole('button', { name: /in the selected finding/ })).toHaveCount(2)
    await expect(page.getByRole('button', { name: /reference call of the selected finding/ })).toHaveCount(1)
    // Nothing on the page describes equal counters as identical prompts.
    expect(await page.locator('body').innerText()).not.toMatch(/identical prompts?|same prompts?/i)
  })

  test('dismissal with a note survives a reload', async ({ page }) => {
    await openBaseline(page)
    await page.getByRole('button', { name: /2 repeated model call\(s\) in one run/ }).click()
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await inspector.getByRole('textbox').fill('Intentional retry after a provider timeout')
    await inspector.getByRole('button', { name: 'Dismiss finding' }).click()
    await expect(page.getByText('Finding dismissed')).toBeVisible()
    await expect(inspector.getByText('Intentional retry after a provider timeout')).toBeVisible()

    await page.reload()
    await expect(page.getByText('Dismissed (1)')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByText('Intentional retry after a provider timeout')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore finding' })).toBeVisible()
  })

  test('selecting a call shows its normalized telemetry', async ({ page }) => {
    await openBaseline(page)
    await page.getByRole('button', { name: /^Step 4 claude-sonnet-4-5\s*, model call/ }).click()
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector.getByText('01K6T4821BEF00000000000004')).toBeVisible()
    await expect(inspector.getByText('$0.02982').first()).toBeVisible()
    await expect(inspector.getByText('Cache-read tokens')).toBeVisible()
    await expect(inspector.getByText('2,400')).toBeVisible()
  })

  test('comparison needs an equivalence answer, then measures the change', async ({ page }) => {
    await openBaseline(page)
    await page.getByRole('button', { name: 'Compare this run with another' }).click()
    await expect(page.getByRole('heading', { name: 'Measure what changed between two runs' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Candidate run' }).click()
    await page.getByRole('option', { name: /T-4821 \(after changes\)/ }).click()
    await expect(page.getByText('Mark whether the runs did equivalent work to see the comparison.')).toBeVisible()
    await expect(page.getByText('Measured change', { exact: true })).toHaveCount(0)

    await page.getByRole('radio', { name: /Same task and input/ }).click()
    await expect(page.getByText('Measured change', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`${MINUS}$0.0264`).first()).toBeVisible()
    await expect(page.getByText(`${MINUS}26.63%`).first()).toBeVisible()
    await expect(page.getByText(/carries no output-quality measure/)).toBeVisible()
    await expect(page.getByText(/not a production savings rate/).first()).toBeVisible()

    await page.getByRole('radio', { name: /Not sure/ }).click()
    await expect(page.getByText('Observed difference', { exact: true }).first()).toBeVisible()

    await page.getByRole('radio', { name: /Same task and input/ }).click()
    await page.getByLabel(/^Note/).fill('Deduplicated classification; validation moved to code')
    await page.getByRole('button', { name: 'Save comparison' }).click()
    await expect(page.getByText('Comparison saved')).toBeVisible()
    await expect(page.getByText('“Deduplicated classification; validation moved to code”')).toBeVisible()
  })

  test('reports export real, self-explanatory files', async ({ page }) => {
    await openBaseline(page)
    await page.getByRole('button', { name: 'Export report' }).click()
    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /HTML report/ }).click()])
    expect(html.suggestedFilename()).toBe('support-agent-before-cost-report.html')
    const htmlText = readFileSync(await html.path(), 'utf-8')
    expect(htmlText).toContain('Resolve billing ticket T-4821 (baseline)')
    expect(htmlText).toContain('Intentional retry after a provider timeout')
    expect(htmlText).toContain('Scenario estimate')
    expect(htmlText).toContain('Deduplicated classification')
    expect(htmlText).not.toContain('<script')
    await expect(page.getByText(/Exported support-agent-before-cost-report.html/)).toBeVisible()

    await page.getByRole('button', { name: 'Export report' }).click()
    const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /JSON report/ }).click()])
    const report = JSON.parse(readFileSync(await json.path(), 'utf-8')) as {
      report: { format: string }
      observed: { spend: { by_currency: { amount: string }[] } }
      findings: { dismissed: boolean; dismissal_note: string | null; evidence: { kind: string } }[]
      calls: unknown[]
      comparisons: unknown[]
    }
    expect(report.report.format).toBe('ai-cost-inspector/report')
    expect(report.observed.spend.by_currency[0]?.amount).toBe('0.09912')
    expect(report.findings).toHaveLength(13)
    expect(report.findings.filter((f) => f.dismissed).map((f) => f.dismissal_note)).toEqual([
      'Intentional retry after a provider timeout',
    ])
    expect(report.findings.every((f) => f.evidence.kind !== 'unavailable')).toBe(true)
    expect(report.calls).toHaveLength(11)
    expect(report.comparisons).toHaveLength(1)
  })

  test('invalid files are rejected with line-specific errors; valid files import', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Import an AUDR file' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Import AUDR telemetry' })
    const good = readFileSync(`${FIXTURES}kora-doctor/simple.jsonl`, 'utf-8').split('\n')[0] ?? ''
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'broken.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(`${good}\n{"spec_version": "1.0.0",\n${good.replace('"input_tokens":500', '"input_tokens":-5')}\n`),
    })
    await dialog.getByRole('button', { name: 'Import file' }).click()
    await expect(dialog.getByText('Nothing was imported.', { exact: false })).toBeVisible()
    await expect(dialog.getByText('Line 2')).toBeVisible()
    await expect(dialog.getByText(/Invalid JSON/)).toBeVisible()
    await expect(dialog.getByText('Line 3')).toBeVisible()
    await expect(dialog.getByText('`usage.llm.input_tokens` must be at least 0 (found -5).')).toBeVisible()

    await dialog.locator('input[type=file]').setInputFiles(`${FIXTURES}kora-doctor/inefficient_agent.jsonl`)
    await dialog.getByRole('button', { name: 'Import file' }).click()
    await expect(page.getByText('Imported inefficient_agent.jsonl')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'inefficient_agent.jsonl' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible()
    await expect(page.getByText('$0.1050').first()).toBeVisible()
  })

  test('deleting an import removes it and its data', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Imports and runs' })
    await nav.getByRole('button', { name: /inefficient_agent\.jsonl/ }).click()
    await page.getByRole('button', { name: 'Delete import' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm.getByText(/permanently removes 2 runs, 11 stored calls/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete import' }).click()
    await expect(page.getByText('Deleted inefficient_agent.jsonl')).toBeVisible()
    await expect(nav.getByRole('button', { name: /inefficient_agent\.jsonl/ })).toHaveCount(0)
  })

  test('command palette navigates by keyboard', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Imports and runs' })).toBeVisible()
    await page.keyboard.press('Control+k')
    await page.getByPlaceholder('Search runs, findings and actions…').fill('after changes')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (after changes)' })).toBeVisible()
  })

  test('narrow screens: no horizontal overflow and the inspector opens as a sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openBaselineMobile(page)
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
    // The two-call finding was dismissed earlier in this suite; use the open one.
    await page.getByRole('button', { name: /1 repeated model call\(s\) in one run/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Evidence' })
    await expect(sheet.getByText('What the analyzer saw')).toBeVisible()
    // The sheet slides in; once settled it must sit fully inside the viewport.
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox()
        return box != null && box.x >= 0 && Math.round(box.x + box.width) <= 390
      })
      .toBe(true)
    await sheet.getByRole('button', { name: 'Close inspector' }).click()
    await expect(sheet).toHaveCount(0)
  })
})

async function openBaselineMobile(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open imports and runs' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /T-4821 \(baseline\)/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Resolve billing ticket T-4821 (baseline)' })).toBeVisible()
}

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** Runs axe-core in the page; returns one line per violated rule. */
async function accessibilityViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE_SOURCE })
  return page.evaluate(async (tags) => {
    const { axe } = window as unknown as { axe: typeof import('axe-core') }
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags } })
    return result.violations.map(
      (v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`,
    )
  }, AXE_TAGS)
}

test.describe('accessibility', () => {
  // axe-core is injected as an inline script, which the app's own CSP rightly blocks.
  test.use({ bypassCSP: true })

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`key screens have no axe-core violations (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.request.post('/api/demo', { headers: { 'X-Requested-With': 'cost-inspector' } })
      const { imports } = (await (await page.request.get('/api/imports')).json()) as {
        imports: { id: string; demo_key: string | null; runs: { id: string }[] }[]
      }
      const demo = (key: string) => {
        const found = imports.find((i) => i.demo_key === key)
        if (!found) throw new Error(`demo import ${key} missing`)
        return found
      }
      const before = demo('support-before').runs[0].id
      const after = demo('support-after').runs[0].id

      await page.goto(`/?run=${before}`)
      await page.locator('[aria-labelledby="findings-title"] li button').first().click()
      await expect(page.getByRole('heading', { name: 'What the analyzer saw' })).toBeVisible()
      expect(await accessibilityViolations(page), 'run with a finding open').toEqual([])

      await page.goto(`/?view=compare&base=${before}&cand=${after}&eq=equivalent`)
      await expect(page.getByText('Measured change').first()).toBeVisible()
      expect(await accessibilityViolations(page), 'comparison').toEqual([])

      await page.goto(`/?import=${demo('partial-telemetry').id}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await accessibilityViolations(page), 'import overview with mixed currencies').toEqual([])
    })
  }
})
