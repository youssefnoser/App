// Frame loading for the Next.js sky view. It takes the sky that js/sky.js
// initSky() starts (the same engine setup index.html uses) and reuses that
// page's queue, photo cache and timeline. No engine maths lives here.
import { cachedFetch } from './frontend-cache.js';
import { createFrameAssets } from './frame-assets.js';
import { Loader, priorityList } from './queue.js';
import { PhotoCache } from './photos.js';
import { toHash } from './state.js';
import { buildSteps } from './timeline.js';
import { frameBox, boxCovers, boxOnScreen, LOAD_FOV_DEG } from './viewbox.js';

const DEG = 180 / Math.PI;
// Slack when testing whether a loaded box holds the canvas: 0.36 arcsec, a ninth of
// a frame pixel. The server rounds a box centre to 5 decimals of a degree.
const HOLD_SLACK_DEG = 1e-4;
export function frameAddress(sequence, uri, clean = false) {
  const p = new URLSearchParams({uri, ra:String(sequence.ra), dec:String(sequence.dec), fov:String(sequence.fov), roll:clean ? '4' : '0'});
  if (clean && sequence.wavelength != null) {
    p.set('wavelength', String(sequence.wavelength));
    p.set('width', String(sequence.width));
  }
  return `/api/frame.png?${p}`;
}

