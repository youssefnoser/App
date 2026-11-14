// React adapter for the index.html viewer. Reuse its queue, photo cache and
// timeline; leave both page shells and all science processing unchanged.
import { cachedFetch } from './frontend-cache.js';
import { createFrameAssets } from './frame-assets.js';
import { Loader, priorityList } from './queue.js';
import { PhotoCache } from './photos.js';
import { toHash } from './state.js';
import { buildSteps } from './timeline.js';
import { frameBox, boxCovers, LOAD_FOV_DEG } from './viewbox.js';

export const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const DEG = 180 / Math.PI;
export function readSkyCentre(stel) {
  const mount = stel.s2c(stel.core.observer.yaw, stel.core.observer.pitch);
  const astrom = stel.convertFrame(stel.observer, 'CIRS', 'ASTROM', mount);
  const [ra, dec] = stel.c2s(astrom);
  return { ra: stel.anp(ra) * DEG, dec: dec * DEG };
}
export function pointSky(stel, { ra, dec }) {
  const astrom = stel.s2c(ra / DEG, dec / DEG);
  stel.lookAt(stel.convertFrame(stel.observer, 'ASTROM', 'CIRS', astrom), 0);
}
export function frameAddress(sequence, uri, clean = false) {
  const p = new URLSearchParams({uri, ra:String(sequence.ra), dec:String(sequence.dec), fov:String(sequence.fov), roll:clean ? '4' : '0'});
  if (clean && sequence.wavelength != null) {
    p.set('wavelength', String(sequence.wavelength));
    p.set('width', String(sequence.width));
  }
  return `/api/frame.png?${p}`;
}

