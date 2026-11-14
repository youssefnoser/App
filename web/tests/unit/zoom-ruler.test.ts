import assert from 'node:assert/strict';
import {
  FIELD_MIN_ARCMIN, FIELD_MAX_ARCMIN, LOAD_ARCMIN, PX_PER_DECADE,
  rulerOffset, fieldAtOffset, rulerLength, rulerTicks, formatField, stepField,
} from '../../lib/zoom-ruler.ts';
import { MIN_ZOOM, MAX_ZOOM } from '../../lib/sky.ts';
import { LOAD_FOV_DEG } from '../../shared/viewbox.js';

const near = (a: number, b: number, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

// The ruler spans the explorer's zoom range: zoom 1 is a 5 arcmin field.
near(FIELD_MIN_ARCMIN, 5 / MAX_ZOOM);
near(FIELD_MAX_ARCMIN, 5 / MIN_ZOOM);
assert.equal(LOAD_ARCMIN, LOAD_FOV_DEG * 60);

// Log scale, zoomed-in end at offset 0: one decade of field is PX_PER_DECADE pixels.
near(rulerOffset(FIELD_MIN_ARCMIN), 0);
near(rulerOffset(FIELD_MIN_ARCMIN * 10), PX_PER_DECADE);
near(rulerLength(), rulerOffset(FIELD_MAX_ARCMIN));
// Out-of-range fields clamp to the ends.
near(rulerOffset(FIELD_MIN_ARCMIN / 10), 0);
near(rulerOffset(FIELD_MAX_ARCMIN * 10), rulerLength());
// fieldAtOffset inverts rulerOffset and clamps too.
for (const field of [0.5, 5, 30, 200]) near(fieldAtOffset(rulerOffset(field)), field, 1e-9);
near(fieldAtOffset(-50), FIELD_MIN_ARCMIN);
near(fieldAtOffset(rulerLength() + 50), FIELD_MAX_ARCMIN);

// Ticks: sorted, inside the ruler, majors labelled, the load limit is a major tick.
const ticks = rulerTicks();
assert(ticks.length > 20);
for (let i = 1; i < ticks.length; i++) assert(ticks[i].offset > ticks[i - 1].offset);
assert(ticks.every(t => t.offset >= 0 && t.offset <= rulerLength() + 1e-9));
assert(ticks.filter(t => t.major).every(t => typeof t.label === 'string' && t.label.length > 0));
assert(ticks.filter(t => !t.major).every(t => t.label === undefined));
assert.deepEqual(ticks.filter(t => t.major).map(t => t.label), ['12″', '30″', '1′', '2′', '5′', '10′', '30′', '1°', '2°', '5°', '10°', '30°', '90°']);
near(FIELD_MAX_ARCMIN, 105 * 60); // the widest view is the 105 degree survey

// Readout text: arcsec below 1′, one decimal below 10′, whole arcmin below 1°, then degrees.
assert.equal(formatField(0.2), '12″');
assert.equal(formatField(5), '5.0′');
assert.equal(formatField(12.4), '12′');
assert.equal(formatField(90), '1.5°');

// Wheel and arrow steps: 1.25 times per step, positive zooms in, clamped.
near(stepField(5, 1), 4);
near(stepField(4, -1), 5);
near(stepField(FIELD_MIN_ARCMIN, 3), FIELD_MIN_ARCMIN);
near(stepField(FIELD_MAX_ARCMIN, -3), FIELD_MAX_ARCMIN);
