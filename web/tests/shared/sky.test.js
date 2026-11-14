import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_SCRIPT, loadEngine, makeSky, projectView } from '../../shared/sky.js';

const D2R = Math.PI / 180;

// A fake engine whose frames are all the identity, except ASTROM -> VIEW,
// which returns whatever `view` holds. Records every conversion it is asked for.
function fakeStel({ view = [0, 0, -1, 0], fov = 1 * D2R, winSize = [800, 600] } = {}) {
  const calls = [];
  const layer = { visible: true };
  const stel = {
    observer: {},
    core: {
      fov, win_size: winSize, observer: { yaw: 0.5, pitch: 0.1 },
      atmosphere: { visible: true }, landscapes: { visible: true },
      dss: { addDataSource: (s) => calls.push(['dss', s.url]), frame: 0 },
    },
    s2c: (a, b) => [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)],
    c2s: (v) => [Math.atan2(v[1], v[0]), Math.asin(v[2])],
    anp: (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    convertFrame: (_obs, from, to, v) => {
      calls.push([from, to]);
      return from === 'ASTROM' && to === 'VIEW' ? view : v;
    },
    lookAt: (v, t) => calls.push(['lookAt', v, t]),
    zoomTo: (f, t) => calls.push(['zoomTo', f, t]),
    createLayer: (opts) => { calls.push(['layer', opts.id]); return layer; },
  };
  return { stel, calls, layer };
}

test('makeSky sets the equatorial, airless view both pages share', () => {
  const { stel, calls, layer } = fakeStel();
  const sky = makeSky(stel, 42);
  assert.equal(stel.core.atmosphere.visible, false);
  assert.equal(stel.core.landscapes.visible, false);
  assert.equal(stel.core.mount_frame, 1);
  assert.equal(stel.core.dss.frame, 42);
  assert(calls.some((c) => c[0] === 'dss' && c[1].includes('spherex_allsky_cube')));
  assert.deepEqual(calls.filter((c) => c[0] === 'layer'), [['layer', 'spherex-frames']]);
  assert.equal(sky.layer, layer);
});

test('viewCentre reads CIRS -> ASTROM and flyTo writes ASTROM -> CIRS', () => {
  const { stel, calls } = fakeStel();
  const sky = makeSky(stel, 0);
  stel.core.observer.yaw = 30 * D2R;
  stel.core.observer.pitch = 20 * D2R;
  const c = sky.viewCentre();
  assert.ok(Math.abs(c.ra - 30) < 1e-9 && Math.abs(c.dec - 20) < 1e-9);
  assert.deepEqual(calls.at(-1), ['CIRS', 'ASTROM']);

  sky.flyTo(90, 10, 0.25);
  const look = calls.find((c) => c[0] === 'lookAt');
  assert.deepEqual(calls[calls.indexOf(look) - 1], ['ASTROM', 'CIRS']);
  assert.equal(look[2], 0);
  assert.deepEqual(calls.at(-1), ['zoomTo', 0.25 * D2R, 0]);
});

test('flyTo without a field of view keeps the current zoom', () => {
  const { stel, calls } = fakeStel();
  makeSky(stel, 0).flyTo(10, 10);
  assert(!calls.some((c) => c[0] === 'zoomTo'));
});

// The engine projects stereographically (proj_stereographic.c), not with a
// pinhole perspective. These cases pin the window maths to that projection.
test('projectView puts the view axis at the canvas centre', () => {
  const p = projectView([0, 0, -1], 1 * D2R, 800, 600);
  assert.deepEqual([p.x, p.y, p.visible], [400, 300, true]);
});

test('projectView matches the stereographic edges of a landscape canvas', () => {
  const fov = 10 * D2R; // vertical when width >= height
  const w = 800, h = 600;
  // Top edge: half the vertical fov above the axis, VIEW +y is up.
  const up = projectView([0, Math.sin(fov / 2), -Math.cos(fov / 2)], fov, w, h);
  assert.ok(Math.abs(up.x - 400) < 1e-9);
  assert.ok(Math.abs(up.y - 0) < 1e-9);
  // Right edge: fovx = 4 atan(tan(fov/4) * aspect) (stereographic compute_fovs).
  const fovx = 4 * Math.atan(Math.tan(fov / 4) * (w / h));
  const right = projectView([Math.sin(fovx / 2), 0, -Math.cos(fovx / 2)], fov, w, h);
  assert.ok(Math.abs(right.x - 800) < 1e-9);
  assert.ok(Math.abs(right.y - 300) < 1e-9);
});

test('projectView uses the widened vertical fov on a portrait canvas', () => {
  const fov = 10 * D2R; // horizontal when width < height
  const w = 400, h = 800;
  const right = projectView([Math.sin(fov / 2), 0, -Math.cos(fov / 2)], fov, w, h);
  assert.ok(Math.abs(right.x - 400) < 1e-9);
});

test('projectView reports points far off screen or behind the viewer as not visible', () => {
  assert.equal(projectView([0, 0, 1], 1 * D2R, 800, 600).visible, false);
  assert.equal(projectView([1, 0, 0], 1 * D2R, 800, 600).visible, false);
});

test('toScreen converts catalogue RA/Dec through the engine VIEW frame', () => {
  const { stel, calls } = fakeStel({ view: [0, 0, -1, 0] });
  const p = makeSky(stel, 0).toScreen(269.45, 4.69, 800, 600);
  assert.deepEqual(calls.at(-1), ['ASTROM', 'VIEW']);
  assert.deepEqual([p.x, p.y, p.visible], [400, 300, true]);
});

test('loadEngine resolves at once when the script already ran', async () => {
  const engine = () => {};
  const doc = { querySelector: () => { throw new Error('should not look'); } };
  assert.equal(await loadEngine(ENGINE_SCRIPT, { win: { StelWebEngine: engine }, doc }), engine);
});

test('loadEngine adds the engine script once and resolves when it loads', async () => {
  const win = {};
  const added = [];
  const doc = {
    querySelector: (sel) => (sel === 'script[data-stel-engine]' ? added[0] ?? null : null),
    createElement: () => {
      const listeners = {};
      return {
        dataset: {}, listeners,
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      };
    },
    head: { appendChild: (s) => added.push(s) },
  };
  const first = loadEngine('/engine/stellarium-web-engine.js', { win, doc });
  const second = loadEngine('/engine/stellarium-web-engine.js', { win, doc });
  assert.equal(added.length, 1);
  assert.equal(added[0].src, '/engine/stellarium-web-engine.js');
  win.StelWebEngine = () => {};
  added[0].listeners.load.forEach((fn) => fn());
  assert.equal(await first, win.StelWebEngine);
  assert.equal(await second, win.StelWebEngine);
});

test('loadEngine rejects with a readable message when the script fails', async () => {
  const added = [];
  const doc = {
    querySelector: () => null,
    createElement: () => {
      const listeners = {};
      return { dataset: {}, listeners, addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); } };
    },
    head: { appendChild: (s) => added.push(s) },
  };
  const p = loadEngine('/engine/missing.js', { win: {}, doc });
  added[0].listeners.error.forEach((fn) => fn());
  await assert.rejects(p, /did not load/);
});

test('both pages load the engine from /engine/', () => {
  assert.equal(ENGINE_SCRIPT, '/engine/stellarium-web-engine.js');
});
