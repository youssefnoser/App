'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sampleDataset, combineImages, imageOperation } from '@/lib/observations';
import { dates } from '@/lib/sky';
import BandCompare from './BandCompare';
import BandDatePicker from './BandDatePicker';

type Props = {
  frame: number;
  bands: number[];
  coordinates?: { ra: number; dec: number };
  targetName?: string;
  gaiaEnabled?: boolean;
  wiseEnabled?: boolean;
  onToggleGaia?: () => void;
  onToggleWise?: () => void;
  onSelectBand?: (band: number) => void;
  onSelectBands?: (bands: number[]) => void;
  onSelectCoords?: (ra: number, dec: number) => void;
  onOpenChange?: (open: boolean) => void;
};

type TabType = 'compare' | 'math';

export default function ImageMath({
  frame,
  bands,
  coordinates = { ra: 269.4521, dec: 4.6934 },
  targetName = 'Target Area',
  onSelectBand = () => {},
  onSelectBands = () => {},
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('compare');
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) closeButton.current?.focus({ preventScroll: true });
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  // Image math states & logic
  const [mode, setMode] = useState('off');
  const [reference, setReference] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useMemo(() => (mode === 'off' ? null : sampleDataset()), [mode]);

  const result = useMemo(() => {
    if (!data) return null;
    const at = (epoch: number) =>
      combineImages(
        data.observations.slice(epoch * 102, (epoch + 1) * 102).filter((o) => bands.includes(o.band))
      );
    const a = at(frame);
    const b = at(reference);
    return a && b ? imageOperation(a, b, mode === 'add' ? 'add' : 'subtract') : null;
  }, [data, frame, reference, bands, mode]);

  useEffect(() => {
    if (!result || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    if (!ctx) return;
    canvas.current.width = result.width;
    canvas.current.height = result.height;
    const pixels = ctx.createImageData(result.width, result.height);
    const max = Math.max(...result.pixels.map(Math.abs), 0.001);
    result.pixels.forEach((v, i) => {
      const n = Math.round((Math.abs(v) / max) * 255);
      pixels.data.set(v < 0 ? [n, n * 0.35, n * 0.15, 255] : [n * 0.5, n * 0.8, n, 255], i * 4);
    });
    ctx.putImageData(pixels, 0, 0);
  }, [result]);

  return (
    <>
      <button
        ref={trigger}
        className="image-math-toggle"
        aria-label="Open advanced options"
        aria-expanded={open}
        aria-controls="image-math-sidebar"
        onClick={() => setOpen(true)}
      >
        <span>Advanced options</span>
      </button>

      <button
        className={`image-math-backdrop${open ? ' is-open' : ''}`}
        aria-label="Close advanced options sidebar"
        tabIndex={-1}
        onClick={close}
        inert={!open}
      />

      <aside
        id="image-math-sidebar"
        className={`image-math${open ? ' is-open' : ''}`}
        aria-label="Advanced options"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">SKY EXPLORER</span>
            <h2>Advanced options</h2>
          </div>
          <button ref={closeButton} aria-label="Close advanced options" onClick={close}>
            Close
          </button>
        </header>

        {/* Tab Navigation Bar (Pinned) */}
        <nav className="advanced-tabs-nav" aria-label="Analysis Tools">
          <button
            type="button"
            className={`adv-tab-btn ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveTab('compare')}
          >
            Compare
          </button>
          <button
            type="button"
            className={`adv-tab-btn ${activeTab === 'math' ? 'active' : ''}`}
            onClick={() => setActiveTab('math')}
          >
            Image Math
          </button>
        </nav>

        {/* Scrollable Content Pane with Pinned Header */}
        <div className="advanced-drawer-content">
          {/* Tab 1: Dual-Band Comparator */}
          {activeTab === 'compare' && (
            <div className="tab-pane">
              <BandCompare
                targetName={targetName}
                coordinates={coordinates}
                frame={frame}
                onSelectBand={onSelectBand}
                onSelectBands={onSelectBands}
              />
            </div>
          )}

          {/* Tab 2: Image Math */}
          {activeTab === 'math' && (
            <div className="tab-pane">
              <p className="image-math-description">Compare observations to reveal changes over time.</p>
              <label>
                Image math
                <select
                  aria-label="Image operation"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="off">Off</option>
                  <option value="add">Add frames</option>
                  <option value="subtract">Subtract frames</option>
                </select>
              </label>
              {mode !== 'off' && (
                <>
                  <label>
                    Reference
                    <select
                      aria-label="Reference frame"
                      value={reference}
                      onChange={(e) => setReference(+e.target.value)}
                    >
                      {dates.map((date, i) => (
                        <option key={date} value={i}>
                          {date}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* Calendar Date-Picker Style Detector & Band Selection */}
                  <div className="math-band-picker-container">
                    <div className="math-picker-header">
                      <span className="eyebrow">SELECT BANDS TO {mode === 'add' ? 'ADD' : 'SUBTRACT'}</span>
                      <span className="math-active-count">{bands.length} / 102 selected</span>
                    </div>
                    <BandDatePicker
                      selectedBands={bands}
                      onChangeBands={(newBands) => onSelectBands(newBands)}
                    />
                  </div>

                  <figure>
                    <canvas ref={canvas} aria-label="Processed sample image" />
                    <figcaption>
                      {dates[frame]} {mode === 'add' ? '+' : '−'} {dates[reference]}
                      <br />
                      Synthetic pixels · {bands.length} selected bands combined
                      <br />
                      Blue: positive · Orange: negative
                    </figcaption>
                  </figure>
                </>
              )}
              <p className="image-math-note">
                Use the band picker above to select specific infrared channels for mathematical frame comparison.
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
