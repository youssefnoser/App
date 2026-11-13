# View-Following SPHEREx Frames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stellarium sky with the SPHEREx DR1 mosaic as background where, wherever the user zooms in, real SPHEREx exposures load patch by patch around the view and blink as one continuous sky.

**Architecture:** A FastAPI server finds exposures (IRSA TAP, with footprints), cuts and caches per-patch crops, and renders them north-up as PNG with a fixed stretch. `GET /api/view` returns the patches around a view (HEALPix order 9, rings 0 to 2) and which exposures cover which patch. The browser (plain ES modules, no build step) runs the forked Stellarium Web Engine, queues crop requests by priority, and shows one exposure per blink step across all patches.

**Tech Stack:** Python 3.11+, uv, FastAPI, uvicorn, httpx, astropy, astropy-healpix, numpy, scipy, pillow, pytest. Browser: ES modules, Stellarium Web Engine (fork `youssefnoser/stellarium-web-engine`, branch `spherex`, submodule `vendor/stellarium-web-engine`), Node 22 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-view-following-frames-design.md` (approved 2026-11-13). Data facts: `docs/DATA.md`. Spike that proved the engine path: `spike/stellarium/`.

This plan supersedes Tasks 6 to 12 of `docs/superpowers/plans/2026-11-13-spherex-blink-tool.md` (canvas blink, float32 frames). Its Tasks 1, 3, 4 and 5 are reworked here as Tasks 1 to 4. Its Task 2 (test targets) is not needed by this spec.

## Global Constraints

- Science image is `IMAGE - ZODI`. Pixels with any bit of `BAD_PIXEL_MASK` (bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29, per `docs/DATA.md`) become NaN. OVERFLOW (1), SOURCE (21), OUTLIER (19) never mask.
- Every function touching pixels accepts NaN and documents what it does with it. NaN renders as alpha 0.
- Output frames are north-up (row 0 north) and east-left (column 0 east), pixel scale 3.075 arcsec.
- Patches: HEALPix order 9 (`nside = 512`), NESTED, ICRS. Crop side `CROP_DEG = 0.18` (cell diagonal 0.162 deg + 10 %). Output grid `PATCH_N = 211` px (0.18 deg / 3.075 arcsec = 210.7, rounded to odd).
- Stretch: asinh, 0 to 40 MJy/sr, identical for every patch and frame: `t = asinh(clip(x, 0, 40)) / asinh(40)`, byte `round(255 * t)`.
- Visits: consecutive exposures (sorted by MJD) more than 60 days apart start a new visit.
- First batch: one exposure per (visit, detector), the one whose MJD is nearest that visit's midpoint (mean of first and last MJD in the visit).
- Loading starts when FOV < 0.5 deg and the view has been still for 300 ms.
- IRSA: at most 8 concurrent downloads (server semaphore). The browser sends at most 8 crop requests at once. Every HTTP call has a 60 s timeout. No automatic retries.
- TLS verification on. Only env `SPHEREX_INSECURE_TLS=1` disables it.
- `uri` must match `^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$` and contain no `..` before any download.
- Cache root `.cache/` (env `SPHEREX_CACHE_DIR` overrides). Never commit data.
- Tests never touch the network. Network only in `scripts/` and manual checks.
- Photo objects in the browser are capped at 600 (least recently used dropped).
- UI copy, verbatim from the spec: "Zoom in to load SPHEREx frames for this part of the sky." / "Loading frames for this spot: {done} of {total}." / "SPHEREx has no exposures here yet. The background map is still shown." / "IRSA did not answer for {n} frames. Try again."
- UI built without a DESIGN.md is labelled draft without direction (antislop R-37): ENERGY 1 / RHYTHM 1 / MOTION 1. No em dashes in UI text. Controls reachable by keyboard with visible focus, 44 px tap targets.

## Review Focus

1. A view at a pole (Dec = +89.9 or -89.9): ring and coverage math must not crash or return empty rings (Task 5).
2. A view crossing RA = 0/360: footprints arrive with longitudes in -180..180. Coverage must treat 359.9 and -0.1 as neighbours (Task 5).
3. A patch the current exposure does not cover: it shows nothing at that step. It must never show another exposure (Task 9).
4. The user pans while 8 requests are in flight: requests for patches outside view + ring 1 are aborted, and aborted requests are not counted as IRSA failures (Task 8).
5. A crop that is entirely NaN (exposure edge, masked bright star): the PNG is fully transparent, not black and not an error (Task 4).

---

### Task 1: Scaffold, HTTP client and IRSA search with footprints

**Files:**
- Create: `pyproject.toml`, `server/__init__.py`, `server/app.py`, `server/http.py`, `server/irsa.py`, `scripts/record_tap_fixture.py`, `tests/test_irsa.py`, `tests/fixtures/tap_barnard_poly.csv` (recorded)

**Interfaces:**
- Produces:
  - `server.app.app: FastAPI` with `GET /health -> {"status": "ok"}`.
  - `server.http.tls_verify() -> bool`; `server.http.make_client() -> httpx.Client` (timeout 60 s, `verify=tls_verify()`).
  - `@dataclass(frozen=True) class Exposure: uri: str; mjd: float; detector: int; obs_id: str; footprint: tuple[tuple[float, float], ...]` (corners as (ra 0..360, dec), closing point dropped).
  - `class IrsaError(Exception)`.
  - `decode_footprint(hex_wkb: str) -> tuple[tuple[float, float], ...]`.
  - `build_query(ra: float, dec: float) -> str`; `parse_tap_csv(text: str) -> list[Exposure]` (sorted by mjd); `find_exposures(ra, dec, *, client=None) -> list[Exposure]`.

- [ ] **Step 1: Record the fixture.** Write `scripts/record_tap_fixture.py`. It runs the query below for Barnard's Star (ra 269.4463, dec 4.7677), with TLS per `server.http`, and writes `tests/fixtures/tap_barnard_poly.csv`. Run it once: `uv run python scripts/record_tap_fixture.py`. Expected: about 358 data rows, header `uri,time_bounds_lower,energy_bandpassname,obs_publisher_did,poly`.

```sql
SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname, p.obs_publisher_did, p.poly
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
ORDER BY p.time_bounds_lower
```

- [ ] **Step 2: Write failing tests** in `tests/test_irsa.py`:
  - `test_health_ok`: `TestClient(app).get("/health")` is 200 and `{"status": "ok"}`.
  - `test_decode_footprint_known`: for the hex string below, the result has 4 corners. The first is within 1e-5 of `(266.698183, 5.472470)` and the third within 1e-5 of `(269.997314, 1.660075)`.
    `0103000020E61000000100000005000000441C9DF6505357C0B377EA0CCFE315409080217FA67456C0BA6A07DF12991440E05C94022C8056C0484AFBBBAA8FFA3FE84775D0EC5F57C0EF4810B4D2D8FF3F441C9DF6505357C0B377EA0CCFE31540`
  - `test_parse_fixture`: the count equals the fixture's row count. The list is sorted by mjd, detectors are `{1..6}`, the first `obs_id` is `"2025W33_2C_0321_1"` (from `obs_publisher_did` after `?`, before `/`), and every footprint has 4 corners.
  - `test_build_query_has_position`: `"CONTAINS(POINT('ICRS', 269.4463, 4.7677)"` and `"p.poly"` are in `build_query(269.4463, 4.7677)`.
  - `test_find_exposures_uses_client`: an `httpx.MockTransport` returning the fixture gives the right count. The request body contains `QUERY=`.
  - `test_find_exposures_http_error_raises`: transport returns 500, so `IrsaError` is raised.
  - `test_tls_verify_env`: True by default, False when `SPHEREX_INSECURE_TLS=1`.
- [ ] **Step 3: Run** `uv run pytest tests/test_irsa.py -v`. Expected: FAIL (import errors).
- [ ] **Step 4: Implement.** `pyproject.toml`: name `spherex-blink`, `requires-python = ">=3.11"`, deps `fastapi, uvicorn, httpx, astropy, astropy-healpix, numpy, scipy, pillow`, dev group `pytest`, `testpaths = ["tests"]`. Run `uv sync`. Decode WKB with `struct` (little-endian; header `<BIII` then point count, then `<dd` pairs; RA = lon mod 360). Parse CSV with the `csv` module.
- [ ] **Step 5: Run** `uv run pytest -q`. Expected: 7 passed.
- [ ] **Step 6: Commit** `feat: scaffold and IRSA search with footprints`.

---

### Task 2: Cutout download and cache

**Files:**
- Create: `server/cutouts.py`, `tests/test_cutouts.py`
- Fixture: `tests/fixtures/crop_barnard_D6_2026-03-19.fits`

**Interfaces:**
- Consumes: `server.http.make_client`.
- Produces:
  - `class CutoutError(Exception)`.
  - `URI_RE` (compiled pattern from Global Constraints) and `check_uri(uri: str) -> None` (raises `ValueError`).
  - `cutout_url(uri, ra, dec, size_deg) -> str` = `https://irsa.ipac.caltech.edu/{uri}?center={ra},{dec}d&size={size_deg}`.
  - `cache_dir() -> Path` (env `SPHEREX_CACHE_DIR` or `.cache`).
  - `fetch_cutout(uri: str, ra: float, dec: float, size_deg: float, *, client=None) -> Path`. Caches under `cache_dir()/cutouts/` keyed by `sha1(f"{uri}|{ra:.6f}|{dec:.6f}|{size_deg:.4f}")`, and keeps only HDUs PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI, WCS-WAVE.
  - `DOWNLOADS: threading.Semaphore` with value 8, held around every IRSA request.

