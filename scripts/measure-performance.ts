/**
 * Measures start-up and frame times against a running production preview.
 *
 *   npm run build && npm run preview          (one terminal)
 *   npm run perf                              (another; software WebGL)
 *   npm run perf -- --gpu                     (use the machine's GPU; run headed if headless has no GPU)
 *   npm run perf -- --headed --gpu
 *
 * Prints a Markdown table (copy it into docs/PERFORMANCE.md together with the
 * machine, browser and GPU used). PERF_URL overrides the server address.
 */
import { chromium } from '@playwright/test';

const base = (process.env.PERF_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const gpu = process.argv.includes('--gpu');
const headed = process.argv.includes('--headed');
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS ?? 6000);

interface Scenario {
  name: string;
  path: string;
  quality: 'low' | 'medium' | 'high';
  viewport: { width: number; height: number };
  mobile?: boolean;
  enter?: boolean;
}

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const SCENARIOS: Scenario[] = [
  { name: 'Whole cell, desktop', path: '/en/', quality: 'low', viewport: desktop, enter: true },
  { name: 'Whole cell, desktop', path: '/en/', quality: 'medium', viewport: desktop, enter: true },
  { name: 'Whole cell, desktop', path: '/en/', quality: 'high', viewport: desktop, enter: true },
  { name: 'Mitochondria in the cell, desktop', path: '/en/mitochondria/', quality: 'medium', viewport: desktop },
  { name: 'ATP synthase close-up, desktop', path: '/en/mitochondria/?view=closeup&detail=atp-synthase', quality: 'medium', viewport: desktop },
  { name: 'Ribosome close-up, desktop', path: '/en/ribosomes/?view=closeup', quality: 'medium', viewport: desktop },
  { name: 'Whole cell, phone', path: '/en/', quality: 'low', viewport: phone, mobile: true, enter: true },
  { name: 'Kinesin close-up, phone', path: '/en/vesicles-and-motor-proteins/?view=closeup', quality: 'low', viewport: phone, mobile: true },
];

async function main(): Promise<void> {
  const args = gpu ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ headless: !headed, args });
  const rows: string[] = [];
  let renderer = '';
  for (const scenario of SCENARIOS) {
    const context = await browser.newContext({ viewport: scenario.viewport, isMobile: !!scenario.mobile, hasTouch: !!scenario.mobile, deviceScaleFactor: scenario.mobile ? 2 : 1 });
    // tsx keeps function names by wrapping named functions in __name(); the
    // callbacks passed to page.evaluate run in the page, which lacks that helper.
    await context.addInitScript({ content: 'globalThis.__name = (fn) => fn;' });
    const page = await context.newPage();
    const sep = scenario.path.includes('?') ? '&' : '?';
    await page.goto(`${base}${scenario.path}${sep}perf=1&quality=${scenario.quality}`, { waitUntil: 'domcontentloaded' });
    const readyMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const check = () => {
            const app = document.querySelector<HTMLElement>('.app');
            if (app && (app.dataset.phase === 'ready' || app.dataset.phase === 'exploring')) resolve(performance.now());
            else setTimeout(check, 50);
          };
          check();
        }),
    );
    if (scenario.enter) await page.getByTestId('enter-cell').click();
    await page.waitForFunction(
      () => {
        const app = document.querySelector<HTMLElement>('.app');
        return app?.dataset.phase === 'exploring' && app.dataset.closeup !== 'loading' && app.dataset.viewState !== 'transition';
      },
      null,
      { timeout: 240_000, polling: 250 },
    );
    await page.waitForTimeout(1500);
    const sample = await page.evaluate(
      (ms) =>
        new Promise<{ frames: number; avg: number; p95: number; worst: number }>((resolve) => {
          const times: number[] = [];
          let last = performance.now();
          const start = last;
          const tick = (now: number) => {
            times.push(now - last);
            last = now;
            if (now - start < ms) requestAnimationFrame(tick);
            else {
              const sorted = [...times].sort((a, b) => a - b);
              resolve({ frames: times.length, avg: (now - start) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1] });
            }
          };
          requestAnimationFrame(tick);
        }),
      SAMPLE_MS,
    );
    const overlay = (await page.getByTestId('perf-overlay').textContent().catch(() => '')) ?? '';
    const calls = overlay.match(/calls (\d+)/)?.[1] ?? '?';
    const tris = overlay.match(/tris ([\d,]+)/)?.[1] ?? '?';
    if (!renderer) {
      renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'no WebGL 2';
      });
    }
    rows.push(
      `| ${scenario.name} | ${scenario.viewport.width}×${scenario.viewport.height} | ${scenario.quality} | ${(readyMs / 1000).toFixed(1)} s | ${(1000 / sample.avg).toFixed(1)} | ${sample.avg.toFixed(0)} / ${sample.p95.toFixed(0)} ms | ${calls} | ${tris} |`,
    );
    console.error(`measured: ${scenario.name} (${scenario.quality})`);
    await context.close();
  }
  await browser.close();
  console.log(`Renderer: ${renderer}\n`);
  console.log('| Scenario | Viewport | Quality | Scene ready | FPS | Frame avg / p95 | Draw calls | Triangles |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
