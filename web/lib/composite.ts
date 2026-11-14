// Names and colour keys for the frame filters (server/composite.py). The key is
// built from each frame's own X-Frame-Meta, so it follows the blink frame by frame.

export type FrameFilter = 'raw' | 'difference' | 'previous' | 'trail';

export const FILTERS: { value: FrameFilter; label: string; title: string }[] = [
  { value: 'raw', label: 'Raw', title: 'Each exposure as recorded' },
  { value: 'difference', label: 'Difference', title: 'Each frame minus the usual sky at this spot, so only what moved or changed is left' },
  { value: 'previous', label: 'Previous visit', title: 'Each frame minus the visit before it' },
  { value: 'trail', label: 'Trail', title: 'Each frame on top of the earlier visits, every visit in its own colour' },
];

export type KeyRow = { swatch: string; text: string; dim: boolean };
export type FilterKey = { rows: KeyRow[]; note: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month: MONTHS[month - 1], day };
}

/** "15 to 27 Aug 2025", naming a month or year only where the ends differ. */
export function visitSpan(start: string, end: string): string {
  const a = parts(start), b = parts(end);
  const last = `${b.day} ${b.month} ${b.year}`;
  if (start === end) return last;
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} to ${last}`;
  if (a.month !== b.month) return `${a.day} ${a.month} to ${last}`;
  return `${a.day} to ${last}`;
}

const rgb = (c: number[]) => `rgb(${c.join(', ')})`;
// REFERENCE_RGB and FRAME_RGB in server/composite.py, times 255.
const REFERENCE = rgb([255, 64, 38]);
const FRAME = rgb([64, 140, 255]);

type Visit = { start: string; end: string; exposures: number };
type Meta = {
  filter?: string;
  reference?: Visit & { kind: string; visits?: number };
  trail?: (Visit & { colour: number[]; shown: boolean; current: boolean })[];
  [key: string]: unknown;
} | null | undefined;

/** The colour key for a frame drawn with `filter`, or null when there is none to
 * show: a raw frame, or a frame that has not arrived with that filter yet. */
export function filterKey(filter: FrameFilter, meta: Meta): FilterKey | null {
  if (filter === 'raw' || !meta || meta.filter !== filter) return null;
  if (filter === 'trail' && meta.trail) {
    return {
      rows: meta.trail.map((v) => ({
        swatch: rgb(v.colour),
        text: `${visitSpan(v.start, v.end)}${v.current ? ' (this frame)' : v.shown ? '' : ' (not yet)'}`,
        dim: !v.shown,
      })),
      note: 'Colours add up: a star in the same place on every visit so far shows their mix.',
    };
  }
  const ref = meta.reference;
  if (!ref) return null;
  const span = visitSpan(ref.start, ref.end);
  if (filter === 'difference') {
    return {
      rows: [
        { swatch: REFERENCE, text: `Usual place: median of ${ref.exposures} exposures, ${span}`, dim: false },
        { swatch: FRAME, text: 'Place on this frame', dim: false },
      ],
      note: 'Black: no change.',
    };
  }
  const label = ref.kind === 'next' ? `Next visit: ${span} (the first visit has none before it)`
    : ref.kind === 'same' ? `This visit (only one here): ${span}`
    : `Previous visit: ${span}`;
  return {
    rows: [
      { swatch: REFERENCE, text: label, dim: false },
      { swatch: FRAME, text: 'This frame', dim: false },
    ],
    note: 'Black: no change.',
  };
}
