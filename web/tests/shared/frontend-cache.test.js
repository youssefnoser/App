import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendCache } from '../../shared/frontend-cache.js';

test('canonical requests share in-flight work and reuse bytes and frame metadata', async () => {
 let calls=0;
 const cache=createFrontendCache({storage:null,fetchFn:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return new Response('pixels',{headers:{'X-Frame-Meta':'{"detector":2}'}});}});
 const [a,b]=await Promise.all([cache.fetch('/api/frame.png?ra=1&uri=a'),cache.fetch('/api/frame.png?uri=a&ra=1')]);
 assert.equal(await a.text(),'pixels');assert.equal(await b.text(),'pixels');
 const c=await cache.fetch('/api/frame.png?uri=a&ra=1');
 assert.equal(c.headers.get('X-Frame-Meta'),'{"detector":2}');assert.equal(await c.text(),'pixels');assert.equal(calls,1);
});

test('one cancelled consumer does not cancel another, failures are not cached', async () => {
 let calls=0;
 const cache=createFrontendCache({storage:null,fetchFn:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return new Response('ok');}});
 const controller=new AbortController();
 const a=cache.fetch('/api/sequence?ra=1',{signal:controller.signal});
 const b=cache.fetch('/api/sequence?ra=1');
 controller.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(await(await b).text(),'ok');assert.equal(calls,1);
 let failures=0;
 const broken=createFrontendCache({storage:null,fetchFn:async()=>{failures++;return new Response('failed',{status:502});}});
 await broken.fetch('/api/sequence');await broken.fetch('/api/sequence');assert.equal(failures,2);
});

test('expired metadata and least recently used entries are fetched again', async () => {
 let clock=0,calls=0;
 const cache=createFrontendCache({storage:null,now:()=>clock,maxEntries:2,fetchFn:async()=>{calls++;return Response.json({calls});}});
 await cache.fetch('/api/sequence?a=1');await cache.fetch('/api/sequence?a=2');await cache.fetch('/api/sequence?a=3');
 await cache.fetch('/api/sequence?a=1');assert.equal(calls,4);
 clock=10*60*1000;await cache.fetch('/api/sequence?a=1');assert.equal(calls,5);
});

test('persistent browser cache survives a new in-memory cache instance', async () => {
 const entries=new Map();
 const store={match:async key=>entries.get(String(key))?.clone(),put:async(key,value)=>{entries.set(String(key),value.clone());},delete:async key=>entries.delete(String(key)),keys:async()=>[...entries.keys()].map(key=>new Request(key))};
 const storage={open:async()=>store};let calls=0;
 const fetchFn=async()=>{calls++;return new Response('pixels',{headers:{'content-type':'image/png'}});};
 await createFrontendCache({storage,fetchFn}).fetch('/api/frame.png?uri=a');
 const response=await createFrontendCache({storage,fetchFn}).fetch('/api/frame.png?uri=a');
 assert.equal(await response.text(),'pixels');assert.equal(calls,1);
});
