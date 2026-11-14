# Architecture

```
browser: web/ (Next.js main app, :5173, proxies /api) or testbench/ (vanilla page served by the server at :8000)
   │  GET /api/exposures?ra&dec           list of exposures covering the patch (~4 s)
   │  GET /api/frame?uri&ra&dec&fov       one reprojected frame, requested in parallel, shown as it arrives
   ▼
server (server/, Python 3.11+, FastAPI)
   ├─ irsa.py       TAP search            -> list[Exposure]
   ├─ cutouts.py    cutout download+cache -> trimmed FITS on disk
   ├─ pixels.py     IMAGE - ZODI, flag masking
   ├─ reproject.py  north-up resample + wavelength lookup
   ├─ targets.py    test targets, proper-motion propagation
   └─ app.py        HTTP routes only, no science logic
   ▼
IRSA (TAP + cutout service). The browser cannot call IRSA directly (see DATA.md, CORS).
```

## Decisions (change only with the user's agreement)

1. **Backend does all astronomy** (astropy, numpy, scipy). The browser only stretches, blinks, stacks, and draws.
2. **Frames travel as raw float32**, not PNG, so the browser can stretch, difference, and stack without re-fetching.
3. **Frames load progressively.** The first frame must appear before the last is fetched.
4. **State lives in the URL hash** (`#ra=..&dec=..`), so a view can be linked or embedded (O7).
5. **Fixed output pixel scale 3.075 arcsec.** `n = round(fov_arcsec / 3.075)`, forced odd so the target pixel is the centre.
6. **Orientation is fixed in the API:** row 0 is north, column 0 is east. The frontend draws the array as is. (The prototype
   stored row 0 as south and flipped in the browser. That caused a real bug. Do not repeat it.)
7. **No database.** A disk cache of trimmed FITS files keyed by `sha1(uri + ra + dec + fov)`.

## HTTP contract

### `GET /api/exposures?ra=<deg>&dec=<deg>[&det=1,2,...]`

200 JSON:

```json
{"ra": 269.4463, "dec": 4.7677, "count": 358,
 "exposures": [{"uri": "ibe/data/spherex/dr1/...fits", "mjd": 60902.864715,
                "date": "2025-08-15", "detector": 6}]}
```

Sorted by `mjd`. `count` 0 returns 200 with an empty list. 422 for invalid `ra`/`dec`. 502 if IRSA fails.

### `GET /api/frame?uri=<uri>&ra=<deg>&dec=<deg>&fov=<arcsec>[&mask=1]`

200 `application/octet-stream`: `n*n` little-endian float32, row-major, NaN for no data, units MJy/sr.
Pixels are the science image `IMAGE - ZODI`; which flags mask a pixel is decided by the two-mask rule in `docs/DATA.md` (unusable
bits, plus TRANSIENT/SUR_ERROR only away from saturation), so a bright star keeps its core.
Header `X-Frame-Meta`: JSON `{"n":41,"scale_arcsec":3.075,"mjd":...,"detector":6,"wavelength_um":4.55,
"bandwidth_um":0.036,"obs_id":"2026W12_1A_0598_1"}`.
`uri` must match `^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$`, otherwise 422. This stops the server fetching arbitrary URLs.
502 if the cutout download fails (the client skips the frame and shows a count of skipped frames).

## URL hash schema (frontend)

`ra`, `dec` (deg, float), `fov` (arcsec, default 126, max 360), `det` (comma list, default all), `speed` (fps, default 6),
`mode` (`frame` | `coadd` | `diff` | more from DISPLAY-IDEAS), `win` (time window in days, 0 = none),
`pmra`, `pmdec` (mas/yr, for the predicted-position marker). Invalid values fall back to defaults and never throw.

### `GET /api/gaia?ra=<deg>&dec=<deg>&fov=<deg>`

