// Gaia DR3 helpers: epoch propagation, search-box parsing, Sesame answers, tooltip text.
// Pure functions, no DOM, shared by the Next.js app and the test bench.

/** Gaia DR3 reference epoch J2016.0 as MJD. */
export const GAIA_EPOCH_MJD = 57388.5;
/** J2000.0 as MJD: the epoch of SIMBAD positions returned by Sesame. */
export const J2000_MJD = 51544.5;
/** Total proper motion (mas/yr) above which a star counts as a fast mover. */
export const FAST_PM_MASYR = 100;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Modified Julian Date for a unix time in milliseconds. */
export function mjdNow(now = Date.now()) {
  return now / 86400000 + 40587;
}

/**
 * Position of `src` at `mjd`, moved linearly from `epochMjd` by its proper motion
 * (pmra includes cos dec, both mas/yr). Parallax and radial velocity are ignored,
 * which is fine at arcsecond level over decades. If pmra or pmdec is missing or
 * NaN the position is returned unchanged. RA is wrapped to [0, 360).
 */
export function propagate(src, mjd, epochMjd = GAIA_EPOCH_MJD) {
  if (!finite(src.pmra) || !finite(src.pmdec) || !finite(mjd)) return { ra: src.ra, dec: src.dec };
  const years = (mjd - epochMjd) / 365.25;
  const cosDec = Math.max(1e-6, Math.abs(Math.cos(src.dec * Math.PI / 180)));
  const dec = Math.max(-90, Math.min(90, src.dec + src.pmdec * years / 3.6e6));
  const ra = (((src.ra + src.pmra * years / (3.6e6 * cosDec)) % 360) + 360) % 360;
  return { ra, dec };
}

/** Total proper motion in mas/yr, or null if not measured. */
export function totalPm(src) {
  if (!finite(src.pmra) || !finite(src.pmdec)) return null;
  return Math.hypot(src.pmra, src.pmdec);
}

/** 'fast' above FAST_PM_MASYR, otherwise 'bright' (also when motion is unknown). */
export function markerKind(src) {
  const pm = totalPm(src);
  return pm !== null && pm > FAST_PM_MASYR ? 'fast' : 'bright';
}

const COORDS = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*(?:,\s*|\s+)([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?$/;
const GAIA_ID = /^(?:gaia\s*(?:dr3)?\s*)?(\d{15,19})$/i;

/** What the search box holds: decimal RA, Dec; a Gaia DR3 source_id; or a name. */
export function classifyQuery(text) {
  const t = String(text ?? '').trim();
  if (!t) return { kind: 'empty' };
  const id = t.match(GAIA_ID);
  if (id) return { kind: 'gaia-id', id: id[1] };
  const pair = t.match(COORDS);
  if (pair) {
    const ra = Number(pair[1]), dec = Number(pair[2]);
    if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return { kind: 'coords-invalid' };
    return { kind: 'coords', ra, dec };
  }
  return { kind: 'name', name: t };
}

/** CDS Sesame name-resolver URL (XML answer; SIMBAD, then NED, then VizieR). */
export function sesameUrl(name) {
  return `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?${encodeURIComponent(name)}`;
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
};

/**
 * Position (J2000, degrees) and proper motion (mas/yr, null if absent) from a
 * Sesame XML answer, or null if the name was not resolved.
 */
export function parseSesame(xml) {
  const text = String(xml ?? '');
  const ra = Number(tag(text, 'jradeg')), dec = Number(tag(text, 'jdedeg'));
  if (tag(text, 'jradeg') === null || !finite(ra) || !finite(dec)) return null;
  const num = name => { const v = tag(text, name); const n = Number(v); return v !== null && finite(n) ? n : null; };
  const oname = tag(text, 'oname') ?? tag(text, 'name') ?? '';
  return { name: oname.replace(/^NAME\s+/, ''), ra, dec, pmra: num('pmRA'), pmdec: num('pmDE') };
}

/** Plain-language tooltip lines. Missing or NaN values say "unknown"/"not measured". */
export function tooltipLines(src) {
  const lines = [`Gaia DR3 ${src.source_id}`];
  lines.push(finite(src.gmag)
    ? `Brightness: G ${src.gmag.toFixed(1)} (Gaia magnitude, smaller is brighter)`
    : 'Brightness: unknown');
  const pm = totalPm(src);
  lines.push(pm === null ? 'Motion: not measured' : `Motion: ${(pm / 1000).toFixed(2)}″ per year across the sky`);
  if (finite(src.parallax) && src.parallax > 0) {
    const pc = 1000 / src.parallax;
    lines.push(`Parallax ${src.parallax.toFixed(1)} mas, about ${pc < 100 ? pc.toFixed(1) : Math.round(pc)} parsecs away`);
  } else {
    lines.push('Distance: unknown');
  }
  return lines;
}
