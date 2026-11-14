'use client';
import { useMemo, useState } from 'react';
import {
  computeTargetSpectrum,
  MOLECULAR_FEATURES,
  type SpectralBandInfo,
  getBandWavelength,
} from '@/lib/spectral';

type Props = {
  targetName: string;
  coordinates: { ra: number; dec: number };
  frame: number;
  selectedBands: number[];
  onSelectBand: (band: number) => void;
};

export default function SpectralViewer({
  targetName,
  coordinates,
  frame,
  selectedBands,
  onSelectBand,
}: Props) {
  const [hoveredBand, setHoveredBand] = useState<SpectralBandInfo | null>(null);
  const [showMolecules, setShowMolecules] = useState(true);

  const spectrum = useMemo(
    () => computeTargetSpectrum(targetName, coordinates, frame),
    [targetName, coordinates, frame]
  );

  const maxFlux = useMemo(
    () => Math.max(...spectrum.map((b) => b.flux), 1.0) * 1.15,
    [spectrum]
  );

  // Chart dimensions
  const width = 640;
  const height = 190;
  const padLeft = 45;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const minWl = 0.75;
  const maxWl = 5.00;

  const getX = (wl: number) => padLeft + ((wl - minWl) / (maxWl - minWl)) * chartW;
  const getY = (flux: number) => padTop + chartH - (flux / maxFlux) * chartH;

  // Polyline points
  const points = spectrum
    .map((b) => `${getX(b.wavelength).toFixed(1)},${getY(b.flux).toFixed(1)}`)
    .join(' ');

  // Gradient area points
  const areaPoints = `${getX(minWl)},${padTop + chartH} ${points} ${getX(
    maxWl
  )},${padTop + chartH}`;

  return (
    <div className="spectral-viewer" aria-label="Spectral Data Viewer (0.75–5.00 µm)">
      <div className="spectral-header">
        <div>
          <span className="eyebrow">SPHEREx 102-CHANNEL SPECTRAL VIEWER</span>
          <h3>
            Spectral Energy Distribution <span>0.75 – 5.00 µm</span>
          </h3>
        </div>
        <div className="spectral-controls">
          <label className="toggle-molecules">
            <input
              type="checkbox"
              checked={showMolecules}
              onChange={(e) => setShowMolecules(e.target.checked)}
            />
            <span>Molecular lines</span>
          </label>
        </div>
      </div>

      <div className="spectral-chart-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="spectral-svg"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="spectrum-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f39c12" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#e74c3c" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id="line-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3498db" />
              <stop offset="25%" stopColor="#2ecc71" />
              <stop offset="60%" stopColor="#f1c40f" />
              <stop offset="100%" stopColor="#e74c3c" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[1.0, 2.0, 3.0, 4.0, 5.0].map((wl) => (
            <g key={wl}>
              <line
                x1={getX(wl)}
                y1={padTop}
                x2={getX(wl)}
                y2={padTop + chartH}
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="2,2"
              />
              <text
                x={getX(wl)}
                y={padTop + chartH + 18}
                fill="rgba(255,255,255,0.5)"
                fontSize="10"
                textAnchor="middle"
              >
                {wl.toFixed(1)} µm
              </text>
            </g>
          ))}

          {/* Y-axis labels */}
          <line
            x1={padLeft}
            y1={padTop}
            x2={padLeft}
            y2={padTop + chartH}
            stroke="rgba(255,255,255,0.15)"
          />
          <line
            x1={padLeft}
            y1={padTop + chartH}
            x2={width - padRight}
            y2={padTop + chartH}
            stroke="rgba(255,255,255,0.15)"
          />
          <text
            x={padLeft - 6}
            y={padTop + 10}
            fill="rgba(255,255,255,0.4)"
            fontSize="9"
            textAnchor="end"
          >
            {maxFlux.toFixed(1)}
          </text>
          <text
            x={padLeft - 6}
            y={padTop + chartH}
            fill="rgba(255,255,255,0.4)"
            fontSize="9"
            textAnchor="end"
          >
            0
          </text>

          {/* Area fill */}
          <polygon points={areaPoints} fill="url(#spectrum-grad)" />

          {/* Spectrum curve */}
          <polyline
            points={points}
            fill="none"
            stroke="url(#line-grad)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Molecular lines */}
          {showMolecules &&
            MOLECULAR_FEATURES.map((feat) => {
              const x = getX(feat.wavelength);
              return (
                <g key={feat.name} className="molecular-feature">
                  <line
                    x1={x}
                    y1={padTop + 15}
                    x2={x}
                    y2={padTop + chartH}
                    stroke="rgba(100, 200, 255, 0.45)"
                    strokeWidth="1"
                    strokeDasharray="3,3"
                  />
                  <rect
                    x={x - 22}
                    y={padTop - 2}
                    width="44"
                    height="14"
                    rx="3"
                    fill="rgba(15, 23, 42, 0.85)"
                    stroke="rgba(100, 200, 255, 0.4)"
                    strokeWidth="0.8"
                  />
                  <text
                    x={x}
                    y={padTop + 8}
                    fill="#93c5fd"
                    fontSize="8.5"
                    fontWeight="600"
                    textAnchor="middle"
                  >
                    {feat.name}
                  </text>
                </g>
              );
            })}

          {/* Selected bands vertical markers */}
          {selectedBands.slice(0, 10).map((bNum) => {
            const b = spectrum.find((s) => s.band === bNum);
            if (!b) return null;
            const x = getX(b.wavelength);
            const y = getY(b.flux);
            return (
              <g key={`sel-${bNum}`} className="selected-band-pin">
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={padTop + chartH}
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                  opacity="0.8"
                />
                <circle cx={x} cy={y} r="3.5" fill="#f59e0b" stroke="#ffffff" strokeWidth="1" />
              </g>
            );
          })}

          {/* Interactive band hitboxes */}
          {spectrum.map((b) => {
            const x = getX(b.wavelength);
            const isSelected = selectedBands.includes(b.band);
            return (
              <rect
                key={b.band}
                x={x - 3}
                y={padTop}
                width="6"
                height={chartH}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredBand(b)}
                onMouseLeave={() => setHoveredBand(null)}
                onClick={() => onSelectBand(b.band)}
              />
            );
          })}
        </svg>
      </div>

      {/* Channel details readout */}
      <div className="spectral-readout">
        {hoveredBand ? (
          <div className="readout-active">
            <span className="readout-badge">Band #{hoveredBand.band}</span>
            <span>Detector {hoveredBand.detector}</span>
            <span>
              Wavelength: <strong>{hoveredBand.wavelength} µm</strong>
            </span>
            <span>
              Flux: <strong>{hoveredBand.flux.toFixed(3)}</strong>
            </span>
            <span>
              SNR: <strong>{hoveredBand.snr}σ</strong>
            </span>
            <small>(Click to tune filter to this band)</small>
          </div>
        ) : (
          <div className="readout-idle">
            <span>Hover over the curve or channels to inspect flux & wavelength.</span>
            <span>
              Active selection:{' '}
              <strong>
                {selectedBands.length === 1
                  ? `Band #${selectedBands[0]} (${getBandWavelength(selectedBands[0])} µm)`
                  : `${selectedBands.length} bands active`}
              </strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
