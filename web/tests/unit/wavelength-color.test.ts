import assert from 'node:assert/strict';
import { wavelengthRGB, wavelengthMatrix } from '../../lib/wavelength-color.ts';
assert.deepEqual(wavelengthRGB(.744), [.65,.4,1]);
assert.ok(wavelengthRGB(5.002).every((c,i)=>Math.abs(c-[1,.3,.2][i])<1e-12));
assert.deepEqual(wavelengthRGB(-1), wavelengthRGB(.744));
assert.deepEqual(wavelengthRGB(99), wavelengthRGB(5.002));
assert.deepEqual(wavelengthRGB(NaN), [1,1,1]);
for (let w=.744; w<5.01; w+=.01) {
 const rgb=wavelengthRGB(w);assert.equal(rgb.length,3);
 assert.ok(rgb.every(c=>Number.isFinite(c)&&c>=0&&c<=1));
 assert.ok(Math.max(...rgb)>.85);
}
const m=wavelengthMatrix(5.002).split(' ').map(Number);
assert.equal(m.length,20);
assert.equal(m[4],0);assert.equal(m[9],0);assert.equal(m[14],0);assert.equal(m[18],1);
assert.ok(Math.abs(m[0]+m[1]+m[2]-1)<1e-6);
assert.ok(Math.abs(m[5]+m[6]+m[7]-.3)<1e-6);
console.log('PASS: wavelength false-color range, clamping, missing values and black/alpha preservation.');
