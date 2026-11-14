'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MIN_ZOOM, MAX_ZOOM, type Camera, type Point } from '@/lib/sky';

type Props = {
  camera: Camera;
  frame: number;
  selected: number;
  bandCount: number;
  infrared: boolean;
  grid: boolean;
  name: string;
  objectType: string;
  coordinates?: { ra: number; dec: number };
  gaiaEnabled?: boolean;
  wiseEnabled?: boolean;
  recenterTrigger?: number;
  onCoordinatesChange?: (coords: { ra: number; dec: number }) => void;
  onZoom: (value: number, anchor?: Point) => void;
  onPan: (pan: Point) => void;
  onResize: (size: Point) => void;
};

const epochDates = [
  new Date('2025-06-01T00:00:00Z'),
  new Date('2025-12-01T00:00:00Z'),
  new Date('2026-06-01T00:00:00Z'),
  new Date('2026-12-01T00:00:00Z'),
  new Date('2027-06-01T00:00:00Z'),
  new Date('2027-12-01T00:00:00Z'),
];

let engineScriptPromise: Promise<any> | null = null;
function loadEngineScript(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Window not available'));
  if ((window as any).StelWebEngine) return Promise.resolve((window as any).StelWebEngine);
  if (engineScriptPromise) return engineScriptPromise;

  engineScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-stel-engine]');
    if (existing) {
      if ((window as any).StelWebEngine) {
        resolve((window as any).StelWebEngine);
      } else {
        existing.addEventListener('load', () => resolve((window as any).StelWebEngine));
        existing.addEventListener('error', reject);
      }
      return;
    }
    const script = document.createElement('script');
    script.src = '/stellarium/stellarium-web-engine.js';
    script.setAttribute('data-stel-engine', 'true');
    script.async = true;
    script.onload = () => resolve((window as any).StelWebEngine);
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });
  return engineScriptPromise;
}

function projectSkyToScreen(
  stel: any,
  raDeg: number,
  decDeg: number,
  width: number,
  height: number
): { x: number; y: number; visible: boolean } | null {
  if (!stel?.core?.observer) return null;

  try {
    const raRad = (raDeg * Math.PI) / 180;
    const decRad = (decDeg * Math.PI) / 180;
    const cx = Math.cos(decRad) * Math.cos(raRad);
    const cy = Math.cos(decRad) * Math.sin(raRad);
    const cz = Math.sin(decRad);

    const yaw = stel.core.observer.yaw;
    const pitch = stel.core.observer.pitch;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;

    // Pure JavaScript 3D rotation matrix from ICRF to camera VIEW frame
    // Rot_Z(-yaw) -> Rot_Y(pitch) -> R2GL coordinate mapping
    const cosYaw = Math.cos(-yaw), sinYaw = Math.sin(-yaw);
    const x1 = cosYaw * cx - sinYaw * cy;
    const y1 = sinYaw * cx + cosYaw * cy;
    const z1 = cz;

    const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
    const x2 = cosPitch * x1 + sinPitch * z1;
    const y2 = y1;
    const z2 = -sinPitch * x1 + cosPitch * z1;

    const vx = -y2;
    const vy = z2;
    const vz = -x2;

    // In VIEW frame: camera looks down along -Z (depth is -vz).
    // If vz >= -0.0001, the celestial point is behind the camera.
    if (vz >= -0.0001) {
      return { x: -9999, y: -9999, visible: false };
    }

    const aspect = width / height;
    const fov = stel.core.fov || (50 * Math.PI) / 180;
    const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
    const f = 1 / Math.tan(fovy / 2);

    const depth = -vz;
    const xNdc = (vx / depth) * (f / aspect);
    const yNdc = (vy / depth) * f;

    const screenX = ((xNdc + 1) / 2) * width;
    const screenY = ((-yNdc + 1) / 2) * height;

    const visible = screenX >= -250 && screenX <= width + 250 && screenY >= -250 && screenY <= height + 250;
    return { x: screenX, y: screenY, visible };
  } catch {
    return null;
  }
}

