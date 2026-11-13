import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, toHash } from '../js/state.js';

const DEFAULTS = { ra: 269.4463, dec: 4.7677, fov: 0.25, step: 0 };

test('parseHash defaults on garbage', () => {
  assert.deepEqual(parseHash('ra=abc&fov=9999&dec=91'), DEFAULTS);
});

test('parseHash on empty or missing hash gives defaults', () => {
  assert.deepEqual(parseHash(''), DEFAULTS);
  assert.deepEqual(parseHash('#'), DEFAULTS);
  assert.deepEqual(parseHash(undefined), DEFAULTS);
});

test('parseHash reads good keys and falls back per bad key', () => {
  assert.deepEqual(parseHash('ra=10&dec=-5&fov=1&step=2'), {
    ra: 10,
    dec: -5,
    fov: 1,
    step: 2,
  });
  // Good ra survives next to bad neighbours.
  assert.deepEqual(parseHash('ra=10&dec=abc'), {
    ra: 10,
    dec: DEFAULTS.dec,
    fov: DEFAULTS.fov,
    step: DEFAULTS.step,
  });
});

test('parseHash rejects out-of-range and malformed values', () => {
  assert.equal(parseHash('#ra=360').ra, DEFAULTS.ra);
  assert.equal(parseHash('ra=-1').ra, DEFAULTS.ra);
  assert.equal(parseHash('dec=90.5').dec, DEFAULTS.dec);
  assert.equal(parseHash('fov=0').fov, DEFAULTS.fov);
  assert.equal(parseHash('fov=-2').fov, DEFAULTS.fov);
  assert.equal(parseHash('step=-3').step, DEFAULTS.step);
  assert.equal(parseHash('step=1.5').step, DEFAULTS.step);
});

test('hash round trip', () => {
  const state = { ra: 123.456, dec: -12.5, fov: 1.25, step: 4 };
  const hash = toHash(state);
  assert.equal(hash, 'ra=123.456&dec=-12.5&fov=1.25&step=4');
  assert.deepEqual(parseHash(hash), state);
  // A leading '#', as in window.location.hash, parses the same.
  assert.deepEqual(parseHash(`#${hash}`), state);
});

test('toHash fills missing keys with defaults', () => {
  assert.deepEqual(parseHash(toHash({ ra: 10 })), {
    ra: 10,
    dec: DEFAULTS.dec,
    fov: DEFAULTS.fov,
    step: DEFAULTS.step,
  });
});
