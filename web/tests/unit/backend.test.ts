import assert from 'node:assert/strict';
import { GET } from '../../app/api/[...path]/route.ts';
import { getBandWavelength } from '../../lib/spectral.ts';
import { selectedBandWindows } from '../../lib/backend-bands.ts';

assert.deepEqual(selectedBandWindows(Array.from({length:102},(_,i)=>i+1)),[1,2,3,4,5,6].map(detector=>({detector})));
assert.equal(selectedBandWindows([1,2,4]).length,2);
assert('wavelength' in selectedBandWindows([21])[0]);
assert.equal(selectedBandWindows([21,21]).length,1);
for (const band of [1, 17, 18, 34, 68, 85, 102]) {
 const window=selectedBandWindows([band])[0];
 assert('wavelength' in window);
 assert.equal(window.detector,Math.floor((band-1)/17)+1);
 const neighbour=band % 17 === 0 ? band-1 : band+1;
 assert(Math.abs(getBandWavelength(neighbour)-window.wavelength) > window.wavelength*window.width, 'Single-band window leaked into its neighbour');
}
const original=globalThis.fetch;
const originalBase=process.env.SPHEREX_BACKEND_URL;
process.env.SPHEREX_BACKEND_URL='http://130.61.174.88:8000';
let seen='';
try {
 globalThis.fetch=(async(url:RequestInfo|URL)=>{
   seen=String(url);
   return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png','x-frame-meta':'{"n":211}'}});
 }) as typeof fetch;
 const response=await GET(new Request('http://localhost/api/patch/12/frame.png?uri=test&stack=12'),{params:Promise.resolve({path:['patch','12','frame.png']})});
 assert.equal(seen,'http://130.61.174.88:8000/api/patch/12/frame.png?uri=test&stack=12');
 assert.equal(response.headers.get('x-frame-meta'),'{"n":211}');
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[137,80,78,71]);
 assert.equal((await GET(new Request('http://localhost/api/anything'),{params:Promise.resolve({path:['anything']})})).status,404);
 globalThis.fetch=(async()=>new Response('archive unavailable',{status:502})) as typeof fetch;
 assert.equal((await GET(new Request('http://localhost/api/sequence'),{params:Promise.resolve({path:['sequence']})})).status,502);
 globalThis.fetch=(async()=>{throw Error('offline');}) as typeof fetch;
 assert.equal((await GET(new Request('http://localhost/api/targets'),{params:Promise.resolve({path:['targets']})})).status,502);
} finally {
 globalThis.fetch=original;
 if(originalBase===undefined) delete process.env.SPHEREX_BACKEND_URL;else process.env.SPHEREX_BACKEND_URL=originalBase;
}
console.log('PASS: backend band windows, binary proxy, metadata, upstream failures and endpoint restrictions.');