200 JSON `{"epoch": 2016.0, "ra", "dec", "radius", "sources": [{"source_id": "<string>", "ra", "dec", "pmra", "pmdec",
"parallax", "gmag", "fast"}]}`: the 50 brightest Gaia DR3 stars in the cone plus every star with total proper motion
above 100 mas/yr. Positions at J2016.0. `source_id` is a string (19 digits overflow JavaScript numbers); `pmra`, `pmdec`,
`parallax`, `gmag` may be null. The centre snaps to a 0.05 deg grid and the radius to 0.1/0.25/0.5/0.75 deg; answers are
cached forever in `cache_dir()/gaia/` (empty ones are not). 422 for invalid input, 502 if IRSA fails.

### `GET /api/gaia/source/{source_id}`

200 one source as above, 404 `No Gaia DR3 source has that ID.`, 422 unless 1 to 19 digits, 502 if IRSA fails.

Object names are resolved in the browser by CDS Sesame (it allows any origin), not by this server.

## Files

| Path | Responsibility |
|------|----------------|
| `server/targets.py` | `TARGETS`, `propagate()` |
| `server/irsa.py` | `find_exposures()` |
| `server/gaia.py` | Gaia DR3 from IRSA TAP: `cone()` (brightest + fast movers), `source()` by id |
| `server/cutouts.py` | `fetch_cutout()` |
| `server/mirror.py` | `fetch_exposure()` (whole file from the AWS mirror, trimmed, LRU cache with a size cap), `cut()` (local crop), `prefetch()` |
| `server/catalog.py` | local SQLite snapshot of the exposure list: `Catalog.find()`, `add_exposures()`, `Catalog.status()` (for `/health`) |
| `server/diskcache.py` | size cap (`SPHEREX_RENDER_CACHE_GB`, default 10) and expiry for `png/`, `grids/`, `cutouts/`, `tap/`: `prune()`, `touch()` |
| `scripts/data/snapshot_metadata.py` | fill the snapshot from IRSA TAP in time windows, resumable (network) |
| `server/footprint.py` | `exposure_from_head()`: time, detector, obs id and footprint from a file's first 28,800 bytes (hand-parsed TAN + SIP) |
| `scripts/data/snapshot_from_aws.py` | fill the snapshot from the AWS mirror alone: list the bucket, read each file's header, resumable (network) |
| `server/pixels.py` | `science_image()` (IMAGE minus ZODI, saturation-aware masking), `masked_pixels()`, `BAD_PIXEL_MASK`, `HARD_PIXEL_MASK` |
| `server/reproject.py` | `resample_north_up()` (NaN-aware north-up resampling), `wavelength_at()` |
| `server/composite.py` | NaN-aware static-sky and previous-visit differences, and date-coloured trails |
| `web/lib/wavelength-color.ts` | Display-only infrared wavelength false-color mapping and SVG tint matrix |
| `web/lib/composite.ts` | Frame filter names and metadata colour keys |
| `web/components/FrameFilterControl.tsx` | Raw, Difference, Previous visit and Trail controls and colour key |
| `server/app.py` | routes, `render_frame_cached()`, `RENDER_VERSION` in the PNG cache path |
| `scripts/data/resolve_targets.py` | one-off: SIMBAD positions and proper motions, cross-checked against Gaia DR3 |
| `scripts/data/check_targets.py` | exposure counts per challenge target (network) |
| `scripts/data/prewarm.py` | warm every frame the browser would request, and report the cost (network on a cold cache) |
| `scripts/data/compare_masks.py` | archive-mask versus page-mask contact sheet, for judging a render change |
| `scripts/checks/*.mjs` | browser checks against a running app (network): `acceptance.mjs`, `check_band_cache.mjs`, `check_next_backend.mjs` |
| `testbench/index.html`, `testbench/app.css` | test bench page shell, served at `/` by `server/app.py` |
| `testbench/app.js` | test bench wiring, blink player |
| `testbench/sky.js` | test bench Stellarium engine setup |
| `web/shared/state.js` | hash parse/serialise |
| `web/shared/viewbox.js` | which frames cover the view |
| `web/shared/queue.js` | progressive frame loading (`Loader`, `priorityList`) |
| `web/shared/timeline.js` | visit steps for the blink |
| `web/shared/photos.js` | `PhotoCache` |
| `web/shared/gaia.js` | Gaia helpers: `propagate()` (epoch), `classifyQuery()`, `parseSesame()`, `tooltipLines()` |
| `web/lib/resolve.ts` | search lookups: name via Sesame, Gaia DR3 id via `/api/gaia/source`, placed at today's position |
| `web/lib/gaiaFetch.ts` | `needsRefetch()`: when the overlay asks `/api/gaia` again |
| `web/components/GaiaOverlay.tsx` | Gaia rings, fast-mover arrows, tooltips, click to re-centre; placed with `Sky.toScreen()` from `web/shared/sky.js` |
| `tests/` | pytest (server); `tests/test_targets.py` covers the five targets |
| `web/tests/shared/` | node:test for `web/shared/` |
| `web/tests/unit/`, `web/tests/browser/` | Next.js unit tests and Playwright |
| `archive/` | throwaway work (`prototype/`, `spike/`). Read, copy ideas, do not import. |

