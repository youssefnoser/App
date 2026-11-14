// SPHEREx 102-Band Spectral and Catalog Cross-Matching Library
// SPHEREx covers 0.75 - 5.00 µm with 6 detector arrays (17 bands each = 102 channels)

export type SpectralBandInfo = {
  band: number;
  detector: number;
  wavelength: number; // in micrometers (µm)
  bandwidth: number;  // in micrometers (µm)
  resolution: number; // R = lambda / delta_lambda
  flux: number;       // relative flux density (uJy or arbitrary units)
  snr: number;        // Signal-to-Noise Ratio
};

export type MolecularFeature = {
  name: string;
  wavelength: number; // µm
  type: 'absorption' | 'emission';
  description: string;
};

export const MOLECULAR_FEATURES: MolecularFeature[] = [
  { name: 'CH4', wavelength: 1.66, type: 'absorption', description: 'Methane band in cold atmospheres' },
  { name: 'CO (1st ov.)', wavelength: 2.32, type: 'absorption', description: 'Carbon monoxide overtone band head' },
  { name: 'H2O ice', wavelength: 3.05, type: 'absorption', description: 'Interstellar & circumstellar water ice' },
  { name: 'PAH', wavelength: 3.30, type: 'emission', description: 'Polycyclic aromatic hydrocarbons emission' },
  { name: 'CO2 ice', wavelength: 4.27, type: 'absorption', description: 'Carbon dioxide ice mantle absorption' },
  { name: 'CO gas', wavelength: 4.67, type: 'absorption', description: 'Carbon monoxide fundamental vibration' },
];

// Detector wavelength ranges:
// Det 1: 0.75 - 1.11 µm (R ~ 41)
// Det 2: 1.11 - 1.64 µm (R ~ 41)
// Det 3: 1.64 - 2.42 µm (R ~ 41)
// Det 4: 2.42 - 3.82 µm (R ~ 35)
// Det 5: 3.82 - 4.42 µm (R ~ 110)
// Det 6: 4.42 - 5.00 µm (R ~ 130)
const DETECTOR_RANGES = [
  { min: 0.75, max: 1.11, r: 41 },
  { min: 1.11, max: 1.64, r: 41 },
  { min: 1.64, max: 2.42, r: 41 },
  { min: 2.42, max: 3.82, r: 35 },
  { min: 3.82, max: 4.42, r: 110 },
  { min: 4.42, max: 5.00, r: 130 },
];

export function getBandWavelength(band: number): number {
  const b = Math.max(1, Math.min(102, Math.round(band)));
  const detIndex = Math.floor((b - 1) / 17);
  const localIndex = (b - 1) % 17;
  const range = DETECTOR_RANGES[detIndex];
  const step = (range.max - range.min) / 16;
  return Number((range.min + localIndex * step).toFixed(4));
}

export function getAllBands(): SpectralBandInfo[] {
  return Array.from({ length: 102 }, (_, i) => {
    const band = i + 1;
    const detector = Math.floor(i / 17) + 1;
    const wavelength = getBandWavelength(band);
    const range = DETECTOR_RANGES[detector - 1];
    const bandwidth = Number(((range.max - range.min) / 16).toFixed(4));
    return {
      band,
      detector,
      wavelength,
      bandwidth,
      resolution: range.r,
      flux: 1.0,
      snr: 25.0,
    };
  });
}

/**
 * Computes realistic spectral energy distribution (SED) flux across all 102 SPHEREx bands
 * based on target astronomical classification or coordinates and observation epoch.
 */
