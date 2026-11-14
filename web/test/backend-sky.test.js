import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendCache } from '../js/frontend-cache.js';
import { createBackendSky, frameAddress } from '../js/backend-sky.js';

// The adapter keeps the page hash in step with the view; Node has neither.
globalThis.location = {hash:''};
globalThis.history = {replaceState:(_s,_t,url)=>{globalThis.location.hash=url;}};

// What js/sky.js makeSky() hands over, built on a fake engine whose frame
// conversions are the identity: the view centre is yaw/pitch in degrees. The real
// engine always has its canvas; fakes without one get a square 800 px canvas.
const skyOf = (stel) => ({
 stel: Object.assign(stel, {canvas: stel.canvas ?? {clientWidth:800,clientHeight:800}}), core: stel.core, layer: stel.createLayer({id:'spherex-frames'}),
 viewCentre: () => ({ra: stel.core.observer.yaw*180/Math.PI, dec: stel.core.observer.pitch*180/Math.PI}),
 fovDeg: () => stel.core.fov*180/Math.PI,
});

test('sequence frame URLs preserve coordinates and the median wavelength window', () => {
 const sequence = {ra:269.4,dec:4.7,fov:.15,wavelength:1.25,width:.05};
 const single = new URL(frameAddress(sequence, 'ibe/a b.fits', false), 'http://localhost');
 assert.equal(single.searchParams.get('roll'),'0');
 assert.equal(single.searchParams.get('uri'),'ibe/a b.fits');
 const median = new URL(frameAddress(sequence,'ibe/test.fits',true), 'http://localhost');
 assert.equal(median.searchParams.get('roll'),'4');
 assert.equal(median.searchParams.get('wavelength'),'1.25');
 assert.equal(median.searchParams.get('width'),'0.05');
 assert.equal(median.searchParams.get('fov'),'0.15');
});

test('frames go on the shared sky layer; the adapter makes no layer of its own', () => {
 let made=0;
 const layer={visible:true,add:()=>({}),remove:()=>{}};
 const stel={core:{fov:1,observer:{yaw:0,pitch:0},dss:{}},createLayer:()=>{made++;return layer;}};
 const sky=skyOf(stel);
 const controller=createBackendSky(sky,{schedule:()=>0,cancel:()=>{}});
 assert.equal(made,1);
 controller.setVisible(false);
 assert.equal(sky.layer.visible,false);
 controller.destroy();
});

test('real frames arrive progressively, expose metadata, and cancel on disposal', async () => {
 const photos=[]; const timelines=[];const statuses=[];const addresses=[];
 let finishSecond;
 const layer={visible:true,add:(_type,args)=>{const p={...args};photos.push(p);return p;},remove:()=>{}};
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},
 s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_o,_f,_t,v)=>v,createLayer:()=>layer};
 const seq={cell:-1,sequence:{ra:180/Math.PI,dec:0,fov:.2,wavelength:1.25,width:.05},cells:[{pix:-1,ra:180/Math.PI,dec:0,ring:0}],
 exposures:[{uri:'one',mjd:1,date:'2025-01-01',detector:2,first:true,cells:[-1]},{uri:'two',mjd:2,date:'2025-02-01',detector:2,first:true,cells:[-1]}]};
 const fetchFn=async(url,options)=>{
   addresses.push(String(url));
   if(String(url).includes('/sequence')) return Response.json(seq);
   if(String(url).includes('uri=two')) await new Promise(resolve=>{finishSecond=resolve;options.signal.addEventListener('abort',resolve,{once:true});});
   return new Response(new Uint8Array([1]),{headers:{'X-Frame-Meta':'{"wavelength_um":1.25,"detector":2}'}});
 };
 const controller=createBackendSky(skyOf(stel),{fetchFn,onTimeline:t=>timelines.push(t),onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
 controller.setBands([{wavelength:1.25,width:.05}],20);
 await controller.refresh({ra:180/Math.PI,dec:0},.15,1);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(timelines.at(-1).steps.length,1);
 assert.equal(timelines.at(-1).steps[0].meta.wavelength_um,1.25);
 assert.equal(photos[0].calibration.orientation,0);
 assert.equal(photos[0].calibration.pixscale,3.075);
 assert.equal(photos[0].visible,true);
 assert(addresses.some(url=>url.includes('/api/frame.png')));
 controller.destroy();
 const count=timelines.length;
 finishSecond?.();
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(timelines.length,count);
 assert(photos.every(p=>!p.visible));
});