- [ ] **Step 1: Write failing tests:** `test_cutout_url` (exact string for `("ibe/x.fits", 269.4463, 4.7677, 0.18)`). `test_check_uri_rejects` is parametrized over `http://evil.example/x.fits`, `ibe/data/spherex/../../etc/passwd.fits`, `ibe/data/spherex/a b.fits`. `test_fetch_caches_once`: the transport counts calls and serves the fixture bytes; two calls give one request, and the file opens with astropy. `test_fetch_drops_epsf`: serve the fixture with an extra `EPSF` BinTable appended; the cached file's EXTNAMEs exclude `EPSF`. `test_fetch_timeout_no_partial`: the transport raises `httpx.ReadTimeout`, so `CutoutError` is raised and the cache dir holds no file.
- [ ] **Step 2: Run** `uv run pytest tests/test_cutouts.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces. Write to a temp name, then `os.replace`.
- [ ] **Step 4: Run** `uv run pytest tests/test_cutouts.py -v`. Expected: 7 passed (the parametrized test counts as 3).
- [ ] **Step 5: Commit** `feat: cutout download with trimmed disk cache`.

---

### Task 3: Science image and north-up resampling

**Files:**
- Create: `server/pixels.py`, `server/reproject.py`, `tests/test_pixels.py`, `tests/test_reproject.py`

**Interfaces:**
- Produces:
  - `server.pixels.BAD_PIXEL_MASK: int`; `science_image(hdul, mask=True) -> np.ndarray` (float32 `IMAGE - ZODI`, masked bits become NaN).
  - `server.reproject.SCALE_ARCSEC = 3.075`; `resample_north_up(image: np.ndarray, wcs: WCS, ra: float, dec: float, n: int) -> np.ndarray` (float32 `(n, n)`, row 0 north, col 0 east, NaN outside input; bilinear spreads NaN to neighbours, documented).
  - `wavelength_at(hdul, ra, dec) -> tuple[float, float]` (um, bandwidth um) via the `WCS-WAVE` recipe in `docs/DATA.md`.

- [ ] **Step 1: Write failing tests.** `tests/test_pixels.py`:
  - `test_bad_pixel_mask_bits`: exactly the bits in Global Constraints; bits 1, 19, 21 are absent.
  - `test_science_image_subtracts_zodi`: IMAGE 5.0, ZODI 2.0, FLAGS 0 gives all 3.0.
  - `test_mask_only_bad_bits`: BLOOM (`1<<26`) becomes NaN and SOURCE (`1<<21`) stays finite with `mask=True`; neither is NaN with `mask=False`.
  - `test_real_crop_mask_count`: the fixture has 29 NaN with `mask=True` and 0 with `mask=False`.

  `tests/test_reproject.py`:
  - `test_orientation_north_and_east`: a synthetic 80x80 image with a TAN WCS rotated 30 deg and a bright pixel 15 arcsec north of centre, resampled with `n=41`. The peak is at row `20 - 5 ± 1`, col `20 ± 1`. Same for 15 arcsec east: col `20 - 5 ± 1`, row `20 ± 1`.
  - `test_nan_input`: a NaN block in gives some NaN and some finite values out, with no exception.
  - `test_real_crop_wavelength`: `abs(wavelength_at(fixture, 269.4463, 4.7677)[0] - 4.551) < 0.01`.
- [ ] **Step 2: Run** `uv run pytest tests/test_pixels.py tests/test_reproject.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.** Output TAN WCS with `cdelt = [-SCALE, +SCALE]` deg and `crpix` at the centre. Map with `scipy.ndimage.map_coordinates(order=1, cval=nan)`, then flip rows so row 0 is north. Reference: `spike/stellarium/make_frames.py:reproject`.
- [ ] **Step 4: Run** the same command. Expected: 7 passed.
- [ ] **Step 5: Commit** `feat: science image and north-up resampling`.

