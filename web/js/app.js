// Page wiring: the sky view, view-following frame loading, the blink player,
// the coordinate box, the background wavelength slider and the URL hash.
// Pixels are drawn by the engine from server PNGs (NaN is already alpha 0
// there), so nothing in this file touches pixel values.

import { initSky } from './sky.js';
import { Loader, priorityList } from './queue.js';
import { buildSteps, keepStep } from './timeline.js';
import { PhotoCache } from './photos.js';
import { parseHash, toHash } from './state.js';

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const LOAD_FOV_DEG = 0.5; // frames load only below this field of view
const SETTLE_MS = 300; // and once the view has been still this long
const MAX_VIEW_FOV_DEG = 1.0; // /api/view rejects anything wider
const PIXSCALE_ARCSEC = 3.075;
const BLINK_MS = 500;
const TARGET_FOV_DEG = 0.15; // field of view a target button flies to
const GO_FOV_DEG = 0.25; // field of view after Go when zoomed out too far to load

const COPY = {
  hint: 'Zoom in to load SPHEREx frames for this part of the sky.',
  loading: (done, total) => `Loading frames for this spot: ${done} of ${total}.`,
  loaded: (total) => `All ${total} frames for this spot are loaded.`,
  none: 'SPHEREx has no exposures here yet. The background map is still shown.',
  failed: (n) => `IRSA did not answer for ${n} ${n === 1 ? 'frame' : 'frames'}. Try again.`,
  finding: 'Finding SPHEREx exposures for this spot.',
  viewFailed: 'IRSA did not answer. Try again in a moment.',
  noEngine: 'The sky view could not start. This page needs a browser with WebGL.',
};

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('sky'),
  form: $('goto'),
  ra: $('ra'),
  dec: $('dec'),
  gotoError: $('goto-error'),
  zoomIn: $('zoom-in'),
  zoomOut: $('zoom-out'),
  prev: $('prev'),
  play: $('play'),
  next: $('next'),
  stepInfo: $('step-info'),
  wl: $('wl'),
  wlOut: $('wl-out'),
  status: $('status'),
  failed: $('failed'),
  failedText: $('failed-text'),
  retry: $('retry'),
};

const app = {
  ready: false,
  sky: null,
  loader: null,
  photos: null,
  view: null, // last /api/view response
  viewState: 'idle', // idle | finding | ready | failed
  steps: [],
  stepIndex: 0,
  wantedUri: null, // step asked for by the URL hash, shown once it loads
  centres: new Map(), // pix -> {ra, dec}, kept across views
  meta: new Map(), // `${pix}|${uri}` -> X-Frame-Meta
  timer: null,
};
window.app = app;

// A view in stack mode names, per exposure, the cell whose exposure list defines its
// visit median. The same uri then always maps to the same image address.
const stackOf = new Map();
const frameUrl = (pix, uri) => {
  const stack = stackOf.has(uri) ? `&stack=${stackOf.get(uri)}` : '';
  return new URL(`/api/patch/${pix}/frame.png?uri=${encodeURIComponent(uri)}${stack}`,
    location.href).href;
};

const round = (x, digits) => Number(x.toFixed(digits));

// ---------------------------------------------------------------- loading

