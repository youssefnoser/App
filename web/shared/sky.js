// Stellarium Web Engine setup, shared by index.html and the Next.js app: SPHEREx
// all-sky cube as the background, an equatorial mount so celestial north is up,
// and the view read and set in catalogue RA/Dec (degrees). No pixel data passes
// through here.

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
// Both pages serve the engine build at /engine/: FastAPI from
// vendor/stellarium-web-engine/build, Next.js from web/public/engine
// (copied there by `npm run sync-engine`).
export const ENGINE_SCRIPT = '/engine/stellarium-web-engine.js';
const WASM = '/engine/stellarium-web-engine.wasm';
const DEFAULT_FRAME = 90;

// src/frames.h: FRAME_ICRF = 1. core_update_mount() (src/navigation.c) maps it
// to ro2m = rh2i, so the mount frame is CIRS (celestial pole up) instead of alt/az.
const MOUNT_EQUATORIAL = 1;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Make sure the engine script has run. index.html loads it with a script tag,
 * so this resolves at once there; the Next.js app has no such tag and adds one.
 * Rejects if the script cannot be fetched.
 */
export function loadEngine(src = ENGINE_SCRIPT, { win = globalThis.window, doc = globalThis.document } = {}) {
  if (typeof win?.StelWebEngine === 'function') return Promise.resolve(win.StelWebEngine);
  return new Promise((resolve, reject) => {
    let script = doc.querySelector('script[data-stel-engine]');
    if (!script) {
      script = doc.createElement('script');
      script.src = src;
      script.dataset.stelEngine = '';
      doc.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(win.StelWebEngine), { once: true });
    script.addEventListener('error', () => reject(new Error('Stellarium Web Engine script did not load.')), { once: true });
  });
}

/**
 * Start the engine on `canvas`. Resolves once the engine is ready.
 * Rejects if the engine script is missing or WebGL cannot start.
 * @returns {Promise<{stel, core, layer, viewCentre: () => {ra:number, dec:number},
 *   fovDeg: () => number, flyTo: (ra:number, dec:number, fovDeg?:number) => void,
 *   toScreen: (ra:number, dec:number, width:number, height:number) =>
 *     {x:number, y:number, visible:boolean}}>}
 */
export async function initSky(canvas, { frame = DEFAULT_FRAME } = {}) {
  const StelWebEngine = await loadEngine();
  // A throw from StelWebEngine itself rejects through the executor; onReady runs
  // later, outside it, so it catches its own.
  return new Promise((resolve, reject) => {
    StelWebEngine({
      wasmFile: WASM,
      canvas,
      onReady: (stel) => {
        try {
          resolve(makeSky(stel, frame));
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

export function makeSky(stel, frame) {
  const core = stel.core;
  // Atmosphere off also fades refraction to zero (core.c update_refraction), so
  // the mount frame is exactly CIRS and viewCentre() needs no refraction term.
  core.atmosphere.visible = false;
  core.landscapes.visible = false;
  core.mount_frame = MOUNT_EQUATORIAL;
  core.dss.addDataSource({ url: HIPS });
  core.dss.frame = frame;
  const layer = stel.createLayer({ id: 'spherex-frames', z: 7, visible: true });

  // Catalogue coordinates live in the engine's ASTROM frame: the HiPS survey
  // (hips.c) and our photos (photos.c) are both drawn there. The engine's ICRF
  // frame is apparent (aberrated, up to 20 arcsec off), so we convert via ASTROM.
  const viewCentre = () => {
    const mount = stel.s2c(core.observer.yaw, core.observer.pitch);
    const astrom = stel.convertFrame(stel.observer, 'CIRS', 'ASTROM', mount);
    const [theta, phi] = stel.c2s(astrom);
    return { ra: stel.anp(theta) * R2D, dec: phi * R2D };
  };

  const fovDeg = () => core.fov * R2D;

  const flyTo = (ra, dec, fov) => {
    const astrom = stel.s2c(ra * D2R, dec * D2R);
    const mount = stel.convertFrame(stel.observer, 'ASTROM', 'CIRS', astrom);
    stel.lookAt(mount, 0);
    if (fov) stel.zoomTo(fov * D2R, 0);
  };

  // Canvas position (CSS pixels, row 0 at the top) of a catalogue position.
  const toScreen = (ra, dec, width, height) => {
    const view = stel.convertFrame(stel.observer, 'ASTROM', 'VIEW', stel.s2c(ra * D2R, dec * D2R));
    return projectView(view, core.fov, width, height);
  };

  return { stel, core, layer, viewCentre, fovDeg, flyTo, toScreen };
}

// Window position of a VIEW-frame direction (the viewer looks down -z, +y up),
// following the engine's stereographic projection: proj_stereographic.c for the
// projection and fov split, projection.c project_to_win() for the window maths.
// `fov` (radians) is core.fov, the field across the shorter canvas side.
// A point counts as visible up to 250 px outside the canvas, so a marker
// sliding off the edge stays drawn until it is gone. The antipode of the view
// axis projects to infinity (or NaN), which fails that test.
export function projectView(v, fov, width, height) {
  const norm = Math.hypot(v[0], v[1], v[2]);
  const [x, y, z] = [v[0] / norm, v[1] / norm, v[2] / norm];
  const aspect = width / height;
  const fovy = aspect < 1 ? 4 * Math.atan(Math.tan(fov / 4) / aspect) : fov;
  const h = 0.5 * (1 - z);
  const scale = 2 * Math.tan(fovy / 4); // proj_stereographic_init: fovy2 = 2 atan(2 tan(fovy/4))
  const ndcX = x / h / (scale * aspect);
  const ndcY = y / h / scale;
  const px = ((ndcX + 1) / 2) * width;
  const py = ((-ndcY + 1) / 2) * height;
  const margin = 250;
  const visible = px >= -margin && px <= width + margin && py >= -margin && py <= height + margin;
  return { x: px, y: py, visible };
}
