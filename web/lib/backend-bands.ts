import { getBandWavelength } from './spectral.ts';
import type { BandWindow } from '../js/backend-sky.js';

// Keep the existing band picker's mapping; request contiguous selected ranges
// together, without including unselected channels between disjoint ranges.
export function selectedBandWindows(bands: number[], minimumWidth = 0): BandWindow[] {
  const selected = [...new Set(bands)].filter(b => Number.isInteger(b) && b >= 1 && b <= 102).sort((a,b)=>a-b);
  const windows: BandWindow[] = [];
  for (let i = 0; i < selected.length;) {
    const first = selected[i];
    let last = first;
    const detector = Math.floor((first - 1) / 17) + 1;
    while (i + 1 < selected.length && selected[i + 1] === last + 1 && Math.floor((selected[i + 1] - 1) / 17) + 1 === detector) last = selected[++i];
    if (last - first === 16) windows.push({ detector });
    else {
      const start = (detector - 1) * 17 + 1;
      const spacing = (getBandWavelength(start + 16) - getBandWavelength(start)) / 16;
      const low = getBandWavelength(first) - spacing / 2;
      const high = getBandWavelength(last) + spacing / 2;
      const wavelength = (low + high) / 2;
      windows.push({ detector, wavelength, width: Math.max(minimumWidth, (high - low) / (2 * wavelength)) });
    }
    i++;
  }
  return windows.length ? windows : selectedBandWindows([1], minimumWidth);
}

// An explicit wavelength uses the same request as the standalone viewer.
// Band selection continues to use its own centres and detector boundaries.
export function sequenceWindows(bands: number[], wavelength: number | undefined, width: number): BandWindow[] {
  const windows = selectedBandWindows(bands, width);
  if (wavelength === undefined) return windows;
  const native = selectedBandWindows(bands)[0];
  return [{ wavelength, width: width || ('width' in native ? native.width : .05) }];
}
