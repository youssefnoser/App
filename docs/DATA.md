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
- **AWS mirror** (measured 2026-11-13): `https://nasa-irsa-spherex.s3.amazonaws.com/` serves the same products and is publicly listable
  (S3 `ListObjectsV2`). The TAP `uri` maps straight onto a key: drop `ibe/data/spherex/`, so `dr1/level2/<period>/<version>/<det>/<file>.fits`.
  Top level holds `dr1/`, `qr2/`, `qr3/`, including `dr1/hips5_cube/` (the 102-channel all-sky cube behind the background slider).
  The bucket carries **products only**: exposure footprints exist only in IRSA's TAP schema (`spherex.plane.poly`), so the mirror cannot
  replace TAP for "which exposures cover this position". One level-2 file is 65 MB (2040 x 2040 arrays) against about 0.25 to 4 MB for the
  same sky through the cutout service. One file serves every patch of an exposure, which is why the mirror is now the default
  pixel source: see "Getting data without IRSA" below for the measured speeds (an earlier 300 KB/s figure here was wrong).
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

## Getting data without IRSA: AWS mirror and local snapshot (measured 2026-11-13)

This is the default path (`SPHEREX_SOURCE=aws`; `irsa` switches back to the two calls above).

- **Mirror.** Bucket `nasa-irsa-spherex` (AWS Open Data), public, HTTPS at `https://nasa-irsa-spherex.s3.amazonaws.com/`.
  The key is the TAP `uri` without the leading `ibe/data/spherex/`. It holds the image files and the HiPS cube, but no table of
  which exposure covers which position, and it has no cutout service.
- **File layout** of one Level-2 file (64,952,640 bytes): IMAGE, VARIANCE and ZODI are uncompressed 2040 x 2040 float32; FLAGS is a
  Rice-compressed table; EPSF and WCS-WAVE follow. Byte-range requests work (HTTP 206), not used yet.
- **Speed from this host.** One whole file: 3.4 s. The 18 first-batch exposures of Barnard's Star with 8 downloads at once: 15.5 s,
  900 MB on disk after trimming to IMAGE, FLAGS, ZODI, WCS-WAVE (50 MB each, FLAGS stored uncompressed).
