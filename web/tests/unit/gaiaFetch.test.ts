import assert from 'node:assert/strict';
import { needsRefetch, snapRadius } from '../../lib/gaiaFetch.ts';

assert.equal(snapRadius(0.05), 0.1);
assert.equal(snapRadius(0.15), 0.25);
assert.equal(snapRadius(0.6), 0.5);
assert.equal(snapRadius(2), 0.75);

const last = { ra: 269.45, dec: 4.75, radius: 0.25 };
assert.equal(needsRefetch(null, { ra: 269.45, dec: 4.75, fov: 0.15 }), true);
assert.equal(needsRefetch(last, { ra: 269.45, dec: 4.75, fov: 0.15 }), false);
assert.equal(needsRefetch(last, { ra: 269.45, dec: 5.05, fov: 0.15 }), true, 'moved 0.3 deg');
assert.equal(needsRefetch(last, { ra: 269.45, dec: 4.75, fov: 0.6 }), true, 'radius bucket changed');
// Separation wraps through RA 0/360.
// fov 0.2 -> bucket 0.25; separation 0.1 + half-fov 0.1 = 0.2 stays inside.
assert.equal(needsRefetch({ ra: 0.05, dec: 0, radius: 0.25 }, { ra: 359.95, dec: 0, fov: 0.2 }), false);

// Above 1.5 deg no single cone (max radius 0.75) covers the view: do not fetch at all.
import { canShowGaia } from '../../lib/gaiaFetch.ts';
assert.equal(canShowGaia(0.1), true);
assert.equal(canShowGaia(1.5), true);
assert.equal(canShowGaia(1.6), false);
assert.equal(canShowGaia(10), false);
