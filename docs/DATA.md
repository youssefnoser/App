# SPHEREx data: verified facts and gotchas

Sources of truth, in order:
1. The SPHEREx Explanatory Supplement, version 2.1 (2026-11-10), `docs/reference/` (see `docs/reference/README.md`). Cited below as "ES section/table".
2. Things measured on real IRSA data on 2026-11-13, marked "measured".
3. Anything marked UNVERIFIED has no source yet.

Figure of one real file: `docs/anatomy-of-a-spherex-file.png`.

## Where the files live

- Exposure files: `https://irsa.ipac.caltech.edu/ibe/data/spherex/<release>/level2/<planning period>/<version>/<detector>/<file>.fits`
  (releases seen: `dr1`, `qr3`). The root `https://irsa.ipac.caltech.edu/ibe/data/spherex` is a path prefix, not a directory listing
  (measured: 404 on the root and on `/dr1/`). Find files by querying TAP, never by browsing.
- The `uri` column from TAP already starts with `ibe/data/spherex/...`. Prepend `https://irsa.ipac.caltech.edu/`.
- File name (ES Table 3): `level2_2025W22_2B_0001_1D3_spx_l2b-v4-2025-152.fits` = observation ID `2025W22_2B_0001_1`, detector `D3`, processing stamp.

## Getting data from IRSA (two calls)

### 1. Which exposures cover a position (TAP, ADQL)

```
POST https://irsa.ipac.caltech.edu/TAP/sync
data: REQUEST=doQuery  LANG=ADQL  FORMAT=csv  QUERY=<below>

SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra_deg}, {dec_deg}), p.poly)
ORDER BY p.time_bounds_lower
```

- `time_bounds_lower` is MJD. `energy_bandpassname` is `SPHEREx-D1` to `SPHEREx-D6`.
- Measured latency 4.3 s for Barnard's Star.
- The metadata tables include DR1 and QR3. The IRSA tutorial says QR3 and DR1 supersede QR2. The ES warns to use caution combining QR2 and QR3 (different gain calibration).
- Recorded results for offline tests: `tests/fixtures/tap_barnard.csv` (358 rows) and `tests/fixtures/tap_wise0855.csv` (258 rows, extra column `planeid`).

### 2. A small crop of one exposure (cutout service)

```
GET https://irsa.ipac.caltech.edu/{uri}?center={ra_deg},{dec_deg}d&size={size_deg}
```

Returns `application/fits`. `size=0.05` gives a 29 x 29 pixel image (pixel 6.15 arcsec, ES Table 2).
Measured: 358 crops in 284 s with 8 parallel threads, no failures. Each crop is about 4 MB, almost all of it the
EPSF table. When caching keep only the HDUs listed in the next section.

## FITS layout (ES section 2.2)

Full files are 2,040 x 2,040 pixels (one exposure, one detector). Cutouts keep the same extensions.

| HDU | Name | Contents |
|-----|------|----------|
| 0 | PRIMARY | No data. Header has `VERSION`. |
| 1 | IMAGE | float32 MJy/sr, calibrated surface brightness. **Not zodi-subtracted.** Header: `DETECTOR` (1 to 6), `MJD-AVG`, `OBSID`, celestial WCS with SIP distortion. |
| 2 | FLAGS | int32 bit mask per pixel. Decoded below. |
| 3 | VARIANCE | float32, (MJy/sr)^2. |
| 4 | ZODI | float32 MJy/sr, model zodiacal light background. |
| 5 | EPSF | 441 oversampled PSFs (21 x 21 grid; detector 3 has 451 rows, 11 x 41). Dimensionless, integral-normalised. |
| 6 | WCS-WAVE | Lookup table for wavelength per pixel. Use `WCS(header, fobj=hdulist, key="W")`, set `.sip = None`, then `pixel_to_world(x, y)` returns (wavelength, bandwidth). ES: fine for visualisation, not for science. Science use should take the separate Spectral WCS files (ES section 4.3.1). |

### Zodi (ES sections 2.2 and 3.4.3)

"No zodiacal light subtraction is applied" to IMAGE. The IRSA mosaic tool computes the science image as
`data = IMAGE - ZODI`. Our tool must do the same, so the cache must keep the ZODI extension.