export function computeTargetSpectrum(
  targetName: string,
  coordinates: { ra: number; dec: number },
  epochFrame = 0
): SpectralBandInfo[] {
  const bands = getAllBands();
  const name = targetName.toLowerCase();

  return bands.map((item) => {
    const wl = item.wavelength;
    let baseFlux = 1.0;
    let noise = Math.sin(item.band * 13.37 + epochFrame * 1.5) * 0.015;

    if (name.includes('barnard')) {
      // M4.0V red dwarf: peak around 1.1 µm, Rayleigh-Jeans falloff into 5 µm, TiO/H2O absorption
      const planckLike = (1.1 / wl) ** 2 * Math.exp(-0.8 * (wl - 1.1) ** 2);
      const h2oDip = 0.28 * Math.exp(-((wl - 1.4) ** 2) / 0.02) + 0.35 * Math.exp(-((wl - 1.9) ** 2) / 0.03);
      const coDip = 0.22 * Math.exp(-((wl - 2.32) ** 2) / 0.01);
      baseFlux = (1.8 * Math.max(0.1, planckLike) - h2oDip - coDip) * (1 + 0.03 * (epochFrame - 2.5));
    } else if (name.includes('epsilon indi')) {
      // T-dwarf binary: strong methane (CH4) & deep H2O troughs, flux peaks at 1.08, 1.28, 1.58 µm
      const continuum = 0.7 * Math.exp(-0.3 * (wl - 1.3) ** 2);
      const ch4_1 = 0.45 * Math.exp(-((wl - 1.66) ** 2) / 0.015);
      const ch4_2 = 0.55 * Math.exp(-((wl - 2.2) ** 2) / 0.02);
      const h2o_ice = 0.38 * Math.exp(-((wl - 3.05) ** 2) / 0.08);
      baseFlux = Math.max(0.08, continuum - ch4_1 - ch4_2 - h2o_ice + 0.2 * Math.exp(-((wl - 4.6) ** 2) / 0.1));
    } else if (name.includes('wise 0855')) {
      // Coldest brown dwarf (Y-dwarf ~250 K): faint near-IR, massive peak at 4.5–5.0 µm, strong water ice at 3.05 µm
      const coldPlanck = 0.05 + 1.2 * Math.exp(-((wl - 4.7) ** 2) / 0.4);
      const iceDip = 0.4 * Math.exp(-((wl - 3.05) ** 2) / 0.12);
      baseFlux = Math.max(0.02, coldPlanck - iceDip + (wl < 2.0 ? 0.04 : 0));
    } else if (name.includes('rw aurigae')) {
      // Young Stellar Object (T Tauri) with protoplanetary disk: infrared excess, silicate, PAH at 3.3 µm
      const star = 1.0 / (wl ** 0.8);
      const diskExcess = 0.65 * (wl / 3.0) * Math.exp(-0.2 * wl);
      const pahEmission = 0.42 * Math.exp(-((wl - 3.3) ** 2) / 0.012);
      const coGasDip = 0.25 * Math.exp(-((wl - 4.67) ** 2) / 0.025);
      baseFlux = (star * 0.8 + diskExcess + pahEmission - coGasDip) * (1 + 0.08 * Math.sin(epochFrame * 1.2));
    } else if (name.includes('r draconis')) {
      // Mira variable: huge amplitude pulsation across epochs
      const cycle = Math.sin((epochFrame / 5) * Math.PI * 2);
      const amp = 0.8 + 0.7 * cycle;
      const co2_ice = 0.3 * Math.exp(-((wl - 4.27) ** 2) / 0.02);
      baseFlux = (amp * (1.2 * Math.exp(-0.4 * (wl - 1.8) ** 2) + 0.3) - co2_ice);
    } else {
      // Generic celestial source derived from coordinates
      const pseudoSeed = (Math.sin(coordinates.ra) * 43758.5453 + Math.cos(coordinates.dec) * 12345.67) % 1;
      const peak = 1.2 + Math.abs(pseudoSeed) * 2.0;
      baseFlux = Math.max(0.1, Math.exp(-0.5 * ((wl - peak) / 1.2) ** 2) * 1.5 + 0.15);
    }

    const flux = Number(Math.max(0.01, baseFlux + noise).toFixed(4));
    const snr = Number(Math.min(99.9, Math.max(5.0, flux * 35.0 + Math.abs(noise) * 100)).toFixed(1));

    return {
      ...item,
      flux,
      snr,
    };
  });
}
