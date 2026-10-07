import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enterCell } from './helpers';

const scan = (page: import('@playwright/test').Page) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('canvas').analyze();

test('no detectable WCAG A/AA violations in the main views', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  expect((await scan(page)).violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

  await page.locator('#structure-nav [data-structure="nucleus"]').click();
  await expect(page).toHaveURL(/nucleus/);
  expect((await scan(page)).violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

  await page.getByTestId('help').click();
  expect((await scan(page)).violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test('keyboard: skip link and search shortcut', async ({ page }) => {
  await page.goto('/en/');
  await enterCell(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link').first()).toBeFocused();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('/');
  await expect(page.getByTestId('search-input')).toBeFocused();
});
