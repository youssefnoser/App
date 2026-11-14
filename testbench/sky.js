// Stellarium Web Engine setup: SPHEREx all-sky cube as the background, an
// equatorial mount so celestial north is up, and the view read and set in
// catalogue RA/Dec (degrees). No pixel data passes through here.

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const WASM = '/engine/stellarium-web-engine.wasm';
const DEFAULT_FRAME = 90;

// src/frames.h: FRAME_ICRF = 1. core_update_mount() (src/navigation.c) maps it
// to ro2m = rh2i, so the mount frame is CIRS (celestial pole up) instead of alt/az.
const MOUNT_EQUATORIAL = 1;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Start the engine on `canvas`. Resolves once the engine is ready.
 * Rejects if the engine script is missing or WebGL cannot start.
 * @returns {Promise<{stel, core, layer, viewCentre: () => {ra:number, dec:number},
 *   fovDeg: () => number, flyTo: (ra:number, dec:number, fovDeg:number) => void}>}
 */
export function initSky(canvas, { frame = DEFAULT_FRAME } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window.StelWebEngine !== 'function') {
      reject(new Error('Stellarium Web Engine script did not load.'));
      return;
    }
    try {
      window.StelWebEngine({
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
    } catch (err) {
      reject(err);
    }
  });
}

function makeSky(stel, frame) {
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

  return { stel, core, layer, viewCentre, fovDeg, flyTo };
}