async function fetchFrame(item, signal) {
  const res = await fetch(frameUrl(item.pix, item.uri), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Read the body so the PNG sits in the HTTP cache before the engine asks for it.
  await res.arrayBuffer();
  try {
    return JSON.parse(res.headers.get('X-Frame-Meta') || 'null');
  } catch {
    return null;
  }
}

function onLoaded(item, meta) {
  if (meta) app.meta.set(item.key, meta);
  const centre = app.centres.get(item.pix);
  if (centre) {
    const photo = app.photos.ensure(item.pix, item.uri, frameUrl(item.pix, item.uri), {
      ra: centre.ra,
      dec: centre.dec,
      orientation: 0,
      pixscale: PIXSCALE_ARCSEC,
    });
    // ensure() adds photos hidden; show it if it belongs to the current step.
    photo.visible = item.uri === currentUri();
  }
  if (item.uri === app.wantedUri) {
    const index = app.steps.findIndex((s) => s.uri === item.uri);
    app.wantedUri = null;
    if (index !== -1) showStep(index);
  } else if (!stepHasFrames(app.stepIndex) && onScreen().has(item.pix)) {
    // Nothing to show yet at the current step: jump to the earliest step that has frames.
    const loaded = loadedStepIndices();
    if (loaded.length) showStep(loaded[0]);
  }
  render();
}

function onFailed() {
  render();
}

function onScreen() {
  const out = new Set();
  for (const c of app.view?.cells ?? []) if (c.ring === 0) out.add(c.pix);
  return out;
}

function nearby() {
  const out = new Set();
  for (const c of app.view?.cells ?? []) if (c.ring <= 1) out.add(c.pix);
  return out;
}

function currentUri() {
  return app.steps[app.stepIndex]?.uri ?? null;
}

// Uris with at least one loaded frame on screen.
function loadedUris() {
  const screen = onScreen();
  const uris = new Set();
  for (const item of app.loader.done.values()) if (screen.has(item.pix)) uris.add(item.uri);
  return uris;
}

function loadedStepIndices() {
  const uris = loadedUris();
  const out = [];
  app.steps.forEach((s, i) => {
    if (uris.has(s.uri)) out.push(i);
  });
  return out;
}

function stepHasFrames(index) {
  const uri = app.steps[index]?.uri;
  if (!uri) return false;
  for (const pix of onScreen()) if (app.loader.done.has(`${pix}|${uri}`)) return true;
  return false;
}

let viewAbort = null;
let lastRequest = null;

async function requestView(centre, fov) {
  const canvas = el.canvas;
  // Ask for the circle that holds the whole screen, not just its short side.
  const diag = Math.hypot(canvas.clientWidth, canvas.clientHeight) /
    Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight));
  const viewFov = Math.min(MAX_VIEW_FOV_DEG, fov * diag);
  lastRequest = { ...centre, fov };
  if (viewAbort) viewAbort.abort();
  const controller = new AbortController();
  viewAbort = controller;
  app.viewState = 'finding';
  render();
  const qs = `ra=${round(centre.ra, 5)}&dec=${round(centre.dec, 5)}&fov=${round(viewFov, 4)}&stack=1`;
  let view;
  try {
    const res = await fetch(`/api/view?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    view = await res.json();
  } catch (err) {
    if (controller.signal.aborted) return;
    app.viewState = 'failed';
    lastRequest = null; // let the next settle or Try again ask again
    render();
    return;
  }
  if (controller.signal.aborted) return;
  viewAbort = null;
  applyView(view);
}

function applyView(view) {
  app.view = view;
  app.viewState = 'ready';
  for (const c of view.cells) app.centres.set(c.pix, { ra: c.ra, dec: c.dec });
  for (const e of view.exposures) {
    if (e.stack != null && !stackOf.has(e.uri)) stackOf.set(e.uri, e.stack);
  }

  const newSteps = buildSteps(view.exposures);
  const index = app.steps.length ? keepStep(app.steps, newSteps, app.stepIndex) : 0;
  if (!app.steps.length && app.wantedStep != null && newSteps.length) {
    app.wantedUri = newSteps[Math.min(app.wantedStep, newSteps.length - 1)].uri;
    app.wantedStep = null;
  }
  app.steps = newSteps;
  app.stepIndex = Math.min(index, Math.max(0, newSteps.length - 1));

  app.loader.cancelOutside(nearby());
  const have = new Set(app.loader.done.keys());
  app.loader.setQueue(priorityList(view, have));
  showStep(app.stepIndex);
  render();
}

function pauseLoading() {
  if (viewAbort) {
    viewAbort.abort();
    viewAbort = null;
  }
  lastRequest = null;
  app.viewState = app.view ? 'ready' : 'idle';
  app.loader.setQueue([]);
}

// ---------------------------------------------------------------- blink

function showStep(index) {
  const step = app.steps[index];
  if (!step) {
    app.photos.showOnly(null);
    render();
    return;
  }
  app.stepIndex = index;
  // Photos dropped by the cache cap come back from the HTTP cache.
  const centres = app.centres;
  for (const pix of nearby()) {
    const key = `${pix}|${step.uri}`;
    const centre = centres.get(pix);
    if (centre && app.loader.done.has(key)) {
      app.photos.ensure(pix, step.uri, frameUrl(pix, step.uri), {
        ra: centre.ra,
        dec: centre.dec,
        orientation: 0,
        pixscale: PIXSCALE_ARCSEC,
      });
    }
  }
  app.photos.showOnly(step.uri);
  writeHash();
  render();
}

function stepBy(delta) {
  const loaded = loadedStepIndices();
  if (!loaded.length) return;
  let pos = loaded.indexOf(app.stepIndex);
  if (pos === -1) {
    // Current step has no frames: go to the nearest loaded one in that direction.
    pos = delta > 0 ? loaded.findIndex((i) => i > app.stepIndex) : -1;
    if (delta > 0) pos = pos === -1 ? 0 : pos;
    else {
      const before = loaded.filter((i) => i < app.stepIndex);
      pos = before.length ? loaded.indexOf(before[before.length - 1]) : loaded.length - 1;
    }
    showStep(loaded[pos]);
    return;
  }
  showStep(loaded[(pos + delta + loaded.length) % loaded.length]);
}

function setPlaying(on) {
  if (on && !app.timer) {
    app.timer = setInterval(() => stepBy(1), BLINK_MS);
  } else if (!on && app.timer) {
    clearInterval(app.timer);
    app.timer = null;
  }
  el.play.textContent = app.timer ? 'Pause blink' : 'Play blink';
}

// ---------------------------------------------------------------- status

function render() {
  if (!app.ready) return;
  const fov = app.sky.fovDeg();
  const stats = app.loader.stats;
  let status;
  if (fov >= LOAD_FOV_DEG) status = COPY.hint;
  else if (app.viewState === 'finding') status = COPY.finding;
  else if (app.viewState === 'failed') status = COPY.viewFailed;
  else if (app.view && app.view.exposures.length === 0) status = COPY.none;
  else if (app.view && stats.total > 0 && stats.done + stats.failed >= stats.total) status = COPY.loaded(stats.done);
  else if (app.view) status = COPY.loading(stats.done, stats.total);
  else status = COPY.hint;
  if (el.status.textContent !== status) el.status.textContent = status;

  const viewFailed = app.viewState === 'failed' && fov < LOAD_FOV_DEG;
  const showFailed = viewFailed || stats.failed > 0;
  el.failed.hidden = !showFailed;
  if (showFailed) {
    el.failedText.textContent = viewFailed ? '' : COPY.failed(stats.failed);
    el.failedText.hidden = viewFailed;
  }

  const step = app.steps[app.stepIndex];
  const loaded = app.steps.length ? loadedStepIndices() : [];
  let info = '';
  if (step && stepHasFrames(app.stepIndex)) {
    const meta = metaFor(step.uri);
    const wl = meta ? `, ${meta.wavelength_um.toFixed(2)} micron` : '';
    const what = meta && meta.stack
      ? `Median of ${meta.stack} exposures around ${step.date}`
      : step.date;
    info = `Frame ${loaded.indexOf(app.stepIndex) + 1} of ${loaded.length} loaded. ` +
      `${what}, detector ${step.detector}${wl}.`;
  } else if (loaded.length) {
    info = `${loaded.length} frames loaded. This step has none on screen.`;
  }
  if (el.stepInfo.textContent !== info) el.stepInfo.textContent = info;
  const canBlink = loaded.length >= 2;
  el.play.disabled = !canBlink && !app.timer;
  el.prev.disabled = !loaded.length;
  el.next.disabled = !loaded.length;
}

// Wavelength at the view-centre patch if it is loaded, else any loaded patch.
function metaFor(uri) {
  const centreKey = `${app.view?.cell}|${uri}`;
  if (app.meta.has(centreKey)) return app.meta.get(centreKey);
  for (const pix of onScreen()) {
    const m = app.meta.get(`${pix}|${uri}`);
    if (m) return m;
  }
  return null;
}

// ---------------------------------------------------------------- hash

function writeHash() {
  if (!app.ready) return;
  const c = app.sky.viewCentre();
  const hash = toHash({
    ra: round(c.ra, 4),
    dec: round(c.dec, 4),
    fov: round(app.sky.fovDeg(), 4),
    step: app.stepIndex,
  });
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', `#${hash}`);
}

function applyHash() {
  const s = parseHash(location.hash);
  app.wantedStep = s.step;
  if (app.steps.length) {
    app.wantedUri = app.steps[Math.min(s.step, app.steps.length - 1)].uri;
    app.wantedStep = null;
  }
  app.sky.flyTo(s.ra, s.dec, s.fov);
  setCoordInputs(s);
}

function setCoordInputs(c) {
  if (document.activeElement === el.ra || document.activeElement === el.dec) return;
  el.ra.value = round(c.ra, 4);
  el.dec.value = round(c.dec, 4);
}

// ---------------------------------------------------------------- settle loop

let last = null;
let lastMove = 0;
let settledHandled = false;
let zoomedOut = null;

function tick(now) {
  const c = app.sky.viewCentre();
  const fov = app.sky.fovDeg();
  const moved = !last ||
    Math.abs(c.ra - last.ra) > 1e-6 || Math.abs(c.dec - last.dec) > 1e-6 ||
    Math.abs(fov - last.fov) > 1e-6;
  if (moved) {
    last = { ...c, fov };
    lastMove = now;
    settledHandled = false;
  }

  const out = fov >= LOAD_FOV_DEG;
  if (out !== zoomedOut) {
    zoomedOut = out;
    app.sky.layer.visible = !out;
    if (out) pauseLoading();
    render();
  }

  if (!settledHandled && now - lastMove >= SETTLE_MS) {
    settledHandled = true;
    writeHash();
    setCoordInputs(c);
    if (!out && viewChanged(c, fov)) requestView(c, fov);
  }
  requestAnimationFrame(tick);
}

function viewChanged(c, fov) {
  if (!lastRequest) return true;
  const arcsec = 1 / 3600;
  return Math.abs(c.ra - lastRequest.ra) * Math.cos(c.dec * Math.PI / 180) > arcsec ||
    Math.abs(c.dec - lastRequest.dec) > arcsec ||
    Math.abs(fov / lastRequest.fov - 1) > 0.01;
}

// ---------------------------------------------------------------- controls

function wireControls() {
  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const ra = Number(el.ra.value);
    const dec = Number(el.dec.value);
    let error = '';
    if (el.ra.value.trim() === '' || !Number.isFinite(ra) || ra < 0 || ra >= 360) {
      error = 'RA must be a number from 0 to 360 degrees.';
    } else if (el.dec.value.trim() === '' || !Number.isFinite(dec) || dec < -90 || dec > 90) {
      error = 'Dec must be a number from -90 to 90 degrees.';
    }
    el.gotoError.textContent = error;
    el.gotoError.hidden = !error;
    if (error) return;
    const fov = app.sky.fovDeg();
    app.sky.flyTo(ra, dec, fov < LOAD_FOV_DEG ? fov : GO_FOV_DEG);
  });

  const zoom = (factor) => {
    const c = app.sky.viewCentre();
    app.sky.flyTo(c.ra, c.dec, Math.min(180, app.sky.fovDeg() * factor));
  };
  el.zoomIn.addEventListener('click', () => zoom(0.5));
  el.zoomOut.addEventListener('click', () => zoom(2));

  el.prev.addEventListener('click', () => stepBy(-1));
  el.next.addEventListener('click', () => stepBy(1));
  el.play.addEventListener('click', () => setPlaying(!app.timer));

  el.retry.addEventListener('click', () => {
    if (app.viewState === 'failed') {
      lastRequest = null;
      settledHandled = false; // the settle loop asks for the view again
    }
    app.loader.retryFailed();
    render();
  });

  window.addEventListener('hashchange', applyHash);
  wireTargets();
}

