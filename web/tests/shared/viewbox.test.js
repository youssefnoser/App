import test from 'node:test';
import assert from 'node:assert/strict';

import { frameBox, LOAD_FOV_DEG, SEQ_MAX_FOV_DEG } from '../../shared/viewbox.js';

// The engine's fov is the short side of the canvas (proj_stereographic.c compute_fov).

test('box covers the corners of a wide screen', () => {
  // The case from the bug report: 1651 x 1030 px at 0.378 deg of height. The old
  // code clamped this to 0.5 deg, which left both side edges without frames.
  const box = frameBox(0.378, 1651, 1030);
  const diagonal = 0.378 * Math.hypot(1651, 1030) / 1030;
  assert.ok(box >= diagonal, `${box} < ${diagonal}`);
  assert.ok(box - diagonal < 0.002);
});

test('portrait screens use the short side too', () => {
  assert.equal(frameBox(0.2, 1000, 2000), frameBox(0.2, 2000, 1000));
});

test('box is never below the server minimum', () => {
  assert.equal(frameBox(0.001, 1600, 1000), 0.05);
});

test('box rounds up so it never undershoots the screen', () => {
  const box = frameBox(0.1234, 1000, 1000);
  assert.ok(box >= 0.1234 * Math.SQRT2);
  assert.equal(box, Number(box.toFixed(3)));
});

test('null at or above the load threshold', () => {
  assert.equal(frameBox(LOAD_FOV_DEG, 1600, 1000), null);
  assert.equal(frameBox(5, 1600, 1000), null);
});

test('null when the screen is too wide for the largest box', () => {
  // 3:1 at 0.45 deg needs 0.45 * sqrt(10) = 1.42 deg, over the 1 deg cap.
  assert.equal(frameBox(0.45, 3000, 1000), null);
  assert.ok(frameBox(0.3, 3000, 1000) <= SEQ_MAX_FOV_DEG);
});

test('a normal 16:10 screen loads right up to the threshold', () => {
  assert.ok(frameBox(0.499, 1600, 1000) <= SEQ_MAX_FOV_DEG);
});

import { boxCovers } from '../../shared/viewbox.js';

// 16:10 screen at 0.4 deg height: 0.64 x 0.4 deg, so it fits a 0.76 deg box with
// 0.06 deg to spare left and right and 0.18 deg above and below.
const W = 1600, H = 1000;

test('a box covers the screen it was sized for', () => {
  const box = { ra: 100, dec: 0, fov: frameBox(0.4, W, H) };
  assert.equal(boxCovers(box, { ra: 100, dec: 0 }, 0.4, W, H), true);
});

test('panning past the spare margin uncovers an edge', () => {
  const box = { ra: 100, dec: 0, fov: frameBox(0.4, W, H) };
  assert.equal(boxCovers(box, { ra: 100.05, dec: 0 }, 0.4, W, H), true);
  assert.equal(boxCovers(box, { ra: 100.08, dec: 0 }, 0.4, W, H), false);
  assert.equal(boxCovers(box, { ra: 100, dec: 0.17 }, 0.4, W, H), true);
  assert.equal(boxCovers(box, { ra: 100, dec: -0.2 }, 0.4, W, H), false);
});

test('zooming out past the box uncovers the edges; zooming in does not', () => {
  const box = { ra: 100, dec: 0, fov: frameBox(0.4, W, H) };
  assert.equal(boxCovers(box, { ra: 100, dec: 0 }, 0.49, W, H), false);
  assert.equal(boxCovers(box, { ra: 100, dec: 0 }, 0.1, W, H), true);
});

test('RA offsets shrink with declination and wrap at 0/360', () => {
  const box = { ra: 359.98, dec: 60, fov: frameBox(0.4, W, H) };
  // 0.1 deg of RA at Dec 60 is 0.05 deg on the sky, inside the 0.06 margin.
  assert.equal(boxCovers(box, { ra: 0.08, dec: 60 }, 0.4, W, H), true);
  assert.equal(boxCovers(box, { ra: 0.2, dec: 60 }, 0.4, W, H), false);
});
