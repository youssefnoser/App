'use client';
// Gaia DR3 markers over the sky canvas. Each source is moved from J2016.0 to the date
// of the frame on screen (or today) before it is projected, so a fast mover's ring
// sits on the star in every blink frame. Fast movers also get an arrow along their motion.
import { useState } from 'react';
import { projectSkyToScreen } from '@/lib/projection';
import { markerKind, mjdNow, propagate, tooltipLines, type GaiaSource } from '@/shared/gaia.js';

type Props = {
  stel: any;
  width: number;
  height: number;
  viewTick: number; // changes whenever the view moves, to re-project
  sources: GaiaSource[];
  observationMjd?: number;
  onRecentre: (ra: number, dec: number) => void;
};

const ARROW_PX = 24;

/** Ring diameter in px: brighter (smaller G) is bigger; unknown brightness is smallest. */
function ringSize(gmag: number | null): number {
  if (gmag === null || !Number.isFinite(gmag)) return 8;
  return Math.max(8, Math.min(22, 22 - 1.2 * (gmag - 8)));
}

export default function GaiaOverlay({ stel, width, height, sources, observationMjd, onRecentre }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  if (!stel || width <= 1 || height <= 1) return null;
  const mjd = observationMjd ?? mjdNow();

  const markers = sources.flatMap(src => {
    const pos = propagate(src, mjd);
    const at = projectSkyToScreen(stel, pos.ra, pos.dec, width, height);
    if (!at || !at.visible) return [];
    const kind = markerKind(src);
    let arrow: { dx: number; dy: number } | null = null;
    if (kind === 'fast') {
      const later = propagate(src, mjd + 365.25);
      const next = projectSkyToScreen(stel, later.ra, later.dec, width, height);
      if (next) {
        const dx = next.x - at.x, dy = next.y - at.y, len = Math.hypot(dx, dy);
        if (len > 0.01) arrow = { dx: dx / len * ARROW_PX, dy: dy / len * ARROW_PX };
      }
    }
    return [{ src, pos, x: at.x, y: at.y, kind, size: ringSize(src.gmag), arrow }];
  });

  const hover = markers.find(m => m.src.source_id === hovered);

  return (
    <div className="gaia-overlay" aria-label="Gaia DR3 stars">
      <svg className="gaia-arrows" width={width} height={height} aria-hidden="true">
        {markers.filter(m => m.arrow).map(m => (
          <line
            key={m.src.source_id}
            x1={m.x + m.arrow!.dx * (m.size / 2 / ARROW_PX)}
            y1={m.y + m.arrow!.dy * (m.size / 2 / ARROW_PX)}
            x2={m.x + m.arrow!.dx * (1 + m.size / 2 / ARROW_PX)}
            y2={m.y + m.arrow!.dy * (1 + m.size / 2 / ARROW_PX)}
            markerEnd="url(#gaia-arrowhead)"
          />
        ))}
        <defs>
          <marker id="gaia-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
      </svg>
      {markers.map(m => {
        const lines = tooltipLines(m.src);
        return (
          <button
            key={m.src.source_id}
            type="button"
            className={`gaia-marker gaia-${m.kind}`}
            style={{ left: m.x - m.size / 2, top: m.y - m.size / 2, width: m.size, height: m.size }}
            aria-label={`${lines[0]}, ${lines[1]}. Click to centre the view on it.`}
            onPointerEnter={() => setHovered(m.src.source_id)}
            onPointerLeave={() => setHovered(h => (h === m.src.source_id ? null : h))}
            onFocus={() => setHovered(m.src.source_id)}
            onBlur={() => setHovered(h => (h === m.src.source_id ? null : h))}
            onClick={() => onRecentre(m.pos.ra, m.pos.dec)}
          />
        );
      })}
      {hover && (
        <div
          className="gaia-tooltip"
          role="tooltip"
          style={{
            left: Math.min(hover.x + hover.size / 2 + 8, width - 260),
            top: Math.max(8, hover.y - 12),
          }}
        >
          {tooltipLines(hover.src).map(line => <div key={line}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
