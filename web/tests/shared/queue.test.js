// Tests for the browser load queue (web/shared/queue.js). No network, no browser:
// the /api/view JSON shape is faked exactly as server/app.py returns it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { priorityList, Loader } from '../../shared/queue.js';

const key = (pix, uri) => `${pix}|${uri}`;

// A fake view: centre cell 100 (ring 0), another ring-0 cell 101, ring-1 cell
// 200, ring-2 cell 300. Four exposures, two in the first batch. Uris are named
// so that uri order is the reverse of mjd order: sorting must follow mjd.
function fakeView() {
  const covered = [100, 101, 200, 300];
  return {
    cell: 100,
    cells: [
      { pix: 100, ring: 0 },
      { pix: 101, ring: 0 },
      { pix: 200, ring: 1 },
      { pix: 300, ring: 2 },
    ],
    exposures: [
      { uri: 'e-b', mjd: 60902.9, first: true, cells: covered },
      { uri: 'e-a', mjd: 60902.8, first: true, cells: covered },
      { uri: 'e-d', mjd: 60903.9, first: false, cells: covered },
      { uri: 'e-c', mjd: 60903.8, first: false, cells: covered },
    ],
  };
}

// One cell, n exposures, all covering it: n independent queue items.
function bigView(n) {
  return {
    cell: 100,
    cells: [{ pix: 100, ring: 0 }],
    exposures: Array.from({ length: n }, (_, i) => ({
      uri: `u${i}`,
      mjd: 60000 + i,
      first: true,
      cells: [100],
    })),
  };
}

function indexOf(list, pix, uri) {
  return list.findIndex((it) => it.pix === pix && it.uri === uri);
}

