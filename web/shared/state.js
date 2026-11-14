// URL hash state: sky position, field of view and blink step.

export const DEFAULTS = { ra: 269.4463, dec: 4.7677, fov: 0.25, step: 0 };

const RANGES = {
  ra: (v) => v >= 0 && v < 360,
  dec: (v) => v >= -90 && v <= 90,
  fov: (v) => v > 0 && v <= 180,
  step: (v) => Number.isInteger(v) && v >= 0,
};

/**
 * Parse "ra=..&dec=..&fov=..&step=.." (a leading '#' is allowed). Each bad,
 * missing or out-of-range value falls back to its default. Never throws.
 */
export function parseHash(str) {
  const out = { ...DEFAULTS };
  let params;
  try {
    params = new URLSearchParams(String(str ?? '').replace(/^#/, ''));
  } catch {
    return out;
  }
  for (const key of Object.keys(DEFAULTS)) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && RANGES[key](value)) out[key] = value;
  }
  return out;
}

/** Build the hash string (no '#'). Missing keys use their defaults. */
export function toHash(state) {
  const s = { ...DEFAULTS, ...state };
  return `ra=${s.ra}&dec=${s.dec}&fov=${s.fov}&step=${s.step}`;
}