---

### Task 4: Fixed-stretch PNG rendering

**Files:**
- Create: `server/render.py`, `tests/test_render.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `STRETCH_MAX = 40.0`; `stretch(arr: np.ndarray) -> np.ndarray` (uint8, formula in Global Constraints; NaN gives 0); `to_png(arr: np.ndarray) -> bytes` (RGBA grey; alpha 0 where NaN, 255 elsewhere).

- [ ] **Step 1: Write failing tests:**
  - `test_stretch_endpoints`: `stretch([0, 40, -3, 1000])` gives `[0, 255, 0, 255]`.
  - `test_stretch_mid`: `stretch([10])[0] == round(255 * asinh(10) / asinh(40))`.
  - `test_png_alpha_from_nan`: a 3x3 with the centre NaN decodes (pillow) to alpha 0 at the centre and 255 elsewhere.
  - `test_png_all_nan_transparent` (Review Focus 5): an all-NaN 211x211 decodes to all alpha 0, with no exception.
  - `test_same_value_same_byte`: equal MJy/sr in two arrays gives equal bytes.
- [ ] **Step 2: Run** `uv run pytest tests/test_render.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with numpy and pillow.
- [ ] **Step 4: Run** the same command. Expected: 5 passed.
- [ ] **Step 5: Commit** `feat: fixed asinh stretch PNG rendering`.

