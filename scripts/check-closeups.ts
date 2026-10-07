/**
 * Opens every close-up view (21) one after another in a running preview and
 * reports, per view: load time, draw calls, triangles, console errors, and the
 * GPU resource counts after returning to the cell (to catch leaks).
 *
 *   npm run build && npm run preview   (one terminal)
 *   npm run check:closeups             (another; add -- --quality=high to force a level)
 *
 * Exit code 1 when a view fails to open, logs an error, or leaks resources.
 */
import { chromium } from '@playwright/test';
import { STRUCTURE_META } from '../src/content/structures';

const base = (process.env.CHECK_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const quality = process.argv.find((a) => a.startsWith('--quality='))?.split('=')[1] ?? 'low';
const gpu = process.argv.includes('--gpu');

type Debug = {
  memory: () => { geometries: number; textures: number; programs: number };
  render: () => { calls: number; triangles: number };
};

async function main(): Promise<void> {
  const args = gpu ? ['--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })).newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/en/?perf=1&quality=${quality}`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'ready', null, { timeout: 240_000 });
  await page.getByTestId('enter-cell').click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'exploring', null, { timeout: 240_000 });
  await page.waitForTimeout(1500);
  const memory = () => page.evaluate(() => (window as unknown as { __HCA_DEBUG__: Debug }).__HCA_DEBUG__.memory());
  const baseline = await memory();

  const rows: string[] = [];
  let failed = false;
  for (const meta of STRUCTURE_META) {
    for (let index = 0; index < meta.closeup.views.length; index++) {
      const view = meta.closeup.views[index];
      const before = errors.length;
      const started = Date.now();
      // Navigate inside the running app (no reload), as a reader would.
      await page.evaluate(
        ({ path }) => {
          window.history.pushState(null, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        { path: `/en/${meta.slug}/?view=closeup${index > 0 ? `&detail=${view.id}` : ''}&perf=1` },
      );
      let status = 'ok';
      try {
        await page.waitForFunction(
          () => {
            const app = document.querySelector<HTMLElement>('.app');
            return app?.dataset.closeup === 'error' || (app?.dataset.closeup === 'ready' && app.dataset.viewState === 'closeup');
          },
          null,
          { timeout: 180_000, polling: 250 },
        );
        if ((await page.locator('.app').getAttribute('data-closeup')) === 'error') status = 'ERROR';
      } catch {
        status = 'TIMEOUT';
      }
      const loadMs = Date.now() - started;
      await page.waitForTimeout(2500);
      const stats = await page.evaluate(() => (window as unknown as { __HCA_DEBUG__: Debug }).__HCA_DEBUG__.render());
      const labels = await page.locator('.scene-label:not([hidden])').count();
      // Back to the cell and check that the close-up's resources were released.
      await page.evaluate(() => {
        window.history.pushState(null, '', '/en/?perf=1');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.closeup === 'idle', null, { timeout: 60_000 });
      await page.waitForTimeout(800);
      const after = await memory();
      const leak = after.geometries - baseline.geometries > 2 || after.textures - baseline.textures > 2;
      const newErrors = errors.slice(before);
      if (status !== 'ok' || leak || newErrors.length) failed = true;
      rows.push(
        `| ${meta.id}${meta.closeup.views.length > 1 ? ` / ${view.id}` : ''} | ${status} | ${(loadMs / 1000).toFixed(1)} s | ${stats.calls} | ${stats.triangles.toLocaleString('en')} | ${labels} | ${leak ? `LEAK (+${after.geometries - baseline.geometries} geometries, +${after.textures - baseline.textures} textures)` : 'released'} | ${newErrors.length ? newErrors.join('; ').slice(0, 120) : '–'} |`,
      );
      console.error(`${meta.id}/${view.id}: ${status}`);
    }
  }
  await browser.close();
  console.log(`Quality: ${quality}. Baseline after entering: ${baseline.geometries} geometries, ${baseline.textures} textures.\n`);
  console.log('| Close-up view | Opened | Load | Draw calls | Triangles | Labels shown | Resources after leaving | Console errors |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
