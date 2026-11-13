// Browser acceptance check for the SPHEREx blink page, on real IRSA data.
//
// Needs the server running: uv run uvicorn server.app:app --port 8000
// Usage: node scripts/acceptance.mjs [base-url]
// Env: CDP_PORT=<port> uses an already running Chromium instead of starting one.
//      OUT_DIR overrides the screenshot folder (default .cache/acceptance).
//
// Checks, at #ra=269.4463&dec=4.7677&fov=0.15 (Barnard's Star):
//  (a) the status reaches "Loading frames for this spot: 18 of" within 15 s
//  (b) Barnard's Star moves north 10 +- 3 arcsec per year, first to last visit
//  (c) no seam where two loaded patches meet after a one-cell pan east
//  (d) zoomed out to 1 deg: the hint shows and no new /api/patch requests start
//  (e) no console errors
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const BASE = process.argv[2] || 'http://localhost:8000/';
const START = { ra: 269.4463, dec: 4.7677, fov: 0.15 };
const OUT = process.env.OUT_DIR || '.cache/acceptance';
const W = 1200;
const H = 800;
const CELL_SIDE_DEG = 0.1145; // HEALPix order 9: sqrt(4 pi / (12 * 512^2)) rad
const PATCH_HALF_DEG = (211 * 3.075) / 3600 / 2; // PATCH_N * pixscale / 2
const BAND = 40; // seam band width, screen px
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ browser

async function startChromium() {
  if (process.env.CDP_PORT) return { port: Number(process.env.CDP_PORT), stop: () => {} };
  const root = join(homedir(), '.cache/ms-playwright');
  const dir = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  if (!dir) throw new Error(`No chromium_headless_shell in ${root}`);
  const bin = join(root, dir, 'chrome-headless-shell-linux-arm64/chrome-headless-shell');
  const port = 9341;
  const profile = mkdtempSync(join(tmpdir(), 'spherex-acceptance-'));
  const proc = spawn(bin, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-sandbox', `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  return {
    port,
    stop: () => {
      proc.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const page = { errors: [], network502: [], patchStarts: [], ws, target };
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    const p = msg.params;
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      page.errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      page.errors.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') {
      const line = `${p.entry.text} ${p.entry.url || ''}`;
      // A 502 from /api/patch is IRSA failing to send a crop; the page shows it
      // as "IRSA did not answer". Reported separately, not hidden.
      if (/status of 502/.test(p.entry.text) && /\/api\/patch\//.test(p.entry.url || '')) page.network502.push(line);
      else page.errors.push(`log: ${line}`);
    } else if (msg.method === 'Network.requestWillBeSent' && p.request.url.includes('/api/patch/')) {
      page.patchStarts.push(Date.now());
    }
  });
  page.send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  page.eval = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  page.shot = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.result.data, 'base64');
    writeFileSync(join(OUT, `${name}.png`), buf);
    return decodePng(buf);
  };
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return page;
}

// ------------------------------------------------------------ PNG -> grey

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Only 8-bit non-interlaced PNG');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const grey = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * bpp;
    grey[i] = bpp >= 3 ? (px[o] + px[o + 1] + px[o + 2]) / 3 : px[o];
  }
  return { width, height, grey, at: (x, y) => grey[y * width + x] };
}

// ------------------------------------------------------------ measurements

/**
 * Centre of the brightest blob near the screen centre (Barnard's Star).
 * Its core is NaN-masked (black) in some frames and clipped white in others, so
 * an intensity centroid wanders. Instead find the point around which the halo
 * is most circular: the centre minimising the spread of grey values within
 * 2 px rings, radius 30 to 90 px, ignoring black (masked) and clipped pixels.
 * Coarse 2 px grid over +-24 px, then 0.5 px refinement.
 */