---

### Task 5: Patch grid and footprint coverage

**Files:**
- Create: `server/patches.py`, `tests/test_patches.py`

**Interfaces:**
- Consumes: `Exposure` (Task 1).
- Produces:
  - `ORDER = 9`, `NSIDE = 512`, `NPIX = 12 * 512**2`, `CROP_DEG = 0.18`, `PATCH_N = 211`.
  - `cell_of(ra: float, dec: float) -> int`; `cell_centre(pix: int) -> tuple[float, float]` (ra 0..360).
  - `view_cells(ra: float, dec: float, fov_deg: float) -> dict[int, int]` maps pix to ring. Ring 0 = the centre cell plus cells whose centre lies within `fov_deg / 2` of the view centre. Ring 1 = neighbours of ring 0 not in ring 0. Ring 2 = neighbours of ring 1 not already listed.
  - `footprint_contains(footprint, ra, dec) -> bool`: point in a spherical convex quad. Use unit vectors: the point is inside when the triple products `(c[i] x c[i+1]) . p` all have the same sign. Orientation-independent, correct across RA 0/360.

- [ ] **Step 1: Write failing tests:**
  - `test_barnard_cell`: `cell_of(269.4463, 4.7677) == 2034010`; `cell_centre(2034010)` within 1e-4 of `(269.38477, 4.78019)`.
  - `test_view_rings_small`: `view_cells(269.4463, 4.7677, 0.15)` has ring 0 containing 2034010, ring 1 containing its 8 neighbours `{2033999, 2034021, 2034032, 2034033, 2034011, 2034009, 2034008, 2033997}`, and some ring-2 cells. No pix appears twice.
  - `test_view_rings_pole` (Review Focus 1): for dec +89.9 and -89.9 at FOV 0.3, ring 0 and ring 1 are non-empty and all pix are in `[0, NPIX)`.
  - `test_footprint_contains_known`: with the Task 1 known footprint, `(269.4463, 4.7677)` is inside and `(272.0, 4.0)` is outside.
  - `test_footprint_wraps_ra0` (Review Focus 2): footprint corners `(359.0, -1.0), (1.0, -1.0), (1.0, 1.0), (359.0, 1.0)`: `(0.0, 0.0)` and `(359.9, 0.5)` are inside, `(2.0, 0.0)` is outside.
