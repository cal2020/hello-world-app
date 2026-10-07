/**
 * Captures the documentation screenshots (docs/screenshots/) from a running
 * production preview:
 *
 *   npm run build && npm run preview      (in one terminal)
 *   npm run screenshots                   (in another)
 *
 * Set SCREENSHOT_URL to use another server (default http://localhost:4173).
 * WebGL runs in software (SwiftShader) when no GPU is available, which is
 * slow but produces the same images.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'docs', 'screenshots');
const base = (process.env.SCREENSHOT_URL ?? 'http://localhost:4173').replace(/\/$/, '');

interface Shot {
  name: string;
  path: string;
  viewport: { width: number; height: number };
  mobile?: boolean;
  /** Extra steps after the page is ready. */
  steps?: (page: Page) => Promise<void>;
  /** Start biological animation (reduced motion starts it frozen). */
  play?: boolean;
  waitMs?: number;
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = document.querySelector<HTMLElement>('.app');
      if (!app) return false;
      if (app.dataset.phase === 'failed') return true;
      if (app.dataset.closeup === 'loading') return false;
      return app.dataset.phase === 'exploring' || app.dataset.phase === 'ready';
    },
    null,
    { timeout: 240_000, polling: 500 },
  );
}

const desktop = { width: 1440, height: 900 };
const tablet = { width: 1024, height: 1366 };
const phone = { width: 390, height: 844 };

const SHOTS: Shot[] = [
  { name: 'desktop-entry', path: '/en/', viewport: desktop, waitMs: 1500 },
  {
    name: 'desktop-overview',
    path: '/en/',
    viewport: desktop,
    steps: async (page) => {
      await page.getByTestId('enter-cell').click();
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'exploring', null, { timeout: 120_000 });
    },
  },
  { name: 'desktop-mitochondria', path: '/en/mitochondria/', viewport: desktop },
  { name: 'desktop-mitochondria-closeup', play: true, path: '/en/mitochondria/?view=closeup', viewport: desktop },
  { name: 'desktop-atp-synthase', play: true, path: '/en/mitochondria/?view=closeup&detail=atp-synthase', viewport: desktop, waitMs: 6000 },
  { name: 'desktop-ribosome-translation', play: true, path: '/en/ribosomes/?view=closeup', viewport: desktop, waitMs: 6000 },
  { name: 'desktop-kinesin', play: true, path: '/en/vesicles-and-motor-proteins/?view=closeup', viewport: desktop, waitMs: 4000 },
  { name: 'desktop-plasma-membrane-closeup', play: true, path: '/en/plasma-membrane/?view=closeup', viewport: desktop, waitMs: 4000 },
  { name: 'desktop-french-nucleus', path: '/fr/nucleus/', viewport: desktop },
  { name: 'desktop-french-nuclear-pore', play: true, path: '/fr/nucleus/?view=closeup', viewport: desktop, waitMs: 5000 },
  { name: 'desktop-chinese-golgi', path: '/zh/golgi-apparatus/', viewport: desktop },
  { name: 'desktop-text-atlas', path: '/en/?renderer=fail', viewport: desktop },
  { name: 'tablet-overview', path: '/en/', viewport: tablet, mobile: true, steps: async (page) => page.getByTestId('enter-cell').click() },
  { name: 'tablet-endosomes', path: '/es/endosomes/', viewport: tablet, mobile: true },
  { name: 'tablet-golgi-closeup', play: true, path: '/sr/golgi-apparatus/?view=closeup', viewport: tablet, mobile: true, waitMs: 4000 },
  { name: 'phone-overview', path: '/en/', viewport: phone, mobile: true, steps: async (page) => page.getByTestId('enter-cell').click() },
  { name: 'phone-nucleolus', path: '/ru/nucleolus/', viewport: phone, mobile: true },
  { name: 'phone-closeup', play: true, path: '/it/telomeres/?view=closeup', viewport: phone, mobile: true, waitMs: 3000 },
];

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const only = process.argv.slice(2);
  for (const shot of SHOTS.filter((s) => only.length === 0 || only.includes(s.name))) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: 1,
      isMobile: !!shot.mobile,
      hasTouch: !!shot.mobile,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${base}${shot.path}`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    if (shot.steps) {
      await shot.steps(page);
      await ready(page);
    }
    if (shot.play) {
      const freeze = page.getByTestId('freeze-toggle');
      if ((await freeze.count()) && (await freeze.getAttribute('aria-pressed')) === 'true') await freeze.click();
    }
    // Let labels settle and a few frames render.
    await page.waitForTimeout(shot.waitMs ?? 3000);
    await page.screenshot({ path: join(out, `${shot.name}.png`), timeout: 120_000 });
    console.log(`${shot.name}.png  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    await context.close();
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
