// What the timeline and zoom ruler say about frame loading (js/backend-sky.js
// onProgress). loaded and cleaned are fractions of the box's exposures, for the
// progress arcs.
import type { LoadProgress } from '../js/backend-sky.js';
import { LOAD_ARCMIN } from './zoom-ruler.ts';

export type ProgressText = {
  title: string;
  detail: string;
  tone: 'busy' | 'ok' | 'warn' | 'idle';
  loaded: number;
  cleaned: number;
};

export function describeProgress(progress: LoadProgress | null): ProgressText {
  const { phase, done, total, failed, cleaned } = progress ?? { phase: 'finding', done: 0, total: 0, failed: 0, cleaned: 0 };
  const loaded = total ? done / total : 0, clean = total ? cleaned / total : 0;
  const out = (title: string, detail: string, tone: ProgressText['tone']) => ({ title, detail, tone, loaded, cleaned: clean });
  switch (phase) {
    case 'zoomed-out':
      return out('Zoom in to load frames', `SPHEREx frames load once the view is narrower than ${LOAD_ARCMIN}′. Until then you see the all-sky map.`, 'idle');
    case 'hidden':
      return out('Visible-light map', 'Switch to Infrared to see SPHEREx frames.', 'idle');
    case 'loading':
      return out(`Loading ${done} of ${total}`, 'Frames join the timeline as they arrive.', 'busy');
    case 'cleaning':
      return out(`Cleaning ${cleaned} of ${total}`,
        'Each frame is being replaced by the median of up to 4 exposures either side from the same visit. Anything seen in only one exposure, such as a satellite trail, disappears.', 'busy');
    case 'ready':
      return out(`${total} frame${total === 1 ? '' : 's'} ready`, 'Press space to play or pause.', 'ok');
    case 'failed':
      return out(`${failed} of ${total} frames failed`, 'The rest are in the timeline. Press Recenter to try the failed ones again.', 'warn');
    case 'empty':
      return out('No exposures here', 'No SPHEREx exposure in the selected bands covers this view. Try other bands.', 'warn');
    case 'error':
      return out('Backend did not answer', 'Press Recenter to try again.', 'warn');
    default:
      return out('Finding exposures', 'Asking which SPHEREx exposures cover this view.', 'busy');
  }
}
