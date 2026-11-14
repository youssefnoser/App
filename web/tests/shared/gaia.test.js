import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GAIA_EPOCH_MJD, J2000_MJD, propagate, markerKind, classifyQuery, sesameUrl, parseSesame, tooltipLines, mjdNow,
} from '../../shared/gaia.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const barnard = {
  source_id: '4472832130942575872', ra: 269.44850252544, dec: 4.73942005111,
  pmra: -801.551, pmdec: 10362.394, parallax: 546.9759, gmag: 8.193974,
};
const twoParam = { source_id: '4472832000000000001', ra: 269.44, dec: 4.70, pmra: null, pmdec: null, parallax: null, gmag: 20.9 };

test('propagate moves Barnard north ~93 arcsec in 9 years', () => {
  const p = propagate(barnard, GAIA_EPOCH_MJD + 9 * 365.25);
  assert.ok(Math.abs((p.dec - barnard.dec) * 3600 - 93.26) < 0.5);
  assert.ok(p.ra < barnard.ra);
});

test('propagate accepts another start epoch', () => {
  const p = propagate(barnard, J2000_MJD + 365.25, J2000_MJD);
  assert.ok(Math.abs((p.dec - barnard.dec) * 3600 - 10.362) < 0.01);
});

test('propagate leaves 2-parameter sources alone', () => {
  assert.deepEqual(propagate(twoParam, GAIA_EPOCH_MJD + 3650), { ra: 269.44, dec: 4.70 });
  assert.deepEqual(propagate({ ...barnard, pmra: NaN }, GAIA_EPOCH_MJD + 3650), { ra: barnard.ra, dec: barnard.dec });
});

test('propagate at the pole does not explode', () => {
  const p = propagate({ ...barnard, dec: 90 }, GAIA_EPOCH_MJD + 3650);
  assert.ok(Number.isFinite(p.ra) && p.ra >= 0 && p.ra < 360);
});

test('mjdNow converts unix time', () => {
  assert.equal(mjdNow(0), 40587);
});

test('classifyQuery tells coordinates, Gaia ids and names apart', () => {
  assert.deepEqual(classifyQuery('269.45, 4.69'), { kind: 'coords', ra: 269.45, dec: 4.69 });
  assert.deepEqual(classifyQuery('Gaia DR3 4472832130942575872'), { kind: 'gaia-id', id: '4472832130942575872' });
  assert.deepEqual(classifyQuery(' 4472832130942575872 '), { kind: 'gaia-id', id: '4472832130942575872' });
  assert.deepEqual(classifyQuery("Barnard's Star"), { kind: 'name', name: "Barnard's Star" });
  assert.deepEqual(classifyQuery('   '), { kind: 'empty' });
  assert.deepEqual(classifyQuery('400, 0'), { kind: 'coords-invalid' });
});

test('sesameUrl encodes the name', () => {
  assert.equal(sesameUrl("Barnard's Star"), "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?Barnard's%20Star");
});

test('parseSesame reads position and proper motion', () => {
  const r = parseSesame(fixture('sesame_barnard.xml'));
  assert.equal(r.ra, 269.4520769586187);
  assert.equal(r.dec, 4.69336496657667);
  assert.equal(r.pmra, -801.551);
  assert.equal(r.pmdec, 10362.394);
  assert.equal(r.name, "Barnard's star");
});

test('parseSesame returns null when nothing was found', () => {
  assert.equal(parseSesame(fixture('sesame_notfound.xml')), null);
  assert.equal(parseSesame(''), null);
});

test('tooltipLines for Barnard', () => {
  assert.deepEqual(tooltipLines(barnard), [
    'Gaia DR3 4472832130942575872',
    'Brightness: G 8.2 (Gaia magnitude, smaller is brighter)',
    'Motion: 10.39″ per year across the sky',
    'Parallax 547.0 mas, about 1.8 parsecs away',
  ]);
});

test('tooltipLines with missing or bad values', () => {
  const lines = tooltipLines(twoParam);
  assert.ok(lines.includes('Motion: not measured'));
  assert.ok(lines.includes('Distance: unknown'));
  assert.ok(tooltipLines({ ...barnard, parallax: -0.3 }).includes('Distance: unknown'));
  assert.ok(tooltipLines({ ...barnard, gmag: null }).includes('Brightness: unknown'));
});

test('markerKind', () => {
  assert.equal(markerKind(barnard), 'fast');
  assert.equal(markerKind({ ...barnard, pmra: 30, pmdec: 40 }), 'bright');
  assert.equal(markerKind(twoParam), 'bright');
});
