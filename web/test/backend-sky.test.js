import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendCache } from '../js/frontend-cache.js';
import { createBackendSky, frameAddress, readSkyCentre, pointSky } from '../js/backend-sky.js';

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
