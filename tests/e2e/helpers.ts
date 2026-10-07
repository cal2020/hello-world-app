import { expect, type Page } from '@playwright/test';

/** Wait until the 3D scene is built (entry screen ready) or the app is exploring. */
export async function waitForScene(page: Page): Promise<void> {
  await expect
    .poll(async () => page.locator('.app').getAttribute('data-phase'), { timeout: 180_000, intervals: [500] })
    .toMatch(/ready|exploring/);
}

export async function enterCell(page: Page): Promise<void> {
  await waitForScene(page);
  const enter = page.getByTestId('enter-cell');
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await expect(page.locator('.app')).toHaveAttribute('data-phase', 'exploring', { timeout: 120_000 });
}

export async function waitForCloseup(page: Page): Promise<void> {
  await expect(page.locator('.app')).toHaveAttribute('data-closeup', 'ready', { timeout: 120_000 });
}

export const panelHeading = (page: Page) => page.getByTestId('reading-panel').locator('h1, h2').first();