### Pixel flags (ES Table 16)

| Bit | Name | Meaning (short) |
|----:|------|-----------------|
| 0 | TRANSIENT | Cosmic ray or similar during the ramp. Can also mark bloom spill from a very bright neighbour. |
| 1 | OVERFLOW | Overflow threshold reached, about half of full-well saturation. |
| 2 | SUR_ERROR | Data handling error. With TRANSIENT or OVERFLOW it means early in the exposure. |
| 6 | NONFUNC | Permanently dead pixel. |
| 7 | DICHROIC | Dark corners of bands 3 and 4, low throughput. |
| 9 | MISSING_DATA | Lost in downlink. |
| 10 | HOT | Noisy this exposure. |
| 11 | COLD | Unresponsive this exposure. |
| 12 | FULLSAMPLE | Informational only. |
| 14 | PHANMISS | Could not be corrected, phantom pixels missing. |
| 15 | NONLINEAR | No reliable nonlinearity correction. |
| 17 | PERSIST | Persistent charge. |
| 19 | OUTLIER | Flagged by outlier module. |
| 20 | CROSSTALK | Ordinary crosstalk. |
| 21 | SOURCE | Pixel mapped to a known source. Informational, not bad. |
| 22 | GHOST | Optical ghost from a bright source in the frame. |
| 23 | GHOST_FPA | Currently unused. |
| 24 | GHOST_EXT | Ghost from a source outside the field. In development. |
| 25 | STREAK | Satellite streak. |
| 26 | BLOOM | Source blooming. |
| 27 | SNOWBALL | Snowball event. |
| 28 | HALO | Halo of a transient. Use caution. |
| 29 | SATELLITE_HALO | Halo of a satellite streak. Not recommended for science. |

Bad-pixel rule used by the IRSA mosaic tool (ES 3.4.3): set to NaN if any of TRANSIENT, SUR_ERROR, NONFUNC, DICHROIC,
MISSING_DATA, HOT, COLD, PHANMISS, NONLINEAR, PERSIST, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK, BLOOM, SNOWBALL, HALO,
SATELLITE_HALO. OVERFLOW, SOURCE and OUTLIER are not rejected, only propagated. `BAD_PIXEL_MASK` in `server/` must equal this list (bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29).

Flag values seen in the Barnard's Star crops, decoded (measured, decoded with Table 16):

| Value | Meaning |
|------:|---------|
| 2097152 | SOURCE |
| 2097216 | SOURCE + NONFUNC |
| 69206017 | SOURCE + BLOOM + TRANSIENT |
| 69206018 | SOURCE + BLOOM + OVERFLOW |
| 69206021 | SOURCE + BLOOM + TRANSIENT + SUR_ERROR |
| 69206022 | SOURCE + BLOOM + OVERFLOW + SUR_ERROR |
| 270532608 | SOURCE + HALO |
| 270532613 | SOURCE + HALO + TRANSIENT + SUR_ERROR |

So the whole 29 x 29 crop around Barnard's Star carries SOURCE (it is a known bright source), which is why every pixel is nonzero. That is not a quality problem.

## Detector bands (ES Table 2)

| Detector | Band | Wavelength (um) | R |
|---|---|---|---|
| D1 | 1 | 0.744 to 1.116 | 39 |
| D2 | 2 | 1.099 to 1.651 | 41 |
| D3 | 3 | 1.636 to 2.421 | 41 |
| D4 | 4 | 2.423 to 3.822 | 35 |
| D5 | 5 | 3.809 to 4.420 | 112 |
| D6 | 6 | 4.412 to 5.002 | 128 |

Whole-instrument coverage 0.744 to 5.002 um. Three H2RG detectors for D1 to D3 (SWIR, 62 K) and three for D4 to D6 (MWIR, 45 K).
Exposure time 113.58 s. Pixel 6.15 arcsec. Each detector has a linear variable filter over it so each pixel sees a narrow slice.
As the pointing drifts, successive exposures at offset positions build a full low-resolution spectrum for each source.

Exposure counts for Barnard's Star (measured): 60/60/59/59/60/58 for D1 to D6 (356 usable of 358).

