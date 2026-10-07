import { expect, test } from '@playwright/test';
import { enterCell, panelHeading } from './helpers';

test('phone layout: list drawer, bottom sheet and settings', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'compact');
  await page.getByTestId('list-toggle').click();
  await page.locator('#structure-nav [data-structure="ribosomes"]').click();
  await expect(page).toHaveURL(/\/en\/ribosomes\/$/);
  await expect(panelHeading(page)).toHaveText('Ribosomes');
  const handle = page.getByTestId('sheet-handle');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('more').click();
  await expect(page.getByTestId('quality-select')).toBeVisible();
  await expect(page.getByTestId('motion-select')).toBeVisible();
});
