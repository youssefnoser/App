// THROWAWAY SPIKE helper: drive headless Chromium over CDP, run steps, save screenshots.
// Usage: node spike/stellarium/shoot.mjs <url> <outdir> '<json list of [label, js-to-eval]>'
import { writeFileSync } from 'node:fs';

const [url, outdir, stepsJson] = process.argv.slice(2);
const steps = JSON.parse(stepsJson || '[["start", ""]]');
const port = process.env.CDP_PORT || 9334;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
for (let t = 0; t < 120 && !(await evalJs('window.spike && window.spike.ready')); t++) await sleep(1000);
console.log('ready:', await evalJs('window.spike && window.spike.ready'));
for (const [label, js] of steps) {
  if (js) console.log(label, '->', JSON.stringify(await evalJs(js)));
  await sleep(Number(process.env.SETTLE_MS || 12000));   // let HiPS tiles stream in
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outdir}/${label}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', label);
}
console.log('console:', logs.slice(-15).join('\n'));
await send('Target.closeTarget', { targetId: target.id }).catch(() => {});
process.exit(0);
