import { test, expect } from '@playwright/test';

const TARGET = { ra: 269.4521, dec: 4.6934 };

// Centre of the crosshair, from the marker's inline position (left/top are x - 21, y - 21).
async function markerCentre(page: import('@playwright/test').Page) {
  return page.locator('#object-label').evaluate((el: HTMLElement) => ({
    x: parseFloat(el.style.left) + 21,
    y: parseFloat(el.style.top) + 21,
    shown: el.style.display !== 'none',
  }));
}

test('the view lands on the requested place and stays there', async ({ page }) => {
  await page.goto(`/#ra=${TARGET.ra}&dec=${TARGET.dec}&fov=0.0833&step=0`);
  await page.waitForFunction(() => !!(window as any).__sky);
  await page.waitForTimeout(1500);
  const centre = await page.evaluate(() => (window as any).__sky.viewCentre());
  // Within one arcsec: a hash position is not replaced by the live target list.
  expect(Math.abs(centre.ra - TARGET.ra) * 3600).toBeLessThan(1);
  expect(Math.abs(centre.dec - TARGET.dec) * 3600).toBeLessThan(1);
});

test('the target marker sits where the engine projects the target, also after a pan', async ({ page }) => {
  await page.goto(`/#ra=${TARGET.ra}&dec=${TARGET.dec}&fov=0.0833&step=0`);
  await page.waitForFunction(() => !!(window as any).__sky);
  await page.waitForTimeout(1000);
  const size = await page.locator('#stel-canvas').evaluate((c: HTMLCanvasElement) => ({ w: c.clientWidth, h: c.clientHeight }));
  let m = await markerCentre(page);
  expect(m.shown).toBe(true);
  expect(Math.abs(m.x - size.w / 2)).toBeLessThan(2);
  expect(Math.abs(m.y - size.h / 2)).toBeLessThan(2);

  // Move the view 1 arcmin south: the target is now above the centre (north up).
  await page.evaluate(({ ra, dec }) => (window as any).__sky.flyTo(ra, dec - 1 / 60), TARGET);
  await page.waitForTimeout(300);
  m = await markerCentre(page);
  const expected = await page.evaluate(({ ra, dec, w, h }) => (window as any).__sky.toScreen(ra, dec, w, h), { ...TARGET, ...size });
  expect(Math.abs(m.x - expected.x)).toBeLessThan(2);
  expect(Math.abs(m.y - expected.y)).toBeLessThan(2);
  expect(m.y).toBeLessThan(size.h / 2 - 50);
});