export function createBackendSky(sky, {
  onTimeline = () => {}, onStatus = () => {}, onView = () => {}, fetchFn = cachedFetch,
  schedule = requestAnimationFrame, cancel = cancelAnimationFrame,
} = {}) {
  const {stel, layer} = sky;
  let photos = new PhotoCache(layer, {cap:600});
  const applied = new Map();
  const assets = createFrameAssets({fetchFn,onEvict:address=>{
    for(const [key,entry] of photos.entries) if(entry.assetKey===address) {
      layer.remove(entry.photo);photos.entries.delete(key);
    }
  }});
  // Frames and photos are keyed `${box}|${uri}`: every sequence box has its own
  // cell id, so boxes from earlier views stay on screen next to the current one
  // (as on index.html) until the photo or blob caps drop them.
  const keyOf = uri => `${view?.cell}|${uri}`;
  const assetFor = uri => applied.get(keyOf(uri)) || (frames.has(keyOf(uri)) ? frameAddress(frames.get(keyOf(uri)),uri) : null);
  let loader;
  let disposed = false, generation = 0, request = null, animation = 0;
  let windows = [{wavelength:1.25,width:.05}], bandKey = '', lastRequest = null;
  let view = null, steps = [], currentUri = null, previous = null, lastMove = 0, settled = false;
  let visible = true, fill = true, upgrades = [], upgrading = 0, loadingPaused = false;
  // wanted: the exposure the user is looking at ({uri, mjd}); it is shown whenever a
  // box has it. drawn: the boxes whose photos are drawn (a Set of cells).
  let wanted = null, drawn = null;
  const frames = new Map(), metadata = new Map(); // frames: key -> box; metadata: uri -> X-Frame-Meta
  const boxes = new Map(); // cell -> {ra, dec, fov, bandKey}: every box asked for so far
  const report = (message) => { if (!disposed) onStatus(message); };
  function writeHash(index) {
    const centre = sky.viewCentre();
    const hash = toHash({...centre,fov:sky.fovDeg(),step:index});
    if (location.hash.slice(1) !== hash) history.replaceState(null,'',`#${hash}`);
  }
  function clearPhotos() {
    photos.showOnly(null);
    for (const {photo} of photos.entries.values()) layer.remove(photo);
    photos = new PhotoCache(layer, {cap:600});
  }
  // Loaded uris per box of the current bands, from the photos still in the cache.
  function loadedByBox() {
    const out = new Map();
    for (const [key,entry] of photos.entries) {
      const cell = Number(key.slice(0,key.indexOf('|')));
      if (boxes.get(cell)?.bandKey !== bandKey) continue;
      if (!out.has(cell)) out.set(cell,new Set());
      out.get(cell).add(entry.uri);
    }
    return out;
  }
  // The boxes the blink runs on, and the uris it may step through.
  //
  // One loaded box that holds the whole canvas, when there is one: each of its
  // frames fills the view, and drawing a single box keeps the picture still from
  // step to step. Two boxes are resampled on different pixel grids, so drawing one
  // over the other moves the sky by a fraction of a pixel wherever they overlap.
  // Boxes left from earlier views, perhaps abandoned half loaded, take nothing away.
  // Of several such boxes the one with the most frames wins, the current box on a tie.
  //
  // The box being loaded waits its turn until it has the exposure on screen, so the
  // picture does not hop to whichever frame happens to arrive first.
  //
  // With no such box (the new box is still empty), every box on screen is drawn
  // and all their uris are steps, so the picture carries over while it loads.
  function stage() {
    const canvas = stel.canvas, centre = sky.viewCentre(), fov = sky.fovDeg();
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const loaded = [...loadedByBox()];
    let best = null;
    for (const [cell,uris] of loaded) {
      const box = boxes.get(cell);
      if (!boxCovers({...box,fov:box.fov+HOLD_SLACK_DEG},centre,fov,width,height)) continue;
      if (cell===view?.cell && wanted && !uris.has(wanted.uri) && loader?.isPending(`${cell}|${wanted.uri}`)) continue;
      if (!best || uris.size>best.uris.size || (uris.size===best.uris.size && cell===view?.cell)) best = {cell,uris};
    }
    if (best) return {cells:new Set([best.cell]),uris:best.uris};
    const shown = loaded.filter(([cell])=>boxOnScreen(boxes.get(cell),centre,fov,width,height));
    return {cells:new Set(shown.map(([cell])=>cell)),uris:new Set(shown.flatMap(([,uris])=>[...uris]))};
  }
  const show = () => photos.showOnly(visible ? currentUri : null,drawn);
  // The loaded box of the current bands that holds the whole canvas and the most
  // frames, if any: asking for it again costs nothing, every cache already has it.
  function coveringBox(centre,fov,width,height) {
    let best = null, most = 0;
    for (const [cell,uris] of loadedByBox()) {
      const box = boxes.get(cell);
      if (uris.size > most && boxCovers(box,centre,fov,width,height)) {best = box; most = uris.size;}
    }
    return best;
  }
  function notify() {
    if (disposed || !view) return;
    const {cells,uris} = stage();
    drawn = cells;
    steps = buildSteps(view.exposures).filter(step=>uris.has(step.uri)).map(step=>({...step,meta:metadata.get(step.uri) || null}));
    // The wanted exposure if it is a step, else the step nearest to it in time.
    wanted ??= steps[0] ? {uri:steps[0].uri,mjd:steps[0].mjd} : null;
    const current = steps.find(step=>step.uri===wanted?.uri) ?? (steps.length
      ? steps.reduce((near,step)=>Math.abs(step.mjd-wanted.mjd)<Math.abs(near.mjd-wanted.mjd) ? step : near) : null);
    currentUri = current?.uri ?? null;
    const index = Math.max(0,steps.indexOf(current));
    show();
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
      const sequence = frames.get(item.key);
      if (!sequence || token !== generation) continue;
      upgrading++;
      const signal = request.signal;
      const url = frameAddress(sequence,item.uri,true);
      assets.load(url,signal,item.pix).then(asset=>{
        if (disposed || token !== generation || !fill) return;
        metadata.set(item.uri,asset.meta);
        applied.set(item.key,url);
        photos.replace(item.pix,item.uri,asset.url,
          {ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
        const entry=photos.entries.get(item.key);
        if(entry) entry.assetKey=url;
        notify();
      }).catch(()=>{}).finally(()=>{upgrading--;pumpUpgrades();});
    }
  }
  function makeLoader(token) {
    return new Loader({concurrency:8,fetchFn:(item,signal)=>assets.load(frameAddress(frames.get(item.key),item.uri),signal,item.pix),
    onLoaded:(item,asset)=>{
      if (disposed || token!==generation) return;
      const sequence=frames.get(item.key);
      // A box asked for again whose photo already shows the cleaned frame: leave it.
      // Rebuilding the photo would only make it flicker.
      if (fill && photos.entries.has(item.key) && applied.get(item.key)===frameAddress(sequence,item.uri,true)) {
        photos.ensure(item.pix,item.uri,asset.url,{ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
        notify();pumpUpgrades();
        return;
      }
      metadata.set(item.uri,asset.meta);
      applied.set(item.key,asset.address);
      photos.ensure(item.pix,item.uri,asset.url,
        {ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
      photos.entries.get(item.key).assetKey=asset.address;
      upgrades.push({item,token});
      notify();pumpUpgrades();
    },onFailed:()=>{if(token===generation){notify();pumpUpgrades();}}});
  }
  // `reuse`: a loaded box that covers the view, asked for instead of a new one.
  async function refresh(centre,fov,aspect=1,reuse=null) {
    if (disposed) return;
    generation++;
    const token = generation;
    request?.abort(); loader?.setQueue([]);
    request = new AbortController();
    const signal = request.signal;
    // Loaded frames stay on screen: the new box is added to them, and the
    // timeline and current step carry over until its answer arrives.
    upgrades=[];
    lastRequest = {...centre,fov};
    if (fov >= LOAD_FOV_DEG || !visible) {steps=[];view=null;onTimeline({steps:[],index:0});writeHash(0);report(visible ? 'Zoom in to load SPHEREx frames for this part of the sky.' : 'Showing the SPHEREx all-sky background.');return;}
    report('Finding SPHEREx exposures for the selected bands.');
    // aspect is the canvas diagonal divided by its short side.
    const boxFov = reuse ? reuse.fov : frameBox(fov, Math.sqrt(Math.max(0, aspect * aspect - 1)), 1);
    if (boxFov == null) {report('Zoom in to load SPHEREx frames for this part of the sky.');return;}
    if (reuse) centre = {ra:reuse.ra, dec:reuse.dec};
    // The box being asked for. The settle check tests coverage against this one,
    // not the box still on screen, so it is requested once while it loads.
    lastRequest.box = {ra:centre.ra, dec:centre.dec, fov:boxFov};
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
      const {ra,dec,fov:side}=first.sequence;
      boxes.set(first.cell,{ra,dec,fov:side,bandKey});
      const exposures=new Map();
      for(const answer of answers) for(const exposure of answer.exposures) {
        if(exposures.has(exposure.uri)) continue;
        exposures.set(exposure.uri,{...exposure,cells:[first.cell]});
        frames.set(`${first.cell}|${exposure.uri}`,answer.sequence);
      }
      view={...first,exposures:[...exposures.values()]};
      assets.pin(first.cell); // the box on screen is never evicted
      loader=makeLoader(token);
      // The exposure on screen first, so this box can take over the picture soonest.
      const queue=priorityList(view,new Set());
      loader.setQueue([...queue.filter(item=>item.uri===wanted?.uri),...queue.filter(item=>item.uri!==wanted?.uri)]);
      notify();
    } catch(error) {
      if(disposed || token!==generation || signal.aborted) return;
      request.abort();
      report('The SPHEREx backend did not answer. Recenter to try again.');
    }
  }
  function tick(now) {
    if(disposed) return;
    const centre=sky.viewCentre(), fov=sky.fovDeg();
    const canvas=stel.canvas;
    const moved=!previous || Math.abs(centre.ra-previous.ra)>1e-6 || Math.abs(centre.dec-previous.dec)>1e-6 || Math.abs(fov-previous.fov)>1e-6;
    if(moved) {
      previous={...centre,fov};lastMove=now;settled=false;onView(centre);
      // While the view moves, the box drawn may stop holding the canvas: draw its neighbours too.
      if(view && fov<LOAD_FOV_DEG) {drawn=stage().cells;show();}
    }
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
      // Which boxes are on screen changed with the view: so may the shared steps.
      if(!settled) {settled=true;notify();}
      const dx=lastRequest ? Math.abs(((centre.ra-lastRequest.ra+540)%360)-180)*Math.cos(centre.dec/DEG) : Infinity;
      const dy=lastRequest ? Math.abs(centre.dec-lastRequest.dec) : Infinity;
      const box=lastRequest?.box;
      const needsFrames = box && fov < LOAD_FOV_DEG
        ? !boxCovers(box,centre,fov,canvas.clientWidth,canvas.clientHeight)
        : dx>.0125 || dy>.0125 || (lastRequest && Math.abs(fov/lastRequest.fov-1)>.1);
      if(!lastRequest || needsFrames) {
        const aspect=Math.hypot(canvas.clientWidth,canvas.clientHeight)/Math.max(1,Math.min(canvas.clientWidth,canvas.clientHeight));
        refresh(centre,fov,aspect,coveringBox(centre,fov,canvas.clientWidth,canvas.clientHeight));
      }
    }
    layer.visible=!paused;
    animation=schedule(tick);
  }
  animation=schedule(tick);
  return {
    refresh,
    setBands(next,backgroundFrame) {
      const key=JSON.stringify(next);
      if(key!==bandKey) {bandKey=key;windows=next;lastRequest=null;lastMove=performance.now();generation++;request?.abort();loader?.setQueue([]);}
      sky.core.dss.frame=backgroundFrame;
    },
    setVisible(value) {
      if(visible===value) return;
      visible=value;layer.visible=value;
      if(!value) {request?.abort();loader?.setQueue([]);} else lastRequest=null;
    },
    setFill(value) {
      if (fill === value) return;
      fill=value;
      if (value) pumpUpgrades();
      else {
        upgrades=[];
        for (const item of loader?.done.values() ?? []) {
          const sequence=frames.get(item.key);
          if (!sequence) continue;
          const address=frameAddress(sequence,item.uri);
          applied.set(item.key,address);
          const token=generation;
          assets.load(address,request.signal,item.pix).then(asset=>{
            if(disposed || token!==generation || fill) return;
            photos.replace(item.pix,item.uri,asset.url,{ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
            const entry=photos.entries.get(item.key);if(entry) entry.assetKey=address;
          }).catch(()=>{});
          upgrades.push({item,token:generation});
        }
      }
    },
    showFrame(index) {
      const step=steps[index] ?? steps[0];
      // A step other than the one on screen is the user's (or the blink's) choice.
      if (step && step.uri!==currentUri) wanted={uri:step.uri,mjd:step.mjd};
      currentUri=step?.uri ?? null;
      const sequence=frames.get(keyOf(currentUri));
      const address=assetFor(currentUri);
      if (sequence && view && address && loader.done.has(`${view.cell}|${currentUri}`) && !photos.entries.has(`${view.cell}|${currentUri}`)) {
        const uri=currentUri,pix=view.cell,token=generation;
        assets.load(address,request.signal,pix).then(asset=>{
          if(disposed || token!==generation || currentUri!==uri) return;
          photos.ensure(pix,uri,asset.url,{ra:sequence.ra,dec:sequence.dec,orientation:0,pixscale:3.075});
          photos.entries.get(`${pix}|${uri}`).assetKey=address;
          show();
        }).catch(()=>{});
      }
      show();
      writeHash(index);
    },
    retry() {lastRequest=null;},
    destroy() {disposed=true;generation++;request?.abort();loader?.setQueue([]);cancel(animation);upgrades=[];clearPhotos();assets.clear();layer.visible=false;},
  };
}
