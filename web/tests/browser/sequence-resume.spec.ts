import { test, expect } from '@playwright/test';

test('pending sequence batches resume after zooming out and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Keep this regression offline; only the app and its bundled engine are needed.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  await page.route('**/api/sequence?**', async route => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: {
      cell: -1,
      sequence: { ra: Number(params.get('ra')), dec: Number(params.get('dec')), fov: Number(params.get('fov')) },
      cells: [{ pix: -1, ring: 0 }],
      exposures: Array.from({ length: 12 }, (_, i) => ({ uri: `fixture-${i}`, mjd: 60900 + i,
        date: '2025-08-15', detector: 1, first: true, cells: [-1] })),
    } });
  });
  await page.route('**/api/frame.png?**', async route => {
    started++;
    await gate;
    await route.fulfill({ contentType: 'image/png', body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64'),
    }).catch(() => {}); // Earlier requests can have been cancelled by the zoom.
  });
  await page.goto('/#ra=269.4463&dec=4.7677&fov=0.15');
  await page.waitForFunction(() => Boolean((window as any).__stel?.core));
  await expect.poll(() => started, { timeout: 15000 }).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => { (window as any).__stel.core.fov = Math.PI / 180; });
  await page.waitForTimeout(100);
  await page.evaluate(() => { (window as any).__stel.core.fov = .15 * Math.PI / 180; });
  release();
  await expect(page.locator('.time-section')).toContainText('/ 12');
  await page.getByRole('button', { name: 'Play observations' }).click();
  await expect.poll(async () => page.locator('.time-section').innerText()).not.toContain('FRAME 01 / 12');
  await page.screenshot({ path: 'test-results/sequence-resumed.png' });
  expect(errors).toEqual([]);
});


test('sequence defaults match the standalone viewer and band tolerance is explicit', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort());
  await page.route('**/api/sequence?**', async route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    await route.fulfill({ json: {cell:-1,sequence:{ra:Number(params.get('ra')),dec:Number(params.get('dec')),fov:Number(params.get('fov'))},cells:[{pix:-1,ring:0}],exposures:[]} });
  });
  await page.goto('/#ra=269.7846&dec=4.9452&fov=0.15');
  await page.waitForFunction(() => Boolean((window as any).__stel?.core));
  await expect.poll(() => queries.at(-1)?.get('wavelength')).toBe('1.25');
  expect(queries.at(-1)?.get('width')).toBe('0.05');
  await page.getByRole('button', { name:'Choose infrared bands' }).click();
  await expect(page.getByLabel('Sequence wavelength (micrometres)')).toHaveValue('1.25');
  await page.getByLabel('Band number', {exact:true}).fill('1');
  await page.getByLabel('Wavelength window', {exact:true}).selectOption('0');
  await expect.poll(() => queries.at(-1)?.get('wavelength')).toBe('0.75');
  await expect.poll(() => Number(queries.at(-1)?.get('width'))).toBeLessThan(.02);
  await page.getByRole('button', {name:'Reset wavelength'}).click();
  // A reset can reuse its initial cached answer. Move to a new box to inspect
  // the next outgoing query rather than requiring a redundant network fetch.
  await page.evaluate(() => {
    const s = (window as any).__stel;
    s.lookAt(s.convertFrame(s.observer, 'ASTROM', 'CIRS', s.s2c(269.95 * Math.PI / 180, 4.9452 * Math.PI / 180)), 0);
  });
  await expect.poll(() => queries.at(-1)?.get('wavelength')).toBe('1.25');
  expect(queries.at(-1)?.get('width')).toBe('0.05');
  await page.screenshot({path:'test-results/wavelength-window-controls.png'});
});
