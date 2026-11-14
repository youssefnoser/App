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

test('eviction drops a whole group, oldest first, and never the pinned group', async () => {
 const evicted=[];
 const assets=createFrameAssets({maxBytes:5*6,onEvict:key=>evicted.push(key),fetchFn:async()=>new Response('pixels')});
 assets.pin('A');
 await assets.load('a1',undefined,'A');await assets.load('a2',undefined,'A');
 await assets.load('b1',undefined,'B');await assets.load('b2',undefined,'B');
 await assets.load('c1',undefined,'C');
 assert.deepEqual(evicted,[]);
 await assets.load('c2',undefined,'C'); // 36 bytes > 30: B is the oldest group that is not pinned
 assert.deepEqual(evicted.sort(),['b1','b2'],'a box half evicted would leave holes in the blink');
 await assets.load('a3',undefined,'A');await assets.load('a4',undefined,'A');
 assert.deepEqual(evicted.sort(),['b1','b2','c1','c2']);
 await assets.load('a5',undefined,'A');await assets.load('a6',undefined,'A'); // only the pinned group is left
 assert.equal(evicted.length,4,'the pinned group may exceed the budget');
 assets.pin('D');await assets.load('d1',undefined,'D');
 assert.equal(evicted.length,10,'once another group is pinned, the old one goes');
});
