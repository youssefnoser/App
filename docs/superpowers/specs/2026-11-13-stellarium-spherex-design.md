# Design: Stellarium sky with SPHEREx HiPS and blinked TAP exposures

Date: 2026-11-13. Approved by the user in conversation.

## Intent

Replace the planned Canvas blink viewer with the Stellarium Web Engine (`vendor/stellarium-web-engine`) as the main display.
The user sees a real sky they can pan and zoom, painted with SPHEREx data, and the dated SPHEREx frames of their chosen patch
blink on top of it so movers stand out.

Two SPHEREx sources, both chosen by the user:

1. **DR1 all-sky HiPS cube** for the sky background, with a wavelength picker.
2. **DR1 level-2 exposures**, found with the IRSA TAP API and cut out per patch, for the time series (R3, R4).

## Goals

- SPHEREx HiPS renders in Stellarium at any of the 100 non-blank wavelengths.
- Entering RA/Dec (or a URL hash) points the sky at the patch and blinks its dated frames there.
- Barnard's Star visibly drifts north over the HiPS background (R5 check).

## Non-goals

- Rebuilding or patching the engine (no emcc in the environment; we use the prebuilt `build/` output).
- Server-side HiPS generation of individual exposures.
- Gaia or WISE overlays (O6) in this round.

## Anti-goals

- Treating the HiPS as a time series. It is a one-year coadd (MJD 60789.75 to 61174.49). UI copy must not suggest it shows motion.
- Dropping raw float32 frames to the browser (ARCHITECTURE decision 2). Stretch, coadd and difference stay client-side.
- Hammering IRSA: every tile and cutout is cached on disk, downloads capped at 8, 60 s timeout.

## Constraints

- Facts in `docs/DATA.md` "SPHEREx all-sky HiPS" (measured): service URL, frame suffix rule, blank frames 50 and 51, CORS.
- The engine HiPS loader has no cube support and reads png/webp/jpeg only.
- The engine is AGPL-3.0. The public page links to the engine source.
- All existing AGENTS.md rules (test first, offline tests, IMAGE - ZODI, north-up east-left, NaN is normal).

## Approaches

| Approach | Trade-off | Outcome |
|----------|-----------|---------|
| **Hybrid: HiPS survey layer + TAP frames as `photo` overlays** | Keeps float32 frames and client-side modes; SPHEREx dated pixels only inside the FOV (max 360 arcsec) | **Chosen** |
| Server builds HiPS tiles per exposure, blink by switching surveys | Native engine path, any zoom, but breaks decision 2, heavy on IRSA and slow | Dropped |
| HiPS only, or TAP footprints only | Cheap, but neither shows motion (fails R3/R4) | Dropped |

## Decisions

- **HiPS slice proxy** (`server/hips.py`): each cube frame is exposed as a flat survey at `/hips/spherex/{frame}/`.
  Properties are rewritten (cube keys removed, service URL pointed at the proxy). Tile paths map to upstream with the frame
  suffix rule. Tiles are cached under `.cache/hips/`. Contract in `docs/ARCHITECTURE.md`.
- **Static mounts**: engine build at `/stel/`, engine test sky data (stars, DSOs, sky cultures) at `/skydata/`.
- **Sky set-up**: atmosphere and landscape off, so the sky shows regardless of clock time. Survey layer = SPHEREx slice.
- **Wavelength picker**: frame index to wavelength from the properties `data_cube_crval3_arr`. Frames 50 and 51 are skipped.
  Default frame 88 (4.533 um, detector 6, where brown dwarfs are bright).
- **Dated frames**: the browser stretches each `/api/frame` array to a canvas, makes a blob URL, and loads it into a
  Stellarium `photo` object at the patch centre with `pixscale = 3.075` arcsec. One photo per frame in its own layer;
  blinking toggles `visible`. Coadd and difference render into a photo the same way.
- **Orientation**: the photo calibration sign (north up, east left) is proved with a synthetic asymmetric frame in
  headless Chromium, not by eye.
- **URL hash**: existing schema plus `band` (HiPS frame index).

## Left to the builder

- Exact Stellarium JS calls for creating a layer and a photo object, and switching the `dss` data source (check
  `src/js/obj.js` and the `simple-html` app).
- Layout of the controls around the sky canvas, following the UI copy rules in AGENTS.md.
