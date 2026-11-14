import assert from 'node:assert/strict';
import {
  detectorBands,
  MIN_ZOOM,
  getNextZoomIn,
  getNextZoomOut,
} from '../lib/sky.ts';
import { svgNumber } from '../lib/rotor.ts';

// Test zoom levels and steps
assert.equal(getNextZoomIn(1.0), 1.4);
assert.equal(getNextZoomOut(1.4), 1.0);
assert.equal(getNextZoomOut(1.0), 0.6);
assert.equal(getNextZoomOut(0.6), 0.4);
assert.equal(getNextZoomOut(0.4), 0.25);
assert.equal(getNextZoomOut(0.25), 0.1);
assert.equal((5 / 60) / MIN_ZOOM, 105);
let wide = 0.25;
for (let i = 0; i < 20; i++) wide = getNextZoomOut(wide);
assert.equal(wide, MIN_ZOOM);
assert.equal(getNextZoomIn(MIN_ZOOM), 0.0015);
assert.equal(getNextZoomIn(14.0), 20.0);
assert.equal(getNextZoomIn(20.0), 25.0);
assert.equal(getNextZoomIn(25.0), 25.0);

const all = Array.from({ length: 6 }, (_, i) => detectorBands(i + 1)).flat();
assert.deepEqual(all, Array.from({ length: 102 }, (_, i) => i + 1));
assert.equal(new Set(all).size, 102);
assert.equal(detectorBands(6)[16], 102);
console.log('PASS: zoom ladder and six complete, non-overlapping 17-band detector groups.');
// Exact differing server/client values reported in the hydration overlay.
for (const [server, client] of [
  [75.95972443316481, 75.95972443316482],
  [64.81255205100389, 64.8125520510039],
  [65.58075523042739, 65.5807552304274],
  [58.52751411449482, 58.52751411449485],
  [36.04457858770627, 36.0445785877063],
  [27.170614254071722, 27.17061425407175],
]) assert.equal(svgNumber(server), svgNumber(client));
console.log('PASS: reported server/browser rotor coordinates serialize identically.');

const { sequenceWindows } = await import('../lib/backend-bands.ts');
assert.deepEqual(sequenceWindows([22], 1.25, .05), [{ wavelength: 1.25, width: .05 }]);
assert.equal((sequenceWindows([1], undefined, .05)[0] as {width:number}).width, .05);
assert((sequenceWindows([1], undefined, 0)[0] as {width:number}).width < .02);
assert.equal(sequenceWindows([1, 40], undefined, .05).length, 2);
console.log('PASS: index wavelength parity and explicit band tolerance.');
