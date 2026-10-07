import { expect, test } from '@playwright/test';
import { enterCell, panelHeading, waitForCloseup } from './helpers';

/**
 * The demonstration journey from the brief: enter → mitochondria → internal
 * membranes → whole cell → search ribosomes → translation close-up → tour
 * start/pause → language switch → image export.
 */
test('main demonstration journey', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/en/');
  await enterCell(page);
  await expect(page.getByTestId('label-layer').locator('.scene-label:not([hidden])').first()).toBeVisible();

  // Select mitochondria from the list.
  await page.locator('#structure-nav [data-structure="mitochondria"]').click();
  await expect(page).toHaveURL(/\/en\/mitochondria\/$/);
  await expect(panelHeading(page)).toHaveText('Mitochondria');
  await expect(page).toHaveTitle(/^Mitochondria/);

  // Internal membranes: the close-up, then its ATP synthase view.
  await page.getByTestId('closeup-toggle').click();
  await expect(page).toHaveURL(/\?view=closeup$/);
  await waitForCloseup(page);
  await expect(page.getByTestId('location-inset')).toBeVisible();
  await expect(page.getByTestId('scale-length')).toHaveText(/nm/);
  await page.getByRole('button', { name: 'Proton gradient and ATP synthase' }).click();
  await expect(page).toHaveURL(/detail=atp-synthase/);

  // Back to the whole cell.
  await page.getByTestId('whole-cell').click();
  await expect(page).toHaveURL(/\/en\/$/);
  await expect(page.getByTestId('scale-length')).toHaveText(/µm/);

  // Search for ribosomes and open the translation close-up.
  await page.getByTestId('search-input').fill('ribosomes');
  await page.getByTestId('search-input').press('Enter');
  await expect(page).toHaveURL(/\/en\/ribosomes\/$/);
  await page.getByTestId('closeup-toggle').click();
  await waitForCloseup(page);
  await expect(page.getByTestId('reading-panel')).toContainText('Translation');

  // Guided tour: start, then pause (the step and remaining time are kept).
  await page.getByTestId('tour-toggle').click();
  await expect(page.getByTestId('tour-bar')).toBeVisible();
  await expect(page.getByTestId('tour-step')).toContainText('1');
  await expect(page).toHaveURL(/\/en\/plasma-membrane\/$/);
  await page.getByTestId('tour-pause').click();
  await expect(page.getByTestId('tour-status')).toHaveText(/Paused/);
  await page.getByTestId('tour-exit').click();

  // Switch language: same structure, French text, French URL.
  await page.getByTestId('language-select').selectOption('fr');
  await expect(page).toHaveURL(/\/fr\/plasma-membrane\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(panelHeading(page)).not.toHaveText('Plasma membrane');

  // Export a clean PNG.
  await page.getByTestId('export-open').click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByTestId('export-clean').first().click()]);
  expect(download.suggestedFilename()).toMatch(/^human-cell-atlas-.*\.png$/);

  expect(errors).toEqual([]);
});