function centroid(img) {
  const RMIN = 30;
  const RMAX = 90;
  const cost = (cx, cy) => {
    const nb = Math.ceil((RMAX - RMIN) / 2);
    const n = new Float64Array(nb);
    const s = new Float64Array(nb);
    const s2 = new Float64Array(nb);
    let total = 0;
    for (let y = Math.floor(cy - RMAX); y <= cy + RMAX; y++) {
      for (let x = Math.floor(cx - RMAX); x <= cx + RMAX; x++) {
        const r = Math.hypot(x - cx, y - cy);
        if (r < RMIN || r >= RMAX) continue;
        const v = img.at(x, y);
        if (v <= 1 || v >= 250) continue;
        const b = Math.floor((r - RMIN) / 2);
        n[b] += 1;
        s[b] += v;
        s2[b] += v * v;
        total += 1;
      }
    }
    let spread = 0;
    for (let b = 0; b < nb; b++) if (n[b]) spread += s2[b] - (s[b] * s[b]) / n[b];
    return spread / total;
  };
  const search = (x0, y0, span, step) => {
    let best = [Infinity, x0, y0];
    for (let y = y0 - span; y <= y0 + span + 1e-9; y += step) {
      for (let x = x0 - span; x <= x0 + span + 1e-9; x += step) {
        const c = cost(x, y);
        if (c < best[0]) best = [c, x, y];
      }
    }
    return best;
  };
  const [, x1, y1] = search(img.width / 2, img.height / 2, 24, 2);
  const [, x, y] = search(x1, y1, 2, 0.5);
  return { x, y };
}

/** Screen position of a sky point, small-field approximation (east left, north up). */
function toScreen(ra, dec, view) {
  const s = H / view.fov; // px per deg: fov is the short (vertical) side
  let dra = ra - view.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  return {
    x: W / 2 - dra * Math.cos((view.dec * Math.PI) / 180) * s,
    y: H / 2 - (dec - view.dec) * s,
    s,
  };
}

/**
 * Mean absolute difference across vertical bands. Pairs each left-half column
 * with its mirror in the right half, so the nearest columns are compared.
 * Pairs where either pixel is black (NaN-masked or no photo; the background map
 * is hidden while measuring) are skipped.
 * Returns {mad, step} where step = |mean(left) - mean(right)|.
 */
function bandDiff(img, xe, rows) {
  const half = BAND / 2;
  let sum = 0;
  let n = 0;
  let sl = 0;
  let sr = 0;
  for (const y of rows) {
    for (let k = 0; k < half; k++) {
      const l = img.at(xe - 1 - k, y);
      const r = img.at(xe + k, y);
      if (l <= 1 || r <= 1) continue; // black = no photo or a masked pixel, not a seam
      sum += Math.abs(l - r);
      sl += l;
      sr += r;
      n += 1;
    }
  }
  return { mad: sum / n, step: Math.abs(sl - sr) / n, rows: rows.length };
}

// ------------------------------------------------------------ run

const results = {};
const say = (...a) => console.log(...a);
const chrome = await startChromium();
const page = await openPage(chrome.port);
const hash = `#ra=${START.ra}&dec=${START.dec}&fov=${START.fov}`;
const t0 = Date.now();
await page.send('Page.navigate', { url: new URL(hash, BASE).href });

