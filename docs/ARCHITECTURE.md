# Architecture

```
browser (web/, vanilla ES modules, no build step)
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

## Files

| Path | Responsibility |
|------|----------------|
| `server/targets.py` | `TARGETS`, `propagate()` |
| `server/irsa.py` | `find_exposures()` |
| `server/cutouts.py` | `fetch_cutout()` |
| `server/mirror.py` | `fetch_exposure()` (whole file from the AWS mirror, trimmed, LRU cache with a size cap), `cut()` (local crop), `prefetch()` |
| `server/catalog.py` | local SQLite snapshot of the exposure list: `Catalog.find()`, `add_exposures()`, `Catalog.status()` (for `/health`) |
| `server/diskcache.py` | size cap (`SPHEREX_RENDER_CACHE_GB`, default 10) and expiry for `png/`, `grids/`, `cutouts/`, `tap/`: `prune()`, `touch()` |
| `scripts/snapshot_metadata.py` | fill the snapshot from IRSA TAP in time windows, resumable (network) |
| `server/footprint.py` | `exposure_from_head()`: time, detector, obs id and footprint from a file's first 28,800 bytes (hand-parsed TAN + SIP) |
| `scripts/snapshot_from_aws.py` | fill the snapshot from the AWS mirror alone: list the bucket, read each file's header, resumable (network) |
| `server/pixels.py` | `science_image()` (IMAGE minus ZODI, saturation-aware masking), `masked_pixels()`, `BAD_PIXEL_MASK`, `HARD_PIXEL_MASK` |
| `server/reproject.py` | `resample_north_up()` (NaN-aware north-up resampling), `wavelength_at()` |
| `server/app.py` | routes, `render_frame_cached()`, `RENDER_VERSION` in the PNG cache path |
| `scripts/resolve_targets.py` | one-off: SIMBAD positions and proper motions, cross-checked against Gaia DR3 |
| `scripts/check_targets.py` | exposure counts per challenge target (network) |
| `scripts/prewarm.py` | warm every frame the browser would request, and report the cost (network on a cold cache) |
| `scripts/compare_masks.py` | archive-mask versus page-mask contact sheet, for judging a render change |
| `web/index.html`, `web/css/app.css` | page shell |
| `web/js/state.js` | hash parse/serialise |
| `web/js/stretch.js` | pixel to colour |
| `web/js/windows.js` | time-window grouping and stacking |
| `web/js/loader.js` | progressive frame loading |
| `web/js/app.js` | wiring, blink player |
| `tests/` | pytest (server), `web/test/` node:test (frontend); `tests/test_targets.py` covers the five targets |
| `prototype/` | throwaway scripts that proved the pipeline. Read, copy ideas, do not import. |

## Next.js canvas integration

The existing Next.js UI (`web/components/SkyExplorer.tsx`) controls the same
Stellarium canvas via `SkyCanvas.tsx`. Its layout, drawers, overlays and control
components remain in place. `web/index.html` and its runtime remain independent.

| Path | Responsibility |
|------|----------------|
| `web/js/backend-sky.js` | React adapter reusing the legacy `Loader`, `PhotoCache`, timeline and hash format; sequence queries, progressive PNG loading, rolling medians, cancellation and north-up calibration |
| `web/js/backend-sky.d.ts` | Typed adapter interface for React |
| `web/lib/backend-bands.ts` | Map the existing selected bands into backend wavelength windows or detector queries |
| `web/app/api/[...path]/route.ts` | Same-origin streaming proxy for the backend's target, view, patch, sequence and frame endpoints; preserves `X-Frame-Meta` |

Run Next.js from `web/`. `SPHEREX_BACKEND_URL` defaults to
`http://130.61.174.88:8000` and can be set in `web/.env.local`. FOV is degrees
in backend requests and the legacy hash, arcminutes in the existing Next.js
query parameters and readout. The observer's clock stays fixed while playback
switches actual images; changing observer time would move the catalogue pointing.

The supplied backend exposes rendered PNGs and frame metadata. It does not expose
raw science arrays, spectra, or Gaia/WISE catalog queries. The existing advanced
frontend implementations and sample JSON route are retained; these tools have
not been replaced with invented backend endpoints or PNG-derived science values.

### Frontend request caching and band sidebar

`web/js/frontend-cache.js` shares identical in-flight requests and caches successful
responses, including `X-Frame-Meta`. Memory and browser Cache Storage each have
64 MiB / 512-entry limits. PNGs expire after 24 hours, sequences after five minutes,
and targets after one hour. Cache Storage keeps responses across reloads where
supported; storage failures fall back to the bounded memory cache. Failed and
aborted requests are not cached.

`web/js/frame-assets.js` keeps up to 256 image blobs within 64 MiB. The engine uses
these Blob URLs instead of downloading each PNG again. Eviction removes the
associated photo and revokes its URL; canvas disposal releases the remaining URLs.

Band selection has one source of truth in `SkyExplorer`. The floating right sidebar
and Advanced tools share it. Partial detector selections query half-channel
wavelength boundaries and filter returned exposures by detector; full detectors
use one query each. Rapid selection changes wait 300 ms before loading. This keeps
the existing frontend's wavelength mapping, rather than claiming a new calibrated
102-channel axis.

Offline checks: `node --test "web/test/*.test.js"` from the project root and
`node --experimental-strip-types tests/backend.test.ts` from `web/`. Manual live
verification: `node scripts/check_band_cache.mjs` with Next.js at localhost:5173;
`NEXT_CHECK_URL` overrides that address. The script checks cold/reload request
counts, detector selections, Advanced sync, last-band protection and sidebar bounds.

The Next.js sequence starts with the standalone viewer's wavelength window:
1.25 micrometres, within 5 percent, with rolling-median fill enabled. The band
picker exposes the sequence wavelength and tolerance. Choosing a band updates
its centre; choosing Exact selected band uses its native channel window.
The wider options explicitly include nearby wavelengths to provide more
exposures for fill; they do not guarantee complete coverage for every exposure.