test('zoomed-out views fetch no crops and backend failures expose a retry message', async () => {
 const statuses=[];let calls=0;
 const layer={visible:true,add:()=>({}),remove:()=>{}};
 const stel={core:{fov:Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const controller=createBackendSky(skyOf(stel),{fetchFn:async()=>{calls++;return new Response('',{status:502});},onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
 await controller.refresh({ra:30,dec:20},1);
 assert.equal(calls,0);
 assert(statuses.at(-1).includes('Zoom in'));
 await controller.refresh({ra:30,dec:20},.15);
 assert.equal(calls,1);
 assert(statuses.at(-1).includes('Recenter'));
 controller.destroy();
});

test('multiple selected detectors share a bounded metadata queue and deduplicate exposure URIs', async () => {
 const statuses=[];const timelines=[];let running=0,max=0;
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:30*Math.PI/180,pitch:20*Math.PI/180},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const fetchFn=async(url)=>{
   if(!url.includes('/sequence')) return new Response(new Uint8Array([1]));
   running++;max=Math.max(max,running);
   await new Promise(resolve=>setTimeout(resolve,5));running--;
   return Response.json({cell:-1,sequence:{ra:30,dec:20,fov:.2,detector:1},cells:[{pix:-1,ra:30,dec:20,ring:0}],exposures:[{uri:'shared',mjd:1,date:'2025-01-01',detector:1,first:true,cells:[-1]}]});
 };
 const controller=createBackendSky(skyOf(stel),{fetchFn,onTimeline:t=>timelines.push(t),onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 controller.setBands([1,2,3,4,5,6].map(detector=>({detector})),0);
 await controller.refresh({ra:30,dec:20},.15);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert(max<=4);
 assert.equal(timelines.at(-1).steps.length,1);
 assert(statuses.at(-1).includes('1 SPHEREx frames'));
 controller.destroy();
});


test('background-only mode keeps the index.html survey and never falls back to the old sky map', () => {
 const layer={visible:true,add:()=>({}),remove:()=>{}};
 const stel={core:{dss:{visible:true}},createLayer:()=>layer};
 const controller=createBackendSky(skyOf(stel),{schedule:()=>0,cancel:()=>{}});
 controller.setVisible(false);
 assert.equal(layer.visible,false);
 assert.equal(stel.core.dss.visible,true);
 controller.setVisible(true);
 assert.equal(stel.core.dss.visible,true);
 controller.destroy();
});


test('revisiting a cached selection makes no new network requests and excludes other detectors', async () => {
 const calls=[],photos=[],timelines=[];
 const layer={visible:true,add:(_type,args)=>{const photo={...args};photos.push(photo);return photo;},remove:()=>{}};
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:30*Math.PI/180,pitch:20*Math.PI/180},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const cache=createFrontendCache({storage:null,fetchFn:async(url)=>{
   calls.push(url);
   if(url.includes('/sequence')) return Response.json({cell:-1,sequence:{ra:30,dec:20,fov:.2,wavelength:1.2,width:.01},cells:[{pix:-1,ra:30,dec:20,ring:0}],exposures:[
    {uri:'selected',mjd:1,date:'2025-01-01',detector:2,first:true,cells:[-1]},
    {uri:'wrong-detector',mjd:2,date:'2025-01-02',detector:3,first:true,cells:[-1]}]});
   return new Response(new Uint8Array([1]),{headers:{'X-Frame-Meta':'{"detector":2}'}});
 }});
 const controller=createBackendSky(skyOf(stel),{fetchFn:cache.fetch,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 controller.setBands([{detector:2,wavelength:1.2,width:.01}],20);
 await controller.refresh({ra:30,dec:20},.15);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(timelines.at(-1).steps.length,1);assert.equal(timelines.at(-1).steps[0].detector,2);
 assert(photos[0].url.startsWith('blob:'));
 assert(!new URL(calls[0]).searchParams.has('detector'));
 assert(!calls.some(url=>url.includes('wrong-detector')));
 const cold=calls.length;
 await controller.refresh({ra:30,dec:20},.15);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls.length,cold);
 controller.destroy();
});


test('wide canvas requests the full diagonal box beyond the old half-degree cap', async () => {
 const addresses=[];
 const layer={visible:true,add:()=>({}),remove:()=>{}};
 const stel={core:{fov:.3*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const controller=createBackendSky(skyOf(stel),{fetchFn:async url=>{
   addresses.push(url);
   return Response.json({cell:-1,sequence:{ra:30,dec:20,fov:.671},exposures:[]});
 },schedule:()=>0,cancel:()=>{}});
 await controller.refresh({ra:30,dec:20},.3,Math.hypot(1600,800)/800);
 assert.equal(new URL(addresses[0],'http://localhost').searchParams.get('fov'),'0.6710');
 await controller.refresh({ra:30,dec:20},105);
 assert.equal(addresses.length,1);
 controller.destroy();
});


test('zooming briefly past the frame threshold resumes every pending batch on return', async () => {
 let tick;
 const timelines=[], started=[];
 const pending=[];
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 const stel={canvas:{clientWidth:800,clientHeight:800},core:{fov:.15*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const exposures=Array.from({length:12},(_,i)=>({uri:`frame-${i}`,mjd:i,date:'2025-01-01',detector:2,first:true,cells:[-1]}));
 const controller=createBackendSky(skyOf(stel),{schedule:fn=>{tick=fn;return 0;},cancel:()=>{},onTimeline:t=>timelines.push(t),fetchFn:async(url,{signal})=>{
   if(url.includes('/sequence')) return Response.json({cell:-1,sequence:{ra:180/Math.PI,dec:0,fov:.3},cells:[{pix:-1,ring:0}],exposures});
   started.push(url);
   await new Promise(resolve=>{pending.push(resolve);signal.addEventListener('abort',resolve,{once:true});});
   return new Response('pixels');
 }});
 controller.setFill(false);
 await controller.refresh({ra:180/Math.PI,dec:0},.15,Math.SQRT2);
 tick(0);
 stel.core.fov=1*Math.PI/180; tick(10);
 stel.core.fov=.15*Math.PI/180; tick(20); tick(400);
 // Release both cancelled and resumed work, including the next queue batch.
 for(let i=0;i<8;i++) {
   pending.splice(0).forEach(resolve=>resolve());
   await new Promise(resolve=>setTimeout(resolve,0));
 }
 assert.equal(timelines.at(-1).steps.length,12);
 assert(started.some(url=>url.includes('frame-11')));
 controller.destroy();
});


test('panning out of the box keeps its frames on screen; only zooming out hides them', async () => {
 let tick;
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 const stel={canvas:{clientWidth:1600,clientHeight:800},core:{fov:.1*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const controller=createBackendSky(skyOf(stel),{schedule:fn=>{tick=fn;return 0;},cancel:()=>{},fetchFn:async()=>Response.json({cell:-1,sequence:{ra:180/Math.PI,dec:0,fov:.224},cells:[{pix:-1,ring:0}],exposures:[]})});
 await controller.refresh({ra:180/Math.PI,dec:0},.1,Math.sqrt(5));
 tick(0);assert.equal(layer.visible,true);
 // Drag past the box edge: the loaded frames stay until the next box adds to them.
 stel.core.observer.pitch=.1*Math.PI/180;
 tick(10);assert.equal(layer.visible,true,'a pan must not swap loaded frames for the blurred survey');
 stel.core.fov=1*Math.PI/180;
 tick(20);assert.equal(layer.visible,false,'zoomed out past frame scale shows only the survey');
 controller.destroy();
});


test('a new box after a pan keeps the old frames loaded and takes over the picture once it has the frame', async () => {
 const photos=[],removed=[],timelines=[];
 const releaseB=[]; // every box B crop waits here
 const layer={visible:true,add:(_type,args)=>{const p={...args};photos.push(p);return p;},remove:p=>removed.push(p)};
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:30*Math.PI/180,pitch:20*Math.PI/180},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const exposures=cell=>[{uri:'one',mjd:1,date:'2025-01-01',detector:2,first:true,cells:[cell]},{uri:'two',mjd:2,date:'2025-02-01',detector:2,first:true,cells:[cell]}];
 const fetchFn=async(url,{signal}={})=>{
   const u=new URL(url,'http://localhost');
   const cell=Number(u.searchParams.get('ra'))<30.01 ? -1 : -2;
   if(u.pathname.endsWith('/sequence')) return Response.json({cell,sequence:{ra:Number(u.searchParams.get('ra')),dec:20,fov:.2},cells:[{pix:cell,ring:0}],exposures:exposures(cell)});
   if(cell===-2) await new Promise(resolve=>{releaseB.push(resolve);signal?.addEventListener('abort',resolve,{once:true});});
   return new Response(new Uint8Array([1]));
 };
 const controller=createBackendSky(skyOf(stel),{fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15);
 await new Promise(resolve=>setTimeout(resolve,10));
 controller.showFrame(1);
 const boxA=photos.filter(p=>p.visible);
 assert.equal(boxA.length,1);
 // Pan: box B is requested, its crops are still downloading.
 stel.core.observer.yaw=30.05*Math.PI/180;
 await controller.refresh({ra:30.05,dec:20},.15);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(removed.length,0,'old frames must not be dropped');
 assert(boxA[0].visible,'the shown exposure stays on screen');
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),['one','two'],'steps that still have frames stay in the timeline');
 assert.equal(timelines.at(-1).steps[timelines.at(-1).index].uri,'two','the blink stays on the same exposure');
 // Box B arrives. It holds the whole canvas, so it alone is drawn: box A is kept
 // for a pan back, but drawing both would shift the picture where they overlap.
 releaseB.forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(photos.filter(p=>p.visible).length,1,'one box per step');
 assert(!boxA[0].visible,'box B took over from box A');
 assert.equal(removed.length,0,'box A stays loaded');
 controller.destroy();
});


test('zooming out past the loaded box asks for the bigger box once, not on every frame', async () => {
 let tick;
 const sequenceCalls=[];
 const pending=[];
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 const stel={canvas:{clientWidth:800,clientHeight:800},core:{fov:.1*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const controller=createBackendSky(skyOf(stel),{schedule:fn=>{tick=fn;return 0;},cancel:()=>{},fetchFn:async(url,{signal}={})=>{
   const fov=Number(new URL(url,'http://localhost').searchParams.get('fov'));
   sequenceCalls.push(fov);
   // The first box answers at once, the bigger one takes a while.
   if(sequenceCalls.length>1) await new Promise(resolve=>{pending.push(resolve);signal?.addEventListener('abort',resolve,{once:true});});
   return Response.json({cell:-sequenceCalls.length,sequence:{ra:180/Math.PI,dec:0,fov},cells:[{pix:-sequenceCalls.length,ring:0}],exposures:[]});
 }});
 tick(0); tick(400); // settle: box for the 0.1 deg view
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(sequenceCalls.length,1);
 stel.core.fov=.18*Math.PI/180; tick(500); // zoom out past that box
 for(const t of [900,1000,1100,1500,3000]) tick(t); // settled; the bigger box is still on its way
 assert.equal(sequenceCalls.length,2,'one request for the bigger box, not one per frame');
 assert(sequenceCalls[1]>sequenceCalls[0]);
 pending.forEach(resolve=>resolve());
 controller.destroy();
});


// A fake backend with several sequence boxes. `pickBox(ra, fov)` names the box a
// request is for: its cell, its exposures, and which crops answer at once; the
// rest wait for `release()` or an abort.
function boxBackend(pickBox) {
 const waiting=[];const calls={sequence:[],frames:0};
 const fetchFn=async(url,{signal}={})=>{
   const u=new URL(url,'http://localhost'),p=u.searchParams;
   const box=pickBox(Number(p.get('ra')),Number(p.get('fov')));
   if(u.pathname.endsWith('/sequence')) {
     calls.sequence.push({ra:p.get('ra'),dec:p.get('dec'),fov:p.get('fov')});
     return Response.json({cell:box.cell,sequence:{ra:Number(p.get('ra')),dec:Number(p.get('dec')),fov:Number(p.get('fov'))},cells:[{pix:box.cell,ring:0}],
       exposures:box.uris.map((uri,i)=>({uri,mjd:i,date:`2025-0${i+1}-01`,detector:2,first:true,cells:[box.cell]}))});
   }
   calls.frames++;
   if(!box.now.includes(p.get('uri'))) await new Promise(resolve=>{waiting.push({uri:p.get('uri'),cell:box.cell,resolve});signal?.addEventListener('abort',resolve,{once:true});});
   return new Response(new Uint8Array([1]));
 };
 const release=(cell,uris)=>{for(const w of waiting) if(w.cell===cell && uris.includes(w.uri)) w.resolve();};
 return {fetchFn,calls,release};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const skyAt=(ra,dec,fovDeg)=>{
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 return {canvas:{clientWidth:800,clientHeight:800},core:{fov:fovDeg*Math.PI/180,observer:{yaw:ra*Math.PI/180,pitch:dec*Math.PI/180},dss:{}},
   observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
};

test('the timeline holds only exposures every loaded patch on screen can show', async () => {
 const uris=['one','two','three'];
 const A={cell:-1,uris,now:uris}, B={cell:-2,uris,now:[]};
 const backend=boxBackend(ra=>ra<30.01 ? A : B);
 const timelines=[];
 const stel=skyAt(30,20,.15);
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),uris);
 // Pan: patch B overlaps A but is not inside it. With nothing loaded yet, B does not cut the blink.
 stel.core.observer.yaw=30.05*Math.PI/180;
 await controller.refresh({ra:30.05,dec:20},.15);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),uris);
 // B loads two of the three: blinking 'two' would flash B's part of the sky on and off.
 backend.release(-2,['one','three']);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),['one','three']);
 backend.release(-2,['two']);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),uris);
 controller.destroy();
});

test('a patch wholly inside a bigger one does not cut the timeline for what the bigger one shows', async () => {
 const uris=['one','two','three'];
 const inner={cell:-1,uris,now:['one']}, outer={cell:-2,uris,now:uris};
 const backend=boxBackend((_ra,fov)=>fov<.3 ? inner : outer);
 const timelines=[];
 const stel=skyAt(30,20,.15);
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),['one']);
 stel.core.fov=.3*Math.PI/180;
 await controller.refresh({ra:30,dec:20},.3);await settle(); // zoom out: the bigger box holds the inner one
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),uris);
 controller.destroy();
});

test('zooming out past frame scale and back reuses the loaded box instead of downloading it again', async () => {
 let tick;
 const box={cell:-1,uris:['one','two'],now:['one','two']};
 const backend=boxBackend(()=>box);
 const stel=skyAt(30,20,.15);
 const timelines=[];
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,onTimeline:t=>timelines.push(t),schedule:fn=>{tick=fn;return 0;},cancel:()=>{}});
 controller.setFill(false);
 tick(0);tick(400);await settle();
 const first=backend.calls.sequence[0], frames=backend.calls.frames;
 assert.equal(timelines.at(-1).steps.length,2);
 stel.core.fov=1*Math.PI/180;tick(500);tick(900); // past 0.5 deg: survey only
 // Back in, a little off the old zoom and centre: the loaded box still covers the canvas.
 stel.core.fov=.14*Math.PI/180;stel.core.observer.yaw=30.01*Math.PI/180;
 tick(1000);tick(1400);await settle();
 assert.deepEqual(backend.calls.sequence.at(-1),first,'asks for the same box, which the caches already hold');
 assert.equal(backend.calls.frames,frames,'no crop is downloaded again');
 assert.equal(timelines.at(-1).steps.length,2);
 controller.destroy();
});


