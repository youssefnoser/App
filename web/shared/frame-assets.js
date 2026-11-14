// Reuse decoded image inputs across view/band changes and bound Blob URL memory.
//
// Images belong to a group (the sequence box they were cut for) and are evicted a
// whole group at a time, least recently used first. A box that lost only some of
// its frames would leave holes in the blink. The pinned group, the box on screen,
// is never evicted, so the limits are a budget for the earlier boxes: one wide box
// of a whole detector alone can be larger than the budget.
export function createFrameAssets({fetchFn,maxBytes=64*1024*1024,maxEntries=1024,onEvict=()=>{}}) {
  const entries=new Map();let bytes=0,pinned=null,disposed=false;
  const groups=new Map(); // group -> Set of addresses; insertion order is least recently used first
  function touch(group) {
    const members=groups.get(group) ?? new Set();
    groups.delete(group);groups.set(group,members);
    return members;
  }
  function dropGroup(group) {
    for(const key of groups.get(group) ?? []) {
      const entry=entries.get(key);
      entries.delete(key);bytes-=entry.size;
      onEvict(key);URL.revokeObjectURL(entry.url);
    }
    groups.delete(group);
  }
  function trim() {
    for(const group of [...groups.keys()]) {
      if(entries.size<=maxEntries && bytes<=maxBytes) break;
      if(group!==pinned) dropGroup(group);
    }
  }
  return {
    /** Keep this group whatever the budget. An address loaded without a group is its own group. */
    pin(group) {pinned=group;if(groups.has(group)) touch(group);trim();},
    async load(address,signal,group=address) {
      if(disposed || signal?.aborted) throw new DOMException('Aborted','AbortError');
      const known=entries.get(address);
      if(known) {touch(known.group);return known;}
      const response=await fetchFn(address,{signal});
      if(!response.ok) throw Error(`HTTP ${response.status}`);
      const blob=await response.blob();
      if(disposed || signal?.aborted) throw new DOMException('Aborted','AbortError');
      if(entries.has(address)) return entries.get(address);
      let meta=null;
      try {meta=JSON.parse(response.headers.get('X-Frame-Meta') || 'null');} catch {}
      const entry={url:URL.createObjectURL(blob),meta,size:blob.size,address,group};
      entries.set(address,entry);bytes+=entry.size;touch(group).add(address);trim();
      return entry;
    },
    clear() {disposed=true;for(const group of [...groups.keys()]) dropGroup(group);},
  };
}
