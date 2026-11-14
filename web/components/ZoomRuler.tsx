'use client';
// Straight zoom control: a log ruler of the field of view that slides under a
// fixed needle, the way the time dial turns under its needle. Zoomed-in end on
// top. The stretch where SPHEREx frames load is marked on the ruler, and the
// readout under it says what the frame loader is doing.
import { useRef, useState } from 'react';
import { svgNumber } from '@/lib/rotor';
import {
  FIELD_MIN_ARCMIN, FIELD_MAX_ARCMIN, LOAD_ARCMIN,
  rulerOffset, fieldAtOffset, rulerTicks, formatField, stepField,
} from '@/lib/zoom-ruler';
import type { ProgressText } from '@/lib/load-progress';

const TICKS = rulerTicks();
const HEIGHT = 220, WIDTH = 74, MID = HEIGHT / 2;
const LOAD_OFFSET = rulerOffset(LOAD_ARCMIN);

type Props = { field: number; status: ProgressText; frames: number; onChange: (arcmin: number) => void };

export default function ZoomRuler({ field, status, frames, onChange }: Props) {
  const drag = useRef<{ pointer: number; y: number; offset: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const offset = live ?? rulerOffset(field);
  const shown = fieldAtOffset(offset);
  const loading = shown < LOAD_ARCMIN;
  const end = () => { drag.current = null; setLive(null); };
  const note = !loading ? `Zoom in past ${LOAD_ARCMIN}′ for frames`
    : status.tone === 'busy' || status.tone === 'warn' ? status.title
    : `${frames} frame${frames === 1 ? '' : 's'} in view`;
  return <div className={`field-ruler${live !== null ? ' is-sliding' : ''}${loading ? ' in-frames' : ''}`} data-tone={status.tone}>
    <div className="field-ruler-window" role="slider" tabIndex={0} aria-label="Field of view" aria-orientation="vertical"
      aria-valuemin={FIELD_MIN_ARCMIN} aria-valuemax={FIELD_MAX_ARCMIN} aria-valuenow={Number(field.toFixed(3))}
      aria-valuetext={`Field of view ${formatField(field)}. ${note}.`}
      onPointerDown={event => {
        if (drag.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        drag.current = { pointer: event.pointerId, y: event.clientY, offset: rulerOffset(field) };
        setLive(drag.current.offset);
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
        // Grab the ruler: dragging down pulls the zoomed-in end towards the needle.
        const next = rulerOffset(fieldAtOffset(current.offset - (event.clientY - current.y)));
        setLive(next); onChange(fieldAtOffset(next));
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={event => {
        const steps = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 4, PageDown: -4 } as Record<string, number>)[event.key];
        if (steps) { event.preventDefault(); onChange(stepField(field, steps)); }
        else if (event.key === 'Home') { event.preventDefault(); onChange(FIELD_MIN_ARCMIN); }
        else if (event.key === 'End') { event.preventDefault(); onChange(FIELD_MAX_ARCMIN); }
      }}
      onWheel={event => { event.stopPropagation(); onChange(stepField(field, event.deltaY < 0 ? 1 : -1)); }}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} aria-hidden="true">
        <g className="field-ruler-tape" style={{ transform: `translateY(${svgNumber(MID - offset)}px)` }}>
          <rect className="field-ruler-frames" x="6" y="0" width="3" height={svgNumber(LOAD_OFFSET)} rx="1.5" />
          {TICKS.map(tick => <g key={tick.arcmin}>
            <line x1={tick.major ? 34 : 42} x2="54" y1={svgNumber(tick.offset)} y2={svgNumber(tick.offset)}
              stroke="currentColor" strokeWidth={tick.major ? 1.6 : 1} opacity={tick.major ? 1 : .5} />
            {tick.label && <text x="29" y={svgNumber(tick.offset)} textAnchor="end" dominantBaseline="middle"
              className={tick.arcmin === LOAD_ARCMIN ? 'field-ruler-limit' : undefined}>{tick.label}</text>}
          </g>)}
        </g>
        <g className="field-ruler-needle">
          <line x1="30" x2={WIDTH - 2} y1={MID} y2={MID} stroke="currentColor" strokeWidth="2.5" />
          <path d={`M${WIDTH} ${MID - 5} L${WIDTH} ${MID + 5} L${WIDTH - 7} ${MID} Z`} fill="currentColor" />
        </g>
      </svg>
    </div>
    <div className="field-ruler-readout" aria-hidden="true">
      <span>{formatField(shown)}</span>
      <small>FIELD</small>
    </div>
    <div className="field-ruler-note" title={loading ? status.detail : `SPHEREx frames load once the view is narrower than ${LOAD_ARCMIN}′.`}>{note}</div>
  </div>;
}