// A fake sky that records which photos the engine is drawing.
function recordingSky(ra,dec,fovDeg,width=800,height=800) {
 const live=new Set();
 const stel=skyAt(ra,dec,fovDeg);
 stel.canvas={clientWidth:width,clientHeight:height};
 const layer={visible:true,added:0,add:(_type,args)=>{const p={...args};layer.added++;live.add(p);return p;},remove:p=>live.delete(p)};
 stel.createLayer=()=>layer;
 return {stel,live,layer,shown:()=>[...live].filter(p=>p.visible)};
}
const moveTo=(stel,ra,fovDeg)=>{stel.core.observer.yaw=ra*Math.PI/180;if(fovDeg) stel.core.fov=fovDeg*Math.PI/180;};

test('a box abandoned half loaded does not cut the timeline of the box that holds the view', async () => {
 const uris=['one','two','three'];
 const A={cell:-1,uris,now:uris}, B={cell:-2,uris,now:['one']}, C={cell:-3,uris,now:uris};
 const backend=boxBackend(ra=>ra<30.05 ? A : ra<30.15 ? B : C);
 const {stel}=recordingSky(30,20,.15);
 const timelines=[];
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15,Math.SQRT2);await settle();
 // Pan to B, which gets one frame before the next pan abandons it. B stays on screen beside C.
 moveTo(stel,30.1);await controller.refresh({ra:30.1,dec:20},.15,Math.SQRT2);await settle();
 moveTo(stel,30.2);await controller.refresh({ra:30.2,dec:20},.15,Math.SQRT2);await settle();
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),uris,'C holds the whole canvas and has every frame');
 controller.destroy();
});

