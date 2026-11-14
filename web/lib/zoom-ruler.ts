// Geometry of the straight zoom ruler: a log scale of the field of view (the
// short side of the canvas, in arcmin), zoomed-in end first. The ruler slides
// under a fixed indicator, as the time dial turns under its needle.
import { MIN_ZOOM, MAX_ZOOM } from './sky.ts';
import { LOAD_FOV_DEG } from '../js/viewbox.js';

export const FIELD_MIN_ARCMIN = 5 / MAX_ZOOM; // zoom 1 is a 5 arcmin field
export const FIELD_MAX_ARCMIN = 5 / MIN_ZOOM;
export const LOAD_ARCMIN = LOAD_FOV_DEG * 60; // SPHEREx frames load below this field
export const PX_PER_DECADE = 120;
const STEP = 1.25; // one wheel notch or arrow key

const clampField = (arcmin: number) => Math.min(FIELD_MAX_ARCMIN, Math.max(FIELD_MIN_ARCMIN, arcmin));

/** Pixels from the zoomed-in end of the ruler to this field, clamped to the ruler. */
export function rulerOffset(arcmin: number): number {
  return Math.log10(clampField(arcmin) / FIELD_MIN_ARCMIN) * PX_PER_DECADE;
}

/** The field at this many pixels from the zoomed-in end, clamped to the ruler. */
export function fieldAtOffset(px: number): number {
  return clampField(FIELD_MIN_ARCMIN * 10 ** (px / PX_PER_DECADE));
}

export function rulerLength(): number {
  return rulerOffset(FIELD_MAX_ARCMIN);
}

/** A tick label: whole arcsec below 1′, whole arcmin below 1°, then whole degrees. */
function tickLabel(arcmin: number): string {
  if (arcmin < 1) return `${Math.round(arcmin * 60)}″`;
  if (arcmin < 60) return `${Math.round(arcmin)}′`;
  return `${Math.round(arcmin / 60)}°`;
}

const MAJOR = [0.2, 0.5, 1, 2, 5, 10, LOAD_ARCMIN, 60, 120, 300, 600, 1800, 5400];

/** Ticks in ruler order: labelled majors, and a fine log-spaced minor every 1..9 × 10^n. */
export type RulerTick = { arcmin: number; offset: number; major: boolean; label?: string };
export function rulerTicks(): RulerTick[] {
  const ticks: RulerTick[] = MAJOR.filter(a => a >= FIELD_MIN_ARCMIN && a <= FIELD_MAX_ARCMIN)
    .map(arcmin => ({ arcmin, offset: rulerOffset(arcmin), major: true, label: tickLabel(arcmin) }));
  for (let decade = -1; decade <= 3; decade++) {
    for (let m = 1; m <= 9; m++) {
      const arcmin = m * 10 ** decade;
      if (arcmin < FIELD_MIN_ARCMIN || arcmin > FIELD_MAX_ARCMIN) continue;
      if (MAJOR.some(a => Math.abs(a / arcmin - 1) < 1e-6)) continue;
      ticks.push({ arcmin, offset: rulerOffset(arcmin), major: false });
    }
  }
  return ticks.sort((a, b) => a.offset - b.offset);
}

/** Readout text: arcsec below 1′, one decimal below 10′, whole arcmin below 1°, then degrees. */
export function formatField(arcmin: number): string {
  if (arcmin < 1) return `${Math.round(arcmin * 60)}″`;
  if (arcmin < 10) return `${arcmin.toFixed(1)}′`;
  if (arcmin < 60) return `${Math.round(arcmin)}′`;
  return `${(arcmin / 60).toFixed(1)}°`;
}

/** The field after `steps` notches; positive steps zoom in. */
export function stepField(arcmin: number, steps: number): number {
  return clampField(arcmin / STEP ** steps);
}