## Facts that shape the design

- **Each image is almost one colour** (LVF). Measured across a 29 pixel crop at 4.55 um: 4.547 to 4.556 um.
  Across all exposures of one spot: 0.74 to 5.0 um.
- **Frames are rotated.** Every exposure has a different sky orientation. Reproject onto a shared north-up, east-left grid before blinking.
  Prototype: `prototype/process.py` (3.075 arcsec/px, 41 x 41, bilinear).
- **Moving targets need epoch-corrected positions.** Barnard's Star J2000 coordinates are about 4.5 arcmin from where it is in 2026.
  Propagate with proper motion (astropy `SkyCoord.apply_space_motion`) before querying.
  The user-typed position is a snapshot of a fixed patch of sky, not a tracked object.
  (The pipeline itself uses Gaia proper motions for astrometry and source masks, ES 3.2.8, so SOURCE flags follow known movers.)
- **Bright stars have masked core pixels.** Measured: only 120 of 356 Barnard's Star exposures had measurable flux. The NaN core pixels carry
  OVERFLOW + SUR_ERROR + SOURCE + BLOOM, so this is saturation and blooming (ES Table 16 and 3.2.1). Bilinear resampling spreads each NaN to its
  neighbours. Handle NaN everywhere.
- **ES says flagged pixels near a source are only a warning.** The photometry tool's `CONTAINS_BAD_PIXEL` (bit 32) is "a conservative warning" and does not necessarily mean exclude the measurement (ES 3.3).

## SPHEREx all-sky HiPS (sky background in the Stellarium view)

All measured 2026-11-13 unless cited.

- Served at `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` (its own `hips_service_url`, ID
  `ivo://IPAC/P/SPHEREx/DR1/cube`). The IBE path `ibe/data/spherex/dr1/hips5_cube/hips_20261026` returns 404 for
  `properties`, tiles and `Moc.fits`. Use the `/data/hips/` URL.
- Properties recorded in `tests/fixtures/hips_spherex_properties.txt`: order 5 (min 0), 512 px PNG tiles,
  pixel 0.0035786 deg (12.9 arcsec), equatorial, `dataproduct_type=cube`, `hips_cube_depth=102`.
- 102 frames in ascending wavelength, `data_cube_crval3_arr` 0.753 to 4.988 um. Frame index = 17*(band-1)+(channel-1).
  Frames 50 and 51 (band 3 channel 17, band 4 channel 1, dichroic) are blank (from the properties `obs_description`).
- Frame 0 is the unsuffixed tile `Npix{n}.png`; frames 1 to 101 are `Npix{n}_{frame}.png`. `_0` and `_102` return 404.
  `Norder3/Allsky.png` and `Allsky_{frame}.png` exist.
- `t_min..t_max` = MJD 60789.75 to 61174.49. **It is a one-year coadd with no time axis.** Moving objects are smeared or
  doubled in it. It is context only; motion comes from the level-2 exposures.
- Tiles carry `access-control-allow-origin: *`. We still proxy them, because the Stellarium engine cannot address cube
  slices (its tile URL is `Norder%d/Dir%d/Npix%d.%s` with no suffix) and so tiles get our disk cache.

## Browser access: CORS

IRSA's cutout and TAP responses carried no `Access-Control-Allow-Origin` header when tested with an `Origin` header (measured).
A page on another origin cannot read them, so a backend must do the fetching. Claude.ai artifacts additionally cannot
fetch any external host (CSP), so an artifact can only be a precomputed demo.

## Sandbox note

In the Claude Code sandbox, TLS verification to IRSA and spaceappschallenge.org fails. The user approved skipping it
there (`curl -k`, `requests verify=False`). Production code must verify TLS. The code reads env var
`SPHEREX_INSECURE_TLS=1` to skip verification, default off.

## Still unverified

- Proper motion of WISE 0855: prototype used pmra -8143 and pmdec 680 mas/yr from memory. Check against Gaia or the literature.
- Coordinates of Epsilon Indi B, RW Aurigae, R Draconis: not yet resolved. Plan Task 2 pins them.
- Whether `X-Frame` cutout size limits exist on the IRSA service for sizes above 0.1 degrees. Untested.
