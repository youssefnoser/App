import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSteps, keepStep } from '../../shared/timeline.js';

const ex = (uri, mjd, detector = 6, date = '2025-08-15') => ({ uri, mjd, date, detector });

test('buildSteps sorts by mjd and keeps one step per uri', () => {
  const exposures = [
    ex('ibe/data/spherex/later.fits', 200),
    ex('ibe/data/spherex/early.fits', 100),
    ex('ibe/data/spherex/early.fits', 100), // duplicate uri
  ];
  const steps = buildSteps(exposures);
  assert.deepEqual(
    steps.map((s) => s.uri),
    ['ibe/data/spherex/early.fits', 'ibe/data/spherex/later.fits'],
  );
  // A step carries exactly the fields the blink player needs.
  assert.deepEqual(Object.keys(steps[0]).sort(), ['date', 'detector', 'mjd', 'uri']);
  assert.deepEqual(steps[0], {
    uri: 'ibe/data/spherex/early.fits',
    mjd: 100,
    date: '2025-08-15',
    detector: 6,
  });
});

test('buildSteps on empty exposures gives empty steps', () => {
  assert.deepEqual(buildSteps([]), []);
});

test('keepStep keeps same exposure after merge', () => {
  const steps = buildSteps([ex('A', 100), ex('B', 200)]);
  const newSteps = buildSteps([ex('C', 50), ex('B', 210), ex('A', 150)]);
  // steps[1] is uri B. newSteps sorts to C, A, B, so B moved to index 2.
  assert.equal(keepStep(steps, newSteps, 1), 2);
});

test('keepStep falls back to nearest mjd', () => {
  const steps = buildSteps([ex('A', 100), ex('GONE', 120)]);
  const newSteps = buildSteps([ex('B', 90), ex('C', 118)]);
  // GONE (mjd 120) disappeared; nearest remaining mjd is 118 at index 1.
  assert.equal(keepStep(steps, newSteps, 1), 1);
});

test('keepStep falls back to first step when newSteps is empty', () => {
  const steps = buildSteps([ex('A', 100)]);
  assert.equal(keepStep(steps, [], 0), 0);
});
