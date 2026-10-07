import { expect, test } from '@playwright/test';
import { enterCell, panelHeading, waitForCloseup } from './helpers';

test('deep links, Back/Forward and Escape', async ({ page }) => {
  await page.goto('/en/nucleus/?view=closeup');
  await waitForCloseup(page);
  await expect(panelHeading(page)).toHaveText('Nucleus');

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/en\/nucleus\/$/);
  await page.locator('#structure-nav [data-structure="golgi"]').click();
  await expect(page).toHaveURL(/\/en\/golgi-apparatus\/$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/en\/nucleus\/$/);
  await expect(panelHeading(page)).toHaveText('Nucleus');
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/nucleus\/\?view=closeup$/);
  await waitForCloseup(page);
  await page.goForward();
  await page.goForward();
  await expect(panelHeading(page)).toHaveText('Golgi apparatus');

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/en\/$/);
});

test('previous and next wrap around', async ({ page }) => {
  await page.goto('/en/centrosome/');
  await enterCell(page);
  await page.getByTestId('next-structure').click();
  await expect(page).toHaveURL(/\/en\/plasma-membrane\/$/);
  await page.getByTestId('prev-structure').click();
  await expect(page).toHaveURL(/\/en\/centrosome\/$/);
});

test('search: synonyms and an empty state', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  const search = page.getByTestId('search-input');
  await search.fill('cell membrane');
  await expect(page.getByTestId('search-results').locator('[data-structure]').first()).toHaveAttribute('data-structure', 'plasma-membrane');
  await search.fill('mitochondrion');
  await expect(page.getByTestId('search-results').locator('[data-structure]').first()).toHaveAttribute('data-structure', 'mitochondria');
  await search.fill('zzzz');
  await expect(page.getByTestId('search-empty')).toBeVisible();
});

test('labels toggle and biological freeze', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  const labels = page.getByTestId('labels-toggle');
  await expect(labels).toHaveAttribute('aria-pressed', 'true');
  await labels.click();
  await expect(labels).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('label-layer').locator('.scene-label:not([hidden])')).toHaveCount(0);
  const freeze = page.getByTestId('freeze-toggle');
  const before = await freeze.getAttribute('aria-pressed');
  await freeze.click();
  await expect(freeze).not.toHaveAttribute('aria-pressed', before ?? '');
});

test('unknown pages fall back to the whole cell with a notice', async ({ page }) => {
  await page.goto('/en/not-a-structure/');
  await expect(page).toHaveURL(/\/en\/$/);
  await expect(page.getByTestId('toasts')).toContainText('does not exist');
});