- [ ] **Step 2: Run** `uv run pytest tests/test_patches.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with `astropy_healpix.HEALPix(nside=512, order="nested")`: `lonlat_to_healpix`, `healpix_to_lonlat`, `neighbours` (drop -1 entries), `cone_search_lonlat` for ring 0.
- [ ] **Step 4: Run** the same command. Expected: 5 passed.
- [ ] **Step 5: Commit** `feat: HEALPix patch grid and footprint coverage`.

---

### Task 6: Timeline: visits and first batch

**Files:**
- Create: `server/timeline.py`, `tests/test_timeline.py`

**Interfaces:**
- Consumes: `Exposure`, `parse_tap_csv` (tests).
- Produces:
  - `group_visits(exposures: list[Exposure]) -> list[list[Exposure]]` (gap > 60 days starts a visit).
  - `first_batch(exposures) -> set[str]` (uris; rule in Global Constraints).

- [ ] **Step 1: Write failing tests** with `tests/fixtures/tap_barnard.csv` (the existing one; read it with a small helper building `Exposure` with `obs_id=""`, `footprint=()`):
  - `test_three_visits`: 3 visits of sizes `[118, 121, 119]`. The first visit spans MJD 60902 to 60950.
  - `test_first_batch_18`: `len(first_batch(...)) == 18`, one per (visit, detector).
  - `test_first_batch_nearest_mid`: on a synthetic visit of 3 detector-6 exposures at MJD 100, 110, 140 (midpoint 120), the chosen uri is the one at 110.
  - `test_empty`: `group_visits([]) == []`, `first_batch([]) == set()`.
- [ ] **Step 2: Run** `uv run pytest tests/test_timeline.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: 4 passed.
- [ ] **Step 5: Commit** `feat: visit grouping and first batch`.

---

### Task 7: View and patch-frame routes

**Files:**
- Modify: `server/app.py`
- Create: `tests/test_api.py`

