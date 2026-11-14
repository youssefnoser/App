export const MIN_ZOOM = (5 / 60) / 105;
export const MAX_ZOOM = 25.0;
export const ZOOM_LEVELS = [MIN_ZOOM, 0.0015, 0.003, 0.006, 0.012, 0.025, 0.05, 0.1, 0.25, 0.4, 0.6, 1.0, 1.4, 2.0, 2.8, 4.0, 6.0, 9.0, 14.0, 20.0, 25.0];

export function getNextZoomIn(current: number): number {
  const next = ZOOM_LEVELS.find((lvl) => lvl > current * (1 + 1e-6));
  return next ?? MAX_ZOOM;
}

export function getNextZoomOut(current: number): number {
  const reversed = [...ZOOM_LEVELS].reverse();
  const prev = reversed.find((lvl) => lvl < current * (1 - 1e-6));
  return prev ?? MIN_ZOOM;
}

export const targets = [
  { name: 'Barnard’s Star', ra: 269.4521, dec: 4.6934, type: 'HIGH PROPER-MOTION STAR', description: 'A star on the move' },
  { name: 'Epsilon Indi B', ra: 330.8417, dec: -56.785, type: 'BROWN DWARF PAIR', description: 'A hidden pair of brown dwarfs' },
  { name: 'WISE 0855', ra: 133.79513, dec: -7.24515, type: 'COLD BROWN DWARF', description: 'Our cold cosmic neighbor' },
  { name: 'RW Aurigae', ra: 76.956, dec: 30.4014, type: 'VARIABLE STAR', description: 'Watch its brightness change' },
  { name: 'R Draconis', ra: 249.19, dec: 66.752, type: 'VARIABLE STAR', description: 'A variable star in Draco' },
];
export const dates = ['June 2025', 'December 2025', 'June 2026', 'December 2026', 'June 2027', 'December 2027'];
export function detectorBands(detector: number): number[] { return Array.from({ length: 17 }, (_, i) => (detector - 1) * 17 + i + 1); }