export function createBackendSky(stel, {
  onTimeline = () => {}, onStatus = () => {}, onView = () => {}, fetchFn = cachedFetch,
  schedule = requestAnimationFrame, cancel = cancelAnimationFrame,
} = {}) {
  const layer = stel.createLayer({id:'spherex-frames', z:7, visible:true});
  let photos = new PhotoCache(layer, {cap:600});
  const applied = new Map();
  const assets = createFrameAssets({fetchFn,onEvict:address=>{
    for(const [key,entry] of photos.entries) if(entry.assetKey===address) {
      layer.remove(entry.photo);photos.entries.delete(key);
    }
  }});
  const assetFor = uri => applied.get(uri) || (frames.has(uri) ? frameAddress(frames.get(uri),uri) : null);
  let loader;
  let disposed = false, generation = 0, request = null, animation = 0;
  let windows = [{wavelength:1.25,width:.05}], bandKey = '', lastRequest = null;
  let view = null, steps = [], currentUri = null, previous = null, lastMove = 0;
  let visible = true, fill = true, upgrades = [], upgrading = 0, loadingPaused = false;
  const frames = new Map(), metadata = new Map();
  const report = (message) => { if (!disposed) onStatus(message); };
  function writeHash(index) {
    if (!globalThis.location || !globalThis.history) return;
    const centre = readSkyCentre(stel);
    const hash = toHash({...centre,fov:stel.core.fov*DEG,step:index});
    if (location.hash.slice(1) !== hash) history.replaceState(null,'',`#${hash}`);
  }
  function clearPhotos() {
    photos.showOnly(null);
    for (const {photo} of photos.entries.values()) layer.remove(photo);
    photos = new PhotoCache(layer, {cap:600});
  }
  function notify() {
    if (disposed || !view) return;
    const loaded = new Set([...loader.done.values()].map(item=>item.uri));
    steps = buildSteps(view.exposures).filter(step=>loaded.has(step.uri)).map(step=>({...step,meta:metadata.get(step.uri) || null}));
    if (!steps.some(step=>step.uri===currentUri)) currentUri = steps[0]?.uri ?? null;
    const index = Math.max(0,steps.findIndex(step=>step.uri===currentUri));
    assets.pin(assetFor(currentUri));
    photos.showOnly(visible ? currentUri : null);
    onTimeline({steps,index});
    const {done,total,failed} = loader.stats;
    report(failed ? `${done} of ${total} frames loaded. ${failed} failed. Recenter to retry.` :
      done < total ? `Loading SPHEREx frames: ${done} of ${total}.` :
      total ? `${done} SPHEREx frames loaded.` : 'No SPHEREx exposures in the selected bands here.');
  }
  function pumpUpgrades() {
    if (disposed || !fill || !loader || loader.stats.done + loader.stats.failed < loader.stats.total) return;
    while (upgrading < 4 && upgrades.length) {
      const {item,token} = upgrades.shift();
      const sequence = frames.get(item.uri);
      if (!sequence || token !== generation) continue;
      upgrading++;
      const signal = request.signal;
      const url = frameAddress(sequence,item.uri,true);
      assets.load(url,signal).then(asset=>{
        if (disposed || token !== generation || !fill) return;
        metadata.set(item.uri,asset.meta);
        applied.set(item.uri,url);
        if(currentUri===item.uri) assets.pin(url);
        photos.replace(item.pix,item.uri,asset.url,
          {ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
        const entry=photos.entries.get(item.key);
        if(entry) entry.assetKey=url;
        notify();
      }).catch(()=>{}).finally(()=>{upgrading--;pumpUpgrades();});
    }
  }
  function makeLoader(token) {
    return new Loader({concurrency:8,fetchFn:(item,signal)=>assets.load(frameAddress(frames.get(item.uri),item.uri),signal),
    onLoaded:(item,asset)=>{
      if (disposed || token!==generation) return;
      const sequence=frames.get(item.uri);
      metadata.set(item.uri,asset.meta);
      applied.set(item.uri,asset.address);
      photos.ensure(item.pix,item.uri,asset.url,
        {ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
      photos.entries.get(item.key).assetKey=asset.address;
      upgrades.push({item,token});
      notify();pumpUpgrades();
    },onFailed:()=>{if(token===generation){notify();pumpUpgrades();}}});
  }
  async function refresh(centre,fov,aspect=1) {
    if (disposed) return;
    generation++;
    const token = generation;
    request?.abort(); loader?.setQueue([]);
    request = new AbortController();
    const signal = request.signal;
    upgrades=[]; frames.clear(); metadata.clear(); applied.clear(); clearPhotos();
    steps=[];view=null;currentUri=null;
    onTimeline({steps:[],index:0});
    lastRequest = {...centre,fov};
    writeHash(0);
    if (fov >= LOAD_FOV_DEG || !visible) {report(visible ? 'Zoom in to load SPHEREx frames for this part of the sky.' : 'Showing the SPHEREx all-sky background.');return;}
    report('Finding SPHEREx exposures for the selected bands.');
    // aspect is the canvas diagonal divided by its short side.
    const boxFov = frameBox(fov, Math.sqrt(Math.max(0, aspect * aspect - 1)), 1);
    if (boxFov == null) {report('Zoom in to load SPHEREx frames for this part of the sky.');return;}
    try {
      // Four metadata queries at a time; crop downloads use the original cap of eight.
      const answers = new Array(windows.length);
      let next = 0;
      await Promise.all(Array.from({length:Math.min(4,windows.length)},async()=>{
        while(next<windows.length) {
          const i=next++, window=windows[i];
          const params=new URLSearchParams({ra:centre.ra.toFixed(5),dec:centre.dec.toFixed(5),fov:boxFov.toFixed(4),...Object.fromEntries(Object.entries(window).filter(([key])=>!(key==='detector' && window.wavelength!=null)).map(([key,value])=>[key,String(value)]))});
          const response=await fetchFn(`/api/sequence?${params}`,{signal});
          if(!response.ok) throw Error(`HTTP ${response.status}`);
          answers[i]=await response.json();
          if(window.detector) answers[i].exposures=answers[i].exposures.filter(exposure=>exposure.detector===window.detector);
        }
      }));
      if(disposed || token!==generation) return;
      const first=answers[0];
      if (!first?.sequence || !Array.isArray(first.exposures)) throw Error('Invalid sequence response');
      const exposures=new Map();
      for(const answer of answers) for(const exposure of answer.exposures) {
        if(exposures.has(exposure.uri)) continue;
        exposures.set(exposure.uri,{...exposure,cells:[first.cell]});
        frames.set(exposure.uri,answer.sequence);
      }
      view={...first,exposures:[...exposures.values()]};
      loader=makeLoader(token);
      loader.setQueue(priorityList(view,new Set()));
      notify();
    } catch(error) {
      if(disposed || token!==generation || signal.aborted) return;
      request.abort();
      report('The SPHEREx backend did not answer. Recenter to try again.');
    }
  }
  function tick(now) {
    if(disposed) return;
    const centre=readSkyCentre(stel), fov=stel.core.fov*DEG;
    const canvas=stel.canvas || globalThis.document?.getElementById('stel-canvas');
    const moved=!previous || Math.abs(centre.ra-previous.ra)>1e-6 || Math.abs(centre.dec-previous.dec)>1e-6 || Math.abs(fov-previous.fov)>1e-6;
    if(moved) {previous={...centre,fov};lastMove=now;onView(centre);}
    // Leaving frame scale cancels the queue. Invalidate its coverage too, so a
    // quick return to the same box cannot mistake a cancelled queue for a live one.
    const paused = fov >= LOAD_FOV_DEG || !visible;
    if (paused && !loadingPaused) {
      generation++;request?.abort();loader?.setQueue([]);upgrades=[];
      lastRequest=null;
    }
    if (!paused && loadingPaused) lastRequest=null;
    loadingPaused=paused;
    if(!moved && now-lastMove>=300) {
      const dx=lastRequest ? Math.abs(((centre.ra-lastRequest.ra+540)%360)-180)*Math.cos(centre.dec/DEG) : Infinity;
      const dy=lastRequest ? Math.abs(centre.dec-lastRequest.dec) : Infinity;
      const box=view?.sequence;
      const needsFrames = box && canvas && fov < LOAD_FOV_DEG
        ? !boxCovers(box,centre,fov,canvas.clientWidth,canvas.clientHeight)
        : dx>.0125 || dy>.0125 || (lastRequest && Math.abs(fov/lastRequest.fov-1)>.1);
      if(!lastRequest || needsFrames) {
        const aspect=canvas ? Math.hypot(canvas.clientWidth,canvas.clientHeight)/Math.max(1,Math.min(canvas.clientWidth,canvas.clientHeight)) : 1;
        refresh(centre,fov,aspect);
      }
    }
    // A photo is a fixed sky box. Once its edge enters the viewport, leave
    // the survey visible until a replacement covering the whole view arrives.
    // Otherwise the old sharp frame is drawn as a rectangle over the survey.
    const coversView = !view?.sequence || !canvas ||
      boxCovers(view.sequence,centre,fov,canvas.clientWidth,canvas.clientHeight);
    layer.visible=!paused && coversView;
    if (!paused && !coversView && moved) report('Updating SPHEREx frames for this view.');
    animation=schedule(tick);
  }
  animation=schedule(tick);
  return {
    refresh,
    setBands(next,backgroundFrame) {
      const key=JSON.stringify(next);
      if(key!==bandKey) {bandKey=key;windows=next.length?next:[{wavelength:1.25,width:.05}];lastRequest=null;lastMove=globalThis.performance?.now() || 0;generation++;request?.abort();loader?.setQueue([]);}
      if(stel.core.dss) stel.core.dss.frame=backgroundFrame;
    },
    setVisible(value) {
      if(visible===value) return;
      visible=value;layer.visible=value;
      if(stel.core.dss) stel.core.dss.visible=true;
      if(!value) {request?.abort();loader?.setQueue([]);} else lastRequest=null;
    },
    setFill(value) {
      if (fill === value) return;
      fill=value;
      if (value) pumpUpgrades();
      else {
        upgrades=[];
        for (const item of loader?.done.values() ?? []) {
          const sequence=frames.get(item.uri);
          if (!sequence) continue;
          const address=frameAddress(sequence,item.uri);
          applied.set(item.uri,address);
          const token=generation;
          assets.load(address,request.signal).then(asset=>{
            if(disposed || token!==generation || fill) return;
            photos.replace(item.pix,item.uri,asset.url,{ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
            const entry=photos.entries.get(item.key);if(entry) entry.assetKey=address;
          }).catch(()=>{});
          upgrades.push({item,token:generation});
        }
      }
    },
    showFrame(index) {
      currentUri=steps[index]?.uri ?? steps[0]?.uri ?? null;
      const sequence=frames.get(currentUri);
      const address=assetFor(currentUri);
      assets.pin(address);
      if (sequence && view && address && loader.done.has(`${view.cell}|${currentUri}`) && !photos.entries.has(`${view.cell}|${currentUri}`)) {
        const uri=currentUri,pix=view.cell,token=generation;
        assets.load(address,request.signal).then(asset=>{
          if(disposed || token!==generation || currentUri!==uri) return;
          photos.ensure(pix,uri,asset.url,{ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
          photos.entries.get(`${pix}|${uri}`).assetKey=address;
          photos.showOnly(visible?currentUri:null);
        }).catch(()=>{});
      }
      photos.showOnly(visible?currentUri:null);
      writeHash(index);
    },
    retry() {lastRequest=null;},
    destroy() {disposed=true;generation++;request?.abort();loader?.setQueue([]);cancel(animation);upgrades=[];clearPhotos();assets.clear();layer.visible=false;},
  };
}