- **Same pixels.** For those 18 exposures, the crop cut locally and the IRSA cutout give identical values after resampling
  (largest difference 0). The local crop is wider (it allows for the detector's roll angle), so 2 to 5% more of each patch is filled.
- **Cache.** `.cache/exposures/`, least recently used deleted above `SPHEREX_EXPOSURE_CACHE_GB` (default 6). Rendered PNGs and grids are capped separately by `SPHEREX_RENDER_CACHE_GB` (default 3), so the whole cache stays under 10 GB.
- **Exposure list.** `scripts/data/snapshot_metadata.py` copies `spherex.artifact` joined to `spherex.plane` into
  `.cache/meta/exposures.sqlite` through queued TAP jobs, one per 30 days of observation time. Re-run with `--refresh` after a data release.
  A filled list is also committed at `data/exposures.sqlite` (Git LFS); the backend falls back to it when there is no
  local one. Deployments read the same rows from PostgreSQL (`SPHEREX_CATALOG_URL`, see ARCHITECTURE.md,
  "Deployment on Vercel").
- **Exposure list without IRSA.** `scripts/data/snapshot_from_aws.py` lists `dr1/level2/` and `qr3/level2/` (1,179,406 + 448,824 files,
  counted 2026-11-13; `qr2/` has 1,367,330 but is superseded: "DR1 and QR3 together supersede QR2", IRSA data-access guide) and reads
  the first 28,800 bytes of each file. The IMAGE header gives `MJD-BEG` (equal to TAP's `time_bounds_lower`), `DETECTOR`, `OBSID` and
  the WCS (TAN + SIP order 3), from which the four detector corners are computed. Checked on one file: corners within one pixel of
  TAP's `poly`, and within 0.01 arcsec of astropy's WCS. The bucket has no index or manifest of its own.

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

### Two masks, not one (measured 2026-11-13)

**The IRSA mosaic rule** (ES 3.4.3) sets a pixel to NaN if any of TRANSIENT, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD,
PHANMISS, NONLINEAR, PERSIST, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK, BLOOM, SNOWBALL, HALO, SATELLITE_HALO is set.
That is right for a stacked mosaic, where a flagged frame is outvoted by the others. It is wrong for a single exposure: on the first-visit
Barnard's Star crop it blanks 34% of the 5 x 5 core and leaves a peak of 25 MJy/sr where the data hold 1609. `BAD_PIXEL_MASK` in
`server/pixels.py` still equals this list (bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29), so the archive's
own behaviour stays testable, but `science_image()` does not use it.

**What the page draws** (`HARD_PIXEL_MASK` plus a saturation rule). Unusable bits always mask: NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD,
PHANMISS, NONLINEAR, PERSIST, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK, SNOWBALL, HALO, SATELLITE_HALO. TRANSIENT and SUR_ERROR mask
only where no pixel within one pixel is OVERFLOW or BLOOM. ES 3.2.1 is the reason: a saturating source flags its core as an early transient or
early overflow, then blooms outward and leaves a ring of late transients, so near a star those two flags are signal rather than a cosmic ray.
Measured over 315 Barnard cutouts: core pixels masked drop from 34.4% to 6.0%, and the rule re-admits only 5 to 13 pixels per frame, all of
them beside the star. A cosmic ray on blank sky is still blanked, which is what keeps it from blinking as a false mover.
OVERFLOW, OUTLIER and SOURCE are propagated, never masked, as in the IRSA mosaic tool.

Expect two or three pixels of NONFUNC to stay blank inside a bright core, and remember that a saturated pixel's value is a *lower limit*
(ES 3.2.1: the slope fit stops at the transient). Those cores carry 1100 to 2600 MJy/sr, far above the 40 MJy/sr top of the display stretch,
so they render as flat white, never as holes.

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
  Prototype: `archive/prototype/process.py` (3.075 arcsec/px, 41 x 41, bilinear).
- **Moving targets need epoch-corrected positions.** Barnard's Star J2000 coordinates are about 4.5 arcmin from where it is in 2026.
  Propagate with proper motion (astropy `SkyCoord.apply_space_motion`) before querying.
  The user-typed position is a snapshot of a fixed patch of sky, not a tracked object.
  (The pipeline itself uses Gaia proper motions for astrometry and source masks, ES 3.2.8, so SOURCE flags follow known movers.)
- **Bright stars have masked core pixels.** Measured: only 120 of 356 Barnard's Star exposures had measurable flux *under the IRSA mosaic rule*.
  The masked core pixels carry OVERFLOW + SUR_ERROR + SOURCE + BLOOM (or TRANSIENT), so this is saturation and blooming (ES Table 16 and 3.2.1),
  and the values are real: 1100 to 2600 MJy/sr. Masking them deletes the brightest thing in the frame. See the two-mask section above.
- **Resampling must not grow the holes.** Naive bilinear propagation of NaN took the masked fraction inside the footprint from 2.9% to 8.1%
  (one dead input pixel smeared over about nine output pixels). `resample_north_up` now interpolates from valid neighbours only and returns NaN
  where less than half the bilinear weight is valid: measured 0.6% against 0.7% native, and a single masked pixel keeps exactly its own area.
- **ES says flagged pixels near a source are only a warning.** The photometry tool's `CONTAINS_BAD_PIXEL` (bit 32) is "a conservative warning" and does not necessarily mean exclude the measurement (ES 3.3).

## Gaia DR3 (verified 2026-11-14)

- IRSA TAP (`https://irsa.ipac.caltech.edu/TAP/sync`) serves table `gaia_dr3_source` with columns `source_id, ra, dec,
  pmra, pmdec, parallax, phot_g_mean_mag, ref_epoch`. `ref_epoch` is 2016.0 (MJD 57388.5). `pmra` includes cos dec.
  `source_id = 4472832130942575872` returns Barnard's Star (pmra -801.551, pmdec 10362.394 mas/yr, parallax 546.98 mas).
- Two-parameter solutions have empty `pmra`, `pmdec`, `parallax`.
- CDS Sesame `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?<name>` returns XML with `jradeg`/`jdedeg` (J2000)
  and `pmRA`/`pmDE`, and sends `Access-Control-Allow-Origin: *`, so the browser calls it directly.
- IRSA TAP and the ESA Gaia archive TAP send no CORS header, so Gaia queries go through `server/gaia.py`.

## Browser access: CORS

IRSA's cutout and TAP responses carried no `Access-Control-Allow-Origin` header when tested with an `Origin` header (measured).
A page on another origin cannot read them, so a backend must do the fetching. Claude.ai artifacts additionally cannot
fetch any external host (CSP), so an artifact can only be a precomputed demo.

## Sandbox note

In the Claude Code sandbox, TLS verification to IRSA and spaceappschallenge.org fails. The user approved skipping it
there (`curl -k`, `requests verify=False`). Production code must verify TLS. The code reads env var
`SPHEREX_INSECURE_TLS=1` to skip verification, default off.

## Target coordinates (verified 2026-11-13)

Resolved by `scripts/data/resolve_targets.py`, which reads SIMBAD's ICRS J2000 position and proper motion and then cross-checks the nearest Gaia
DR3 source at the propagated 2016 position. `server/targets.py` holds the values.

| Target | ICRS J2000 | pmra, pmdec (mas/yr) | Check |
|---|---|---|---|
| Barnard's Star | 269.4520770, +4.6933650 | -801.551, +10362.394 | Gaia DR3 4472832130942575872, 0.00 arcsec |
| Epsilon Indi B | 331.0441466, -56.7828442 | +3981.977, -2466.832 | Gaia DR3 6412596012146801152, 0.04 arcsec |
| WISE 0855 | 133.8189082, -7.2470480 | -8123.700, +673.200 | SIMBAD 2021ApJS..253....7K, no Gaia source (too faint) |
| RW Aurigae | 76.9565260, +30.4014382 | +7.230, -20.330 | Gaia DR3 156430817820015232, 0.13 arcsec |
| R Draconis | 248.1676108, +66.7549794 | -20.643, +6.149 | Gaia DR3 1648328016354496384, 0.00 arcsec |

- The WISE 0855 coordinates on the challenge page (08h55m10.831s, -07d14m42.53s) are the discovery-epoch position: 86 arcsec east of the
  ICRS J2000 place above, which is 8.12 arcsec/yr over about 10.6 years. Both still fall inside a 0.15 degree view.
- RW Aurigae's SIMBAD and Gaia proper motions differ by 4.3 mas/yr; at 26 years that is 0.1 arcsec, far below one pixel.

## Still unverified

- Whether SPHEREx DR1 *covers* Epsilon Indi B, RW Aurigae and R Draconis, and with how many visits. The exposure index had to come from IRSA
  TAP, which was queueing every job on 2026-11-13 evening (sync requests timed out, async jobs sat in QUEUED); `scripts/data/check_targets.py`
  answers it once the service recovers.
- Whether cutout size limits exist on the IRSA service for sizes above 0.1 degrees. Untested.
