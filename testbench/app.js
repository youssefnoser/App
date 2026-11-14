// Page wiring: the sky view, view-following frame loading, the blink player,
// the coordinate box, the background wavelength slider and the URL hash.
// Pixels are drawn by the engine from server PNGs (NaN is already alpha 0
// there), so nothing in this file touches pixel values.

import { initSky } from './sky.js';
import { Loader, priorityList } from '/shared/queue.js';
import { buildSteps, keepStep } from '/shared/timeline.js';
import { PhotoCache } from '/shared/photos.js';
import { parseHash, toHash } from '/shared/state.js';
import { boxCovers, frameBox, LOAD_FOV_DEG } from '/shared/viewbox.js';

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const SETTLE_MS = 300; // and once the view has been still this long
const PIXSCALE_ARCSEC = 3.075;
const BLINK_MS = 500;
const TARGET_FOV_DEG = 0.15; // field of view a target button flies to
const GO_FOV_DEG = 0.25; // field of view after Go when zoomed out too far to load
const MAX_FOV_DEG = 105; // widest zoom; the engine clamps there too (proj_stereographic.c)

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
  fill: $('fill'),
  wave: $('wave'),
  waveOut: $('wave-out'),
  waveWidth: $('wave-width'),
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
// Live sequence mode: one image per exposure for a fixed sky box, which the page
// treats as a single patch (pix below zero). seqOf remembers each box.
const seqOf = new Map();
const SEQ_ROLL = 4; // a clean frame is the median of itself and up to 4 exposures either side
// A sequence frame loads twice: first the exposure alone (`clean` false), shown the
// moment it arrives, then the rolling median, which fills its blank pixels.
const frameUrl = (pix, uri, clean = false) => {
  const seq = seqOf.get(pix);
  if (seq) {
    // The median only mixes frames inside the chosen wavelength window.
    const window = clean ? `&wavelength=${seq.wavelength}&width=${seq.width}` : '';
    return new URL(`/api/frame.png?uri=${encodeURIComponent(uri)}&ra=${seq.ra}&dec=${seq.dec}` +
      `&fov=${seq.fov}&roll=${clean ? SEQ_ROLL : 0}${window}`, location.href).href;
  }
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

// ---- second pass for sequences: swap each quick frame for its rolling median.
// It starts when the quick pass has nothing left to fetch, so every exposure the
// medians need is already on the server and this pass downloads nothing new.
const upgrade = { waiting: [], running: 0, done: new Map(), generation: 0 }; // done: key -> item
const UPGRADE_CONCURRENCY = 4;

function resetUpgrades() {
  upgrade.waiting = [];
  upgrade.generation += 1;
}

// Put the single exposures back: a median over neighbouring frames removes
// anything that moves between them, which is exactly what an asteroid does.
function undoUpgrades() {
  upgrade.generation += 1;
  for (const item of upgrade.done.values()) {
    const centre = app.centres.get(item.pix);
    if (centre) {
      app.photos.replace(item.pix, item.uri, frameUrl(item.pix, item.uri, false), {
        ra: centre.ra, dec: centre.dec, orientation: 0, pixscale: PIXSCALE_ARCSEC,
      });
    }
    const meta = app.meta.get(item.key);
    if (meta) app.meta.set(item.key, { ...meta, stack: undefined });
    upgrade.waiting.push(item);
  }
  upgrade.done.clear();
}

function pumpUpgrades() {
  if (!el.fill.checked) return;
  const stats = app.loader.stats;
  if (stats.done + stats.failed < stats.total) return; // quick pass still fetching
  while (upgrade.running < UPGRADE_CONCURRENCY && upgrade.waiting.length) {
    const item = upgrade.waiting.shift();
    if (upgrade.done.has(item.key) || !seqOf.has(item.pix)) continue;
    const generation = upgrade.generation;
    const url = frameUrl(item.pix, item.uri, true);
    upgrade.running += 1;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
        let meta = null;
        try { meta = JSON.parse(res.headers.get('X-Frame-Meta') || 'null'); } catch { /* keep old */ }
        if (generation !== upgrade.generation) return;
        const centre = app.centres.get(item.pix);
        if (centre && app.photos.replace(item.pix, item.uri, url, {
          ra: centre.ra, dec: centre.dec, orientation: 0, pixscale: PIXSCALE_ARCSEC,
        })) {
          upgrade.done.set(item.key, item);
          if (meta) app.meta.set(item.key, meta);
        }
      })
      .catch(() => { /* the quick frame stays; nothing to report */ })
      .finally(() => {
        upgrade.running -= 1;
        pumpUpgrades();
        render();
      });
  }
}

