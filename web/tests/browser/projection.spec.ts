import { test, expect } from '@playwright/test';

test('Target reticle stays static on the searched celestial place using pure JS projection', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#stel-canvas');
  await page.waitForFunction(() => !!(window as any).__stel);

  const res = await page.evaluate(() => {
    const stel = (window as any).__stel;
    const canvas = document.getElementById('stel-canvas') as HTMLCanvasElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const coords = { ra: 269.4521, dec: 4.6934 };

    const raRad = (coords.ra * Math.PI) / 180;
    const decRad = (coords.dec * Math.PI) / 180;
    const cx = Math.cos(decRad) * Math.cos(raRad);
    const cy = Math.cos(decRad) * Math.sin(raRad);
    const cz = Math.sin(decRad);

    const yaw = stel.core.observer.yaw;
    const pitch = stel.core.observer.pitch;

    // Pure JS 3D rotation from ICRF to VIEW
    const cosYaw = Math.cos(-yaw), sinYaw = Math.sin(-yaw);
    const x1 = cosYaw * cx - sinYaw * cy;
    const y1 = sinYaw * cx + cosYaw * cy;
    const z1 = cz;

    const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
    const x2 = cosPitch * x1 + sinPitch * z1;
    const y2 = y1;
    const z2 = -sinPitch * x1 + cosPitch * z1;

    const vx = -y2;
    const vy = z2;
    const vz = -x2;

    const aspect = width / height;
    const fov = stel.core.fov;
    const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
    const f = 1 / Math.tan(fovy / 2);

    const depth = -vz;
    const xNdc = (vx / depth) * (f / aspect);
    const yNdc = (vy / depth) * f;

    const screenX = ((xNdc + 1) / 2) * width;
    const screenY = ((-yNdc + 1) / 2) * height;

    return {
      screenX,
      screenY,
      centerX: width / 2,
      centerY: height / 2,
    };
  });

  console.log('Pure JS projection centered:', res);
  expect(Math.abs(res.screenX - res.centerX)).toBeLessThan(2);
  expect(Math.abs(res.screenY - res.centerY)).toBeLessThan(2);
});