export default function SkyCanvas({
  camera,
  frame,
  bandCount,
  infrared,
  grid,
  name,
  objectType,
  coordinates = { ra: 269.4521, dec: 4.6934 },
  gaiaEnabled = false,
  wiseEnabled = false,
  recenterTrigger,
  onCoordinatesChange,
  onZoom,
  onPan,
  onResize,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stelRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [ready, setReady] = useState(false);
  const [reticlePos, setReticlePos] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });

  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;
  const onCoordinatesChangeRef = useRef(onCoordinatesChange);
  onCoordinatesChangeRef.current = onCoordinatesChange;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const cameraZoomRef = useRef(camera.zoom);
  cameraZoomRef.current = camera.zoom;
  const isUpdatingFromInternal = useRef(false);
  const isUserDragging = useRef(false);
  const animFrameRef = useRef<number | null>(null);
  const lastTargetCoords = useRef({ ra: -999, dec: -999 });

  const updateReticlePosition = useCallback(() => {
    const stel = stelRef.current;
    if (!stel?.core?.observer) return;
    const w = size.width > 1 ? size.width : (typeof window !== 'undefined' ? window.innerWidth : 800);
    const h = size.height > 1 ? size.height : (typeof window !== 'undefined' ? window.innerHeight : 600);
    const pos = projectSkyToScreen(stel, coordinates.ra, coordinates.dec, w, h);
    if (pos) {
      setReticlePos(pos);
    }
  }, [coordinates.ra, coordinates.dec, size.width, size.height]);

  const pointToTarget = (stel: any, coords: { ra: number; dec: number }) => {
    if (!stel?.core) return;
    const raRad = (coords.ra * Math.PI) / 180;
    const decRad = (coords.dec * Math.PI) / 180;
    const normYaw = raRad > Math.PI ? raRad - 2 * Math.PI : raRad;

    isUpdatingFromInternal.current = true;
    if (stel.core.observer) {
      stel.core.observer.yaw = normYaw;
      stel.core.observer.pitch = decRad;
    }
    setTimeout(() => {
      isUpdatingFromInternal.current = false;
      updateReticlePosition();
    }, 100);
  };

  const startDragLoop = () => {
    isUserDragging.current = true;
    const tick = () => {
      if (!isUserDragging.current) return;
      updateReticlePosition();
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  };

  const stopDragLoop = () => {
    isUserDragging.current = false;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    updateReticlePosition();
  };

  // Size observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const bounds = el.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setSize({ width: bounds.width, height: bounds.height });
        onResize({ x: bounds.width, y: bounds.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onResize]);

  // Initialize Stellarium Web Engine
  useEffect(() => {
    let active = true;
    const canvas = canvasRef.current;
    if (!canvas) return;

    loadEngineScript()
      .then((StelWebEngine) => {
        if (!active || !canvas) return;
        return StelWebEngine({
          wasmFile: '/stellarium/stellarium-web-engine.wasm',
          canvas,
          translateFn: (_domain: string, str: string) => str,
          onReady: (stel: any) => {
            if (!active) return;
            stelRef.current = stel;
            if (typeof window !== 'undefined') (window as any).__stel = stel;
            const core = stel.core;

            // Stop real-time clock drift (static telescope observation epochs)
            core.time_speed = 0;

            // Space survey telescope mode
            if (core.atmosphere) core.atmosphere.visible = false;
            if (core.landscapes) core.landscapes.visible = false;
            core.mount_frame = stel.FRAME_ICRF ?? 1;

            // Star field fidelity & brightness
            core.star_linear_scale = 1.6;
            core.star_relative_scale = 1.25;
            core.display_limit_mag = 12.0;

            if (core.milkyway) core.milkyway.visible = true;
            if (core.dsos) core.dsos.visible = true;
            if (core.constellations) {
              core.constellations.lines_visible = false;
              core.constellations.labels_visible = false;
            }
            if (core.lines?.azimuthal) core.lines.azimuthal.visible = false;
            if (core.lines?.equatorial) core.lines.equatorial.visible = grid;

            // Data sources
            const origin = window.location.origin;
            const baseUrl = `${origin}/skydata/`;
            try { core.stars?.addDataSource({ url: `${baseUrl}stars` }); } catch {}
            try { core.dsos?.addDataSource({ url: `${baseUrl}dso` }); } catch {}
            try { core.milkyway?.addDataSource({ url: `${baseUrl}surveys/milkyway` }); } catch {}
            try { core.skycultures?.addDataSource({ url: `${baseUrl}skycultures/western`, key: 'western' }); } catch {}

            // Fonts
            try {
              stel.setFont('regular', `${origin}/fonts/Roboto-Regular.ttf`, 1.38);
              stel.setFont('bold', `${origin}/fonts/Roboto-Bold.ttf`, 1.38);
            } catch {}

            // Observation epoch
            const epochDate = epochDates[frame] || epochDates[0];
            if (core.observer && typeof stel.date2MJD === 'function') {
              core.observer.utc = stel.date2MJD(epochDate);
            }

            // Initial Target pointing
            const coords = coordinatesRef.current;
            lastTargetCoords.current = { ra: coords.ra, dec: coords.dec };
            pointToTarget(stel, coords);

            // Initial FOV
            const fovRad = (50 / Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cameraZoomRef.current))) * (Math.PI / 180);
            core.fov = fovRad;

            // Listen to observer movements / drag and zoom changes
            stel.change((_obj: any, attr: string) => {
              if (attr === 'yaw' || attr === 'pitch') {
                updateReticlePosition();
                if (isUserDragging.current && !isUpdatingFromInternal.current && core.observer) {
                  let raDeg = ((core.observer.yaw * 180) / Math.PI) % 360;
                  if (raDeg < 0) raDeg += 360;
                  const decDeg = Math.max(-90, Math.min(90, (core.observer.pitch * 180) / Math.PI));
                  onCoordinatesChangeRef.current?.({ ra: raDeg, dec: decDeg });
                }
              } else if (attr === 'fov') {
                updateReticlePosition();
                if (!isUpdatingFromInternal.current && core.fov) {
                  const fovDeg = (core.fov * 180) / Math.PI;
                  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 50 / fovDeg));
                  if (Math.abs(newZoom - cameraZoomRef.current) > 0.05) {
                    onZoomRef.current(newZoom);
                  }
                }
              }
            });

            setReady(true);
            setTimeout(() => {
              updateReticlePosition();
            }, 50);
          },
        });
      })
      .catch((err) => {
        console.warn('Stellarium Web Engine loading notice:', err);
      });

    return () => {
      active = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [updateReticlePosition]);

  // Recenter trigger from parent
  useEffect(() => {
    const stel = stelRef.current;
    if (stel && recenterTrigger !== undefined && recenterTrigger > 0) {
      pointToTarget(stel, coordinates);
    }
  }, [recenterTrigger]);

  // Update observation epoch frame
  useEffect(() => {
    const stel = stelRef.current;
    if (stel?.core?.observer && typeof stel.date2MJD === 'function') {
      const epochDate = epochDates[frame] || epochDates[0];
      stel.core.observer.utc = stel.date2MJD(epochDate);
    }
    updateReticlePosition();
  }, [frame, updateReticlePosition]);

  // Update target coordinates
  useEffect(() => {
    const stel = stelRef.current;
    if (!stel) return;
    const diff = Math.hypot(coordinates.ra - lastTargetCoords.current.ra, coordinates.dec - lastTargetCoords.current.dec);
    if (diff > 0.001) {
      lastTargetCoords.current = { ra: coordinates.ra, dec: coordinates.dec };
      pointToTarget(stel, coordinates);
    } else {
      updateReticlePosition();
    }
  }, [coordinates.ra, coordinates.dec, updateReticlePosition]);

  // Update equatorial coordinate grid
  useEffect(() => {
    const stel = stelRef.current;
    if (stel?.core?.lines?.equatorial) {
      stel.core.lines.equatorial.visible = grid;
    }
  }, [grid]);

  // Update FOV / Zoom from rotor / buttons
  useEffect(() => {
    const stel = stelRef.current;
    if (stel?.core) {
      const fovRad = (50 / Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom))) * (Math.PI / 180);
      if (Math.abs((stel.core.fov || 0) - fovRad) > 0.005) {
        isUpdatingFromInternal.current = true;
        if (typeof stel.zoomTo === 'function') {
          stel.zoomTo(fovRad, 0.1);
        } else {
          stel.core.fov = fovRad;
        }
        setTimeout(() => {
          isUpdatingFromInternal.current = false;
          updateReticlePosition();
        }, 150);
      }
    }
  }, [camera.zoom, updateReticlePosition]);

  // Proper motion offset across epochs for high proper-motion sources
  const offsetX = (frame - 2.5) * 4;
  const offsetY = -(frame - 2.5) * 2;
  const labelX = (reticlePos.x || (size.width || 800) * 0.5) + offsetX;
  const labelY = (reticlePos.y || (size.height || 600) * 0.5) + offsetY;
  const isVisible = reticlePos.visible;

  // Dynamic distance-aware scaling: marker scales down as you pan or zoom away from the target
  const vpWidth = size.width > 1 ? size.width : 800;
  const vpHeight = size.height > 1 ? size.height : 600;
  const centerX = vpWidth * 0.5;
  const centerY = vpHeight * 0.5;
  const distFromCenter = Math.hypot(labelX - centerX, labelY - centerY);
  const maxCenterDist = Math.hypot(centerX, centerY) || 1;
  const distRatio = Math.min(1.0, distFromCenter / maxCenterDist);

  // Pan distance factor: 1.0 at center down to 0.55 near the edge
  const panScaleFactor = 1.0 - 0.45 * distRatio;

  // Zoom distance factor: scales down when zooming out into wide sky view
  const zoomScaleFactor = Math.max(0.65, Math.min(1.15, 0.75 + 0.25 * camera.zoom));

  // Combined marker scale factor clamped between 0.40 and 1.15
  const markerScale = Math.max(0.4, Math.min(1.15, panScaleFactor * zoomScaleFactor));

  return (
    <div
      ref={containerRef}
      className="stel-container"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        id="stel-canvas"
        className="stel-canvas sky-canvas"
        aria-label="Stellarium sky map. Drag to pan, scroll to zoom."
        onPointerDown={startDragLoop}
        onPointerUp={stopDragLoop}
        onPointerCancel={stopDragLoop}
        onMouseLeave={stopDragLoop}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          filter: infrared
            ? `contrast(1.15) brightness(${0.92 + (bandCount / 102) * 0.25}) sepia(0.65) hue-rotate(305deg) saturate(1.5)`
            : 'none',
          transition: 'filter 0.3s ease',
        }}
      />
      <div
        id="object-label"
        className="object-label"
        style={{
          left: labelX - 21,
          top: labelY - 21,
          display: isVisible ? 'flex' : 'none',
          pointerEvents: 'none',
          transformOrigin: '21px 21px',
          transform: `scale(${markerScale.toFixed(3)})`,
          transition: isUserDragging.current ? 'none' : 'transform 0.18s ease-out',
        }}
      >
        <span className="crosshair" />
        <div
          style={{
            opacity: Math.max(0.65, Math.min(1, markerScale * 1.1)),
            transition: 'opacity 0.18s ease-out',
          }}
        >
          <span className="object-type">{objectType}</span>
          <strong>{name}</strong>
          <small>Follow the star. See the difference.</small>
        </div>
      </div>
      {gaiaEnabled && (
        <div
          className="catalog-pin gaia-pin"
          style={{
            left: labelX - 52 * markerScale,
            top: labelY - 42 * markerScale,
            display: isVisible ? 'flex' : 'none',
            transformOrigin: 'center center',
            transform: `scale(${markerScale.toFixed(3)})`,
            transition: isUserDragging.current ? 'none' : 'transform 0.18s ease-out',
          }}
          title="Gaia DR3 Optical Astrometry Counterpart"
        >
          <span className="catalog-pin-dot gaia-dot" />
          <span className="catalog-pin-text">Gaia DR3</span>
        </div>
      )}
      {wiseEnabled && (
        <div
          className="catalog-pin wise-pin"
          style={{
            left: labelX + 46 * markerScale,
            top: labelY + 34 * markerScale,
            display: isVisible ? 'flex' : 'none',
            transformOrigin: 'center center',
            transform: `scale(${markerScale.toFixed(3)})`,
            transition: isUserDragging.current ? 'none' : 'transform 0.18s ease-out',
          }}
          title="AllWISE Mid-Infrared Counterpart"
        >
          <span className="catalog-pin-dot wise-dot" />
          <span className="catalog-pin-text">WISE</span>
        </div>
      )}
    </div>
  );
}
