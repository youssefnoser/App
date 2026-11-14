import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendCache } from '../../shared/frontend-cache.js';
import { createBackendSky, frameAddress, readSkyCentre, pointSky } from '../../shared/backend-sky.js';

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

test('catalogue pointing and readout use ASTROM/CIRS conversion', () => {
 const calls=[];
 const stel={observer:{},core:{observer:{yaw:1,pitch:.2}},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,
 convertFrame:(_,from,to,v)=>{calls.push([from,to]);return v;},lookAt:v=>calls.push(v)};
 pointSky(stel,{ra:90,dec:30});
 assert.deepEqual(calls[0],['ASTROM','CIRS']);
 assert.equal(readSkyCentre(stel).ra,180/Math.PI);
 assert.deepEqual(calls[2],['CIRS','ASTROM']);
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
 const controller=createBackendSky(stel,{fetchFn,onTimeline:t=>timelines.push(t),onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
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
 const controller=createBackendSky(stel,{fetchFn:async()=>{calls++;return new Response('',{status:502});},onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
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
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const fetchFn=async(url)=>{
   if(!url.includes('/sequence')) return new Response(new Uint8Array([1]));
   running++;max=Math.max(max,running);
   await new Promise(resolve=>setTimeout(resolve,5));running--;
   return Response.json({cell:-1,sequence:{ra:30,dec:20,fov:.2,detector:1},cells:[{pix:-1,ra:30,dec:20,ring:0}],exposures:[{uri:'shared',mjd:1,date:'2025-01-01',detector:1,first:true,cells:[-1]}]});
 };
 const controller=createBackendSky(stel,{fetchFn,onTimeline:t=>timelines.push(t),onStatus:s=>statuses.push(s),schedule:()=>0,cancel:()=>{}});
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
 const controller=createBackendSky(stel,{schedule:()=>0,cancel:()=>{}});
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
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const cache=createFrontendCache({storage:null,fetchFn:async(url)=>{
   calls.push(url);
   if(url.includes('/sequence')) return Response.json({cell:-1,sequence:{ra:30,dec:20,fov:.2,wavelength:1.2,width:.01},cells:[{pix:-1,ra:30,dec:20,ring:0}],exposures:[
    {uri:'selected',mjd:1,date:'2025-01-01',detector:2,first:true,cells:[-1]},
    {uri:'wrong-detector',mjd:2,date:'2025-01-02',detector:3,first:true,cells:[-1]}]});
   return new Response(new Uint8Array([1]),{headers:{'X-Frame-Meta':'{"detector":2}'}});
 }});
 const controller=createBackendSky(stel,{fetchFn:cache.fetch,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
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
 const controller=createBackendSky(stel,{fetchFn:async url=>{
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
 const controller=createBackendSky(stel,{schedule:fn=>{tick=fn;return 0;},cancel:()=>{},onTimeline:t=>timelines.push(t),fetchFn:async(url,{signal})=>{
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


test('frames stay drawn while the view pans or zooms past the loaded box, like the test bench', async () => {
 let tick;
 const layer={visible:true,add:(_type,args)=>({...args}),remove:()=>{}};
 const stel={canvas:{clientWidth:1600,clientHeight:800},core:{fov:.1*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const controller=createBackendSky(stel,{schedule:fn=>{tick=fn;return 0;},cancel:()=>{},fetchFn:async()=>Response.json({cell:-1,sequence:{ra:180/Math.PI,dec:0,fov:.224},cells:[{pix:-1,ring:0}],exposures:[]})});
 await controller.refresh({ra:180/Math.PI,dec:0},.1,Math.sqrt(5));
 tick(0);assert.equal(layer.visible,true);
 // Drag outside the box, before the 300 ms settle timer can request a new one.
 stel.core.observer.pitch=.1*Math.PI/180;
 tick(10);assert.equal(layer.visible,true,'hiding the frames here is the snap to the blurry survey');
 stel.core.observer.pitch=0;
 stel.core.fov=.2*Math.PI/180;
 tick(20);assert.equal(layer.visible,true,'a small zoom-out must not hide the frames either');
 // Past the frame scale nothing loads, so the layer goes, as in the test bench.
 stel.core.fov=1*Math.PI/180;
 tick(30);assert.equal(layer.visible,false);
 controller.destroy();
});


test('a reload for a new box keeps the old frames and the current step until that step arrives', async () => {
 const added=[],removed=[],timelines=[];
 let releaseTwo;
 const layer={visible:true,add:(_type,args)=>{const p={...args};added.push(p);return p;},remove:p=>removed.push(p)};
 const stel={core:{fov:.15*Math.PI/180,observer:{yaw:1,pitch:0},dss:{}},observer:{},s2c:(a,b)=>[a,b],c2s:v=>v,anp:v=>v,convertFrame:(_a,_b,_c,v)=>v,createLayer:()=>layer};
 const exposures=[{uri:'one',mjd:1,date:'2025-01-01',detector:2,first:true},{uri:'two',mjd:2,date:'2025-02-01',detector:2,first:true}];
 const box=(cell,ra)=>({cell,sequence:{ra,dec:0,fov:.2},cells:[{pix:cell,ra,dec:0,ring:0}],exposures:exposures.map(e=>({...e,cells:[cell]}))});
 const fetchFn=async(url)=>{
   url=String(url);
   if(url.includes('/sequence')) return Response.json(Number(new URL(url,'http://x').searchParams.get('ra'))<50 ? box(-1,30) : box(-2,60));
   if(url.includes('ra=60') && url.includes('uri=two')) await new Promise(resolve=>{releaseTwo=resolve;});
   return new Response(new Uint8Array([1]));
 };
 const controller=createBackendSky(stel,{fetchFn,onTimeline:t=>timelines.push(t),schedule:()=>0,cancel:()=>{}});
 controller.setFill(false);
 await controller.refresh({ra:30,dec:0},.15);
 await new Promise(resolve=>setTimeout(resolve,20));
 controller.showFrame(1);
 const oldTwo=added.find(p=>p.visible && p.calibration.ra===30);
 assert(oldTwo,'step two of the first box is on screen');
 const before=timelines.length;

 await controller.refresh({ra:60,dec:0},.15);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert(!timelines.slice(before).some(t=>t.steps.length===0),'the timeline must not be emptied while reloading');
 assert.equal(oldTwo.visible,true,'the old frame stays on screen until its replacement arrives');
 assert(!removed.includes(oldTwo));

 releaseTwo();
 await new Promise(resolve=>setTimeout(resolve,20));
 const newTwo=added.find(p=>p.visible && p.calibration.ra===60);
 assert(newTwo,'the new frame for the same step is shown');
 assert(removed.includes(oldTwo),'the old frame is removed once replaced');
 const last=timelines.at(-1);
 assert.equal(last.steps[last.index].uri,'two','the time step is kept');
 controller.destroy();
});