function onLoaded(item, meta) {
  if (meta) app.meta.set(item.key, meta);
  if (seqOf.has(item.pix)) upgrade.waiting.push(item);
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
  pumpUpgrades();
  render();
}

function onFailed() {
  pumpUpgrades();
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

// Side of the sky box that covers the canvas now, or null when frames should not load.
const boxNow = () => frameBox(app.sky.fovDeg(), el.canvas.clientWidth, el.canvas.clientHeight);

async function requestView(centre, fov) {
  const seqFov = boxNow();
  if (seqFov === null) return;
  lastRequest = { ...centre, fov };
  if (viewAbort) viewAbort.abort();
  const controller = new AbortController();
  viewAbort = controller;
  app.viewState = 'finding';
  render();
  // Stream every exposure that recorded this spot near the chosen wavelength.
  const where = `ra=${round(centre.ra, 5)}&dec=${round(centre.dec, 5)}`;
  const address = `/api/sequence?${where}&fov=${seqFov}` +
    `&wavelength=${Number(el.wave.value)}&width=${Number(el.waveWidth.value)}`;
  let view;
  try {
    const res = await fetch(address, { signal: controller.signal });
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
  if (view.sequence) seqOf.set(view.cell, view.sequence);
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

  if (!app.loader.done.size || ![...app.loader.done.values()].some((it) => it.pix === view.cell)) {
    resetUpgrades(); // a different box: pending medians belong to the old one
  }
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
  const out = boxNow() === null;
  const stats = app.loader.stats;
  let status;
  if (out) status = COPY.hint;
  else if (app.viewState === 'finding') status = COPY.finding;
  else if (app.viewState === 'failed') status = COPY.viewFailed;
  else if (app.view && app.view.exposures.length === 0) status = COPY.none;
  else if (app.view && stats.total > 0 && stats.done + stats.failed >= stats.total) status = COPY.loaded(stats.done);
  else if (app.view) status = COPY.loading(stats.done, stats.total);
  else status = COPY.hint;
  if (el.status.textContent !== status) el.status.textContent = status;

  const viewFailed = app.viewState === 'failed' && !out;
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

  const out = boxNow() === null;
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
  // A live sequence covers a fixed box: keep it while the whole canvas is still
  // inside, so panning a little does not start the whole sequence again.
  const seq = app.view && app.view.sequence;
  if (seq && seq.wavelength === Number(el.wave.value) && seq.width === Number(el.waveWidth.value)) {
    return !boxCovers(seq, c, fov, el.canvas.clientWidth, el.canvas.clientHeight);
  }
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
    app.sky.flyTo(c.ra, c.dec, Math.min(MAX_FOV_DEG, app.sky.fovDeg() * factor));
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

  const showWave = () => { el.waveOut.textContent = `${Number(el.wave.value).toFixed(2)} micron`; };
  const newWindow = () => {
    // Forget the last request so the next settle check asks for this wavelength.
    showWave();
    lastRequest = null;
    settledHandled = false;
  };
  el.fill.addEventListener('change', () => {
    if (el.fill.checked) pumpUpgrades();
    else undoUpgrades();
    render();
  });
  el.wave.addEventListener('input', showWave); // label follows the drag
  el.wave.addEventListener('change', newWindow); // frames load on release
  el.waveWidth.addEventListener('change', newWindow);
  showWave();
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
