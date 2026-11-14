# Architecture

```
browser (web/, vanilla ES modules, no build step)
   │  Stellarium Web Engine (prebuilt wasm, served at /stel/) draws the sky:
   │    survey layer  = SPHEREx all-sky HiPS, one wavelength slice at a time
   │    photo layer   = the dated SPHEREx frames of the chosen patch, blinked
   │  GET /api/exposures?ra&dec           list of exposures covering the patch (~4 s)
   │  GET /api/frame?uri&ra&dec&fov       one reprojected frame, requested in parallel, shown as it arrives
   │  GET /hips/spherex/{frame}/...       one HiPS wavelength slice, presented as a flat survey
   ▼
server (server/, Python 3.11+, FastAPI)
   ├─ irsa.py       TAP search            -> list[Exposure]
   ├─ cutouts.py    cutout download+cache -> trimmed FITS on disk
   ├─ pixels.py     IMAGE - ZODI, flag masking
   ├─ reproject.py  north-up resample + wavelength lookup
   ├─ targets.py    test targets, proper-motion propagation
   ├─ hips.py       HiPS slice proxy + tile cache
   └─ app.py        HTTP routes and static mounts only, no science logic
   ▼
IRSA (TAP, cutout service, HiPS). The browser cannot call TAP or cutouts directly (see DATA.md, CORS).
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
Pixels are the science image `IMAGE - ZODI`. With `mask=1` (default) pixels with bad-pixel flags are NaN (list in `docs/DATA.md`);
`mask=0` returns them unmasked, useful for very bright stars whose core is otherwise blanked.
Header `X-Frame-Meta`: JSON `{"n":41,"scale_arcsec":3.075,"mjd":...,"detector":6,"wavelength_um":4.55,
"bandwidth_um":0.036,"obs_id":"2026W12_1A_0598_1"}`.
`uri` must match `^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$`, otherwise 422. This stops the server fetching arbitrary URLs.
502 if the cutout download fails (the client skips the frame and shows a count of skipped frames).

### `GET /hips/spherex/{frame}/properties`

`frame` is the HiPS cube frame index, int 0 to 101, otherwise 422. 200 `text/plain`: the upstream properties rewritten as a
flat survey: `dataproduct_type`, `hips_cube_*`, `data_cube_*` and `custom_tile_format*` lines removed,
`hips_service_url` set to this proxy path, `obs_title` suffixed with the slice wavelength.

### `GET /hips/spherex/{frame}/Norder{k}/Dir{d}/Npix{n}.png` and `GET /hips/spherex/{frame}/Norder3/Allsky.png`

200 `image/png`, the upstream tile for that slice (frame 0 unsuffixed, frames 1 to 101 with `_{frame}`, see DATA.md).
Cached on disk under `.cache/hips/`. 404 if upstream has no such tile. 502 if upstream fails.

### Static mounts

`/` -> `web/`, `/stel/` -> `vendor/stellarium-web-engine/build/`, `/skydata/` -> `vendor/stellarium-web-engine/apps/test-skydata/`.

## URL hash schema (frontend)

`ra`, `dec` (deg, float), `fov` (arcsec, default 126, max 360), `det` (comma list, default all), `speed` (fps, default 6),
`mode` (`frame` | `coadd` | `diff` | more from DISPLAY-IDEAS), `win` (time window in days, 0 = none),
`pmra`, `pmdec` (mas/yr, for the predicted-position marker), `band` (HiPS frame index 0 to 101, not 50 or 51; default 88, 4.533 um). Invalid values fall back to defaults and never throw.

## Files

| Path | Responsibility |
|------|----------------|
| `server/targets.py` | `TARGETS`, `propagate()` |
| `server/irsa.py` | `find_exposures()` |
| `server/cutouts.py` | `fetch_cutout()` |
| `server/pixels.py` | `science_image()` (IMAGE minus ZODI, bad-pixel masking), `BAD_PIXEL_MASK` |
| `server/reproject.py` | `reproject_frame()` |
| `server/hips.py` | HiPS slice proxy: properties rewrite, tile URL mapping, tile cache |
| `server/app.py` | routes, static mounts |
| `web/index.html`, `web/css/app.css` | page shell |
| `web/js/state.js` | hash parse/serialise |
| `web/js/stretch.js` | pixel to colour |
| `web/js/windows.js` | time-window grouping and stacking |
| `web/js/loader.js` | progressive frame loading |
| `web/js/sky.js` | Stellarium engine start-up, data sources, survey switch, point at patch |
| `web/js/bands.js` | HiPS frame index <-> wavelength, blank frames |
| `web/js/overlay.js` | float32 frame -> image -> Stellarium photo object |
| `web/js/app.js` | wiring, blink player |
| `tests/` | pytest (server), `web/test/` node:test (frontend) |
| `prototype/` | throwaway scripts that proved the pipeline. Read, copy ideas, do not import. |
