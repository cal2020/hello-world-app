// Browser end-to-end: the built UI against a real Zit engine in a disposable
// repository. Needs `npm run build` and a Chromium (Playwright's, or CHROMIUM_PATH).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repo, Task, TaskView } from '../shared/api';
import { edit, makeRepo, projectRoot, startHarness, state, zitBin, type Harness } from './harness';

const dist = join(projectRoot, 'dist');
const chrome = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => p && existsSync(p));
const run = zitBin && existsSync(join(dist, 'index.html')) && chrome ? describe : describe.skip;

run('UI end to end', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let repo: Repo;
  const errors: string[] = [];

  beforeAll(async () => {
    h = await startHarness({ staticRoot: dist });
    repo = await h.ok<Repo>('POST', '/api/repos', { path: await makeRepo(h, 'store'), demo: true });
    await h.ok('POST', `/api/repos/${repo.id}/init`, {});
    const mk = async (title: string, owner: string, change: (ws: string) => Promise<void>) => {
      const t = await h.ok<Task>('POST', `/api/repos/${repo.id}/tasks`, { title, owner, notes: '' });
      const v = (await state(h, repo.id)).tasks.find((x: TaskView) => x.id === t.id)!;
      await change(v.primaryWorkspace!.path);
      await h.ok('POST', `/api/repos/${repo.id}/workspaces/${v.primaryWorkspace!.id}/record`, { summary: `${owner} did it` });
    };
    await mk('Add discount module', 'alice', (p) => edit(p, 'src/discount.js', () => 'export const d = 1;\n'));
    await mk('Truncate tax', 'carol', (p) => edit(p, 'src/pricing.js', (s) => s.replace('Math.round(cents * rate)', 'Math.floor(cents * rate)')));
    browser = await chromium.launch({ executablePath: chrome });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('428') && !m.text().includes('409') && errors.push(m.text()));
  });
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  const lane = (name: string) => page.getByRole('region', { name: new RegExp(`^${name} \\(`) });
  const card = (title: string) => page.getByRole('button', { name: new RegExp(`^${title}, `) });
  const cards = (name: string) => lane(name).getByRole('button', { name: /, owner / });

  it('shows the board from engine state', async () => {
    await page.goto(h.base);
    await page.getByRole('heading', { name: 'Mainline' }).waitFor();
    await expect.poll(() => cards('Waiting').count()).toBe(2);
    expect(await page.getByText('Synthetic demo data').isVisible()).toBe(true);
  });

  it('asks for approval of the exact command, then runs the failing check', async () => {
    await card('Truncate tax').click();
    await page.getByRole('button', { name: 'Run checks' }).last().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    expect(await dialog.getByText('node --test').isVisible()).toBe(true);
    await dialog.getByRole('button', { name: /Approve command and continue/ }).click();
    await expect.poll(() => lane('Check failed').getByRole('button', { name: /^Truncate tax/ }).count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => page.getByRole('button', { name: 'Accept', exact: true }).isDisabled()).toBe(true);
  });

  it('accepts a change through Zit and keeps it accepted after reload', async () => {
    await page.keyboard.press('Escape');
    await card('Add discount module').click();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Accept through Zit' }).click();
    await expect.poll(() => lane('Accepted').getByRole('button', { name: /^Add discount module/ }).count(), { timeout: 30_000 }).toBe(1);
    await page.reload();
    await page.getByRole('heading', { name: 'Mainline' }).waitFor();
    await expect.poll(() => lane('Accepted').getByRole('button', { name: /^Add discount module/ }).count()).toBe(1);
    // Carol's failed change is still there, intact.
    await expect.poll(() => cards('Check failed').count()).toBe(1);
  });

  it('creates a task from the keyboard', async () => {
    await page.keyboard.press('n');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Task').fill('Write the changelog');
    await dialog.getByLabel('Owner').fill('dana');
    await dialog.getByRole('button', { name: 'Open workspace' }).click();
    await expect.poll(() => lane('Editing').getByRole('button', { name: /^Write the changelog/ }).count(), { timeout: 20_000 }).toBe(1);
    expect(await page.getByRole('complementary').getByText(/Workspace [0-9a-f]{8}/).first().isVisible()).toBe(true);
  });

  it('keeps essential actions reachable on a phone-sized screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await card('Truncate tax').click();
    expect(await page.getByRole('button', { name: 'Re-run checks' }).isVisible()).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  it('logged no browser errors', () => {
    expect(errors).toEqual([]);
  });
});
