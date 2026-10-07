import { expect, test } from '@playwright/test';
import { enterCell } from './helpers';

test('3D start-up failure shows the complete text atlas', async ({ page }) => {
  await page.goto('/en/?renderer=fail');
  await expect(page.getByTestId('failure-banner')).toBeVisible();
  const atlas = page.getByTestId('text-atlas');
  await expect(atlas).toBeVisible();
  await expect(atlas.locator('section[id^="atlas-"]')).toHaveCount(19);
  await expect(atlas).toContainText('Mitochondria');
});

test('a failed language load keeps the page usable and says so', async ({ page }) => {
  await page.goto('/fr/?simulate=locale-failure');
  await expect(page.getByTestId('locale-banner')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('losing the WebGL context offers a restart', async ({ page }) => {
  await page.goto('/en/?simulate=context-loss');
  await enterCell(page);
  await expect(page.getByTestId('failure-banner')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('restart-3d').click();
  await expect(page.getByTestId('failure-banner')).toBeHidden();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('every page is readable as prerendered text', async ({ page }) => {
    await page.goto('/fr/mitochondria/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/fr\/mitochondria\/$/);
    await expect(page.locator('link[rel="alternate"][hreflang="zh-Hans"]')).toHaveAttribute('href', /\/zh\/mitochondria\/$/);
    await page.locator('.static-prev-next a[rel="next"]').click();
    await expect(page).toHaveURL(/\/fr\/lysosomes\/$/);
    await page.goto('/en/about/');
    await expect(page.locator('h1')).toHaveText('About this atlas');
  });
});