**Interfaces:**
- Consumes: `find_exposures`, `IrsaError` (Task 1); `fetch_cutout`, `check_uri`, `CutoutError` (Task 2); `science_image`, `resample_north_up`, `wavelength_at` (Task 3); `to_png` (Task 4); `cell_of`, `cell_centre`, `view_cells`, `footprint_contains`, `CROP_DEG`, `PATCH_N`, `NPIX` (Task 5); `group_visits`, `first_batch` (Task 6).
- Produces:
  - `GET /api/view?ra=&dec=&fov=` returns 200 JSON:
    ```json
    {"cell": 2034010,
     "cells": [{"pix": 2034010, "ra": 269.38477, "dec": 4.78019, "ring": 0}],
     "exposures": [{"uri": "ibe/...fits", "obs_id": "2025W33_2C_0321_1", "mjd": 60902.864715,
                    "date": "2025-08-15", "detector": 6, "visit": 0, "first": true,
                    "cells": [2034010, 2034011]}]}
    ```
    Exposures come from `find_exposures` at the centre cell's centre, cached as JSON at `cache_dir()/tap/{cell}.json`. `cells` per exposure lists the pix of `view_cells` whose centre the footprint contains. Sorted by mjd. Status codes: 422 for `ra` outside `[0, 360)`, `dec` outside `[-90, 90]`, `fov` outside `(0, 180]`. 502 on `IrsaError`. 200 with `exposures: []` when nothing covers the view.
  - `GET /api/patch/{pix}/frame.png?uri=` returns 200 `image/png`, `PATCH_N`x`PATCH_N`, with header `X-Frame-Meta`: JSON `{"mjd", "detector", "wavelength_um", "obs_id"}`. Pipeline: `fetch_cutout(uri, *cell_centre(pix), CROP_DEG)`, then `science_image`, then `resample_north_up(..., PATCH_N)`, then `to_png`. The PNG is cached at `cache_dir()/png/{pix}/{sha1(uri)}.png`. Status codes: 422 for bad uri or pix outside `[0, NPIX)`, 502 on `CutoutError`. Response header `Cache-Control: public, max-age=86400`.
  - Static mounts: `/engine` serves `vendor/stellarium-web-engine/build`, `/skydata` serves `vendor/stellarium-web-engine/apps/test-skydata`, and `/` serves `web/` (`html=True`, mounted last).

