'use client';
import { useState, useMemo, useEffect } from 'react';
import { getBandWavelength, computeTargetSpectrum, MOLECULAR_FEATURES } from '@/lib/spectral';

type Props = {
  targetName: string;
  coordinates: { ra: number; dec: number };
  frame: number;
  onSelectBand?: (band: number) => void;
  onSelectBands?: (bands: number[]) => void;
};

// Preset comparisons for rapid astrophysical analysis
export const COMPARISON_PRESETS = [
  {
    id: 'dust-vs-stellar',
    title: 'Dust vs. Stellar (1.2 / 4.2 µm)',
    short: 'Dust vs. Stellar',
    desc: 'Compares 1.2 µm stellar continuum with 4.2 µm warm circumstellar dust emission to reveal infrared excess.',
    bandA: 21, // ~1.21 µm (Detector 2)
    bandB: 80, // ~4.23 µm (Detector 5)
    category: 'Infrared Excess',
  },
  {
    id: 'water-ice',
    title: 'Water Ice Absorption (2.4 / 3.05 µm)',
    short: 'Water Ice (3.05 µm)',
    desc: 'Compares continuum with the deep 3.05 µm interstellar H2O ice absorption band.',
    bandA: 44, // ~2.37 µm (Detector 3)
    bandB: 59, // ~3.03 µm (Detector 4)
    category: 'Ice Mantles',
  },
  {
    id: 'co-ice',
    title: 'CO Gas / Ice (4.1 / 4.67 µm)',
    short: 'CO Ice / Gas (4.67 µm)',
    desc: 'Compares pre-absorption continuum with fundamental 4.67 µm carbon monoxide transition.',
    bandA: 78, // ~4.16 µm (Detector 5)
    bandB: 93, // ~4.67 µm (Detector 6)
    category: 'Molecular Gas',
  },
  {
    id: 'pah-hydrocarbon',
    title: 'PAH Organics (3.3 / 3.6 µm)',
    short: 'PAH Organics (3.3 µm)',
    desc: 'Isolates polycyclic aromatic hydrocarbon emission band at 3.3 µm from continuum.',
    bandA: 62, // ~3.30 µm (Detector 4)
    bandB: 70, // ~3.59 µm (Detector 5)
    category: 'Organics',
  },
  {
    id: 'stellar-color',
    title: 'Color Gradient (0.85 / 1.65 µm)',
    short: 'Color Gradient',
    desc: 'Near-infrared color index sensitive to stellar effective temperature.',
    bandA: 5,  // ~0.84 µm (Detector 1)
    bandB: 34, // ~1.64 µm (Detector 2)
    category: 'Temperature',
  },
];

type CompareViewMode = 'split' | 'blink' | 'composite';

