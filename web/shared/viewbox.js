// Size of the sky box the page asks the server for, so its frames cover the canvas.
// The engine's fov is the short side of the canvas (proj_stereographic.c
// compute_fov), so the long side and the corners are wider than fov.

export const LOAD_FOV_DEG = 0.5; // frames load only below this field of view
export const SEQ_MIN_FOV_DEG = 0.05; // server limits for /api/sequence (server/app.py)
export const SEQ_MAX_FOV_DEG = 1.0;
// Widest zoom; the engine clamps there too (proj_stereographic.c).
export const MAX_FOV_DEG = 105;

/**
 * Field of view after a zoom button: the current one times `factor` (0.5 in,
 * 2 out), never wider than MAX_FOV_DEG. Mouse wheel and pinch zoom are left to
 * the engine; pages only read its fov and never write it back.
 */
export function zoomFov(fovDeg, factor) {
  return Math.min(MAX_FOV_DEG, fovDeg * factor);
}

/**
 * Side in degrees of the square box that holds the whole canvas, corners included,
 * rounded up to the 0.001 deg the server works in. Null when frames should not load:
 * zoomed out past LOAD_FOV_DEG, or a screen so wide that the box would exceed the
 * server limit and leave the edges empty.
 */
export function frameBox(fovDeg, width, height) {
  if (!(fovDeg < LOAD_FOV_DEG)) return null;
  const short = Math.max(1, Math.min(width, height));
  const diagonal = fovDeg * Math.hypot(width, height) / short;
  const box = Math.max(SEQ_MIN_FOV_DEG, Math.ceil(diagonal * 1000 - 1e-9) / 1000);
  return box <= SEQ_MAX_FOV_DEG ? box : null;
}

/**
 * True when the loaded square box {ra, dec, fov} still holds the whole canvas,
 * corners included, for the view centred at c with short-side fovDeg. Flat-sky
 * offsets, fine below 1 deg; RA differences wrap at 0/360.
 */
export function boxCovers(box, c, fovDeg, width, height) {
  const short = Math.max(1, Math.min(width, height));
  const halfW = (fovDeg * width) / short / 2;
  const halfH = (fovDeg * height) / short / 2;
  const dRa = ((c.ra - box.ra + 540) % 360) - 180;
  const dx = Math.abs(dRa) * Math.cos((c.dec * Math.PI) / 180);
  const dy = Math.abs(c.dec - box.dec);
  return dx + halfW <= box.fov / 2 && dy + halfH <= box.fov / 2;
}
