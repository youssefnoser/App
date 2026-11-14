'use client';
import { useEffect, useRef, useState } from 'react';
import { getBandWavelength } from '@/lib/spectral';
import { GoogleLayersIcon, GoogleZoomInIcon, GoogleZoomOutIcon } from './GoogleMapIcons';

type Props = { selected: number[]; onSelection: (bands: number[]) => void; onOpenChange?: (open: boolean) => void; wavelength: number; width: number; onWavelength: (value:number) => void; onWidth: (value:number) => void };

const BANDS = 102, PER_DETECTOR = 17;
const WINDOWS = [
  { value: 0, label: 'Exact', title: 'Only the selected band' },
  { value: .02, label: '2%', title: 'Within 2 percent of the centre wavelength' },
  { value: .05, label: '5%', title: 'Within 5 percent of the centre wavelength' },
  { value: .1, label: '10%', title: 'Within 10 percent of the centre wavelength' },
];

// Ruler geometry in SVG user units: 102 ticks in six detector groups with a gap between groups.
const TICK = 3, GAP = 6, RULER_W = BANDS * TICK + 5 * GAP;
const tickX = (band: number) => (band - 1) * TICK + Math.floor((band - 1) / PER_DETECTOR) * GAP + TICK / 2;

export default function BandSelector({ selected, onSelection, onOpenChange, wavelength, width, onWavelength, onWidth }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(selected[0] ?? 1));
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const band = selected[0] ?? 1;
  const detector = Math.floor((band - 1) / PER_DETECTOR) + 1;
  const localBand = (band - 1) % PER_DETECTOR + 1;

  useEffect(() => { setDraft(String(band)); setError(''); }, [band]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  function choose(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > BANDS) {
      setError('Enter a whole number from 1 to 102.');
      return;
    }
    setDraft(String(value)); setError(''); onSelection([value]);
  }
  function close() { setOpen(false); trigger.current?.focus(); }

  return <div ref={root} className={`band-control${open ? ' is-open' : ''}`}>
    <button ref={trigger} id="bands-toggle" aria-expanded={open} aria-controls="band-pop" aria-label="Choose infrared bands" onClick={() => setOpen(!open)}>
      <span className="bands-toggle-icon" aria-hidden="true"><GoogleLayersIcon size={18} /></span><span className="bands-toggle-label">Band <b id="bands-button-value">{band}</b></span><span className="bands-chevron" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg></span>
    </button>
    <section id="band-pop" className="band-pop" aria-label="Infrared band selection" inert={!open} aria-hidden={!open} onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <header className="band-pop-head">
        <span className="band-pop-title">Band</span>
        <span className="band-pop-meta">Detector {detector} · channel {localBand} of {PER_DETECTOR}</span>
        <button className="band-pop-close" aria-label="Close band selection" onClick={close}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </header>

      <form className="band-pop-stepper" onSubmit={event => { event.preventDefault(); choose(Number(draft)); }}>
        <button type="button" aria-label="Previous band" disabled={band <= 1} onClick={() => choose(band - 1)}><GoogleZoomOutIcon size={16} /></button>
        <label className="band-pop-number">
          <span className="sr-only">Band number</span>
          <input id="band-number" type="number" min="1" max={BANDS} step="1" value={draft} aria-invalid={!!error} aria-describedby="band-number-help" onChange={event => {
            const value = event.target.value; setDraft(value);
            if (value && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= BANDS) choose(Number(value));
            else setError(value ? 'Enter a whole number from 1 to 102.' : 'Enter a band number.');
          }} />
        </label>
        <button type="button" aria-label="Next band" disabled={band >= BANDS} onClick={() => choose(band + 1)}><GoogleZoomInIcon size={16} /></button>
        <output className="band-pop-wavelength" htmlFor="band-number">{getBandWavelength(band).toFixed(2)}<small>µm</small></output>
      </form>
      <p id="band-number-help" className="band-pop-error" role="status">{error}</p>

      <div className="band-ruler">
        <svg viewBox={`0 0 ${RULER_W} 30`} preserveAspectRatio="none" aria-hidden="true">
          {Array.from({ length: BANDS }, (_, i) => {
            const b = i + 1, x = tickX(b), edge = (b - 1) % PER_DETECTOR === 0 || b % PER_DETECTOR === 0;
            return <line key={b} x1={x} x2={x} y1={edge ? 8 : 14} y2={26} className={Math.floor(i / PER_DETECTOR) + 1 === detector ? 'on' : ''} />;
          })}
          <path className="band-ruler-marker" d={`M${tickX(band) - 4} 0h8l-4 6z`} />
          <line className="band-ruler-marker" x1={tickX(band)} x2={tickX(band)} y1={4} y2={30} />
        </svg>
        <input type="range" min="1" max={BANDS} step="1" value={band} aria-label="Band" aria-valuetext={`Band ${band}, ${getBandWavelength(band).toFixed(2)} micrometres`} onChange={event => choose(event.target.valueAsNumber)} />
        <div className="band-ruler-labels" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => <span key={i} className={i + 1 === detector ? 'on' : ''}>D{i + 1}</span>)}
        </div>
        <div className="band-ruler-ends" aria-hidden="true"><span>0.75 µm</span><span>5.0 µm</span></div>
      </div>

      <fieldset className="band-pop-window">
        <legend>Wavelength window</legend>
        <div className="band-pop-segments">
          {WINDOWS.map(option => <label key={option.value} title={option.title}>
            <input type="radio" name="sequence-width" value={option.value} checked={width === option.value} onChange={() => onWidth(option.value)} />
            <span>{option.label}</span>
          </label>)}
        </div>
        <div className="band-pop-centre">
          <label htmlFor="sequence-wavelength">Centre</label>
          <span className="band-pop-field"><input id="sequence-wavelength" type="number" min="0.75" max="5" step="0.01" value={Math.round(wavelength * 100) / 100} onChange={event => {
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value) && value >= .75 && value <= 5) onWavelength(value);
          }} /><small>µm</small></span>
          <button type="button" className="band-pop-reset" onClick={() => { onWavelength(1.25); onWidth(.05); }}>Reset</button>
        </div>
        <p className="band-pop-note">Wider windows let more neighbouring exposures fill the view. Some exposures may still have gaps.</p>
      </fieldset>
    </section>
  </div>;
}
