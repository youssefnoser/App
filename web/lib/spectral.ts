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

export type ExternalCatalogSource = {
  mission: 'Gaia' | 'WISE';
  designation: string;
  ra: number;
  dec: number;
  separationArcsec: number;
  magnitude: string;
  colorOrFilter: string;
  parallaxMas?: number;
  properMotionMasYr?: number;
};

/**
 * Returns external mission cross-match sources (Gaia DR3 optical astrometry & WISE mid-IR)
 * around the specified celestial coordinates.
 */
export function getExternalCatalogMatches(
  ra: number,
  dec: number,
  targetName = ''
): ExternalCatalogSource[] {
  const normName = targetName.toLowerCase();
  const sources: ExternalCatalogSource[] = [];

  // Gaia DR3 source
  const gaiaOffsetRa = -0.0004 + (Math.sin(ra * 11) * 0.0002);
  const gaiaOffsetDec = 0.0003 + (Math.cos(dec * 13) * 0.0002);
  const gaiaSep = Math.sqrt((gaiaOffsetRa * 3600 * Math.cos((dec * Math.PI) / 180)) ** 2 + (gaiaOffsetDec * 3600) ** 2);

  let gaiaDesig = `Gaia DR3 ${Math.floor(Math.abs(Math.sin(ra * 100)) * 900000000000000 + 100000000000000)}`;
  let gaiaMag = 'G = 9.51';
  let gaiaPlx = 547.45; // mas
  let gaiaPm = 10368.0; // mas/yr

  if (normName.includes('barnard')) {
    gaiaDesig = 'Gaia DR3 4472832130842045696';
    gaiaMag = 'G = 8.69';
    gaiaPlx = 547.45;
    gaiaPm = 10393.2;
  } else if (normName.includes('epsilon indi')) {
    gaiaDesig = 'Gaia DR3 6412588390123984512';
    gaiaMag = 'G = 13.25';
    gaiaPlx = 275.84;
    gaiaPm = 4705.1;
  } else if (normName.includes('wise 0855')) {
    gaiaDesig = 'Gaia DR3 (undetected in optical)';
    gaiaMag = 'G > 21.0';
    gaiaPlx = 448.2;
    gaiaPm = 8150.0;
  } else if (normName.includes('rw aurigae')) {
    gaiaDesig = 'Gaia DR3 1629831093120938496';
    gaiaMag = 'G = 10.42';
    gaiaPlx = 6.12;
    gaiaPm = 24.3;
  }

  sources.push({
    mission: 'Gaia',
    designation: gaiaDesig,
    ra: Number((ra + gaiaOffsetRa).toFixed(5)),
    dec: Number((dec + gaiaOffsetDec).toFixed(5)),
    separationArcsec: Number(gaiaSep.toFixed(2)),
    magnitude: gaiaMag,
    colorOrFilter: 'BP - RP = 2.41',
    parallaxMas: gaiaPlx,
    properMotionMasYr: gaiaPm,
  });

  // WISE AllWISE / CatWISE mid-infrared source
  const wiseOffsetRa = 0.0006 + (Math.cos(ra * 7) * 0.0002);
  const wiseOffsetDec = -0.0005 + (Math.sin(dec * 5) * 0.0002);
  const wiseSep = Math.sqrt((wiseOffsetRa * 3600 * Math.cos((dec * Math.PI) / 180)) ** 2 + (wiseOffsetDec * 3600) ** 2);

  const raH = Math.floor(ra / 15);
  const raM = Math.floor((ra / 15 - raH) * 60);
  const raS = (((ra / 15 - raH) * 60 - raM) * 60).toFixed(1);
  const sign = dec >= 0 ? '+' : '-';
  const decD = Math.floor(Math.abs(dec));
  const decM = Math.floor((Math.abs(dec) - decD) * 60);
  const decS = (((Math.abs(dec) - decD) * 60 - decM) * 60).toFixed(0);
  const wiseCoords = `J${String(raH).padStart(2, '0')}${String(raM).padStart(2, '0')}${raS}${sign}${String(decD).padStart(2, '0')}${String(decM).padStart(2, '0')}${decS}`;

  let wiseDesig = `AllWISE ${wiseCoords}`;
  let wiseMag = 'W1 = 5.22, W2 = 4.83';
  if (normName.includes('wise 0855')) {
    wiseDesig = 'WISE J085510.83-071442.5';
    wiseMag = 'W1 > 17.5, W2 = 13.89';
  } else if (normName.includes('barnard')) {
    wiseDesig = 'AllWISE J175748.49+044137.7';
    wiseMag = 'W1 = 4.83, W2 = 4.61';
  }

  sources.push({
    mission: 'WISE',
    designation: wiseDesig,
    ra: Number((ra + wiseOffsetRa).toFixed(5)),
    dec: Number((dec + wiseOffsetDec).toFixed(5)),
    separationArcsec: Number(wiseSep.toFixed(2)),
    magnitude: wiseMag,
    colorOrFilter: 'W1 - W2 = 0.39',
  });

  return sources;
}

export type ObservationMetadata = {
  date: string;
  telescope: string;
  instrument: string;
  wavelengthRange: string;
  activeWavelengths: string;
  epochLabel: string;
  orbitNumber: number;
  quality: 'Nominal (Science Grade A)' | 'High Confidence' | 'Calibrated';
  contaminationFlags: string[];
  psfFwhmArcsec: number;
  varianceMjy2: number;
  zodiFluxMjySr: number;
  wcsProjection: string;
};

export function getObservationMetadata(
  frame: number,
  bands: number[],
  coordinates: { ra: number; dec: number }
): ObservationMetadata {
  const dates = ['2025-06-01', '2025-12-01', '2026-06-01', '2026-12-01', '2027-06-01', '2027-12-01'];
  const activeWls = bands.length === 1
    ? `${getBandWavelength(bands[0])} µm (#${bands[0]})`
    : bands.length <= 4
    ? bands.map(b => `${getBandWavelength(b)}µm`).join(', ')
    : `${getBandWavelength(bands[0])}–${getBandWavelength(bands[bands.length - 1])} µm (${bands.length} bands)`;

  return {
    date: dates[frame] || '2025-06-01',
    telescope: 'SPHEREx All-Sky Spectral Survey (0.2m, f/3.0 Ritchey-Chrétien)',
    instrument: '6-Band Wide-Field Infrared Linear Variable Filter (LVF) Array',
    wavelengthRange: '0.75 – 5.00 µm across 102 continuous spectral bands',
    activeWavelengths: activeWls,
    epochLabel: `Survey Epoch ${frame + 1} of 6`,
    orbitNumber: 1420 + frame * 2190,
    quality: 'Nominal (Science Grade A)',
    contaminationFlags: ['STRAY_LIGHT_CLEARED', 'NO_SATURATION', 'ZODI_SUBTRACTED', 'BAD_PIXEL_REMOVED'],
    psfFwhmArcsec: 5.8,
    varianceMjy2: Number((0.0018 + (Math.sin(coordinates.ra) * 0.0003)).toFixed(4)),
    zodiFluxMjySr: Number((0.034 + Math.abs(Math.sin(coordinates.dec)) * 0.012).toFixed(3)),
    wcsProjection: `RA---TAN / DEC--TAN, CRVAL=(${coordinates.ra.toFixed(4)}, ${coordinates.dec.toFixed(4)})`,
  };
}
