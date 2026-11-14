'use client';
// Sky view for the Next.js app. The engine is started and driven exactly as in
// index.html: js/sky.js initSky() sets it up, the engine owns the view (drag and
// wheel move it directly), and the page only reads the view back or sends an
// explicit command (`goto`). Frames load through js/backend-sky.js.
import { useCallback, useEffect, useRef, useState } from 'react';
import { initSky, type Sky } from '@/shared/sky.js';
import { createBackendSky, type BackendTimeline, type LoadProgress } from '@/shared/backend-sky.js';
import { sequenceWindows } from '@/lib/backend-bands';
import GaiaOverlay from './GaiaOverlay';
import type { GaiaSource } from '@/shared/gaia.js';

export type SkyView = { ra: number; dec: number; fovDeg: number };
// A command to move the view. A new `id` runs it once; without ra/dec it keeps
// the current centre (a zoom), without fovDeg it keeps the current zoom.
// `retry` also asks the backend again for this spot.
export type SkyGoto = { id: number; ra?: number; dec?: number; fovDeg?: number; retry?: boolean };

type Props = {
  goto: SkyGoto;
  target: { ra: number; dec: number };
  frame: number;
  bands: number[];
  sequenceWavelength?: number;
  sequenceWidth: number;
  onTimeline: (timeline: BackendTimeline) => void;
  // Only when the sky view cannot start; frame loading reports through onProgress.
  onStatus: (status: string) => void;
  onProgress: (progress: LoadProgress) => void;
  onView: (view: SkyView) => void;
  showFrames: boolean;
  grid: boolean;
  name: string;
  objectType: string;
  gaiaEnabled: boolean;
  // Gaia DR3 stars for the overlay, moved to the date of the frame on screen.
  gaiaSources?: GaiaSource[];
  observationMjd?: number;
  onRecentre?: (ra: number, dec: number) => void;
  wiseEnabled: boolean;
};

// Next.js-only display choices on top of the shared setup: no planets (the only
// built-in layer that draws without a data source), and fonts for the labels of
// the equatorial grid, which the grid button toggles.
function applyExplorerLayers(sky: Sky) {
  sky.core.planets.visible = false;
  sky.stel.setFont('regular', '/fonts/Roboto-Regular.ttf');
  sky.stel.setFont('bold', '/fonts/Roboto-Bold.ttf');
}