export default function BandCompare({
  targetName,
  coordinates,
  frame,
  onSelectBand,
  onSelectBands,
}: Props) {
  // Default to Dust vs Stellar: Band 21 (1.21 µm) vs Band 80 (4.23 µm)
  const [bandA, setBandA] = useState(21);
  const [bandB, setBandB] = useState(80);
  const [sliderPos, setSliderPos] = useState(50);
  const [viewMode, setViewMode] = useState<CompareViewMode>('split');
  const [appliedFeedback, setAppliedFeedback] = useState<string | null>(null);

  // Blink comparator states
  const [blinking, setBlinking] = useState(false);
  const [blinkSpeedMs, setBlinkSpeedMs] = useState(600);
  const [blinkPhase, setBlinkPhase] = useState<'A' | 'B'>('A');

  const spectrum = useMemo(
    () => computeTargetSpectrum(targetName, coordinates, frame),
    [targetName, coordinates, frame]
  );

  const dataA = spectrum.find((b) => b.band === bandA) || spectrum[20];
  const dataB = spectrum.find((b) => b.band === bandB) || spectrum[79];

  const wlA = getBandWavelength(bandA);
  const wlB = getBandWavelength(bandB);

  const detA = Math.floor((bandA - 1) / 17) + 1;
  const detB = Math.floor((bandB - 1) / 17) + 1;

  const ratio = (dataA.flux / Math.max(0.001, dataB.flux)).toFixed(2);
  const inverseRatio = (dataB.flux / Math.max(0.001, dataA.flux)).toFixed(2);
  const diffPercent = (((dataA.flux - dataB.flux) / Math.max(0.001, dataB.flux)) * 100).toFixed(1);

  // Blink interval timer
  useEffect(() => {
    if (!blinking || viewMode !== 'blink') return;
    const timer = setInterval(() => {
      setBlinkPhase((p) => (p === 'A' ? 'B' : 'A'));
    }, blinkSpeedMs);
    return () => clearInterval(timer);
  }, [blinking, blinkSpeedMs, viewMode]);

  // Color simulation for bands
  const getColorForWl = (wl: number) => {
    if (wl < 1.15) return 'rgba(56, 189, 248, 0.9)';   // Pulsar Cyan (stellar / hot)
    if (wl < 1.7) return 'rgba(129, 140, 248, 0.9)';   // Indigo
    if (wl < 2.5) return 'rgba(52, 211, 153, 0.9)';    // Emerald green
    if (wl < 3.5) return 'rgba(251, 191, 36, 0.9)';    // Amber gold (PAH / ice)
    if (wl < 4.4) return 'rgba(249, 115, 22, 0.9)';    // Orange (dust emission)
    return 'rgba(244, 63, 94, 0.9)';                   // Ruby crimson (deep IR)
  };

  // Astrophysical diagnostic
  const diagnostic = useMemo(() => {
    if (wlA <= 1.5 && wlB >= 3.8) {
      const excess = Number(inverseRatio) > 0.8;
      return {
        title: 'Dust vs. Stellar Emission',
        badge: excess ? 'IR DUST EXCESS' : 'STELLAR CONTINUUM',
        badgeColor: excess ? '#fbbf24' : '#38bdf8',
        detail: `Band A (${wlA.toFixed(2)} µm) captures stellar photosphere. Band B (${wlB.toFixed(2)} µm) isolates warm circumstellar dust grains. Flux ratio B/A is ${inverseRatio}×. ${
          excess
            ? 'Strong thermal emission from circumstellar dust or protoplanetary disk detected.'
            : 'Rayleigh-Jeans stellar continuum dominates over cold diffuse dust.'
        }`,
      };
    }
    if ((wlB >= 2.9 && wlB <= 3.2) || (wlA >= 2.9 && wlA <= 3.2)) {
      const isDip = dataB.flux < dataA.flux * 0.9;
      return {
        title: 'Water Ice Absorption (3.05 µm)',
        badge: isDip ? 'H2O ICE DETECTED' : 'ICE CONTINUUM',
        badgeColor: isDip ? '#38bdf8' : '#94a3b8',
        detail: `The 3.05 µm O-H stretching vibration is an indicator of icy mantles on interstellar grains. ${
          isDip
            ? `Distinct absorption trough observed (Flux ratio A/B = ${ratio}×).`
            : 'No significant ice absorption relative to continuum.'
        }`,
      };
    }
    if ((wlB >= 4.5 && wlB <= 4.8) || (wlA >= 4.5 && wlA <= 4.8)) {
      return {
        title: 'Carbon Monoxide Feature (4.67 µm)',
        badge: 'CO BAND',
        badgeColor: '#c084fc',
        detail: `4.67 µm probes solid CO ice and fundamental v=1-0 gas transitions. Relative flux difference is ${diffPercent}%.`,
      };
    }
    return {
      title: 'Dual-Band Photometry',
      badge: Number(ratio) >= 1 ? 'BAND A DOMINANT' : 'BAND B DOMINANT',
      badgeColor: '#38bdf8',
      detail: `Comparing Band #${bandA} (${wlA.toFixed(2)} µm, D${detA}) with Band #${bandB} (${wlB.toFixed(2)} µm, D${detB}). Flux ratio A/B = ${ratio}× (Δ = ${diffPercent}%).`,
    };
  }, [wlA, wlB, ratio, inverseRatio, diffPercent, dataA.flux, dataB.flux, bandA, bandB, detA, detB]);

  function applyPreset(p: typeof COMPARISON_PRESETS[0]) {
    setBandA(p.bandA);
    setBandB(p.bandB);
    setAppliedFeedback(`Loaded: ${p.short}`);
    setTimeout(() => setAppliedFeedback(null), 2500);
  }

  function handleSwap() {
    const tempA = bandA;
    setBandA(bandB);
    setBandB(tempA);
    setAppliedFeedback('Swapped Band A and Band B');
    setTimeout(() => setAppliedFeedback(null), 2000);
  }

  function handleApplyBandA() {
    onSelectBand?.(bandA);
    setAppliedFeedback(`Applied Band #${bandA} (${wlA.toFixed(2)} µm) to map`);
    setTimeout(() => setAppliedFeedback(null), 2500);
  }

  function handleApplyBandB() {
    onSelectBand?.(bandB);
    setAppliedFeedback(`Applied Band #${bandB} (${wlB.toFixed(2)} µm) to map`);
    setTimeout(() => setAppliedFeedback(null), 2500);
  }

  return (
    <div className="band-compare-panel" aria-label="Infrared Band Comparison Tool">
      {/* Header */}
      <div className="compare-header">
        <span className="eyebrow">SPHEREx SPECTRAL TOOLS</span>
        <h4>Band Comparison</h4>
        <p className="compare-subtitle">
          Evaluate flux ratios and emission diagnostics between any two infrared channels.
        </p>
      </div>

      {/* Astrophysical Presets */}
      <div className="compare-presets-section">
        <span className="presets-label">ASTROPHYSICAL PRESETS</span>
        <div className="compare-preset-pills">
          {COMPARISON_PRESETS.map((p) => {
            const isActive = bandA === p.bandA && bandB === p.bandB;
            return (
              <button
                key={p.id}
                type="button"
                className={`preset-pill ${isActive ? 'active' : ''}`}
                title={p.desc}
                onClick={() => applyPreset(p)}
              >
                {p.short}
              </button>
            );
          })}
        </div>
      </div>

      {/* Unified Side-by-Side Channel Card with In-Between Swap & Ratio */}
      <div className="compare-channels-card">
        {/* Band A */}
        <div className="channel-box channel-a">
          <div className="channel-box-header">
            <span className="channel-tag tag-a">BAND A</span>
            <span className="channel-wl">{wlA.toFixed(2)} µm</span>
          </div>
          <select
            value={bandA}
            onChange={(e) => setBandA(Number(e.target.value))}
            aria-label="Select Band A"
          >
            {Array.from({ length: 102 }, (_, i) => i + 1).map((b) => {
              const wl = getBandWavelength(b);
              const det = Math.floor((b - 1) / 17) + 1;
              const feat = MOLECULAR_FEATURES.find((f) => Math.abs(f.wavelength - wl) < 0.05);
              return (
                <option key={`a-${b}`} value={b}>
                  #{b} ({wl.toFixed(2)} µm · D{det}){feat ? ` · ${feat.name}` : ''}
                </option>
              );
            })}
          </select>
          <div className="channel-stats">
            <span>Flux: <strong>{dataA.flux.toFixed(3)}</strong></span>
            <span>SNR: <strong>{dataA.snr}σ</strong></span>
          </div>
        </div>

        {/* Swap Button & Ratio Center Badge */}
        <div className="channel-swap-col">
          <button
            type="button"
            className="swap-btn"
            title="Swap Band A and Band B"
            onClick={handleSwap}
            aria-label="Swap Band A and Band B"
          >
            ⇄
          </button>
          <div className="ratio-display" title="Ratio of Band A flux over Band B flux">
            <span className="metric-title">FLUX RATIO</span>
            <span className="ratio-num">{ratio}×</span>
            <span className="ratio-delta">
              {Number(diffPercent) >= 0 ? `+${diffPercent}%` : `${diffPercent}%`}
            </span>
          </div>
        </div>

        {/* Band B */}
        <div className="channel-box channel-b">
          <div className="channel-box-header">
            <span className="channel-tag tag-b">BAND B</span>
            <span className="channel-wl">{wlB.toFixed(2)} µm</span>
          </div>
          <select
            value={bandB}
            onChange={(e) => setBandB(Number(e.target.value))}
            aria-label="Select Band B"
          >
            {Array.from({ length: 102 }, (_, i) => i + 1).map((b) => {
              const wl = getBandWavelength(b);
              const det = Math.floor((b - 1) / 17) + 1;
              const feat = MOLECULAR_FEATURES.find((f) => Math.abs(f.wavelength - wl) < 0.05);
              return (
                <option key={`b-${b}`} value={b}>
                  #{b} ({wl.toFixed(2)} µm · D{det}){feat ? ` · ${feat.name}` : ''}
                </option>
              );
            })}
          </select>
          <div className="channel-stats">
            <span>Flux: <strong>{dataB.flux.toFixed(3)}</strong></span>
            <span>SNR: <strong>{dataB.snr}σ</strong></span>
          </div>
        </div>
      </div>

      {/* Visual Inspector Modes */}
      <div className="compare-mode-tabs" role="tablist" aria-label="Visual display mode">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'split'}
          className={`mode-tab-btn ${viewMode === 'split' ? 'active' : ''}`}
          onClick={() => setViewMode('split')}
        >
          ↔ Split Slider
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'blink'}
          className={`mode-tab-btn ${viewMode === 'blink' ? 'active' : ''}`}
          onClick={() => setViewMode('blink')}
        >
          ⚡ Blink Comparator
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'composite'}
          className={`mode-tab-btn ${viewMode === 'composite' ? 'active' : ''}`}
          onClick={() => setViewMode('composite')}
        >
          🎨 False Color
        </button>
      </div>

      {/* Viewport 1: Split-Slider Viewport */}
      {viewMode === 'split' && (
        <div className="split-comparison-container">
          <div className="split-viewport">
            <div
              className="split-layer layer-a"
              style={{
                clipPath: `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)`,
                background: `radial-gradient(circle at 50% 50%, ${getColorForWl(
                  wlA
                )} 0%, rgba(15, 23, 42, 0.95) 75%)`,
              }}
            >
              <span className="split-layer-label">Band #{bandA} ({wlA.toFixed(2)} µm)</span>
            </div>
            <div
              className="split-layer layer-b"
              style={{
                clipPath: `polygon(${sliderPos}% 0, 100% 0, 100% 100%, ${sliderPos}% 100%)`,
                background: `radial-gradient(circle at 50% 50%, ${getColorForWl(
                  wlB
                )} 0%, rgba(15, 23, 42, 0.95) 75%)`,
              }}
            >
              <span className="split-layer-label right">Band #{bandB} ({wlB.toFixed(2)} µm)</span>
            </div>
            <div
              className="split-divider-line"
              style={{ left: `${sliderPos}%` }}
            />
          </div>
          <div className="split-slider-ctrl">
            <span>Band A ({wlA.toFixed(2)} µm)</span>
            <input
              type="range"
              min="0"
              max="100"
              value={sliderPos}
              onChange={(e) => setSliderPos(Number(e.target.value))}
              aria-label="Split comparison slider"
            />
            <span>Band B ({wlB.toFixed(2)} µm)</span>
          </div>
        </div>
      )}

      {/* Viewport 2: Astronomical Blink Comparator */}
      {viewMode === 'blink' && (
        <div className="blink-comparator-container">
          <div
            className="blink-viewport"
            style={{
              background: `radial-gradient(circle at 50% 50%, ${getColorForWl(
                blinkPhase === 'A' ? wlA : wlB
              )} 0%, rgba(15, 23, 42, 0.95) 75%)`,
            }}
          >
            <div className="blink-phase-indicator">
              <span className={`blink-tag ${blinkPhase === 'A' ? 'active-a' : 'active-b'}`}>
                SHOWING: BAND {blinkPhase} ({blinkPhase === 'A' ? `${wlA.toFixed(2)} µm` : `${wlB.toFixed(2)} µm`})
              </span>
            </div>
          </div>
          <div className="blink-controls-row">
            <button
              type="button"
              className={`blink-toggle-btn ${blinking ? 'is-blinking' : ''}`}
              onClick={() => setBlinking(!blinking)}
            >
              {blinking ? '⏸ Pause Blink' : '▶ Start Blink'}
            </button>
            <div className="blink-speed-select">
              <label>
                Speed:
                <select
                  value={blinkSpeedMs}
                  onChange={(e) => setBlinkSpeedMs(Number(e.target.value))}
                >
                  <option value={300}>0.3s (Fast)</option>
                  <option value={600}>0.6s (Normal)</option>
                  <option value={1000}>1.0s (Slow)</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className="blink-manual-btn"
              onClick={() => setBlinkPhase((p) => (p === 'A' ? 'B' : 'A'))}
            >
              Flip A ⇄ B
            </button>
          </div>
        </div>
      )}

      {/* Viewport 3: False-Color Two-Band Composite */}
      {viewMode === 'composite' && (
        <div className="composite-container">
          <div
            className="composite-viewport"
            style={{
              background: `radial-gradient(circle at 50% 50%, ${getColorForWl(wlA)} 15%, ${getColorForWl(wlB)} 55%, rgba(5, 8, 16, 0.98) 85%)`,
            }}
          >
            <div className="composite-legend">
              <span className="legend-chip" style={{ color: getColorForWl(wlA) }}>
                ● Cyan/Blue: Band #{bandA} ({wlA.toFixed(2)} µm - Stellar)
              </span>
              <span className="legend-chip" style={{ color: getColorForWl(wlB) }}>
                ● Amber/Red: Band #{bandB} ({wlB.toFixed(2)} µm - Dust/Molecules)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Astrophysical Interpretation Card */}
      <div className="diagnostic-card">
        <div className="diagnostic-header">
          <span className="diagnostic-badge" style={{ backgroundColor: `${diagnostic.badgeColor}22`, color: diagnostic.badgeColor, borderColor: `${diagnostic.badgeColor}55` }}>
            {diagnostic.badge}
          </span>
          <strong>{diagnostic.title}</strong>
        </div>
        <p className="diagnostic-body">{diagnostic.detail}</p>
      </div>

      {/* Action Buttons to Apply to Sky Explorer Canvas */}
      <div className="compare-apply-actions">
        <span className="actions-label">SHOW ON SKY MAP</span>
        <div className="action-buttons-row">
          <button
            type="button"
            className="apply-btn apply-a"
            onClick={handleApplyBandA}
            title={`View Band #${bandA} (${wlA.toFixed(2)} µm) on the sky map`}
          >
            Show Band A ({wlA.toFixed(2)} µm)
          </button>
          <button
            type="button"
            className="apply-btn apply-b"
            onClick={handleApplyBandB}
            title={`View Band #${bandB} (${wlB.toFixed(2)} µm) on the sky map`}
          >
            Show Band B ({wlB.toFixed(2)} µm)
          </button>
        </div>
        {appliedFeedback && (
          <div className="apply-feedback-pill" role="status">
            ✓ {appliedFeedback}
          </div>
        )}
      </div>
    </div>
  );
}
