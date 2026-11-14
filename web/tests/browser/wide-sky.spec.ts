import { test, expect } from '@playwright/test';

test('the zoom ruler reaches the 105 degree survey and returns to frame scale', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#ra=269.4463&dec=4.7677&fov=1');
  await page.waitForFunction(() => Boolean((window as any).__stel?.core));
  const ruler = page.getByRole('slider', { name: 'Field of view' });
  await ruler.focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => (window as any).__stel.core.fov * 180 / Math.PI)).toBeCloseTo(105, 1);
  await expect(page.locator('.field-ruler-note')).toContainText('Zoom in past 30′');
  await page.waitForTimeout(30000);
  await page.screenshot({ path: 'test-results/wide-sky-105.png' });
  expect(await page.evaluate(() => (window as any).__stel.core.dss.visible)).toBeTruthy();
  // Six PageUps are 24 steps of 1.25: 6300′ / 1.25^24 is just under 30′.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(150);
  }
  await expect.poll(() => page.evaluate(() => (window as any).__stel.core.fov * 180 / Math.PI)).toBeLessThan(.5);
  expect(errors).toEqual([]);
});
