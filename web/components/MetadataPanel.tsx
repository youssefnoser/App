'use client';
import { useMemo } from 'react';
import { getObservationMetadata, type ObservationMetadata } from '@/lib/spectral';

type Props = {
  frame: number;
  bands: number[];
  coordinates: { ra: number; dec: number };
};

export default function MetadataPanel({ frame, bands, coordinates }: Props) {
  const metadata: ObservationMetadata = useMemo(
    () => getObservationMetadata(frame, bands, coordinates),
    [frame, bands, coordinates]
  );

  return (
    <div className="metadata-panel" aria-label="Observation details and quality metrics">
      <header className="metadata-header">
        <span className="eyebrow">MISSION METADATA & TELEMETRY</span>
        <h4>SPHEREx Observation Record</h4>
      </header>

      <div className="metadata-grid">
        {/* Section 1: Observation Details */}
        <div className="metadata-section">
          <h5>Observation Details</h5>
          <dl>
            <div>
              <dt>Telescope</dt>
              <dd>{metadata.telescope}</dd>
            </div>
            <div>
              <dt>Instrument</dt>
              <dd>{metadata.instrument}</dd>
            </div>
            <div>
              <dt>Survey Epoch</dt>
              <dd>
                {metadata.epochLabel} ({metadata.date})
              </dd>
            </div>
            <div>
              <dt>Orbit / Exposure</dt>
              <dd>Orbit #{metadata.orbitNumber} · Low Earth Orbit (SSO 650 km)</dd>
            </div>
            <div>
              <dt>Active Wavelength(s)</dt>
              <dd>
                <strong>{metadata.activeWavelengths}</strong>
              </dd>
            </div>
          </dl>
        </div>

        {/* Section 2: Data Quality Metrics */}
        <div className="metadata-section">
          <h5>Data Quality Metrics</h5>
          <dl>
            <div>
              <dt>Image Quality</dt>
              <dd>
                <span className="quality-pill nominal">{metadata.quality}</span>
              </dd>
            </div>
            <div>
              <dt>PSF FWHM</dt>
              <dd>
                <strong>{metadata.psfFwhmArcsec}″</strong> (Optical Point Spread Function)
              </dd>
            </div>
            <div>
              <dt>Contamination Flags</dt>
              <dd className="flags-list">
                {metadata.contaminationFlags.map((flag) => (
                  <span key={flag} className="flag-badge">
                    ✓ {flag}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </div>

        {/* Section 3: Physical Parameters */}
        <div className="metadata-section">
          <h5>Physical Parameters</h5>
          <dl>
            <div>
              <dt>Pixel Variance (σ²)</dt>
              <dd>
                <strong>{metadata.varianceMjy2} mJy²</strong>
              </dd>
            </div>
            <div>
              <dt>Zodiacal Light (ZODI)</dt>
              <dd>
                <strong>{metadata.zodiFluxMjySr} MJy/sr</strong> (Interplanetary dust foreground)
              </dd>
            </div>
            <div>
              <dt>WCS-Wave Solution</dt>
              <dd className="wcs-code">
                <code>{metadata.wcsProjection}</code>
                <br />
                <code>WCS-WAVE: LINEAR (0.75 - 5.00 µm LVF)</code>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
