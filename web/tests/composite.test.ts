import assert from 'node:assert/strict';
import { visitSpan, filterKey, FILTERS } from '../lib/composite.ts';

// Visit dates read as a span, naming each month and year once.
assert.equal(visitSpan('2025-08-15', '2025-08-27'), '15 to 27 Aug 2025');
assert.equal(visitSpan('2026-03-19', '2026-05-05'), '19 Mar to 5 May 2026');
assert.equal(visitSpan('2025-12-30', '2026-01-04'), '30 Dec 2025 to 4 Jan 2026');
assert.equal(visitSpan('2026-08-16', '2026-08-16'), '16 Aug 2026');

assert.deepEqual(FILTERS.map(f => f.value), ['raw', 'difference', 'previous', 'trail']);

// Raw frames need no key; a frame drawn without the chosen filter is still loading.
assert.equal(filterKey('raw', { detector: 6 }), null);
assert.equal(filterKey('difference', { detector: 6 }), null);
assert.equal(filterKey('difference', null), null);
assert.equal(filterKey('trail', { filter: 'difference', reference: {
  kind: 'static', start: '2025-08-15', end: '2026-08-20', exposures: 58 } }), null);

// Difference: red is the reference, blue this frame, in the colours the server paints.
const diff = filterKey('difference', { filter: 'difference', reference: {
  kind: 'static', start: '2025-08-15', end: '2026-08-20', exposures: 58, visits: 3 } })!;
assert.deepEqual(diff.rows.map(r => [r.swatch, r.text]), [
  ['rgb(255, 64, 38)', 'Usual place: median of 58 exposures, 15 Aug 2025 to 20 Aug 2026'],
  ['rgb(64, 140, 255)', 'Place on this frame'],
]);
assert.equal(diff.note, 'Black: no change.');

// Previous visit, and the two cases without one.
const ref = (kind: string) => ({ filter: 'previous', reference: { kind, start: '2025-08-15', end: '2025-08-27', exposures: 17 } });
assert.equal(filterKey('previous', ref('previous'))!.rows[0].text, 'Previous visit: 15 to 27 Aug 2025');
assert.equal(filterKey('previous', ref('next'))!.rows[0].text, 'Next visit: 15 to 27 Aug 2025 (the first visit has none before it)');
assert.equal(filterKey('previous', ref('same'))!.rows[0].text, 'This visit (only one here): 15 to 27 Aug 2025');
assert.equal(filterKey('previous', ref('previous'))!.rows[1].text, 'This frame');

// Trail: one row per visit in its colour; later visits are marked as not drawn yet.
const trail = filterKey('trail', { filter: 'trail', trail: [
  { start: '2025-08-15', end: '2025-08-27', exposures: 17, colour: [255, 0, 0], shown: true, current: false },
  { start: '2026-03-19', end: '2026-05-05', exposures: 24, colour: [0, 255, 0], shown: true, current: true },
  { start: '2026-08-16', end: '2026-08-20', exposures: 17, colour: [0, 0, 255], shown: false, current: false },
] })!;
assert.deepEqual(trail.rows.map(r => [r.swatch, r.text, r.dim]), [
  ['rgb(255, 0, 0)', '15 to 27 Aug 2025', false],
  ['rgb(0, 255, 0)', '19 Mar to 5 May 2026 (this frame)', false],
  ['rgb(0, 0, 255)', '16 to 20 Aug 2026 (not yet)', true],
]);
assert.equal(trail.note, 'Colours add up: a star in the same place on every visit so far shows their mix.');

console.log('composite tests passed');
