// Reuse decoded image inputs across view/band changes and bound Blob URL memory.
export function createFrameAssets({fetchFn,maxBytes=64*1024*1024,maxEntries=256,onEvict=()=>{}}) {
  const entries=new Map();let bytes=0,pinned=null,disposed=false;
  function drop(key) {
    const entry=entries.get(key);
    if(!entry) return;
    entries.delete(key);bytes-=entry.size;
    onEvict(key);URL.revokeObjectURL(entry.url);
  }
  function trim() {
    for(const key of entries.keys()) {
      if(entries.size<=maxEntries && bytes<=maxBytes) break;
      if(key!==pinned) drop(key);
    }
  }
  return {
    pin(key) {pinned=key;trim();},
    async load(address,signal) {
      if(disposed || signal?.aborted) throw new DOMException('Aborted','AbortError');
      const known=entries.get(address);
      if(known) {entries.delete(address);entries.set(address,known);return known;}
      const response=await fetchFn(address,{signal});
      if(!response.ok) throw Error(`HTTP ${response.status}`);
      const blob=await response.blob();
      if(disposed || signal?.aborted) throw new DOMException('Aborted','AbortError');
      if(entries.has(address)) return entries.get(address);
      let meta=null;
      try {meta=JSON.parse(response.headers.get('X-Frame-Meta') || 'null');} catch {}
      const entry={url:URL.createObjectURL(blob),meta,size:blob.size,address};
      entries.set(address,entry);bytes+=entry.size;trim();
      return entry;
    },
    clear() {disposed=true;for(const key of entries.keys()) drop(key);},
  };
}