test('each blink step draws one box when a loaded box holds the whole canvas', async () => {
 const uris=['one','two'];
 const small={cell:-1,uris,now:uris}, big={cell:-2,uris,now:uris};
 const backend=boxBackend((_ra,fov)=>fov<.3 ? small : big);
 const {stel,shown}=recordingSky(30,20,.1);
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.1,Math.SQRT2);await settle();
 moveTo(stel,30,.25);await controller.refresh({ra:30,dec:20},.25,Math.SQRT2);await settle();
 // Both boxes have both frames; the small one lies inside the big one.
 for(const index of [0,1]) {
   controller.showFrame(index);
   assert.equal(shown().length,1,'two boxes drawn over each other shift the picture between steps');
 }
 controller.destroy();
});

test('the chosen exposure stays on screen while a new box loads, and the box takes over once it has it', async () => {
 const uris=['one','two','three'];
 const A={cell:-1,uris,now:uris}, B={cell:-2,uris,now:[]};
 const backend=boxBackend(ra=>ra<30.05 ? A : B);
 const {stel,shown}=recordingSky(30,20,.15);
 const timelines=[];
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15,Math.SQRT2);await settle();
 controller.showFrame(2); // the user picks 'three'
 const current=()=>timelines.at(-1).steps[timelines.at(-1).index]?.uri;
 moveTo(stel,30.1);await controller.refresh({ra:30.1,dec:20},.15,Math.SQRT2);await settle();
 // B's other frames arrive first: the picture must not hop to them.
 backend.release(-2,['one']);await settle();
 assert.equal(current(),'three','the shown exposure does not change while its frame for the new box is on its way');
 assert(shown().length>=1 && shown().every(p=>p.calibration.ra===30),'still drawn from the earlier box');
 backend.release(-2,['three']);await settle();
 assert.equal(current(),'three');
 assert.deepEqual(timelines.at(-1).steps.map(s=>s.uri),['one','three'],'the new box holds the canvas: its frames are the steps');
 assert.equal(shown().length,1);assert.equal(shown()[0].calibration.ra,30.1);
 controller.destroy();
});

