// When the Gaia overlay must ask /api/gaia again: the server snaps each cone's radius
// to the buckets below (server/app.py snap_cone), so a view still inside the last
// cone, at the same bucket, needs no new request.
const RADII = [0.1, 0.25, 0.5, 0.75];

/** Radius bucket (deg) the server uses for a view `fov` degrees wide. */
export function snapRadius(fov: number): number {
  const want = Math.min(0.75, Math.max(0.05, 0.75 * fov));
  return RADII.find(r => r >= want - 1e-9) ?? 0.75;
}

/** Great-circle separation in degrees. */
export function separationDeg(a: { ra: number; dec: number }, b: { ra: number; dec: number }): number {
  const rad = Math.PI / 180;
  const dDec = (b.dec - a.dec) * rad, dRa = (b.ra - a.ra) * rad;
  const h = Math.sin(dDec / 2) ** 2 + Math.cos(a.dec * rad) * Math.cos(b.dec * rad) * Math.sin(dRa / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / rad;
}

export type Cone = { ra: number; dec: number; radius: number };

/** True if the view is not fully inside the last cone, or needs another radius bucket. */
export function needsRefetch(last: Cone | null, view: { ra: number; dec: number; fov: number }): boolean {
  if (!last) return true;
  if (snapRadius(view.fov) !== last.radius) return true;
  return separationDeg(last, view) + view.fov / 2 > last.radius;
}
