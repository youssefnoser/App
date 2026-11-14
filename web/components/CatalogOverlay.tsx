'use client';
import { useMemo } from 'react';
import { getExternalCatalogMatches, type ExternalCatalogSource } from '@/lib/spectral';

type Props = {
  coordinates: { ra: number; dec: number };
  targetName: string;
  gaiaEnabled: boolean;
  wiseEnabled: boolean;
  onToggleGaia: () => void;
  onToggleWise: () => void;
  onSelectCoords: (ra: number, dec: number) => void;
};

export default function CatalogOverlay({
  coordinates,
  targetName,
  gaiaEnabled,
  wiseEnabled,
  onToggleGaia,
  onToggleWise,
  onSelectCoords,
}: Props) {
  const sources = useMemo(
    () => getExternalCatalogMatches(coordinates.ra, coordinates.dec, targetName),
    [coordinates.ra, coordinates.dec, targetName]
  );

  const activeSources = sources.filter(
    (s) => (s.mission === 'Gaia' && gaiaEnabled) || (s.mission === 'WISE' && wiseEnabled)
  );

  return (
    <div className="external-catalog-panel" aria-label="External Mission Cross-Reference (Gaia & WISE)">
      <div className="catalog-header">
        <div>
          <span className="eyebrow">EXTERNAL SURVEY MISSIONS</span>
          <h4>Multi-Mission Overlays</h4>
        </div>
        <div className="catalog-toggles">
          <button
            type="button"
            className={`catalog-pill gaia-pill ${gaiaEnabled ? 'active' : ''}`}
            aria-pressed={gaiaEnabled}
            onClick={onToggleGaia}
          >
            <span className="dot gaia-dot" /> Gaia DR3
          </button>
          <button
            type="button"
            className={`catalog-pill wise-pill ${wiseEnabled ? 'active' : ''}`}
            aria-pressed={wiseEnabled}
            onClick={onToggleWise}
          >
            <span className="dot wise-dot" /> WISE / AllWISE
          </button>
        </div>
      </div>

      {(gaiaEnabled || wiseEnabled) && (
        <div className="catalog-matches-list">
          {activeSources.map((src) => (
            <div key={src.designation} className={`catalog-match-card ${src.mission.toLowerCase()}-card`}>
              <div className="match-card-top">
                <span className={`mission-tag ${src.mission.toLowerCase()}`}>
                  {src.mission}
                </span>
                <strong className="match-name">{src.designation}</strong>
                <button
                  type="button"
                  className="match-jump-btn"
                  title="Target this catalog source"
                  onClick={() => onSelectCoords(src.ra, src.dec)}
                >
                  Target ↗
                </button>
              </div>
              <div className="match-card-body">
                <span>
                  Offset: <strong>{src.separationArcsec}″</strong>
                </span>
                <span>
                  Coords: {src.ra.toFixed(4)}°, {src.dec >= 0 ? '+' : ''}{src.dec.toFixed(4)}°
                </span>
                <span>
                  Photometry: <strong>{src.magnitude}</strong>
                </span>
                {src.parallaxMas && (
                  <span>
                    Parallax: <strong>{src.parallaxMas} mas</strong> (pm: {src.properMotionMasYr} mas/yr)
                  </span>
                )}
                {src.colorOrFilter && (
                  <span>
                    Color: <strong>{src.colorOrFilter}</strong>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