export default function SkyCanvas({
  goto,
  target,
  frame,
  bands,
  sequenceWavelength,
  sequenceWidth,
  onTimeline,
  onStatus,
  onProgress,
  onView,
  showFrames,
  grid,
  name,
  objectType,
  gaiaEnabled,
  gaiaSources = [],
  observationMjd,
  onRecentre,
  wiseEnabled,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<Sky | null>(null);
  const backendRef = useRef<ReturnType<typeof createBackendSky> | null>(null);
  const callbacks = useRef({ onTimeline, onStatus, onProgress, onView });
  callbacks.current = { onTimeline, onStatus, onProgress, onView };
  const targetRef = useRef(target);
  targetRef.current = target;
  const backgroundFrame = Math.max(0, (bands[0] ?? 1) - 1);
  const backgroundFrameRef = useRef(backgroundFrame);
  backgroundFrameRef.current = backgroundFrame;
  const [ready, setReady] = useState(false);
  const [marker, setMarker] = useState({ x: 0, y: 0, visible: false, fovDeg: 5 / 60, width: 800, height: 600 });

  const placeMarker = useCallback(() => {
    const sky = skyRef.current, canvas = canvasRef.current;
    if (!sky || !canvas) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const { ra, dec } = targetRef.current;
    const p = sky.toScreen(ra, dec, width, height);
    setMarker({ ...p, fovDeg: sky.fovDeg(), width, height });
  }, []);

  // Start the engine once.
  useEffect(() => {
    let active = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    initSky(canvas, { frame: backgroundFrameRef.current })
      .then((sky) => {
        if (!active) return;
        skyRef.current = sky;
        (window as any).__sky = sky;
        (window as any).__stel = sky.stel;
        applyExplorerLayers(sky);
        backendRef.current = createBackendSky(sky, {
          onTimeline: (timeline) => callbacks.current.onTimeline(timeline),
          // Loading progress goes to the timeline and zoom ruler, not the message line.
          onProgress: (progress) => callbacks.current.onProgress(progress),
          // Called on every animation frame in which the view moved.
          onView: (centre) => {
            placeMarker();
            callbacks.current.onView({ ...centre, fovDeg: sky.fovDeg() });
          },
        });
        setReady(true);
      })
      .catch((err) => {
        callbacks.current.onStatus('The sky view could not start. This page needs a browser with WebGL. Reload to try again.');
        console.warn('Stellarium Web Engine did not start:', err);
      });
    return () => {
      active = false;
      backendRef.current?.destroy();
      backendRef.current = null;
      skyRef.current = null;
    };
  }, [placeMarker]);

  // Run each view command once, as soon as the engine is ready.
  const doneGoto = useRef(-1);
  useEffect(() => {
    const sky = skyRef.current;
    if (!ready || !sky || goto.id === doneGoto.current) return;
    doneGoto.current = goto.id;
    const centre = goto.ra != null && goto.dec != null ? { ra: goto.ra, dec: goto.dec } : sky.viewCentre();
    sky.flyTo(centre.ra, centre.dec, goto.fovDeg);
    if (goto.retry) backendRef.current?.retry();
  }, [goto, ready]);

  useEffect(() => { placeMarker(); }, [target.ra, target.dec, ready, placeMarker]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => placeMarker());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [placeMarker]);

  useEffect(() => { backendRef.current?.showFrame(frame); }, [frame, ready]);
  const bandKey = bands.join(',');
  useEffect(() => {
    backendRef.current?.setBands(sequenceWindows(bands, sequenceWavelength, sequenceWidth), backgroundFrame);
  }, [bandKey, sequenceWavelength, sequenceWidth, backgroundFrame, ready]);
  useEffect(() => { backendRef.current?.setVisible(showFrames); }, [showFrames, ready]);
  useEffect(() => {
    if (skyRef.current) skyRef.current.core.lines.equatorial.visible = grid;
  }, [grid, ready]);

  // The marker shrinks as it moves away from the centre and as the view widens.
  const centreX = marker.width / 2, centreY = marker.height / 2;
  const edge = Math.min(1, Math.hypot(marker.x - centreX, marker.y - centreY) / Math.hypot(centreX, centreY));
  const zoom = (5 / 60) / marker.fovDeg; // 1 at a 5 arcmin view
  const zoomScale = Math.max(0.65, Math.min(1.15, 0.75 + 0.25 * zoom));
  const markerScale = Math.max(0.4, Math.min(1.15, (1 - 0.45 * edge) * zoomScale));
  const display = marker.visible ? 'flex' : 'none';

  return (
    <div className="stel-container" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        id="stel-canvas"
        className="stel-canvas sky-canvas"
        aria-label="Sky view. Drag to pan, scroll to zoom."
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
      <div
        id="object-label"
        className="object-label"
        style={{
          left: marker.x - 21,
          top: marker.y - 21,
          display,
          pointerEvents: 'none',
          transformOrigin: '21px 21px',
          transform: `scale(${markerScale.toFixed(3)})`,
        }}
      >
        <span className="crosshair" />
        <div style={{ opacity: Math.max(0.65, Math.min(1, markerScale * 1.1)) }}>
          <span className="object-type">{objectType}</span>
          <strong>{name}</strong>
          <small>Follow the star. See the difference.</small>
        </div>
      </div>
      {gaiaEnabled && gaiaSources.length > 0 && skyRef.current && (
        <GaiaOverlay
          toScreen={skyRef.current.toScreen}
          width={marker.width}
          height={marker.height}
          sources={gaiaSources}
          observationMjd={observationMjd}
          onRecentre={(ra, dec) => onRecentre?.(ra, dec)}
        />
      )}
      {wiseEnabled && (
        <div
          className="catalog-pin wise-pin"
          style={{ left: marker.x + 46 * markerScale, top: marker.y + 34 * markerScale, display, transformOrigin: 'center center', transform: `scale(${markerScale.toFixed(3)})` }}
          title="AllWISE Mid-Infrared Counterpart"
        >
          <span className="catalog-pin-dot wise-dot" />
          <span className="catalog-pin-text">WISE</span>
        </div>
      )}
    </div>
  );
}
