'use client';
import { useEffect, useRef, useState } from 'react';
import { detectorBands } from '@/lib/sky';
import { getBandWavelength } from '@/lib/spectral';

type Props = {
  onSelection: (bands: number[]) => void;
  onOpenChange?: (open: boolean) => void;
};

const DETECTOR_INFO = [
  { id: 1, name: 'Detector 1', range: '0.75 – 1.11 µm', res: 'R ~ 41', regime: 'Near-IR (NIR)' },
  { id: 2, name: 'Detector 2', range: '1.11 – 1.64 µm', res: 'R ~ 41', regime: 'Near-IR (NIR)' },
  { id: 3, name: 'Detector 3', range: '1.64 – 2.42 µm', res: 'R ~ 41', regime: 'Near-IR (NIR)' },
  { id: 4, name: 'Detector 4', range: '2.42 – 3.82 µm', res: 'R ~ 35', regime: 'Mid-IR (MIR)' },
  { id: 5, name: 'Detector 5', range: '3.82 – 4.42 µm', res: 'R ~ 110', regime: 'High-Res ices' },
  { id: 6, name: 'Detector 6', range: '4.42 – 5.00 µm', res: 'R ~ 130', regime: 'CO gas & ice' },
];

export default function BandSelector({ onSelection, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [detector, setDetector] = useState(1);
  const [selected, setSelected] = useState<number[]>([1]);
  const [status, setStatus] = useState('');

  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    onSelection(selected);
  }, [selected, onSelection]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  useEffect(() => {
    if (open) closeBtn.current?.focus({ preventScroll: true });
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function toggle(band: number) {
    if (selected.includes(band) && selected.length === 1) {
      setStatus('Keep at least one band selected.');
      return;
    }
    const updated = selected.includes(band)
      ? selected.filter((b) => b !== band)
      : [...selected, band].sort((a, b) => a - b);
    setSelected(updated);
    setStatus('');
  }

  const currentDetBands = detectorBands(detector);
  const allInCurrent = currentDetBands.every((b) => selected.includes(b));
  const currentInfo = DETECTOR_INFO[detector - 1];

  function toggleCurrentDetector() {
    if (allInCurrent) {
      if (selected.length === 17) {
        setStatus('Keep at least one band selected.');
        return;
      }
      setSelected(selected.filter((b) => !currentDetBands.includes(b)));
    } else {
      setSelected(Array.from(new Set([...selected, ...currentDetBands])).sort((a, b) => a - b));
    }
    setStatus('');
  }

  function selectAllSurvey() {
    setSelected(Array.from({ length: 102 }, (_, i) => i + 1));
    setStatus('');
  }

  return (
    <div ref={ref} className={`band-control${open ? ' is-open' : ''}`}>
      <button
        ref={trigger}
        id="bands-toggle"
        aria-expanded={open}
        aria-controls="bands-panel"
        aria-label="Choose infrared bands"
        onClick={() => setOpen(!open)}
      >
        <span className="bands-toggle-icon" aria-hidden="true">
          ▥
        </span>
        <span className="bands-toggle-label">
          Bands{' '}
          <b id="bands-button-value">
            {selected.length}
          </b>
        </span>
        <span className="bands-chevron">⌃</span>
      </button>

      <div
        id="bands-panel"
        className="bands-large-screen"
        inert={!open}
        aria-hidden={!open}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        {/* Tray Heading */}
        <div className="band-tray-heading">
          <div>
            <span className="eyebrow">SPHEREX 102-CHANNEL SPECTROMETER</span>
            <h2>
              Infrared Bands{' '}
              <span>6 Detectors · 17 Channels Each (0.75 – 5.00 µm)</span>
            </h2>
          </div>
          <button
            ref={closeBtn}
            id="bands-close"
            aria-label="Close band selection"
            onClick={close}
          >
            ×
          </button>
        </div>

        {/* Large Screen Date-Picker Style Band Chooser */}
        <div className="band-picker-large-view">
          {/* 6-Detector Strip */}
          <div
            className="picker-detector-strip"
            role="tablist"
            aria-label="Choose SPHEREx detector"
          >
            {DETECTOR_INFO.map((det) => {
              const count = detectorBands(det.id).filter((b) => selected.includes(b)).length;
              const isActive = detector === det.id;
              return (
                <button
                  key={det.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`picker-det-tab ${isActive ? 'active' : ''} ${
                    count > 0 ? 'has-bands' : ''
                  }`}
                  onClick={() => setDetector(det.id)}
                >
                  <span className="det-tab-num">Detector {det.id}</span>
                  <span className="det-tab-range">{det.range}</span>
                  {count > 0 && <span className="det-tab-badge">{count} active</span>}
                </button>
              );
            })}
          </div>

          {/* Level 2: Calendar Day-Style 17-Band Grid */}
          <div
            className="picker-bands-grid large-grid"
            role="group"
            aria-label={`Bands in ${currentInfo.name}`}
          >
            {currentDetBands.map((band, index) => {
              const isChecked = selected.includes(band);
              const wl = getBandWavelength(band).toFixed(2);
              const localNum = String(index + 1).padStart(2, '0');
              return (
                <label
                  key={band}
                  className={`picker-band-cell individual-band ${isChecked ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(band)}
                    aria-label={`Detector ${detector}, local band ${index + 1}, global band ${band}`}
                  />
                  <span className="picker-band-local">{localNum}</span>
                  <span className="picker-band-wl">{wl} µm</span>
                  <span className="picker-band-global">Band #{band}</span>
                </label>
              );
            })}
          </div>

          {/* Quick Action Buttons */}
          <div className="picker-actions-bar">
            <button
              type="button"
              className="picker-action-btn"
              onClick={toggleCurrentDetector}
            >
              {allInCurrent
                ? `Deselect Detector ${detector}`
                : `Select all 17 in Detector ${detector}`}
            </button>
            <button
              type="button"
              className="picker-action-btn survey-all-btn"
              onClick={selectAllSurvey}
            >
              Select All 102 Bands
            </button>
          </div>
        </div>

        {/* Tray Footer Status */}
        <div className="band-tray-footer">
          <p id="band-status" role="status">
            {status || `${selected.length} individual bands selected across detectors`}
          </p>
          <span className="band-tray-note">
            Active: {selected.length} / 102 channels · SPHEREx All-Sky Survey
          </span>
        </div>
      </div>
    </div>
  );
}
