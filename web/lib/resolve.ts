// Search-box lookups that need a service: a Gaia DR3 source_id (our backend) or an
// object name (CDS Sesame, called from the browser; it allows any origin).
// Results are placed where the object is today, using its proper motion.
import { classifyQuery, J2000_MJD, mjdNow, parseSesame, propagate, sesameUrl } from '../shared/gaia.js';

export type Resolved =
  | { ok: true; name: string; type: string; ra: number; dec: number }
  | { ok: false; message: string };

const GAIA_DOWN = 'The Gaia service did not answer. Try again in a minute.';
const NAMES_DOWN = 'The name service did not answer. Try again, or enter RA, Dec in degrees.';

async function byGaiaId(id: string, fetchFn: typeof fetch, now: number): Promise<Resolved> {
  let response: Response;
  try {
    response = await fetchFn(`/api/gaia/source/${id}`);
  } catch {
    return { ok: false, message: GAIA_DOWN };
  }
  if (response.status === 404 || response.status === 422) {
    return { ok: false, message: `No Gaia DR3 source has the ID ${id}. Check the number and try again.` };
  }
  if (!response.ok) return { ok: false, message: GAIA_DOWN };
  const src = await response.json();
  const { ra, dec } = propagate(src, mjdNow(now));
  return { ok: true, name: `Gaia DR3 ${id}`, type: 'GAIA DR3', ra, dec };
}

async function byName(name: string, fetchFn: typeof fetch, now: number): Promise<Resolved> {
  let xml: string;
  try {
    const response = await fetchFn(sesameUrl(name));
    if (!response.ok) return { ok: false, message: NAMES_DOWN };
    xml = await response.text();
  } catch {
    return { ok: false, message: NAMES_DOWN };
  }
  const found = parseSesame(xml);
  if (!found) {
    return { ok: false, message: `No object called “${name}” was found. Check the spelling, or enter RA, Dec in degrees.` };
  }
  const { ra, dec } = propagate(found, mjdNow(now), J2000_MJD);
  return { ok: true, name: found.name || name, type: 'SIMBAD', ra, dec };
}

/** Resolve a Gaia DR3 id or an object name. Coordinates are handled by the caller. */
export async function resolveQuery(text: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Resolved> {
  const query = classifyQuery(text);
  if (query.kind === 'gaia-id') return byGaiaId(query.id, fetchFn, now);
  if (query.kind === 'name') return byName(query.name, fetchFn, now);
  return { ok: false, message: 'Enter an object name, a Gaia DR3 ID, or RA, Dec in degrees.' };
}
