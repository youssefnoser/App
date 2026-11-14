import assert from 'node:assert/strict';
import {
  getAllBands,
  getBandWavelength,
  computeTargetSpectrum,
  getExternalCatalogMatches,
  getObservationMetadata,
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

// 4. Validate External Catalog Matches (Gaia & WISE)
const matches = getExternalCatalogMatches(269.4521, 4.6934, "Barnard's Star");
assert.equal(matches.length, 2, 'Must return Gaia and WISE catalog counterparts');
assert(matches.some((m) => m.mission === 'Gaia'), 'Must include Gaia match');
assert(matches.some((m) => m.mission === 'WISE'), 'Must include WISE match');
assert(matches[0].separationArcsec >= 0, 'Separation must be non-negative');

// 5. Validate Metadata & QA Parameters
const metadata = getObservationMetadata(0, [1, 2, 3], { ra: 269.4521, dec: 4.6934 });
assert.equal(metadata.psfFwhmArcsec, 5.8, 'SPHEREx PSF FWHM must be 5.8 arcsec');
assert(metadata.contaminationFlags.length >= 3, 'Must have contamination flags');
assert(metadata.varianceMjy2 > 0, 'Variance must be positive');
assert(metadata.zodiFluxMjySr > 0, 'ZODI foreground must be positive');
assert(metadata.wcsProjection.includes('RA---TAN'), 'WCS must include tangential projection');

console.log('PASS: SPHEREx 102-band spectral library, molecular features, Gaia/WISE cross-matching, and telemetry metadata.');
