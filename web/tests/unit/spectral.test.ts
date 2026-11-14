import assert from 'node:assert/strict';
import {
  getAllBands,
  getBandWavelength,
  computeTargetSpectrum,
  MOLECULAR_FEATURES,
} from '../../lib/spectral.ts';

// 1. Validate all 102 bands and wavelength coverage
const bands = getAllBands();
assert.equal(bands.length, 102, 'Must have exactly 102 bands');
assert.equal(bands[0].wavelength, 0.75, 'Band 1 must start at 0.75 um');
assert.equal(bands[101].wavelength, 5.0, 'Band 102 must end at 5.00 um');

// Test monotonic ordering
for (let i = 1; i < bands.length; i++) {
  assert(
    bands[i].wavelength >= bands[i - 1].wavelength,
    `Wavelength must be monotonic: band ${i + 1} (${bands[i].wavelength}) vs band ${i} (${bands[i - 1].wavelength})`
  );
  assert(bands[i].detector >= 1 && bands[i].detector <= 6, 'Detector must be 1 to 6');
}

// 2. Validate molecular features
assert(MOLECULAR_FEATURES.length >= 5, 'Should have key molecular features');
const h2oIce = MOLECULAR_FEATURES.find((f) => f.name === 'H2O ice');
assert(h2oIce && h2oIce.wavelength === 3.05, 'H2O ice must be at 3.05 um');

// 3. Validate Spectrum Synthesis for known targets
const barnardSpectrum = computeTargetSpectrum("Barnard's Star", { ra: 269.4521, dec: 4.6934 }, 0);
assert.equal(barnardSpectrum.length, 102, 'Barnard spectrum must have 102 bands');
assert(barnardSpectrum.every((b) => b.flux > 0 && b.snr > 0), 'All fluxes and SNRs must be positive');

const wiseSpectrum = computeTargetSpectrum('WISE 0855', { ra: 133.795, dec: -7.245 }, 0);
// Y dwarf should have much higher flux in Band 100+ (deep IR) than Band 1 (near-IR)
assert(
  wiseSpectrum[95].flux > wiseSpectrum[5].flux,
  'Cold brown dwarf WISE 0855 must peak in mid-to-deep infrared'
);

console.log('PASS: SPHEREx 102-band spectral library and molecular features.');