## Next.js canvas integration

The Next.js UI (`web/components/SkyExplorer.tsx`) starts Stellarium exactly as
the test bench (`testbench/index.html`) does: `SkyCanvas.tsx` calls `initSky()` from `web/shared/sky.js`, the
engine owns the view (drag and wheel move it directly), and React only reads the
view back (`onView`) or sends an explicit move (`goto`). Both pages load the engine
from `/engine/`.

| Path | Responsibility |
|------|----------------|
| `web/shared/sky.js` | Engine bootstrap shared by both pages: script loading, equatorial airless view, SPHEREx HiPS background, RA/Dec read/set, engine-matching screen projection for the target marker |
| `web/public/engine/` | Committed copy of the engine build; `npm run sync-engine` (also run before `dev` and `build`) refreshes it from `vendor/stellarium-web-engine/build` |
| `web/shared/backend-sky.js` | Frame loading on the shared sky, reusing the legacy `Loader`, `PhotoCache`, timeline and hash format; sequence queries, progressive PNG loading, rolling medians, cancellation and north-up calibration. Frames are keyed per sequence box and earlier boxes stay loaded after a pan; the layer hides only when zoomed out past frame scale. The blink runs on one box: the loaded box that holds the whole canvas (most frames wins, the current box on a tie). Only that box is drawn and its exposures are the timeline, because two boxes drawn over each other sit on different pixel grids and shift the picture. Until the box being loaded has the exposure on screen (which it downloads first), every box on screen is drawn and the timeline carries over. The exposure the user chose is kept through reloads. A loaded box that still covers the view is asked for again instead of a new one, so the caches answer without a download |
| `web/shared/backend-sky.d.ts` | Typed adapter interface for React, including `onProgress` ({phase, done, total, failed, cleaned}: finding, loading, cleaning while raw frames are swapped for their rolling medians, ready, failed, empty, error, zoomed-out, hidden) |
| `web/shared/viewbox.d.ts` | Types for `viewbox.js` (frame-box geometry, `LOAD_FOV_DEG`) |
| `web/components/ZoomRuler.tsx` | Straight zoom control: a log ruler of the field of view sliding under a fixed needle (drag, wheel, arrow/Page/Home/End keys); marks the 30′ stretch where frames load and says what the loader is doing |
| `web/lib/zoom-ruler.ts` | Ruler geometry: field ↔ offset, ticks and labels, readout text, 1.25× steps |
| `web/lib/load-progress.ts` | Plain-language title, detail and progress fractions for `onProgress`, shown on the time dial (arcs and status line) and under the ruler |

