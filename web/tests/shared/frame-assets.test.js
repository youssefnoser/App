import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameAssets } from '../../shared/frame-assets.js';

test('Blob images are reused, bounded and released on eviction/disposal', async () => {
 let calls=0;const evicted=[];
 const assets=createFrameAssets({maxEntries:2,maxBytes:20,onEvict:key=>evicted.push(key),fetchFn:async()=>{calls++;return new Response('pixels');}});
 const a=await assets.load('a');assets.pin('a');
 assert.equal((await assets.load('a')).url,a.url);
 await assets.load('b');await assets.load('c');
 assert.deepEqual(evicted,['b']);assert.equal(calls,3);
 assets.clear();assert.deepEqual(new Set(evicted),new Set(['a','b','c']));
 await assert.rejects(assets.load('a'),{name:'AbortError'});
});