// One button per challenge test target. The list is optional: without it the
// coordinate box still works, so a failed request leaves the row empty.
async function wireTargets() {
  let list = [];
  try {
    const r = await fetch('/api/targets');
    if (r.ok) list = await r.json();
  } catch { /* row stays empty */ }
  const row = $('targets');
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    b.addEventListener('click', () => {
      setCoordInputs({ ra: t.ra, dec: t.dec });
      app.sky.flyTo(t.ra, t.dec, TARGET_FOV_DEG);
    });
    row.appendChild(b);
  }
}

async function wireWavelength() {
  const show = (lambdas) => {
    const i = Number(el.wl.value);
    app.sky.core.dss.frame = i;
    const l = lambdas[i];
    el.wlOut.textContent = l ? `${l.toFixed(2)} micron` : `frame ${i}`;
  };
  let lambdas = [];
  el.wl.addEventListener('input', () => show(lambdas));
  show(lambdas);
  try {
    const txt = await (await fetch(`${HIPS}/properties`)).text();
    const line = txt.split('\n').find((l) => l.startsWith('data_cube_crval3_arr'));
    lambdas = line.split('=')[1].trim().split(/\s+/).map(Number);
  } catch {
    // Keep frame numbers in the label; the slider still works.
  }
  show(lambdas);
}

// ---------------------------------------------------------------- start

async function main() {
  let sky;
  try {
    sky = await initSky(el.canvas, { frame: Number(el.wl.value) });
  } catch {
    el.status.textContent = COPY.noEngine;
    return;
  }
  app.sky = sky;
  app.photos = new PhotoCache(sky.layer, { cap: 600 });
  app.loader = new Loader({ fetchFn: fetchFrame, concurrency: 8, onLoaded, onFailed });
  app.showStep = showStep;
  app.stepBy = stepBy;
  app.ready = true;
  wireControls();
  wireWavelength();
  applyHash();
  render();
  requestAnimationFrame(tick);
}

main();
