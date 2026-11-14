import { test, expect } from '@playwright/test';

test('zoom buttons reach the 105 degree survey and return to frame scale', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#ra=269.4463&dec=4.7677&fov=1');
  await page.waitForFunction(() => Boolean((window as any).__stel?.core));
  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  for (let i = 0; i < 20 && await zoomOut.isEnabled(); i++) {
    await zoomOut.click();
    await page.waitForTimeout(150);
  }
  await expect(zoomOut).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).__stel.core.fov * 180 / Math.PI)).toBeCloseTo(105, 1);
  await page.waitForTimeout(30000);
  await page.screenshot({ path: 'test-results/wide-sky-105.png' });
  expect(await page.evaluate(() => (window as any).__stel.core.dss.visible)).toBeTruthy();
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  for (let i = 0; i < 11; i++) {
    await zoomIn.click();
    await page.waitForTimeout(150);
  }
  await expect.poll(() => page.evaluate(() => (window as any).__stel.core.fov * 180 / Math.PI)).toBeLessThan(.5);
  expect(errors).toEqual([]);
});
