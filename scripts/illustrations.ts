/**
 * Renders one original illustration per structure from its close-up (and the
 * whole cell) into public/illustrations/, for the text atlas and the
 * prerendered pages. Run against a production preview:
 *
 *   npm run build && npm run preview      (one terminal)
 *   npm run illustrations                 (another)
 *
 * Images are 960×600 JPEG renders of this project's own 3D scenes.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { STRUCTURE_META } from '../src/content/structures';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'public', 'illustrations');
const base = (process.env.ILLUSTRATION_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const quality = process.env.ILLUSTRATION_QUALITY ?? 'high';

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const only = process.argv.slice(2);
  const jobs = [
    { id: 'cell', path: '/en/' },
    ...STRUCTURE_META.map((s) => ({ id: s.id, path: `/en/${s.slug}/?view=closeup` })),
  ].filter((job) => only.length === 0 || only.includes(job.id));
  for (const job of jobs) {
    const context = await browser.newContext({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const started = Date.now();
    const sep = job.path.includes('?') ? '&' : '?';
    await page.goto(`${base}${job.path}${sep}capture=1&quality=${quality}`, { waitUntil: 'domcontentloaded' });
    if (job.id === 'cell') {
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'ready', null, { timeout: 240_000 });
      await page.getByTestId('enter-cell').click();
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'exploring', null, { timeout: 240_000 });
      await page.waitForTimeout(8000);
    } else {
      await page.waitForFunction(
        () => {
          const app = document.querySelector<HTMLElement>('.app');
          return app?.dataset.closeup === 'ready' && app.dataset.viewState === 'closeup';
        },
        null,
        { timeout: 240_000, polling: 500 },
      );
      // Let the teaching animation reach a representative moment.
      await page.waitForTimeout(6000);
    }
    await page.screenshot({ path: join(out, `${job.id}.jpg`), type: 'jpeg', quality: 82, timeout: 180_000 });
    console.log(`${job.id}.jpg (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    await context.close();
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