test('the frame on screen is the first one a new box downloads', async () => {
 const uris=['one','two','three','four'];
 const A={cell:-1,uris,now:uris}, B={cell:-2,uris,now:[]};
 const backend=boxBackend(ra=>ra<30.05 ? A : B);
 const {stel}=recordingSky(30,20,.15);
 const asked=[];
 const fetchFn=(url,options)=>{
   const u=new URL(url,'http://localhost');
   if(u.pathname.endsWith('.png') && Number(u.searchParams.get('ra'))>30.05) asked.push(u.searchParams.get('uri'));
   return backend.fetchFn(url,options);
 };
 const controller=createBackendSky(skyOf(stel),{fetchFn,schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:20},.15,Math.SQRT2);await settle();
 controller.showFrame(2);
 moveTo(stel,30.1);await controller.refresh({ra:30.1,dec:20},.15,Math.SQRT2);await settle();
 assert.equal(asked[0],'three');
 controller.destroy();
});

test('wide views of megabyte frames: the box on screen is never evicted while it loads', async () => {
 let tick;
 const uris=Array.from({length:13},(_,i)=>`f${i}`);
 const cells=new Map();
 const fetchFn=async(url)=>{
   const u=new URL(url,'http://localhost'),p=u.searchParams;
   if(!u.pathname.endsWith('/sequence')) return new Response(new Uint8Array(960000));
   const key=`${p.get('ra')}|${p.get('fov')}`;
   if(!cells.has(key)) cells.set(key,-1-cells.size);
   const cell=cells.get(key);
   return Response.json({cell,sequence:{ra:Number(p.get('ra')),dec:Number(p.get('dec')),fov:Number(p.get('fov')),wavelength:1.25,width:.05},cells:[{pix:cell,ring:0}],
     exposures:uris.map((uri,i)=>({uri,mjd:i,date:'2025-01-01',detector:2,first:true,cells:[cell]}))});
 };
 const {stel,live}=recordingSky(10,0,.45,1600,900);
 const timelines=[];
 const controller=createBackendSky(skyOf(stel),{fetchFn,onTimeline:t=>timelines.push(t),schedule:fn=>{tick=fn;return 0;},cancel:()=>{}});
 controller.setBands([{wavelength:1.25,width:.05}],0);
 let now=0;
 for(let pan=0;pan<5;pan++) {
   const from=timelines.length;
   moveTo(stel,10+pan*.2);
   now+=10;tick(now);now+=400;tick(now);
   for(let i=0;i<40;i++) await new Promise(resolve=>setTimeout(resolve,0));
   const lengths=timelines.slice(from).map(t=>t.steps.length);
   if(pan) assert(!lengths.includes(0),`pan ${pan}: the blink lost every step while loading (${lengths})`);
   assert.equal(lengths.at(-1),13,`pan ${pan}`);
   assert(lengths.every((n,i)=>i===0 || n>=lengths[i-1] || lengths[i-1]===13),`pan ${pan}: steps only grow while the new box loads (${lengths})`);
 }
 assert(live.size<=13*3,'earlier boxes are dropped whole to stay near the memory budget');
 controller.destroy();
});

test('returning to a loaded box does not rebuild photos that already show the cleaned frame', async () => {
 let tick;
 const box={cell:-1,uris:['one','two'],now:['one','two']};
 const backend=boxBackend(()=>box);
 const {stel,live,layer}=recordingSky(30,20,.15);
 const controller=createBackendSky(skyOf(stel),{fetchFn:backend.fetchFn,schedule:fn=>{tick=fn;return 0;},cancel:()=>{}});
 tick(0);tick(400);await settle();await settle();
 const before=layer.added;
 assert.equal(before,4,'two raw frames, each swapped once for its cleaned version');
 moveTo(stel,30,1);tick(500);tick(900);
 moveTo(stel,30,.15);tick(1000);tick(1400);await settle();await settle();
 assert.equal(layer.added,before,'no photo is added again');
 assert.equal(live.size,2);
 controller.destroy();
});
