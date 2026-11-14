'use client';
import { useEffect, useRef, useState } from 'react';
import { getBandWavelength } from '@/lib/spectral';

type Props = { selected: number[]; onSelection: (bands: number[]) => void; onOpenChange?: (open: boolean) => void };

export default function BandSelector({ selected, onSelection, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(selected[0] ?? 1));
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const band = selected[0] ?? 1;
  const detector = Math.floor((band - 1) / 17) + 1;
  const localBand = (band - 1) % 17 + 1;

  useEffect(() => { setDraft(String(band)); setError(''); }, [band]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  function choose(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 102) {
      setError('Enter a whole number from 1 to 102.');
      return;
    }
    setDraft(String(value)); setError(''); onSelection([value]);
  }
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div ref={root} className={`band-control${open ? ' is-open' : ''}`}>
    <button ref={trigger} id="bands-toggle" aria-expanded={open} aria-controls="bands-panel" aria-label="Choose infrared bands" onClick={() => setOpen(!open)}>
      <span className="bands-toggle-icon" aria-hidden="true">?</span><span className="bands-toggle-label">Band <b id="bands-button-value">{band}</b></span><span className="bands-chevron">?</span>
    </button>
    <aside id="bands-panel" className="bands-sidebar band-counter-sidebar" aria-label="Infrared band selection" inert={!open} aria-hidden={!open} onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <div className="band-tray-heading"><div><span className="eyebrow">SPHEREX SKY EXPLORER</span><h2>Choose a band<span>Available range: 1?102</span></h2></div><button id="bands-close" aria-label="Close band selection" onClick={close}>?</button></div>
      <form className="band-counter-form" onSubmit={event => { event.preventDefault(); choose(Number(draft)); }}>
        <label htmlFor="band-number">Band number</label>
        <div className="band-counter-controls"><button type="button" aria-label="Previous band" disabled={band <= 1} onClick={() => choose(band - 1)}>?</button><input id="band-number" type="number" min="1" max="102" step="1" value={draft} aria-invalid={!!error} aria-describedby="band-number-help" onChange={event => { const value=event.target.value; setDraft(value); if (value && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 102) choose(Number(value)); else setError(value ? 'Enter a whole number from 1 to 102.' : 'Enter a band number.'); }} /><button type="button" aria-label="Next band" disabled={band >= 102} onClick={() => choose(band + 1)}>+</button></div>
        <p id="band-number-help" role="status">{error || `Band ${band} ? Detector ${detector} ? Channel ${localBand} of 17`}</p>
        <p className="band-counter-wavelength">Approximate wavelength: {getBandWavelength(band).toFixed(2)} ?m</p>
        {selected.length > 1 && <p className="band-counter-wavelength">{selected.length} bands are selected from Advanced options. Choose a number to view one band.</p>}
      </form>
    </aside>
  </div>;
}
