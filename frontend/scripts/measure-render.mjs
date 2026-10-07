// Measures how long the built app takes to show a run, and to open its largest
// finding, in headless Chromium against a running server.
//
//   node scripts/measure-render.mjs http://127.0.0.1:8765 <run id> [repeats]
//
// "Run visible" runs from navigation start until the run heading and the first call
// row are in the DOM; "finding open" from the click until the evidence section shows.
import { chromium } from '@playwright/test'

const [base, runId, repeatArg] = process.argv.slice(2)
if (!base || !runId) {
  console.error('usage: node scripts/measure-render.mjs <base url> <run id> [repeats]')
  process.exit(2)
}
const repeats = Number(repeatArg ?? 5)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const browser = await chromium.launch()
const visible = []
const findingOpen = []
let title = ''
for (let i = 0; i < repeats; i++) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const start = Date.now()
  await page.goto(`${base}/?run=${encodeURIComponent(runId)}`)
  const heading = page.getByRole('heading', { level: 1 })
  await heading.waitFor()
  await page.locator('table tbody tr').first().waitFor()
  visible.push(Date.now() - start)
  title = await heading.innerText()

  const sort = page.getByRole('button', { name: /^Sort findings/ })
  await sort.click()
  await page.getByRole('menuitemradio', { name: /Number of affected calls/ }).click()
  const clicked = Date.now()
  await page.locator('[aria-labelledby="findings-title"] li button').first().click()
  await page.getByRole('heading', { name: 'What the analyzer saw' }).waitFor()
  findingOpen.push(Date.now() - clicked)
  await page.close()
}
await browser.close()
console.log(`Run: ${title.replace(/\s+/g, ' ')} (${repeats} repeats, headless Chromium, 1440×900)`)
console.log(`Run visible: median ${median(visible)} ms (min ${Math.min(...visible)}, max ${Math.max(...visible)})`)
console.log(`Largest finding open: median ${median(findingOpen)} ms (min ${Math.min(...findingOpen)}, max ${Math.max(...findingOpen)})`)