// Resolves once done + failed reaches n (loads that have left the queue for
// good); polls, never touches the network.
async function waitSettled(loader, n) {
  for (;;) {
    const s = loader.stats;
    if (s.done + s.failed >= n) return s;
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('order follows spec groups', () => {
  const list = priorityList(fakeView(), new Set());
  assert.deepEqual(
    list.map((it) => it.key),
    [
      key(100, 'e-a'), key(100, 'e-b'), // 1: centre cell, first batch
      key(101, 'e-a'), key(101, 'e-b'), // 2: other ring 0, first batch
      key(200, 'e-a'), key(200, 'e-b'), // 3: ring 1, first batch
      key(100, 'e-c'), key(100, 'e-d'), // 4: ring 0, the rest (centre cell first)
      key(101, 'e-c'), key(101, 'e-d'),
      key(200, 'e-c'), key(200, 'e-d'), // 5: ring 1, the rest
      key(300, 'e-a'), key(300, 'e-b'), // 6: ring 2, first batch only
    ],
  );
  for (const it of list) {
    assert.equal(it.key, `${it.pix}|${it.uri}`);
  }
});

test('skips uncovered and already loaded', () => {
  const view = fakeView();
  // Covers only the two ring-0 cells, so (200, e-x) and (300, e-x) must not appear.
  view.exposures.push({ uri: 'e-x', mjd: 60901.0, first: false, cells: [100, 101] });
  const have = new Set([key(100, 'e-a'), key(300, 'e-a')]);
  const list = priorityList(view, have);
  assert.equal(indexOf(list, 200, 'e-x'), -1);
  assert.equal(indexOf(list, 300, 'e-x'), -1);
  assert.equal(indexOf(list, 100, 'e-a'), -1);
  assert.equal(indexOf(list, 300, 'e-a'), -1);
  // The same exposure is still listed for cells it covers and that are not loaded.
  assert.notEqual(indexOf(list, 101, 'e-x'), -1);
  assert.notEqual(indexOf(list, 300, 'e-b'), -1);
});

test('ring 2 only first batch', () => {
  const list = priorityList(fakeView(), new Set());
  assert.notEqual(indexOf(list, 300, 'e-a'), -1);
  assert.notEqual(indexOf(list, 300, 'e-b'), -1);
  assert.equal(indexOf(list, 300, 'e-c'), -1);
  assert.equal(indexOf(list, 300, 'e-d'), -1);
});

test('concurrency never exceeds 8', async () => {
  let inflight = 0;
  let max = 0;
  const fetchFn = async () => {
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise((r) => setTimeout(r, 2));
    inflight -= 1;
  };
  const loader = new Loader({ fetchFn });
  loader.setQueue(priorityList(bigView(30), new Set()));
  const s = await waitSettled(loader, 30);
  assert.ok(max <= 8, `max in-flight was ${max}`);
  assert.deepEqual(s, { done: 30, total: 30, failed: 0 });
});

test('cancelOutside aborts and does not count failures', async () => {
  const view = {
    cell: 1,
    cells: [
      { pix: 1, ring: 0 },
      { pix: 2, ring: 1 },
    ],
    exposures: Array.from({ length: 10 }, (_, i) => ({
      uri: `u${i}`,
      mjd: 60000 + i,
      first: true,
      cells: [1, 2],
    })),
  };
  const signals = [];
  const fetchFn = (item, signal) =>
    new Promise((resolve, reject) => {
      signals.push({ item, signal });
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      setTimeout(() => resolve(), 5);
    });
  const loader = new Loader({ fetchFn });
  loader.setQueue(priorityList(view, new Set()));
  // Priority order puts all pix-1 items first, so the 8 in flight are pix 1.
  await new Promise((r) => setTimeout(r, 1));
  loader.cancelOutside(new Set([2]));
  const s = await waitSettled(loader, 10);
  assert.equal(s.failed, 0);
  assert.equal(s.done, 10);
  const aborted = signals.filter(({ item }) => item.pix === 1);
  assert.ok(aborted.length > 0, 'expected in-flight pix-1 items');
  for (const { signal } of aborted) {
    assert.equal(signal.aborted, true);
  }
});

test('failed items retry only on retryFailed', async () => {
  let calls = 0;
  const loader = new Loader({
    fetchFn: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  loader.setQueue(priorityList(bigView(2), new Set()));
  await waitSettled(loader, 2);
  assert.deepEqual(loader.stats, { done: 0, total: 2, failed: 2 });
  // Give any illegal automatic retry a chance to happen.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2, 'must not retry automatically');
  loader.retryFailed();
  assert.equal(loader.stats.failed, 0, 'retried items are no longer failed');
  await waitSettled(loader, 2);
  assert.equal(calls, 4);
  assert.deepEqual(loader.stats, { done: 0, total: 2, failed: 2 });
});

test('an item dropped by setQueue can be queued again before its abort settles', async () => {
  const started = [];
  const fetchFn = (item, signal) =>
    new Promise((resolve, reject) => {
      started.push(item.key);
      signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 5));
      setTimeout(resolve, 20);
    });
  const loader = new Loader({ fetchFn });
  const items = priorityList(bigView(1), new Set());
  loader.setQueue(items);
  loader.setQueue([]); // aborts the in-flight item
  loader.setQueue(items); // wanted again while the abort is still winding down
  const s = await waitSettled(loader, 1);
  assert.deepEqual(s, { done: 1, total: 1, failed: 0 });
  assert.equal(started.length, 2);
});

test('within a group the order is mjd-major across cells (R13)', () => {
  const covered = [100, 101, 102, 200, 201];
  const view = {
    cell: 100,
    cells: [
      { pix: 201, ring: 1 },
      { pix: 102, ring: 0 },
      { pix: 100, ring: 0 },
      { pix: 200, ring: 1 },
      { pix: 101, ring: 0 },
    ],
    exposures: [
      { uri: 'e-b', mjd: 2, first: true, cells: covered },
      { uri: 'e-a', mjd: 1, first: true, cells: covered },
      { uri: 'e-d', mjd: 4, first: false, cells: covered },
      { uri: 'e-c', mjd: 3, first: false, cells: covered },
    ],
  };
  const got = priorityList(view, new Set()).map((it) => it.key);
  assert.deepEqual(got, [
    key(100, 'e-a'), key(100, 'e-b'), // 1 centre cell
    key(101, 'e-a'), key(102, 'e-a'), key(101, 'e-b'), key(102, 'e-b'), // 2 other ring 0
    key(200, 'e-a'), key(201, 'e-a'), key(200, 'e-b'), key(201, 'e-b'), // 3 ring 1
    key(100, 'e-c'), key(100, 'e-d'), // 4 centre cell first ...
    key(101, 'e-c'), key(102, 'e-c'), key(101, 'e-d'), key(102, 'e-d'), // ... then other ring 0
    key(200, 'e-c'), key(201, 'e-c'), key(200, 'e-d'), key(201, 'e-d'), // 5 ring 1 rest
  ]);
});

test('setQueue drops failed entries the new queue no longer wants', async () => {
  let calls = 0;
  const loader = new Loader({
    fetchFn: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  loader.setQueue(priorityList(bigView(2), new Set()));
  await waitSettled(loader, 2);
  assert.equal(loader.stats.failed, 2);
  // New view wants only u0: u1's failure is stale and must not be retried.
  loader.setQueue(priorityList(bigView(2), new Set()).slice(0, 1));
  assert.deepEqual(loader.stats, { done: 0, total: 1, failed: 1 });
  loader.retryFailed();
  await waitSettled(loader, 1);
  assert.equal(calls, 3, 'only u0 is re-fetched');
});

test('setQueue ignores duplicate keys and concurrency is clamped', async () => {
  let inflight = 0;
  let max = 0;
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise((r) => setTimeout(r, 2));
    inflight -= 1;
  };
  const items = priorityList(bigView(3), new Set());
  const loader = new Loader({ fetchFn, concurrency: 0.4 });
  loader.setQueue([...items, ...items]);
  assert.equal(loader.stats.total, 3);
  await waitSettled(loader, 3);
  assert.equal(calls, 3);
  assert.equal(max, 1);
  assert.equal(new Loader({ fetchFn, concurrency: 99 }).concurrency, 8);
  assert.equal(new Loader({ fetchFn, concurrency: 3.7 }).concurrency, 3);
});

test('isPending: true while an item waits or is being fetched, false once it settles or is dropped', async () => {
  const release = {};
  const loader = new Loader({ concurrency: 1, fetchFn: (item) => new Promise((resolve) => { release[item.key] = resolve; }) });
  loader.setQueue([{ pix: 1, uri: 'a', key: '1|a' }, { pix: 1, uri: 'b', key: '1|b' }]);
  assert.equal(loader.isPending('1|a'), true); // in flight
  assert.equal(loader.isPending('1|b'), true); // waiting
  release['1|a']();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loader.isPending('1|a'), false); // done
  loader.setQueue([]);
  assert.equal(loader.isPending('1|b'), false); // dropped from the queue
});
