// Browser load queue for SPHEREx crops: decides what to fetch and in what
// order (priorityList), and runs the fetches with a concurrency cap (Loader).
// Pure logic: no DOM, no network of its own. The caller supplies fetchFn.
//
// No pixel data passes through here, so NaN does not apply.

const MAX_CONCURRENCY = 8;

const byMjd = (a, b) => a.mjd - b.mjd;
const byPix = (a, b) => a.pix - b.pix;

/**
 * Ordered list of crops still to load for a /api/view response.
 *
 * Only (pix, uri) pairs the exposure covers and that are not in `have`
 * (a Set of keys) are listed. Groups, highest priority first:
 *   1 centre cell, first batch      4 ring 0 rest (centre cell first)
 *   2 other ring 0, first batch     5 ring 1 rest
 *   3 ring 1, first batch           6 ring 2, first batch only
 * Within a group: by cell (pix), then by mjd. Ring 2 non-first exposures are
 * never listed.
 *
 * @param {{cell:number, cells:Array<{pix:number,ring:number}>,
 *          exposures:Array<{uri:string,mjd:number,first:boolean,cells:number[]}>}} view
 * @param {Set<string>} have keys `${pix}|${uri}` already loaded
 * @returns {Array<{pix:number, uri:string, key:string}>}
 */
export function priorityList(view, have) {
  const exposures = [...view.exposures].sort(byMjd);
  const covers = exposures.map((e) => new Set(e.cells));
  const cells = [...view.cells].sort(byPix);
  const centre = cells.filter((c) => c.pix === view.cell);
  const ring0 = cells.filter((c) => c.ring === 0);
  const ring0Other = ring0.filter((c) => c.pix !== view.cell);
  const ring0Ordered = [...centre, ...ring0Other];
  const ring1 = cells.filter((c) => c.ring === 1);
  const ring2 = cells.filter((c) => c.ring === 2);

  const out = [];
  const seen = new Set();
  const push = (cellList, wantFirst) => {
    for (const c of cellList) {
      exposures.forEach((e, i) => {
        if (e.first !== wantFirst) return;
        if (!covers[i].has(c.pix)) return;
        const key = `${c.pix}|${e.uri}`;
        if (have.has(key) || seen.has(key)) return;
        seen.add(key);
        out.push({ pix: c.pix, uri: e.uri, key });
      });
    }
  };

  push(centre, true); // 1
  push(ring0Other, true); // 2
  push(ring1, true); // 3
  push(ring0Ordered, false); // 4
  push(ring1, false); // 5
  push(ring2, true); // 6
  return out;
}

/**
 * Runs queued fetches with at most `concurrency` in flight.
 *
 * - No automatic retries: a rejected fetch counts as failed and stays failed
 *   until retryFailed().
 * - An aborted fetch (cancelOutside, or dropped by setQueue) is neither done
 *   nor failed.
 * - stats: done and failed are cumulative since the items were cancelled out;
 *   total = done + failed + waiting + in flight.
 */
export class Loader {
  /**
   * @param {{fetchFn:(item:object, signal:AbortSignal)=>Promise<any>,
   *          concurrency?:number, onLoaded?:(item:object, result:any)=>void,
   *          onFailed?:(item:object, err:any)=>void}} opts
   */
  constructor({ fetchFn, concurrency = MAX_CONCURRENCY, onLoaded, onFailed }) {
    this.fetchFn = fetchFn;
    this.concurrency = Math.min(concurrency, MAX_CONCURRENCY);
    this.onLoaded = onLoaded;
    this.onFailed = onFailed;
    this.waiting = []; // items not started yet, in priority order
    this.inflight = new Set(); // entries {item, controller, cancelled}; aborted ones stay until they settle
    this.done = new Map(); // key -> item
    this.failed = new Map(); // key -> item
  }

  get stats() {
    let live = 0;
    for (const entry of this.inflight) if (!entry.cancelled) live += 1;
    return {
      done: this.done.size,
      total: this.done.size + this.failed.size + this.waiting.length + live,
      failed: this.failed.size,
    };
  }

  /**
   * Replace the waiting queue with `items` (already in priority order).
   * Items already done, failed or in flight are not queued again. In-flight
   * items missing from `items` are aborted.
   */
  setQueue(items) {
    const wanted = new Set(items.map((it) => it.key));
    const running = new Set();
    for (const entry of this.inflight) {
      if (entry.cancelled) continue;
      if (wanted.has(entry.item.key)) running.add(entry.item.key);
      else this._abort(entry);
    }
    this.waiting = items.filter(
      (it) => !this.done.has(it.key) && !this.failed.has(it.key) && !running.has(it.key),
    );
    this._pump();
  }

  /** Drop everything (waiting, in flight, done, failed) whose pix is not in keepPix. */
  cancelOutside(keepPix) {
    this.waiting = this.waiting.filter((it) => keepPix.has(it.pix));
    for (const entry of this.inflight) {
      if (!entry.cancelled && !keepPix.has(entry.item.pix)) this._abort(entry);
    }
    for (const map of [this.done, this.failed]) {
      for (const [key, it] of map) if (!keepPix.has(it.pix)) map.delete(key);
    }
    this._pump();
  }

  /** Put failed items back at the front of the queue and try them once more. */
  retryFailed() {
    this.waiting = [...this.failed.values(), ...this.waiting];
    this.failed.clear();
    this._pump();
  }

  _abort(entry) {
    entry.cancelled = true;
    entry.controller.abort();
  }

  _pump() {
    while (this.inflight.size < this.concurrency && this.waiting.length > 0) {
      this._start(this.waiting.shift());
    }
  }

  _start(item) {
    const entry = { item, controller: new AbortController(), cancelled: false };
    this.inflight.add(entry);
    let promise;
    try {
      promise = Promise.resolve(this.fetchFn(item, entry.controller.signal));
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (result) => this._settle(entry, true, result),
      (err) => this._settle(entry, false, err),
    );
  }

  // The slot is released only when the fetch settles, so an aborted request
  // that is still winding down keeps counting toward the cap.
  _settle(entry, ok, value) {
    const { item } = entry;
    this.inflight.delete(entry);
    if (!entry.cancelled) {
      const cb = ok ? this.onLoaded : this.onFailed;
      if (ok) this.done.set(item.key, item);
      else this.failed.set(item.key, item);
      try {
        if (cb) cb(item, value);
      } catch {
        // A throwing callback must not stop the queue.
      }
    }
    this._pump();
  }
}
