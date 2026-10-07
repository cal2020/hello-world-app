// Visual check of the running app at desktop and phone sizes.
//   npm start  (or npm run dev)  then  npm run screenshots [-- http://127.0.0.1:4780]
// Uses the Chromium that Playwright finds; set CHROMIUM_PATH to use another.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:4780';
const out = resolve(process.env.SCREENSHOT_DIR ?? 'docs/screenshots');
const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean) as string[];
const executablePath = candidates.find((p) => existsSync(p));

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: false });
  console.log(`  ${name}.png`);
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
const errors: string[] = [];

for (const theme of ['dark', 'light'] as const) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${theme}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${theme} console: ${m.text()}`));
  await page.goto(url);
  await page.getByRole('heading', { name: 'Mainline' }).waitFor();
  await shot(page, `board-${theme}`);
  if (theme === 'dark') {
    await page.getByRole('button', { name: /^Round tax down.*owner/ }).click();
    await page.getByRole('tab', { name: 'Checks' }).click();
    await shot(page, 'inspector-checks');
    await page.getByRole('tab', { name: 'Diff' }).click();
    await shot(page, 'inspector-diff');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Overlaps/ }).click();
    await shot(page, 'overlaps');
    await page.getByRole('button', { name: /Checks/ }).first().click();
    await shot(page, 'checks');
    await page.getByRole('button', { name: /Board/ }).click();
  }
  await ctx.close();
}

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await phone.newPage();
p.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await p.goto(url);
await p.getByRole('heading', { name: 'Mainline' }).waitFor();
await shot(p, 'phone-board');
await p.getByRole('button', { name: /^Add bulk discount.*owner/ }).click();
await shot(p, 'phone-inspector');
const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log(`  phone horizontal overflow: ${overflow}px`);

await browser.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