try {
  // (a) status reaches 18 loaded frames
  let reachedAt = null;
  let lastStatus = '';
  while (Date.now() - t0 < 180000) {
    const s = await page.eval('document.getElementById("status")?.textContent || ""').catch(() => '');
    if (s !== lastStatus) {
      say(`  ${((Date.now() - t0) / 1000).toFixed(1)} s  ${s}`);
      lastStatus = s;
    }
    const m = s.match(/^Loading frames for this spot: (\d+) of/) || s.match(/^All (\d+) frames/);
    if (m && Number(m[1]) >= 18) {
      reachedAt = (Date.now() - t0) / 1000;
      break;
    }
    await sleep(100);
  }
  results.a = {
    pass: reachedAt !== null && reachedAt <= 15,
    detail: reachedAt === null ? 'never reached 18 frames in 180 s' : `18 frames after ${reachedAt.toFixed(1)} s (limit 15 s)`,
  };
  say(`(a) ${results.a.pass ? 'PASS' : 'FAIL'}: ${results.a.detail}`);
  await page.shot('a-loading');

  // (b) Barnard's Star moves north, first visit to last visit, per detector
  const plan = await page.eval(`(() => {
    const v = app.view, cell = v.cell;
    const firsts = v.exposures.filter((e) => e.first && e.cells.includes(cell));
    const visits = [...new Set(firsts.map((e) => e.visit))].sort((a, b) => a - b);
    const lo = visits[0], hi = visits[visits.length - 1];
    const pairs = [];
    for (let d = 1; d <= 6; d++) {
      const a = firsts.find((e) => e.visit === lo && e.detector === d);
      const b = firsts.find((e) => e.visit === hi && e.detector === d);
      if (a && b) pairs.push({ d, a: a.uri, b: b.uri, ma: a.mjd, mb: b.mjd });
    }
    return { cell, pairs, visits };
  })()`);
  const need = plan.pairs.flatMap((p) => [p.a, p.b]);
  const tWait = Date.now();
  while (Date.now() - tWait < 180000) {
    const settled = await page.eval(`${JSON.stringify(need)}.filter((u) =>
      app.loader.done.has(${plan.cell} + '|' + u) || app.loader.failed.has(${plan.cell} + '|' + u)).length`);
    if (settled === need.length) break;
    await sleep(1000);
  }
  await page.eval(`(() => {
    document.getElementById('panel').style.visibility = 'hidden';
    app.sky.core.dss.visible = false;
  })()`);
  const rates = [];
  for (const p of plan.pairs) {
    const pos = {};
    for (const [tag, uri] of [['first', p.a], ['last', p.b]]) {
      const ok = await page.eval(`(() => { const i = app.steps.findIndex((s) => s.uri === ${JSON.stringify(uri)});
        if (i < 0 || !app.loader.done.has(${plan.cell} + '|' + ${JSON.stringify(uri)})) return false;
        app.showStep(i); return true; })()`);
      if (!ok) break;
      await sleep(2500);
      const view = await page.eval('({ ...app.sky.viewCentre(), fov: app.sky.fovDeg() })');
      const img = await page.shot(`b-det${p.d}-${tag}`);
      pos[tag] = { ...centroid(img), scale: H / view.fov / 3600 }; // px per arcsec
    }
    if (!pos.first || !pos.last) {
      say(`    detector ${p.d}: frames not loaded, skipped`);
      continue;
    }
    const years = (p.mb - p.ma) / 365.25;
    const north = (pos.first.y - pos.last.y) / pos.first.scale; // screen y grows south
    const east = (pos.first.x - pos.last.x) / pos.first.scale; // screen x grows west
    const rate = north / years;
    rates.push(rate);
    say(`    detector ${p.d}: north ${north.toFixed(2)} arcsec, east ${east.toFixed(2)} arcsec over ${years.toFixed(3)} yr -> ${rate.toFixed(2)} arcsec/yr north`);
  }
  rates.sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : NaN;
  results.b = {
    pass: rates.length > 0 && Math.abs(median - 10) <= 3,
    detail: `median ${median.toFixed(2)} arcsec/yr north over ${rates.length} detector pairs (expected 10 +- 3)`,
  };
  say(`(b) ${results.b.pass ? 'PASS' : 'FAIL'}: ${results.b.detail}`);
  await page.eval(`document.getElementById('panel').style.visibility = ''; app.sky.core.dss.visible = true;`);

  // (c) seam: pan one cell east, wait 20 s, show a first-batch step, compare across patch edges
  const panned = { ra: START.ra + CELL_SIDE_DEG / Math.cos((START.dec * Math.PI) / 180), dec: START.dec, fov: START.fov };
  await page.eval(`app.sky.flyTo(${panned.ra}, ${panned.dec}, ${panned.fov})`);
  await sleep(20000);
  const seamPlan = await page.eval(`(() => {
    const v = app.view;
    const done = app.loader.done;
    let best = null;
    for (const e of v.exposures.filter((x) => x.first)) {
      const pix = v.cells.filter((c) => done.has(c.pix + '|' + e.uri)).map((c) => ({ pix: c.pix, ra: c.ra, dec: c.dec }));
      if (!best || pix.length > best.pix.length) best = { uri: e.uri, pix };
    }
    if (!best) return null;
    app.showStep(app.steps.findIndex((s) => s.uri === best.uri));
    return best;
  })()`);
  let seam = { pass: false, detail: 'no first-batch step loaded after the pan' };
  if (seamPlan && seamPlan.pix.length >= 2) {
    await page.eval(`document.getElementById('panel').style.visibility = 'hidden'; app.sky.core.dss.visible = false;`);
    await sleep(2500);
    const view = await page.eval('({ ...app.sky.viewCentre(), fov: app.sky.fovDeg() })');
    const img = await page.shot('c-seam');
    const squares = seamPlan.pix.map((c) => {
      const p = toScreen(c.ra, c.dec, view);
      const h = PATCH_HALF_DEG * p.s;
      return { pix: c.pix, x0: p.x - h, x1: p.x + h, y0: p.y - h, y1: p.y + h };
    });
    const inside = (x, y, skip) => squares.some((q) => q !== skip && x > q.x0 + 2 && x < q.x1 - 2 && y > q.y0 + 2 && y < q.y1 - 2);
    const bands = [];
    for (const q of squares) {
      for (const xe of [Math.round(q.x0), Math.round(q.x1)]) {
        if (xe - BAND < 2 || xe + BAND > W - 2) continue;
        const rows = [];
        for (let y = Math.max(2, Math.ceil(q.y0) + 2); y < Math.min(H - 2, q.y1 - 2); y++) {
          // Both halves must be painted by a loaded patch, one of them another patch than q.
          const out = xe === Math.round(q.x0) ? xe - BAND / 2 - 2 : xe + BAND / 2 + 2;
          const inn = xe === Math.round(q.x0) ? xe + BAND / 2 + 2 : xe - BAND / 2 - 2;
          if (inside(out, y, q) && (inside(inn, y, null))) rows.push(y);
        }
        if (rows.length >= 40) bands.push({ pix: q.pix, xe, ...bandDiff(img, xe, rows) });
      }
    }
    // Baseline: same measure where no patch edge is within a band width.
    const edges = squares.flatMap((q) => [q.x0, q.x1]);
    const base = [];
    for (let xe = BAND + 2; xe < W - BAND - 2; xe += 7) {
      if (edges.some((e) => Math.abs(e - xe) < BAND)) continue;
      const rows = [];
      for (let y = 2; y < H - 2; y++) if (inside(xe - BAND / 2, y, null) && inside(xe + BAND / 2, y, null)) rows.push(y);
      if (rows.length >= 40) base.push(bandDiff(img, xe, rows).mad);
    }
    base.sort((a, b) => a - b);
    const baseMed = base.length ? base[Math.floor(base.length / 2)] : NaN;
    for (const b of bands) {
      say(`    edge of patch ${b.pix} at x=${b.xe}: mean abs diff ${b.mad.toFixed(2)}, mean step ${b.step.toFixed(2)} over ${b.rows} rows`);
    }
    say(`    baseline away from edges: median mean abs diff ${baseMed.toFixed(2)} over ${base.length} bands`);
    // Diagnostic: the same sky as drawn by each of the two patches on the longest
    // shared edge. Shows each patch alone and compares them pixel by pixel where
    // they overlap, so sky content cancels and only resampling differences remain.
    const longest = [...bands].sort((a, b) => b.rows - a.rows)[0];
    if (longest) {
      const q = squares.find((s) => s.pix === longest.pix);
      const outX = longest.xe === Math.round(q.x0) ? longest.xe - BAND : longest.xe + BAND;
      const p = squares.find((s) => s !== q && outX > s.x0 && outX < s.x1 && H / 2 > s.y0 && H / 2 < s.y1) ||
        squares.find((s) => s !== q && outX > s.x0 && outX < s.x1);
      if (p) {
        const solo = async (pix) => {
          await page.eval(`(() => { for (const [k, e] of app.photos.entries) e.photo.visible = k === ${JSON.stringify(`${pix}|${seamPlan.uri}`)}; })()`);
          await sleep(1500);
          return page.shot(`c-solo-${pix}`);
        };
        const A = await solo(q.pix);
        const B = await solo(p.pix);
        await page.eval(`app.showStep(app.stepIndex)`);
        let sum = 0;
        let n = 0;
        const x0 = Math.max(2, Math.ceil(Math.max(q.x0, p.x0)) + 2);
        const x1 = Math.min(W - 2, Math.floor(Math.min(q.x1, p.x1)) - 2);
        const y0 = Math.max(2, Math.ceil(Math.max(q.y0, p.y0)) + 2);
        const y1 = Math.min(H - 2, Math.floor(Math.min(q.y1, p.y1)) - 2);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const a = A.at(x, y);
            const b = B.at(x, y);
            if (a <= 1 || b <= 1) continue;
            sum += Math.abs(a - b);
            n += 1;
          }
        }
        say(`    same sky drawn by patch ${q.pix} and patch ${p.pix}: mean abs diff ${(sum / n).toFixed(2)} grey levels over ${n} px`);
      }
    }
    const worst = bands.length ? Math.max(...bands.map((b) => b.mad)) : NaN;
    seam = {
      pass: bands.length > 0 && worst < 6,
      detail: bands.length
        ? `worst band ${worst.toFixed(2)} grey levels across ${bands.length} patch edges (limit 6; baseline ${baseMed.toFixed(2)})`
        : 'no patch edge with loaded patches on both sides is on screen',
    };
    await page.eval(`document.getElementById('panel').style.visibility = ''; app.sky.core.dss.visible = true;`);
  }
  results.c = seam;
  say(`(c) ${results.c.pass ? 'PASS' : 'FAIL'}: ${results.c.detail}`);

  // (d) zoom out to 1 deg: hint shows, no new /api/patch requests
  await page.eval(`(() => { const c = app.sky.viewCentre(); app.sky.flyTo(c.ra, c.dec, 1.0); })()`);
  const hint = 'Zoom in to load SPHEREx frames for this part of the sky.';
  let hintAt = null;
  for (let i = 0; i < 50 && !hintAt; i++) {
    if ((await page.eval('document.getElementById("status").textContent')) === hint) hintAt = Date.now();
    else await sleep(100);
  }
  await sleep(5000);
  const after = hintAt ? page.patchStarts.filter((t) => t > hintAt).length : NaN;
  await page.shot('d-zoomed-out');
  results.d = {
    pass: hintAt !== null && after === 0,
    detail: hintAt ? `hint shown; ${after} /api/patch requests started in the 5 s after` : 'hint did not show',
  };
  say(`(d) ${results.d.pass ? 'PASS' : 'FAIL'}: ${results.d.detail}`);

  // (e) console errors
  results.e = {
    pass: page.errors.length === 0,
    detail: `${page.errors.length} console errors; ${page.network502.length} crop requests answered 502 (IRSA did not return the crop)`,
  };
  for (const line of page.errors) say(`    ${line}`);
  for (const line of page.network502) say(`    502: ${line}`);
  say(`(e) ${results.e.pass ? 'PASS' : 'FAIL'}: ${results.e.detail}`);
} catch (err) {
  say(`acceptance run stopped: ${err.stack || err}`);
} finally {
  // Closing the tab also closes its socket, so close it over HTTP, not CDP.
  await fetch(`http://127.0.0.1:${chrome.port}/json/close/${page.target.id}`).catch(() => {});
  chrome.stop();
}

const failed = ['a', 'b', 'c', 'd', 'e'].filter((k) => !results[k]?.pass);
say(failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL PASS');
process.exit(failed.length ? 1 : 0);