The test bench (`testbench/`) is a separate page; the server serves it at `/` and `web/shared/` at `/shared`.
| `web/lib/backend-bands.ts` | Map the existing selected bands into backend wavelength windows or detector queries |
| `web/app/api/[...path]/route.ts` | Same-origin streaming proxy for the backend's target, view, patch, sequence and frame endpoints; preserves `X-Frame-Meta` |

Run Next.js from `web/`. `SPHEREX_BACKEND_URL` defaults to
`http://130.61.174.88:8000` and can be set in `web/.env.local`. FOV is degrees
in backend requests and the legacy hash, arcminutes in the existing Next.js
query parameters and readout. The observer's clock stays fixed while playback
switches actual images; changing observer time would move the catalogue pointing.

The supplied backend exposes rendered PNGs and frame metadata. It does not expose
raw science arrays, spectra, or Gaia/WISE catalog queries. The sample JSON route
(`/api/observations`, used by Image math) is retained; it has not been replaced
with invented backend endpoints or PNG-derived science values. The unused
spectral viewer, metadata panel and catalog overlay components were removed
(2026-11-14); they are in git history if those features return.

### Frontend request caching and band sidebar

`web/shared/frontend-cache.js` shares identical in-flight requests and caches successful
responses, including `X-Frame-Meta`. Memory and browser Cache Storage each have
64 MiB / 512-entry limits. PNGs expire after 24 hours, sequences after five minutes,
and targets after one hour. Cache Storage keeps responses across reloads where
supported; storage failures fall back to the bounded memory cache. Failed and
aborted requests are not cached.

`web/shared/frame-assets.js` keeps up to 1024 image blobs within 64 MiB. It evicts a whole sequence box at a time, least recently used first, and never the box on screen, which alone may exceed the budget (a 1 deg box of 13 exposures is about 25 MB with the cleaned frames). The engine uses
these Blob URLs instead of downloading each PNG again. Eviction removes the
associated photo and revokes its URL; canvas disposal releases the remaining URLs.

Band selection has one source of truth in `SkyExplorer`. The floating right sidebar
and Advanced tools share it. Partial detector selections query half-channel
wavelength boundaries and filter returned exposures by detector; full detectors
use one query each. Rapid selection changes wait 300 ms before loading. This keeps
the existing frontend's wavelength mapping, rather than claiming a new calibrated
102-channel axis.

Offline checks: `npm test` from `web/` (runs `tests/shared/` and `tests/unit/`;
the TS unit tests need a Node build with TypeScript stripping). Manual live
verification: `node scripts/checks/check_band_cache.mjs` with Next.js at localhost:5173;
`NEXT_CHECK_URL` overrides that address. The script checks cold/reload request
counts, detector selections, Advanced sync, last-band protection and sidebar bounds.

The Next.js sequence starts with the standalone viewer's wavelength window:
1.25 micrometres, within 5 percent, with rolling-median fill enabled. The band
picker exposes the sequence wavelength and tolerance. Choosing a band updates
its centre; choosing Exact selected band uses its native channel window.
The wider options explicitly include nearby wavelengths to provide more
exposures for fill; they do not guarantee complete coverage for every exposure.

### Frame filters

`/api/sequence` and `/api/frame.png` accept `filter=raw|difference|previous|trail` (default `raw`). Filtered sequences use separate cache keys. Difference subtracts the static sky; Previous visit subtracts the earlier visit (the next visit for the first); Trail colours earlier visits by date. Frame metadata supplies the reference dates and colour key.

The wavelength-color toolbar toggle tints the Raw sky canvas using the displayed frame wavelength, falling back to the selected wavelength while loading. The band ruler inside the Bands menu uses the same wavelength colors, ordered from short (violet) to long (red); its gradient follows each band’s wavelength rather than spreading colors evenly over band numbers. Comparison modes keep their own color keys. Tab hides the interface and grid without unmounting the engine; Tab or Escape restores it.

The canvas applies display gamma `output = input^1.6` in sRGB before wavelength tinting, darkening midtones while preserving black and peak white. This does not change cached science pixels.