- [ ] **Step 1: Write failing tests** (monkeypatch `server.app.find_exposures` and `server.app.fetch_cutout`; set `SPHEREX_CACHE_DIR` to `tmp_path`):
  - `test_view_shape`: patched exposures from `tap_barnard_poly.csv`. `/api/view?ra=269.4463&dec=4.7677&fov=0.15` gives `cell == 2034010`, ring-0 includes 2034010, the number of exposures with `first: true` equals `len(first_batch(parsed_fixture))` (18 for the old fixture's 3 visits), every exposure's `cells` contains 2034010, and dates are ISO.
  - `test_view_cached`: two calls give `find_exposures` called once.
  - `test_view_empty_is_200`: patched `[]` gives 200 and `exposures == []`.
  - `test_view_rejects`: parametrized over `ra=abc`, `ra=360`, `dec=91`, `fov=0`, `fov=500`, each giving 422.
  - `test_view_irsa_down_502`.
  - `test_frame_png`: patched `fetch_cutout` returns the FITS fixture. `/api/patch/2034010/frame.png?uri=ibe/data/spherex/x.fits` gives 200, `image/png`, a 211x211 image, and `X-Frame-Meta.detector == 6`.
  - `test_frame_rejects`: a bad uri and `pix=-1` and `pix=NPIX` give 422, and `fetch_cutout` is never called.
  - `test_frame_cutout_502`.
- [ ] **Step 2: Run** `uv run pytest tests/test_api.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with plain `def` routes (thread pool) and FastAPI `Query` validators. Date via `astropy.time.Time(mjd, format="mjd").iso[:10]`.
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: all pass.
- [ ] **Step 5: Manual check (network).** Run `uv run uvicorn server.app:app --port 8000`. `curl "localhost:8000/api/view?ra=269.4463&dec=4.7677&fov=0.15" | head -c 400` shows cells and about 358 exposures in under 10 s. Fetching one frame URL from it returns a PNG.
- [ ] **Step 6: Commit** `feat: view and patch frame routes`.

---

### Task 8: Browser load queue

**Files:**
- Create: `web/js/queue.js`, `web/test/queue.test.js`

**Interfaces:**
- Consumes: the `/api/view` JSON (Task 7).
- Produces:
  - `priorityList(view, have: Set<string>) -> Array<{pix: number, uri: string, key: string}>`, where `key = `${pix}|${uri}``. Includes only (pix, uri) pairs where the exposure's `cells` contains pix and `key` is not in `have`. Order (spec "Load order"): (1) centre cell, first; (2) other ring 0, first; (3) ring 1, first; (4) ring 0 (centre cell first), the rest; (5) ring 1, the rest; (6) ring 2, first. Ring 2 non-first items are never listed. Within a group, sort by mjd.
  - `class Loader { constructor({fetchFn, concurrency = 8, onLoaded, onFailed}); setQueue(items); cancelOutside(keepPix: Set<number>); retryFailed(); get stats() -> {done, total, failed} }`. `fetchFn(item, signal) -> Promise`. Aborted requests are neither failed nor done.

- [ ] **Step 1: Write failing tests** (`node:test`, a fake view with cells at rings 0/1/2 and 4 exposures, 2 of them `first`):
  - `order follows spec groups`: the asserted index of each (pix, uri) matches groups 1 to 6.
  - `skips uncovered and already loaded`.
  - `ring 2 only first batch`.
  - `concurrency never exceeds 8`: a fetchFn that tracks in-flight count over 30 items.
  - `cancelOutside aborts and does not count failures` (Review Focus 4): items for a removed pix see `signal.aborted`, and `stats.failed === 0`.
  - `failed items retry only on retryFailed`: a rejecting fetchFn gives `failed` incremented once with no second call until `retryFailed()`.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test web/test/`. Expected: 6 passed.
- [ ] **Step 5: Commit** `feat: browser load queue with priorities and cancel`.

---

### Task 9: Blink timeline, photo cache and URL state

**Files:**
- Create: `web/js/timeline.js`, `web/js/photos.js`, `web/js/state.js`, `web/test/timeline.test.js`, `web/test/photos.test.js`, `web/test/state.test.js`

**Interfaces:**
- Consumes: `/api/view` exposures (Task 7).
- Produces:
  - `timeline.js`: `buildSteps(exposures) -> Array<{uri, mjd, date, detector}>` (sorted by mjd, unique uri); `keepStep(steps, newSteps, index) -> number` (index of the same uri in `newSteps`; if gone, the nearest mjd).
  - `photos.js`: `class PhotoCache { constructor(layer, {cap = 600}); ensure(pix, uri, url, cal) -> photo; showOnly(uri); size }`. `layer.add('photo', {url, calibration: cal, visible: false, instant: true})`. Over cap, it drops (via `layer.remove(photo)`) the least recently ensured photo that is not part of the current uri. `showOnly(uri)` sets `visible = true` exactly on photos with that uri and false on all others. A patch without a photo for that uri shows nothing.
  - `state.js`: `parseHash(str) -> {ra, dec, fov, step}`; `toHash(state) -> string`. Defaults: `ra 269.4463, dec 4.7677, fov 0.25, step 0`. Invalid values fall back to defaults and never throw.

- [ ] **Step 1: Write failing tests:**
  - `keepStep keeps same exposure after merge`.
  - `keepStep falls back to nearest mjd`.
  - `showOnly never shows another exposure` (Review Focus 3): a fake layer, 3 patches, uri A loaded for 2 of them; after `showOnly(A)`, exactly 2 photos are visible and both are A.
  - `cap drops least recent but not current`: cap 4, ensure 6 for different uris while current is the first; size is 4 and the current uri's photos remain.
  - `parseHash defaults on garbage`: `ra=abc&fov=9999&dec=91` gives defaults for each bad key.
  - `hash round trip`.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: blink timeline, capped photo cache, URL state`.

---

### Task 10: The page: Stellarium wiring, view tracking, states, acceptance

**Files:**
- Create: `web/index.html`, `web/css/app.css`, `web/js/app.js`, `web/js/sky.js`, `scripts/acceptance.mjs`

**Interfaces:**
- Consumes: Tasks 7 to 9. Engine API (fork branch `spherex`): `StelWebEngine({wasmFile, canvas, onReady})`, `core.dss.addDataSource({url})`, `core.dss.frame`, `stel.createLayer`, `photo` objects with `instant`, `stel.lookAt`, `stel.zoomTo`, `stel.convertFrame`, `stel.s2c`, `core.mount_frame`, `core.fov`, `core.observer.yaw/pitch`.
- Produces:
  - `sky.js`: `initSky(canvas) -> Promise<Sky>` where `Sky = {stel, core, layer, viewCentre() -> {ra, dec}, fovDeg() -> number, flyTo(ra, dec, fovDeg)}`. Background: `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`, frame 90 by default. Atmosphere and landscape off. Equatorial mount so north is up.
  - `app.js`: settle detection (FOV < 0.5 deg, still for 300 ms) leads to `fetch('/api/view?...')`, then `Loader.setQueue(priorityList(...))`. `cancelOutside` keeps ring 0 and ring 1. Blink play/pause and step controls, the coordinate box (R2), the wavelength slider for the background, the hash state, and the status line using the exact Global Constraints copy. Photo calibration: `{ra, dec}` from the cell centre, `orientation: 0`, `pixscale: 3.075`.

- [ ] **Step 1: Build the engine** (once per machine): `source ~/emsdk/emsdk_env.sh && cd vendor/stellarium-web-engine && emscons scons -j3 mode=release`. Expected: `build/stellarium-web-engine.{js,wasm}` exist. (On this host Python downloads need IPv4. See `~/emsdk/ipv4_wrapper.py`.)
- [ ] **Step 2: Implement `sky.js`.** Set `core.mount_frame` to the equatorial value, and confirm the value in `vendor/stellarium-web-engine/src/frames.h`. Derive `viewCentre()` from the observer's view direction converted to ICRF with `convertFrame`. Then check it in the browser: after `flyTo(269.4463, 4.7677, 0.25)`, `viewCentre()` is within 0.01 deg of that position. If the yaw/pitch sign convention differs, fix it here.
- [ ] **Step 3: Implement `index.html`, `app.css`, `app.js`.** Use native controls (buttons, range input, two number inputs plus a Go button), keyboard reachable with visible focus and 44 px targets. Include the "draft without direction" note in the HTML comment and the panel heading. Put copy in the four states exactly as in Global Constraints. The "Try again" button calls `loader.retryFailed()`.
- [ ] **Step 4: Write `scripts/acceptance.mjs`** (CDP driver modelled on `spike/stellarium/shoot.mjs`). With the server running and real IRSA, at `#ra=269.4463&dec=4.7677&fov=0.15`:
  - (a) The status reaches "Loading frames for this spot: 18 of" within 15 s.
  - (b) Barnard's Star's centroid on screen moves north between the first and last visit by 10 ± 3 arcsec per year. Measure as in the spike: centroid of the brightest blob near centre, screen scale from `fovDeg()`.
  - (c) Seam check. Pan by one cell width east, wait 20 s, blink to a first-batch step. In a 40 px band straddling the boundary between two loaded patches, the mean absolute difference between the left and right halves is below 6 grey levels.
  - (d) Zoom out to 1 deg: the hint copy shows and no new `/api/patch` requests start.
  - (e) No console errors.
- [ ] **Step 5: Run** `uv run uvicorn server.app:app --port 8000 &` then `node scripts/acceptance.mjs`. Expected: (a) to (e) PASS printed. Save screenshots to `.cache/acceptance/`.
- [ ] **Step 6: Run** `uv run pytest -q && node --test web/test/`. Expected: all pass.
- [ ] **Step 7: Commit** `feat: Stellarium page with view-following frames`.

---

## Self-review notes

- Spec coverage: grid (Task 5), exposure timeline and same-exposure rule (Tasks 6 and 9), load order and rings (Task 8), start/stop rules and cancel (Tasks 8 and 10), server routes and fixed stretch (Tasks 4 and 7), states and copy (Task 10), testing list (Tasks 3, 5, 9 and 10), equatorial view (Task 10). "Later" items are intentionally absent.
- Amendments made to the spec while planning: coverage is computed on the server; coordinate box added (R2).
