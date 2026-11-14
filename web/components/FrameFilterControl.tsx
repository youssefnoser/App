'use client';
// Frame filter switch and colour key, top right of the map above the toolbar. The
// filter applies to every frame, so it keeps working while the blink plays; the
// key is built from the frame on screen (its X-Frame-Meta) and follows it.
import { FILTERS, filterKey, type FrameFilter } from '@/lib/composite';
import type { FrameMeta } from '@/shared/backend-sky.js';

type Props = {
  filter: FrameFilter;
  onFilter: (filter: FrameFilter) => void;
  meta: FrameMeta | null;
  hasFrames: boolean;
};

export default function FrameFilterControl({ filter, onFilter, meta, hasFrames }: Props) {
  const key = filterKey(filter, meta as Parameters<typeof filterKey>[1]);
  return (
    <>
      <div className="frame-filter-switch" role="group" aria-label="Frame filter">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            title={option.title}
            onClick={() => onFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {filter !== 'raw' && (
        <div className="frame-filter-key" aria-live="polite">
          {key ? (
            <>
              <ul>
                {key.rows.map((row) => (
                  <li key={row.text} className={row.dim ? 'is-dim' : ''}>
                    <span className="frame-filter-swatch" style={{ background: row.swatch }} aria-hidden="true" />
                    {row.text}
                  </li>
                ))}
              </ul>
              <p>{key.note}</p>
            </>
          ) : (
            <p>
              {hasFrames
                ? 'Comparing each frame with the other visits here. The first one can take up to a minute at a new spot.'
                : 'Zoom in until SPHEREx frames load, then each frame is compared with the other visits.'}
            </p>
          )}
        </div>
      )}
    </>
  );
}
