/**
 * Shows, for every close-up view, when each of its labels is in phase over the
 * animation loop, and suggests a poster moment (the middle of the longest
 * window in which the most labels are shown). Use it to choose a view's
 * `posterTime` (see src/engine/closeups/types.ts), then check the frozen frame.
 *
 *   npm run build && npm run preview   (one terminal)
 *   npm run probe:labels               (another; add view ids to limit, e.g. -- golgi)
 *
 * Labels can still be hidden on screen by overlap or occlusion; this only
 * reports the phase-limited visibility each close-up declares.
 */
import { chromium } from '@playwright/test';
import { STRUCTURE_META } from '../src/content/structures';

const base = (process.env.CHECK_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const STEP = 0.25;
const SPAN = 40;

type Probe = { labels: string[]; inPhase: boolean[][] } | null;
type Debug = { closeupLabels: (times: number[]) => Probe };

function windows(flags: boolean[], times: number[]): string {
  const out: string[] = [];
  let start = -1;
  flags.forEach((on, i) => {
    if (on && start < 0) start = i;
    if ((!on || i === flags.length - 1) && start >= 0) {
      out.push(`${times[start]}–${times[on ? i : i - 1]} s`);
      start = -1;
    }
  });
  return out.length === 0 ? 'never' : out.length === 1 && out[0] === `0–${SPAN} s` ? 'always' : out.slice(0, 4).join(', ');
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 800, height: 500 }, reducedMotion: 'reduce' })).newPage();
  await page.goto(`${base}/en/?perf=1&quality=low`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'ready', null, { timeout: 240_000 });
  await page.getByTestId('enter-cell').click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.phase === 'exploring', null, { timeout: 240_000 });
  const times = Array.from({ length: Math.round(SPAN / STEP) + 1 }, (_, i) => i * STEP);

  for (const meta of STRUCTURE_META) {
    if (only.length && !only.includes(meta.id)) continue;
    for (let index = 0; index < meta.closeup.views.length; index++) {
      const view = meta.closeup.views[index];
      await page.evaluate(
        ({ path }) => {
          window.history.pushState(null, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        { path: `/en/${meta.slug}/?view=closeup${index > 0 ? `&detail=${view.id}` : ''}&perf=1` },
      );
      await page.waitForFunction(
        () => {
          const app = document.querySelector<HTMLElement>('.app');
          return app?.dataset.closeup === 'ready' && app.dataset.viewState === 'closeup';
        },
        null,
        { timeout: 180_000, polling: 250 },
      );
      const probe = await page.evaluate((t) => (window as unknown as { __HCA_DEBUG__: Debug }).__HCA_DEBUG__.closeupLabels(t), times);
      if (probe) {
        const counts = probe.inPhase.map((row) => row.filter(Boolean).length);
        const most = Math.max(...counts);
        // Longest run of samples with the most labels; suggest its middle.
        let best = { start: 0, length: 0 };
        let start = -1;
        counts.forEach((count, i) => {
          if (count === most && start < 0) start = i;
          if ((count !== most || i === counts.length - 1) && start >= 0) {
            const length = (count === most ? i + 1 : i) - start;
            if (length > best.length) best = { start, length };
            start = -1;
          }
        });
        const suggestion = times[best.start + Math.floor((best.length - 1) / 2)];
        console.log(`\n${meta.id} / ${view.id}: ${most} of ${probe.labels.length} labels at most; at 0 s: ${counts[0]}; suggested poster time ≈ ${suggestion} s`);
        probe.labels.forEach((label, j) => console.log(`  ${label.padEnd(44)} ${windows(probe.inPhase.map((row) => row[j]), times)}`));
      }
      await page.evaluate(() => {
        window.history.pushState(null, '', '/en/?perf=1');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.app')?.dataset.closeup === 'idle', null, { timeout: 60_000 });
    }
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
