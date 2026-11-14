import test from 'node:test';
import assert from 'node:assert/strict';

import { PhotoCache } from '../../shared/photos.js';

// Fake Stellarium layer per ruling: add(type, args) returns an object with
// mutable fields (visible etc.), remove(obj) takes it off the layer.
function fakeLayer() {
  const photos = [];
  return {
    photos,
    add(type, args) {
      const photo = { ...args, visible: false };
      photos.push(photo);
      return photo;
    },
    remove(photo) {
      const i = photos.indexOf(photo);
      if (i !== -1) photos.splice(i, 1);
    },
  };
}

const url = (pix, uri) => `/api/patch/${pix}/frame.png?uri=${uri}`;
const cal = { ra: 269.4, dec: 4.8, orientation: 0, pixscale: 3.075 };

test('ensure adds an invisible instant photo on the layer', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer);
  const photo = cache.ensure(7, 'A', url(7, 'A'), cal);
  assert.equal(layer.photos.length, 1);
  assert.equal(photo.visible, false);
  assert.equal(photo.instant, true);
  assert.equal(photo.url, url(7, 'A'));
  assert.equal(photo.calibration, cal);
});

test('ensure returns the same photo for the same patch and uri', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer);
  const first = cache.ensure(3, 'A', url(3, 'A'), cal);
  const again = cache.ensure(3, 'A', url(3, 'A'), cal);
  assert.equal(first, again);
  assert.equal(layer.photos.length, 1);
  assert.equal(cache.size, 1);
});

test('showOnly never shows another exposure', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer);
  // 3 patches; uri A loaded for 2 of them, B for the third.
  cache.ensure(0, 'A', url(0, 'A'), cal);
  cache.ensure(1, 'A', url(1, 'A'), cal);
  cache.ensure(2, 'B', url(2, 'B'), cal);
  cache.showOnly('A');
  const visible = layer.photos.filter((p) => p.visible);
  assert.equal(visible.length, 2);
  for (const photo of visible) {
    assert.ok(photo.url.includes('uri=A'), `photo ${photo.url} is not exposure A`);
  }
  // The patch without a photo for A shows nothing at this step.
  assert.equal(layer.photos[2].visible, false);
  // An uri nobody loaded shows nothing anywhere.
  cache.showOnly('C');
  assert.equal(layer.photos.filter((p) => p.visible).length, 0);
});

test('cap drops least recent but not current', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer, { cap: 4 });
  cache.ensure(0, 'A', url(0, 'A'), cal);
  cache.showOnly('A'); // current uri is the first one ensured
  for (const uri of ['B', 'C', 'D', 'E', 'F']) {
    cache.ensure(1, uri, url(1, uri), cal);
  }
  assert.equal(cache.size, 4);
  assert.equal(layer.photos.length, 4);
  // The current uri's photos remain.
  assert.ok(layer.photos.some((p) => p.url === url(0, 'A')));
  // Least recently ensured non-current photos (B, then C) were dropped.
  assert.ok(!layer.photos.some((p) => p.url === url(1, 'B')));
  assert.ok(!layer.photos.some((p) => p.url === url(1, 'C')));
  // The most recent ones stay.
  assert.ok(layer.photos.some((p) => p.url === url(1, 'F')));
});

test('dropped photos are removed from the layer', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer, { cap: 1 });
  const a = cache.ensure(0, 'A', url(0, 'A'), cal);
  cache.ensure(1, 'B', url(1, 'B'), cal);
  assert.equal(cache.size, 1);
  assert.equal(layer.photos.length, 1);
  assert.ok(!layer.photos.includes(a));
});

test('replace swaps the image and keeps visibility', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer);
  cache.ensure(7, 'A', 'quick-A', cal);
  cache.ensure(7, 'B', 'quick-B', cal);
  cache.showOnly('A');
  const better = cache.replace(7, 'A', 'clean-A', cal);
  assert.equal(better.url, 'clean-A');
  assert.equal(better.visible, true);
  assert.equal(layer.photos.length, 2);
  assert.deepEqual(layer.photos.map((p) => p.url).sort(), ['clean-A', 'quick-B']);
  const hidden = cache.replace(7, 'B', 'clean-B', cal);
  assert.equal(hidden.visible, false);
  cache.showOnly('B');
  assert.equal(hidden.visible, true);
  assert.equal(better.visible, false);
});

test('replace of a photo that is gone does nothing', () => {
  const layer = fakeLayer();
  const cache = new PhotoCache(layer);
  assert.equal(cache.replace(7, 'A', 'clean-A', cal), null);
  assert.equal(layer.photos.length, 0);
});
