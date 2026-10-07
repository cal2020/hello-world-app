import { expect, test, type Page } from '@playwright/test';
import { enterCell, panelHeading, waitForCloseup } from './helpers';

/** Every visible control does what it says. */

/** Nanometres per screen pixel at the focus point (bar length ÷ bar width). */
const nmPerPx = async (page: Page) => {
  const lengthNm = Number(await page.getByTestId('scale-indicator').getAttribute('data-length-nm'));
  const width = await page.locator('.scale-bar').evaluate((el) => el.getBoundingClientRect().width);
  return lengthNm / width;
};

test('zoom, reset, quality, motion, text atlas and About', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/en/');
  await enterCell(page);

  // The scale bar updates on the next rendered frame; wait for a stable reading.
  await expect.poll(async () => {
    const a = await nmPerPx(page);
    await page.waitForTimeout(1200);
    return Math.abs((await nmPerPx(page)) - a);
  }, { timeout: 60_000 }).toBeLessThan(1e-6);
  const before = await nmPerPx(page);
  await page.getByTestId('zoom-in').click();
  await expect.poll(() => nmPerPx(page), { timeout: 30_000 }).toBeLessThan(before * 0.97);
  await page.getByTestId('zoom-out').click();
  await page.getByTestId('zoom-out').click();
  await expect.poll(() => nmPerPx(page), { timeout: 30_000 }).toBeGreaterThan(before * 1.03);
  await page.getByTestId('reset-view').click();
  await expect.poll(async () => Math.abs((await nmPerPx(page)) / before - 1), { timeout: 30_000 }).toBeLessThan(0.03);

  // Quality: the number of drawn ribosomes follows the setting.
  await page.locator('#structure-nav [data-structure="ribosomes"]').click();
  const drawn = page.getByTestId('drawn-count');
  await page.getByTestId('quality-select').selectOption('low');
  await expect(drawn).toContainText('Low');
  const low = await drawn.textContent();
  await page.getByTestId('quality-select').selectOption('high');
  await expect(drawn).toContainText('High');
  expect(await drawn.textContent()).not.toBe(low);

  // Motion setting is applied to the document.
  await page.getByTestId('motion-select').selectOption('reduce');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');

  // Text atlas and back.
  await page.getByTestId('text-atlas-toggle').click();
  await expect(page.getByTestId('text-atlas')).toBeVisible();
  await page.getByTestId('back-to-3d').click();
  await expect(page.getByTestId('text-atlas')).toBeHidden();

  // About opens as its own page and closes back to the structure.
  await page.getByTestId('about-open').click();
  await expect(page).toHaveURL(/\/en\/about\/$/);
  await expect(page.getByTestId('about-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/en\/ribosomes\/$/);
  expect(errors).toEqual([]);
});

test('labels, related links, citations, close-up views and the location inset', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);

  // A label selects its structure.
  const label = page.getByTestId('label-layer').locator('.scene-label:not([hidden])', { hasText: 'Nucleus' }).first();
  await label.click();
  await expect(page).toHaveURL(/\/en\/nucleus\/$/);

  // A related-structure link selects it.
  await page.getByTestId('reading-panel').getByRole('button', { name: /Chromosomes/ }).first().click();
  await expect(page).toHaveURL(/\/en\/chromosomes\/$/);

  // Citation numbers point at the source list of the same article.
  const cite = page.getByTestId('reading-panel').locator('a.cite').first();
  const target = (await cite.getAttribute('href'))!.slice(1);
  await expect(page.locator(`[id="${target}"]`)).toHaveCount(1);
  await expect(page.locator(`[id="${target}"] a[href^="http"]`).first()).toHaveAttribute('href', /^https:\/\//);

  // Close-up with two views, then back through the location inset.
  await page.getByTestId('closeup-toggle').click();
  await waitForCloseup(page);
  await page.getByRole('button', { name: 'DNA packaging' }).click();
  await expect(page).toHaveURL(/detail=nucleosomes/);
  await expect(page.getByTestId('scale-length')).toHaveText(/nm/);
  await page.getByTestId('back-to-cell').click();
  await expect(page).toHaveURL(/\/en\/chromosomes\/$/);
  await expect(panelHeading(page)).toHaveText('Chromosomes');
});

test('tour controls and annotated export', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  await page.getByTestId('tour-toggle').click();
  await expect(page.getByTestId('tour-step')).toContainText('1');
  await page.getByTestId('tour-next').click();
  await expect(page).toHaveURL(/\/en\/cytoplasm\/$/);
  await expect(page.getByTestId('tour-step')).toContainText('2');
  await page.getByTestId('tour-prev').click();
  await expect(page).toHaveURL(/\/en\/plasma-membrane\/$/);
  await page.getByTestId('tour-exit').click();
  await expect(page.getByTestId('tour-bar')).toBeHidden();

  await page.getByTestId('export-open').click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByTestId('export-annotated').first().click()]);
  expect(download.suggestedFilename()).toMatch(/annotated\.png$/);
  const path = await download.path();
  expect(path).toBeTruthy();
});

test('rapid selection, resizing and rotation leave a consistent state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/en/');
  await enterCell(page);
  for (const id of ['nucleus', 'golgi', 'mitochondria', 'lysosomes', 'centrosome']) {
    await page.locator(`#structure-nav [data-structure="${id}"]`).click();
  }
  await expect(page).toHaveURL(/\/en\/centrosome\/$/);
  await expect(panelHeading(page)).toHaveText('Centrosome');
  await expect(page.locator('.app')).toHaveAttribute('data-view-state', 'focused', { timeout: 60_000 });

  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1024, height: 1366 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(800);
    await expect(panelHeading(page)).toHaveText('Centrosome');
  }
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'wide');
  expect(errors).toEqual([]);
});
