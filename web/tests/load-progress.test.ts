import assert from 'node:assert/strict';
import { describeProgress } from '../lib/load-progress.ts';

const p = (phase: any, done = 0, total = 0, failed = 0, cleaned = 0) => ({ phase, done, total, failed, cleaned });

let d = describeProgress(p('loading', 3, 12));
assert.equal(d.title, 'Loading 3 of 12');
assert.equal(d.tone, 'busy');
assert.equal(d.loaded, 0.25);
assert.equal(d.cleaned, 0);

d = describeProgress(p('cleaning', 12, 12, 0, 6));
assert.equal(d.title, 'Cleaning 6 of 12');
assert.equal(d.loaded, 1);
assert.equal(d.cleaned, 0.5);
assert.match(d.detail, /median/);

d = describeProgress(p('ready', 12, 12, 0, 12));
assert.equal(d.title, '12 frames ready');
assert.equal(d.tone, 'ok');
assert.equal(describeProgress(p('ready', 1, 1, 0, 1)).title, '1 frame ready');

d = describeProgress(p('failed', 10, 12, 2));
assert.equal(d.title, '2 of 12 frames failed');
assert.equal(d.tone, 'warn');
assert.match(d.detail, /Recenter/);

assert.equal(describeProgress(p('error')).tone, 'warn');
assert.match(describeProgress(p('error')).detail, /Recenter/);
assert.match(describeProgress(p('zoomed-out')).title, /Zoom in/);
assert.match(describeProgress(p('zoomed-out')).detail, /30′/);
assert.equal(describeProgress(p('zoomed-out')).tone, 'idle');
assert.match(describeProgress(p('empty')).title, /No exposures/);
assert.match(describeProgress(p('finding')).title, /Finding/);
assert.match(describeProgress(p('hidden')).detail, /Infrared/);
// Nothing reported yet reads as finding, not as an error.
assert.match(describeProgress(null).title, /Finding/);
