// Browser-owned, bounded response cache. Failed/aborted requests are never saved.
// PNGs live for a day; exposure lists for five minutes; targets for one hour.
const CACHE_NAME = 'spherex-frontend-v1';
const STAMP = 'X-Spherex-Cached-At';
const encoder = new TextEncoder();
function canonical(input) {
  const url = new URL(String(input), globalThis.location?.origin || 'http://localhost');
  url.searchParams.sort();
  return url.href;
}
function lifetime(key) {
  const path = new URL(key).pathname;
  return path.endsWith('.png') ? 86400000 : path.endsWith('/targets') ? 3600000 : 300000;
}
export function createFrontendCache({
  fetchFn = (...args) => fetch(...args), storage = globalThis.caches,
  maxBytes = 64 * 1024 * 1024, maxEntries = 512, now = Date.now,
} = {}) {
  const entries = new Map(), pending = new Map();
  let bytes = 0, diskPromise, diskIndexPromise;
  const diskIndex = new Map();
  let diskWrites = Promise.resolve();
  const disk = () => diskPromise ??= storage ? storage.open(CACHE_NAME).catch(() => null) : Promise.resolve(null);
  function remember(key, entry) {
    const old = entries.get(key);
    if (old) {bytes -= old.size; entries.delete(key);}
    if (entry.size > maxBytes) return;
    entries.set(key, entry); bytes += entry.size;
    while (entries.size > maxEntries || bytes > maxBytes) {
      const first = entries.keys().next().value;
      bytes -= entries.get(first).size; entries.delete(first);
    }
  }
  const responseOf = entry => new Response(entry.body.slice(0), {status:entry.status,headers:entry.headers});
  async function saveDisk(key, entry) {
    const cache = await disk();
    if (!cache || entry.size > maxBytes) return;
    const headers = new Headers(entry.headers);
    headers.set(STAMP,String(entry.saved));
    headers.set('X-Spherex-Body-Bytes',String(entry.body.byteLength));
    try {
      diskIndexPromise ??= (async()=>{
        for (const request of await cache.keys()) {
          const item=await cache.match(request);
          diskIndex.set(request.url,Number(item?.headers.get('X-Spherex-Body-Bytes') || 0));
        }
      })();
      await diskIndexPromise;
      // Maintain the size index instead of rescanning every PNG on every write.
      await cache.delete(key);
      await cache.put(key,new Response(entry.body.slice(0),{status:entry.status,headers}));
      diskIndex.delete(key);diskIndex.set(key,entry.body.byteLength);
      let diskBytes=[...diskIndex.values()].reduce((sum,size)=>sum+size,0);
      for (const [oldKey,size] of diskIndex) {
        if(diskIndex.size<=maxEntries && diskBytes<=maxBytes) break;
        await cache.delete(oldKey);diskIndex.delete(oldKey);diskBytes-=size;
      }
    } catch { /* Quota or private browsing: memory caching still works. */ }
  }
  async function resolve(key, signal) {
    const cached = entries.get(key);
    if (cached && now()-cached.saved < lifetime(key)) {
      entries.delete(key);entries.set(key,cached);return cached;
    }
    if (cached) {entries.delete(key);bytes-=cached.size;}
    const cache = await disk();
    if (signal.aborted) throw signal.reason;
    if (cache) {
      try {
        const response = await cache.match(key);
        const stamp = Number(response?.headers.get(STAMP));
        if (response && response.headers.has(STAMP) && now()-stamp < lifetime(key)) {
          const body=await response.arrayBuffer();
          const entry={body,status:response.status,headers:[...response.headers],saved:stamp,size:body.byteLength};
          remember(key,entry);return entry;
        }
        if (response) {await cache.delete(key);diskIndex.delete(key);}
      } catch { /* A cache storage failure must not block the map. */ }
    }
    if (signal.aborted) throw signal.reason;
    const response = await fetchFn(key,{signal});
    const body = await response.arrayBuffer();
    if (signal.aborted) throw signal.reason;
    const entry = {body,status:response.status,headers:[...response.headers],saved:now(),size:body.byteLength+encoder.encode(JSON.stringify([...response.headers])).byteLength};
    if (response.ok) {
      remember(key,entry);
      // Serialize writes so concurrent downloads cannot race the disk limit.
      const write = diskWrites.then(()=>saveDisk(key,entry));
      diskWrites=write.catch(()=>{});
      await write;
    }
    return entry;
  }
  return {
    fetch(input, {signal} = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted','AbortError'));
      const key = canonical(input);
      let shared = pending.get(key);
      if (!shared || shared.controller.signal.aborted) {
        const controller=new AbortController();
        shared={controller,consumers:0,promise:null};
        const current=shared;
        shared.promise=resolve(key,controller.signal).finally(()=>{if(pending.get(key)===current) pending.delete(key);});
        pending.set(key,shared);
      }
      shared.consumers++;
      return new Promise((resolve,reject)=>{
        let finished=false;
        const release=()=>{
          if(finished) return false;
          finished=true;signal?.removeEventListener('abort',abort);
          shared.consumers--;return true;
        };
        const abort=()=>{
          if(!release()) return;
          if(shared.consumers===0) shared.controller.abort();
          reject(signal.reason || new DOMException('Aborted','AbortError'));
        };
        signal?.addEventListener('abort',abort,{once:true});
        shared.promise.then(entry=>{if(release()) resolve(responseOf(entry));},error=>{if(release()) reject(error);});
      });
    },
  };
}
const frontendCache=createFrontendCache();
export const cachedFetch=(input,options)=>frontendCache.fetch(input,options);
