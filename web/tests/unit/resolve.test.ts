import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveQuery } from '../../lib/resolve.ts';

const sesameXml = readFileSync(new URL('../shared/fixtures/sesame_barnard.xml', import.meta.url), 'utf8');
const notFoundXml = readFileSync(new URL('../shared/fixtures/sesame_notfound.xml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 14);
const BARNARD_ID = '4472832130942575872';

const fakeFetch = (handler: (url: string) => Response | Promise<Response>) =>
  (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;

// Name via Sesame, propagated from J2000 to today (~26.9 yr x 10.36"/yr = ~0.077 deg north).
{
  const seen: string[] = [];
  const r = await resolveQuery("Barnard's Star", fakeFetch(url => { seen.push(url); return new Response(sesameXml); }), NOW);
  assert.ok(seen[0].startsWith('https://cds.unistra.fr/cgi-bin/nph-sesame/'));
  assert.ok(r.ok);
  if (r.ok) {
    const moved = r.dec - 4.69336496657667;
    assert.ok(moved > 0.07 && moved < 0.08, `moved ${moved}`);
    assert.equal(r.type, 'SIMBAD');
    assert.equal(r.name, "Barnard's Star", 'shows the name the user typed, not the SIMBAD designation');
  }
}

// Name not found.
{
  const r = await resolveQuery('not a star xyz', fakeFetch(() => new Response(notFoundXml)), NOW);
  assert.deepEqual(r, { ok: false, message: 'No object called “not a star xyz” was found. Check the spelling, or enter RA, Dec in degrees.' });
}

// Name service down.
{
  const r = await resolveQuery('Vega', fakeFetch(() => { throw new TypeError('network'); }), NOW);
  assert.deepEqual(r, { ok: false, message: 'The name service did not answer. Try again, or enter RA, Dec in degrees.' });
}

// Gaia id found: asks the backend, propagates from J2016.0.
{
  const seen: string[] = [];
  const body = { source_id: BARNARD_ID, ra: 269.44850252544, dec: 4.73942005111, pmra: -801.551, pmdec: 10362.394, parallax: 546.9759, gmag: 8.19 };
  const r = await resolveQuery(`Gaia DR3 ${BARNARD_ID}`, fakeFetch(url => { seen.push(url); return Response.json(body); }), NOW);
  assert.equal(seen[0], `/api/gaia/source/${BARNARD_ID}`);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.name, `Gaia DR3 ${BARNARD_ID}`);
    assert.equal(r.type, 'GAIA DR3');
    // 2016.0 -> 2026-11-14 is 10.87 yr x 10.36"/yr = ~0.0313 deg north.
    assert.ok(r.dec > body.dec + 0.030 && r.dec < body.dec + 0.033);
  }
}

// Gaia id not found.
{
  const r = await resolveQuery('123456789012345', fakeFetch(() => Response.json({ detail: 'x' }, { status: 404 })), NOW);
  assert.deepEqual(r, { ok: false, message: 'No Gaia DR3 source has the ID 123456789012345. Check the number and try again.' });
}

// Gaia service down.
{
  const r = await resolveQuery(BARNARD_ID, fakeFetch(() => Response.json({}, { status: 502 })), NOW);
  assert.deepEqual(r, { ok: false, message: 'The Gaia service did not answer. Try again in a minute.' });
}
