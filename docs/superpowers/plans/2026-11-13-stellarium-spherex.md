# Stellarium + SPHEREx Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public web tool where the sky is drawn by the Stellarium Web Engine with the SPHEREx all-sky HiPS as background, and the user's chosen RA/Dec patch blinks its dated SPHEREx exposures (found with IRSA TAP) on top, so movers stand out.

**Architecture:** A FastAPI backend queries IRSA TAP, downloads and caches small FITS crops, resamples them onto a shared north-up grid and serves raw float32 frames. It also proxies the SPHEREx HiPS cube one wavelength slice at a time as flat surveys the engine can read. The vanilla-JS frontend runs the prebuilt Stellarium engine, stretches each frame client-side and shows it as a Stellarium `photo` object at the patch; blinking toggles which photo is visible. State lives in the URL hash.

**Tech Stack:** Python 3.11+, uv, FastAPI, httpx, astropy, numpy, scipy, pytest. Frontend: ES modules, Stellarium Web Engine (prebuilt `vendor/stellarium-web-engine/build/`, AGPL-3.0), Node 22 `node:test`, headless Chromium for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-13-stellarium-spherex-design.md` (this round's design), `docs/SPEC.md` (requirements), `docs/DATA.md` (data facts, including "SPHEREx all-sky HiPS"), `docs/ARCHITECTURE.md` (contract and decisions), `docs/DISPLAY-IDEAS.md`, `docs/reference/README.md`.

Tasks 1 to 7 are carried over from the earlier blink-tool plan (git `HEAD:docs/superpowers/plans/2026-11-13-spherex-blink-tool.md`); only Task 7 changed (adds `band`).

## Global Constraints


- Output pixel scale is 3.075 arcsec. `n = round(fov_arcsec / 3.075)`, bumped to the next odd number if even.
- Default FOV 126 arcsec, maximum 360 arcsec, minimum 30 arcsec.
- Frames are north-up (row 0 north) and east-left (column 0 east), float32 MJy/sr, NaN for no data.
- `uri` must match `^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$` before any download.
- Cutout request size in degrees is `fov_arcsec * 1.5 / 3600` so a rotated frame still covers the output grid.
- Server downloads at most 8 at a time. Frontend requests at most 6 frames at a time. Every HTTP call has a 60 s timeout.
- TLS verification on. Only env `SPHEREX_INSECURE_TLS=1` turns it off.
- Cache directory `.cache/cutouts/` (env `SPHEREX_CACHE_DIR` overrides). Cache key `sha1(f"{uri}|{ra:.6f}|{dec:.6f}|{size_deg:.6f}")`.
- Cache keeps only HDUs PRIMARY, IMAGE, FLAGS, ZODI, WCS-WAVE.
- The science image is `IMAGE - ZODI` (IMAGE is not zodi-subtracted, ES 2.2 and 3.4.3). By default pixels with any bit in `BAD_PIXEL_MASK` become NaN. `BAD_PIXEL_MASK` is the list in `docs/DATA.md` (bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29). OVERFLOW, SOURCE and OUTLIER never mask. `/api/frame` takes `mask` (default true) to turn masking off.
- Authoritative source for any SPHEREx fact is the Explanatory Supplement, see `docs/reference/README.md`.
- Tests never use the network. Fixtures are in `tests/fixtures/`.
- Flag meanings, zodi handling and detector band edges in code or UI copy must match `docs/DATA.md`, which cites the Explanatory Supplement. Detector band edges (um): D1 0.744-1.116, D2 1.099-1.651, D3 1.636-2.421, D4 2.423-3.822, D5 3.809-4.420, D6 4.412-5.002.
- URL hash keys: `ra, dec, fov, det, speed, mode, win, pmra, pmdec`. Defaults: `fov=126, det=1..6, speed=6, mode=frame, win=0`.
- URL hash adds `band`: HiPS cube frame index, int 0 to 101, never 50 or 51, default 88 (4.533 um).
- SPHEREx HiPS upstream base: `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` (not the IBE `hips5_cube` path, which 404s). Frame 0 tile is `Npix{n}.png`, frame k (1 to 101) is `Npix{n}_{k}.png`. Same for `Norder3/Allsky.png`.
- HiPS tiles cached under `.cache/hips/` (env `SPHEREX_HIPS_CACHE_DIR` overrides). They share the 8-download cap, 60 s timeout and TLS rule.
- UI copy must say the background is "SPHEREx all-sky map, averaged over a year" and must not suggest it shows motion.
- The engine is used as built in `vendor/stellarium-web-engine/build/`. Do not edit the submodule. The page footer links to `https://github.com/Stellarium/stellarium-web-engine` (AGPL-3.0).
- A Stellarium `photo` computes its sky placement once, on first render, from `calibration` and the image size. Set `calibration` before `url`, never change it afterwards; make a new photo instead.

## Review Focus

Inputs and conditions the spec implies but does not spell out, most likely to bite first. Each has a test in the task named.

1. RA/Dec that is non-numeric, RA of 360 or more, Dec beyond +-90: reject with a clear 422, never a stack trace (Task 6).
2. A position no SPHEREx exposure covers: 200 with an empty list; the sky still shows and the page says "No SPHEREx images cover this position" (Tasks 6, 11).
3. Some cutouts fail or time out: skip them, keep the rest, show how many were skipped (Tasks 6, 11).
4. HiPS tile missing upstream or IRSA down: 404 or 502 from the proxy, never a 500, and the stars, the frames and the blink still work (Tasks 8, 9).
5. A malformed or hostile URL hash (`ra=abc`, `fov=9999`, `det=9,x`, `band=50`, `band=abc`, repeated keys): fall back to defaults, never throw (Task 7).

Frames that are all NaN, or pixels NaN in every frame, are still covered by the Task 7 and Task 12 tests.

---

### Task 1: Project scaffold and health route

**Files:**
- Create: `pyproject.toml`, `server/__init__.py`, `server/app.py`, `tests/test_health.py`
- Existing: `.gitignore`, `AGENTS.md`

**Interfaces:**
- Produces: `server.app.app: FastAPI`. Route `GET /health` returns `{"status": "ok"}`. Later tasks add routes to this `app`.

- [ ] **Step 1: Write the failing test** in `tests/test_health.py`: `test_health_ok` uses `fastapi.testclient.TestClient(app)`, asserts status 200 and `json() == {"status": "ok"}`.
- [ ] **Step 2: Run** `uv run pytest tests/test_health.py -v`. Expected: FAIL (import error).
- [ ] **Step 3: Create `pyproject.toml`** (package name `spherex-blink`, `requires-python = ">=3.11"`, deps `fastapi, uvicorn, httpx, astropy, numpy, scipy`, dev group `pytest`, pytest `testpaths = ["tests"]`) and implement `app = FastAPI(title="SPHEREx Blink")` with the `/health` route in `server/app.py`. Run `uv sync`.
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: 1 passed.
- [ ] **Step 5: Commit** (run `git init` in this directory first if it is not its own repository).

```bash
git add -A && git commit -m "chore: scaffold server with health route"
```

---

### Task 2: Test targets and proper motion

**Files:**
- Create: `server/targets.py`, `scripts/resolve_targets.py`, `tests/test_targets.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Target: name: str; ra_deg: float; dec_deg: float; pmra_masyr: float; pmdec_masyr: float` (ICRS J2000, `pmra` includes cos(dec)).
  - `TARGETS: dict[str, Target]` with keys `barnards-star, epsilon-indi-b, wise-0855, rw-aurigae, r-draconis`.
  - `propagate(target: Target, mjd: float) -> tuple[float, float]` returns `(ra_deg, dec_deg)` at that MJD.

- [ ] **Step 1: Write failing tests**: `test_barnard_at_mjd_61000` asserts `propagate(TARGETS["barnards-star"], 61000.0)` is within 0.001 deg of `(269.4463, 4.7677)`. `test_propagate_at_j2000_returns_catalog_position` uses MJD 51544.5 and asserts equality within 1e-9 deg. `test_all_five_targets_present` asserts the five keys and `-90 <= dec <= 90`, `0 <= ra < 360` for each.
- [ ] **Step 2: Run** `uv run pytest tests/test_targets.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement `propagate`** with astropy `SkyCoord(..., obstime=Time("J2000")).apply_space_motion(new_obstime=Time(mjd, format="mjd"))`. Barnard's values: ra 269.45207, dec 4.69339, pmra -798.58, pmdec 10328.12 (from `prototype/fetch.py`).
- [ ] **Step 4: Resolve the other four targets** by running `scripts/resolve_targets.py`, a one-off that asks SIMBAD through `astroquery.simbad` for position and proper motion and prints a `Target(...)` line per name. Paste the printed values into `TARGETS` with a comment naming the source and date. WISE 0855 must come from SIMBAD or the literature, not from the prototype's remembered numbers. Update the "Unverified inputs" section of `docs/DATA.md` to say what was verified.
- [ ] **Step 5: Run** `uv run pytest tests/test_targets.py -v`. Expected: 3 passed.
- [ ] **Step 6: Commit** `feat: test targets with proper motion`.

---

### Task 3: IRSA exposure search

**Files:**
- Create: `server/http.py`, `server/irsa.py`, `tests/test_irsa.py`
- Fixtures used: `tests/fixtures/tap_barnard.csv`, `tests/fixtures/tap_wise0855.csv`

**Interfaces:**
- Produces:
  - `server.http.tls_verify() -> bool` (False only when env `SPHEREX_INSECURE_TLS == "1"`).
  - `server.http.make_client() -> httpx.Client` (timeout 60 s, `verify=tls_verify()`).
  - `@dataclass(frozen=True) class Exposure: uri: str; mjd: float; detector: int`.
  - `class IrsaError(Exception)`.
  - `build_query(ra: float, dec: float) -> str` (the ADQL in `docs/DATA.md`).
  - `parse_tap_csv(text: str) -> list[Exposure]` sorted by `mjd`; detector parsed from `SPHEREx-D<n>`.
  - `find_exposures(ra: float, dec: float, *, client: httpx.Client | None = None) -> list[Exposure]`.

- [ ] **Step 1: Write failing tests**: `test_parse_barnard_fixture` asserts 358 results, first is `Exposure(uri=<first row uri>, mjd=60902.864715, detector=6)`, detectors set equals `{1,2,3,4,5,6}`, list is sorted by `mjd`. `test_parse_wise_fixture_count` asserts 258. `test_build_query_has_position` asserts `"CONTAINS(POINT('ICRS', 269.4463, 4.7677)"` appears for `build_query(269.4463, 4.7677)`. `test_find_exposures_uses_client` builds `httpx.Client(transport=httpx.MockTransport(...))` returning the barnard fixture text and asserts 358 results and that the request body contains `QUERY=`. `test_find_exposures_http_error_raises` has the transport return 500 and asserts `IrsaError`. `test_tls_verify_env` uses `monkeypatch.setenv` to assert `tls_verify()` is True by default and False for `"1"`.
- [ ] **Step 2: Run** `uv run pytest tests/test_irsa.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. Parse with the `csv` module (astropy's CSV reader failed on text input in the prototype). Wrap `httpx.HTTPError` in `IrsaError`.
- [ ] **Step 4: Run** `uv run pytest tests/test_irsa.py -v`. Expected: 6 passed.
- [ ] **Step 5: Commit** `feat: IRSA exposure search`.

---

### Task 4: Cutout download and cache

**Files:**
- Create: `server/cutouts.py`, `tests/test_cutouts.py`
- Fixture used: `tests/fixtures/crop_barnard_D6_2026-03-19.fits` (HDUs PRIMARY, IMAGE, FLAGS, ZODI, WCS-WAVE)

**Interfaces:**
- Consumes: `server.http.make_client`.
- Produces:
  - `class CutoutError(Exception)`.
  - `cutout_url(uri: str, ra: float, dec: float, size_deg: float) -> str` (pattern in `docs/DATA.md`).
  - `cache_path(cache_dir: Path, uri: str, ra: float, dec: float, size_deg: float) -> Path` (key in Global Constraints, suffix `.fits`).
  - `trim_hdul(hdul: fits.HDUList) -> fits.HDUList` keeps PRIMARY, IMAGE, FLAGS, ZODI, WCS-WAVE, drops the rest (VARIANCE and EPSF).
  - `fetch_cutout(uri, ra, dec, size_deg, cache_dir: Path, *, client: httpx.Client | None = None) -> Path`.

- [ ] **Step 1: Write failing tests**: `test_cutout_url` asserts the exact string `https://irsa.ipac.caltech.edu/ibe/x.fits?center=269.4463,4.7677d&size=0.05` for `("ibe/x.fits", 269.4463, 4.7677, 0.05)`. `test_cache_path_stable_and_distinct` asserts equal inputs give equal paths and a different `ra` gives a different path. `test_trim_drops_epsf` builds an HDUList with an extra `EPSF` table (add one in the test) and asserts remaining `EXTNAME`s are `["PRIMARY","IMAGE","FLAGS","ZODI","WCS-WAVE"]`. `test_fetch_cutout_caches` serves the fixture bytes through a `MockTransport` that counts calls, calls `fetch_cutout` twice, asserts one request and that the file opens with `astropy.io.fits`. `test_fetch_cutout_timeout_raises` has the transport raise `httpx.ReadTimeout` and asserts `CutoutError` and that no partial file remains in the cache directory.
- [ ] **Step 2: Run** `uv run pytest tests/test_cutouts.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures. Write to a temp name and `os.replace` into place so a failed download leaves no partial file.
- [ ] **Step 4: Run** `uv run pytest tests/test_cutouts.py -v`. Expected: 5 passed.
- [ ] **Step 5: Commit** `feat: cutout download with trimmed disk cache`.

---

### Task 5: Science image, resample to north-up, wavelength lookup

**Files:**
- Create: `server/pixels.py`, `tests/test_pixels.py`, `server/reproject.py`, `tests/test_reproject.py`
- Fixture used: the real crop from Task 4. Reference implementation: `prototype/process.py`.

**Interfaces:**
- Consumes: `server.targets.TARGETS`, `propagate` (tests only).
- Produces (`server/pixels.py`):
  - `BAD_PIXEL_MASK: int` (bitwise OR of the bits listed in Global Constraints).
  - `science_image(hdul: fits.HDUList, mask: bool = True) -> np.ndarray` returns float32 `IMAGE - ZODI`; with `mask=True` pixels whose FLAGS & `BAD_PIXEL_MASK` is nonzero are NaN.
- Produces (`server/reproject.py`):
  - `SCALE_ARCSEC: float = 3.075`
  - `grid_size(fov_arcsec: float) -> int` (always odd, see Global Constraints).
  - `resample_north_up(image: np.ndarray, wcs: WCS, ra: float, dec: float, n: int) -> np.ndarray` float32 `(n, n)`, row 0 north, column 0 east, NaN outside the input.
  - `wavelength_at(hdul: fits.HDUList, ra: float, dec: float) -> tuple[float, float]` returns `(wavelength_um, bandwidth_um)` using the `WCS-WAVE` recipe in `docs/DATA.md`.
  - `@dataclass(frozen=True) class FrameMeta: n: int; scale_arcsec: float; mjd: float; detector: int; wavelength_um: float; bandwidth_um: float; obs_id: str`.
  - `reproject_frame(hdul: fits.HDUList, ra: float, dec: float, fov_arcsec: float, mask: bool = True) -> tuple[np.ndarray, FrameMeta]` (uses `science_image`).

- [ ] **Step 1: Write failing tests** in `tests/test_pixels.py`: `test_bad_pixel_mask_bits` asserts `BAD_PIXEL_MASK` has exactly the bits `{0,2,6,7,9,10,11,14,15,17,20,22,23,24,25,26,27,28,29}` and does not have bits 1, 21 or 19. `test_science_image_subtracts_zodi` builds an HDUList with IMAGE all 5.0, ZODI all 2.0, FLAGS all 0 and asserts every output pixel is 3.0. `test_mask_only_bad_bits` sets FLAGS to `1<<26` (BLOOM) at one pixel and `1<<21` (SOURCE) at another, asserts the first is NaN and the second is finite with `mask=True`, and that neither is NaN with `mask=False`. `test_real_crop_mask_count` loads the fixture and asserts exactly 29 NaN pixels with `mask=True` and 0 with `mask=False`. Then in `tests/test_reproject.py`: `test_grid_size_values` asserts `grid_size(126) == 41` and `grid_size(60) == 21`, and for every integer fov 30 to 360 the result is odd. `test_orientation_north_and_east` builds a synthetic 60 x 60 image with a TAN WCS rotated 30 degrees, plants one bright pixel at the position 10 arcsec north of the centre, resamples with `n=41`, and asserts the peak row is `20 - 3` (about 3.25 px north, within 1 row) and the peak column is 20. Repeat for a source 10 arcsec east and assert the peak column is `20 - 3`, row 20. `test_nan_in_input_does_not_crash` sets a block of NaN and asserts output has NaN and finite values and no exception. `test_real_crop_star_near_centre` loads the fixture, takes `propagate(TARGETS["barnards-star"], 61118.31)`, calls `reproject_frame(hdul, ra, dec, 126)`, and asserts shape `(41, 41)`, `meta.detector == 6`, `abs(meta.wavelength_um - 4.551) < 0.01`, and that the peak pixel is within 2 px of the centre `(20, 20)` (call with `mask=False`; the masked core would otherwise move the peak). `test_mask_adds_nan` asserts the `mask=True` output has at least as many NaN pixels as `mask=False`, and strictly more for the real crop.
- [ ] **Step 2: Run** `uv run pytest tests/test_pixels.py tests/test_reproject.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures. Build an output TAN WCS with `cdelt = [-SCALE, +SCALE]` degrees and `crpix` at the centre, map each output pixel to input pixel coordinates, interpolate with `scipy.ndimage.map_coordinates(order=1, cval=nan)`, then flip rows so row 0 is north. Bilinear interpolation spreads NaN to neighbours. That is accepted behaviour and documented in the docstring.
- [ ] **Step 4: Run** `uv run pytest tests/test_pixels.py tests/test_reproject.py -v`. Expected: 9 passed.
- [ ] **Step 5: Commit** `feat: science image, north-up resampling and wavelength lookup`.

---

### Task 6: HTTP routes for exposures and frames

**Files:**
- Modify: `server/app.py`
- Create: `tests/test_api.py`

**Interfaces:**
- Consumes: `find_exposures`, `fetch_cutout`, `reproject_frame`, `grid_size`, `IrsaError`, `CutoutError`.
- Produces: the two routes defined in `docs/ARCHITECTURE.md` (`/api/exposures`, `/api/frame`). Serves `web/` as static files at `/` (mounted last, `html=True`).

- [ ] **Step 1: Write failing tests** (monkeypatch `server.app.find_exposures`, `server.app.fetch_cutout`, and point the cache at `tmp_path`):
  - `test_exposures_ok`: patched result of two `Exposure`s gives JSON with `count == 2`, `exposures[0].date == "2025-08-15"` for `mjd=60902.86`, detectors as ints.
  - `test_exposures_empty_is_200`: patched empty list gives 200 and `count == 0` (Review Focus 2).
  - `test_exposures_rejects_bad_position`: parametrized over `ra=abc`, `ra=360`, `ra=-1`, `dec=91`, `dec=-91`, and missing `ra`; each returns 422 (Review Focus 1).
  - `test_exposures_irsa_down_is_502`: patched function raises `IrsaError`, asserts 502.
  - `test_frame_returns_float32_and_meta`: patched `fetch_cutout` returns the fixture path; request with `fov=126`; asserts `len(content) == 41*41*4`, header `X-Frame-Meta` parses as JSON with `n == 41` and `detector == 6`.
  - `test_frame_rejects_bad_uri`: `uri=http://evil.example/x.fits` and `uri=ibe/data/spherex/../../etc/passwd` each return 422 and `fetch_cutout` is never called.
  - `test_frame_cutout_failure_is_502`: patched `fetch_cutout` raises `CutoutError`, asserts 502 (Review Focus 3).
  - `test_frame_mask_param`: with the fixture, `mask=0` returns fewer NaN float32 values than the default (parse the body with `numpy.frombuffer`).
  - `test_frame_fov_clamped`: `fov=9999` is rejected with 422, `fov=10` is rejected with 422 (limits 30 to 360).
- [ ] **Step 2: Run** `uv run pytest tests/test_api.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement the routes** with FastAPI `Query` validators (`ra: float = Query(ge=0, lt=360)`, `dec: float = Query(ge=-90, le=90)`, `fov: float = Query(126, ge=30, le=360)`, `mask: bool = True`). Run the blocking astropy and httpx work with `def` routes so FastAPI uses its thread pool; bound server-side concurrency with a module-level `threading.Semaphore(8)` around downloads. Convert MJD to date with `astropy.time.Time(mjd, format="mjd").iso[:10]`.
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: all pass.
- [ ] **Step 5: Manual check against real IRSA** (network, not part of the suite). Run the server with `SPHEREX_INSECURE_TLS=1` inside the sandbox, then `curl "localhost:8000/api/exposures?ra=269.4463&dec=4.7677"` and expect `count` about 358 in about 5 s.
- [ ] **Step 6: Commit** `feat: exposures and frame API`.

---

### Task 7: Frontend state, stretch and normalisation

**Files:**
- Create: `web/js/state.js`, `web/js/stretch.js`, `web/test/state.test.js`, `web/test/stretch.test.js`, `web/package.json` (`{"type":"module"}`)

**Interfaces:**
- Produces (`state.js`):
  - `DEFAULTS = { ra: null, dec: null, fov: 126, det: [1,2,3,4,5,6], speed: 6, mode: "frame", win: 0, pmra: 0, pmdec: 0, band: 88 }`
  - `parseHash(hash: string): State`
  - `serializeHash(state: State): string` (omits values equal to defaults)
- Produces (`stretch.js`):
  - `asinhStretch(x: number, softness: number): number` returns a value in [0, 1], 0 for `x <= 0`, 1 for `x >= 1`.
  - `normalizeFrame(pixels: Float32Array): { data: Float32Array, hi: number }` subtracts the median of finite pixels and divides by the 99.8th percentile of the result. NaN is preserved. `hi` is 1 if there are no finite pixels or the percentile is not positive.
  - `toRGBA(norm: Float32Array, softness: number, invert: boolean): Uint8ClampedArray` NaN pixels become `(32, 36, 47, 255)`.

- [ ] **Step 1: Write failing tests** (`node:test`, `node:assert/strict`):
  - state: `parseHash("#ra=133.786&dec=-7.244&fov=176&det=2,5&mode=coadd")` gives those values with `det` `[2,5]`. `parseHash("")` equals `DEFAULTS`. Table test of bad input: `ra=abc` gives `ra === null`; `fov=9999` gives 360; `fov=10` gives 30; `fov=-5` gives 126; `det=9,x,2` gives `[2]`; `det=` gives all six; `ra=1&ra=2` uses the last value; `mode=bogus` gives `"frame"`; `band=40` gives 40; `band=50`, `band=51`, `band=102`, `band=abc` each give 88 (Review Focus 5). `serializeHash(parseHash(h))` is stable: parsing the output returns the same state.
  - stretch: `asinhStretch(0, .1) === 0`, `asinhStretch(1, .1) === 1`, and it is strictly increasing on `[0, 1]`. `normalizeFrame` of `[1,2,3,100]` has median-subtracted data and `hi > 0`. A frame of all NaN returns `hi === 1` and all-NaN data without throwing. `toRGBA` on `[NaN]` returns `[32,36,47,255]`, and on `[0.5]` with `invert=true` returns a different pixel from `invert=false`. No test output contains NaN in `toRGBA` bytes (NaN rule, AGENTS.md).
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `state.js` and `stretch.js` to the signatures. Colour ramp: the 8-stop inferno table in `prototype/viewer_template.html` (`STOPS`).
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: URL state, stretch and normalisation`.

---

---

### Task 8: SPHEREx HiPS slice proxy

**Files:**
- Create: `server/hips.py`, `tests/test_hips.py`
- Modify: `server/app.py` (two routes, registered before the static mount)
- Fixture (already recorded): `tests/fixtures/hips_spherex_properties.txt`

**Interfaces:**
- Consumes: the TLS setting (`SPHEREX_INSECURE_TLS`) handling from Task 4 (`server/cutouts.py`) and the download semaphore from Task 6; reuse them, do not duplicate.
- Produces (`server/hips.py`):
  - `HIPS_BASE: str` (Global Constraints), `FRAME_COUNT = 102`, `BLANK_FRAMES = frozenset({50, 51})`.
  - `class HipsNotFound(Exception)`, `class HipsError(Exception)`.
  - `tile_path(frame: int, tile: str) -> str`: `tile` must match `^Norder\d{1,2}/(Dir\d+/Npix\d+|Allsky)\.png$`, otherwise `ValueError`; `frame` outside 0..101 raises `ValueError`. Returns the upstream relative path with the suffix rule.
  - `flat_properties(text: str, frame: int, service_url: str) -> str`: drops lines whose key is `dataproduct_type` or starts with `hips_cube_`, `data_cube_` or `custom_tile_format`; replaces `hips_service_url`; appends ` - {wl:.3f} um` to `obs_title`; sets `creator_did` to `ivo://IPAC/P/SPHEREx/DR1/cube/{frame}` so each slice gets its own engine cache key.
  - `fetch_hips_file(rel: str, fetch: Callable[[str], bytes] | None = None) -> bytes`: disk cache under `<hips cache dir>/<rel>`; on miss calls `fetch(HIPS_BASE + "/" + rel)`. Default fetch uses httpx with a 60 s timeout. Upstream 404 raises `HipsNotFound`, other failures raise `HipsError`. Never caches a failure.
  - Routes: `GET /hips/spherex/{frame}/properties` -> `text/plain`; `GET /hips/spherex/{frame}/{tile:path}` -> `image/png`. 422 for bad `frame` or `tile`, 404 for `HipsNotFound`, 502 for `HipsError`. Header `Cache-Control: public, max-age=86400`.

- [ ] **Step 1: Write failing tests** (`tests/test_hips.py`, `SPHEREX_HIPS_CACHE_DIR` pointed at `tmp_path`, fake fetch records the URLs it was asked for):
  - `test_tile_path_suffix`: `tile_path(0, "Norder5/Dir0/Npix100.png") == "Norder5/Dir0/Npix100.png"`, `tile_path(40, "Norder5/Dir0/Npix100.png") == "Norder5/Dir0/Npix100_40.png"`, `tile_path(101, "Norder3/Allsky.png") == "Norder3/Allsky_101.png"`.
  - `test_tile_path_rejects`: parametrized `(102, ok)`, `(-1, ok)`, `(5, "../properties")`, `(5, "Norder5/Dir0/Npix1.fits")`, `(5, "Norder5/Dir0/Npix1.png?x=1")` each raise `ValueError`.
  - `test_flat_properties`: from the fixture with `frame=88`, the output has no `hips_cube_depth`, `data_cube_crval3_arr`, `dataproduct_type` or `custom_tile_format` line, has `hips_service_url = http://test/hips/spherex/88`, keeps `hips_tile_format = png` and `hips_order = 5`, and `obs_title` ends with `4.533 um`.
  - `test_fetch_cache_hit`: two calls for the same `rel` call the fake fetch once and return identical bytes.
  - `test_fetch_not_cached_on_failure`: a fetch that raises `HipsError` once and then succeeds is called twice across two calls.
  - `test_routes`: through `TestClient`, `/hips/spherex/40/Norder5/Dir0/Npix100.png` returns 200 `image/png` and the fake fetch saw `.../Npix100_40.png`; `/hips/spherex/102/properties` returns 422; `/hips/spherex/5/Norder5/Dir0/Npix1.fits` returns 422; a fetch raising `HipsNotFound` gives 404 and one raising `HipsError` gives 502 (Review Focus 4).
- [ ] **Step 2: Run** `uv run pytest tests/test_hips.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `server/hips.py` and the routes** to the interfaces. Inject the fetch through a module-level `_fetch` that tests monkeypatch, as Task 6 does for `fetch_cutout`. The upstream properties file is fetched once and cached like a tile (`rel = "properties"`).
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: all pass.
- [ ] **Step 5: Manual check** (network): start the server, `curl -s localhost:8000/hips/spherex/88/properties | head` shows the flat survey; `curl -o /dev/null -w '%{http_code}' localhost:8000/hips/spherex/88/Norder3/Allsky.png` prints 200 and a second request does not reach IRSA (file present in `.cache/hips/`).
- [ ] **Step 6: Commit** `feat: SPHEREx HiPS slice proxy`.

---

### Task 9: Sky shell: Stellarium with the SPHEREx background and wavelength picker

**Files:**
- Create: `web/js/bands.js`, `web/test/bands.test.js`, `web/js/sky.js`
- Create or modify: `web/index.html`, `web/css/app.css`
- Modify: `server/app.py` (static mounts `/stel/` and `/skydata/`, before the `/` mount)

**Interfaces:**
- Consumes: Task 8 routes, `parseHash` (Task 7).
- Produces (`bands.js`, pure, no DOM):
  - `DEFAULT_BAND = 88`, `BLANK_FRAMES = [50, 51]`.
  - `parseWavelengths(propertiesText: string): number[]` reads `data_cube_crval3_arr`, returns 102 numbers.
  - `usableFrames(count = 102): number[]` all indices except blanks.
  - `detectorOf(frame: number): number` = `Math.floor(frame / 17) + 1`.
  - `bandLabel(frame: number, wavelengths: number[]): string` e.g. `"4.533 µm, detector 6"`.
- Produces (`sky.js`, the only file that calls the engine apart from `overlay.js`):
  - `startSky(canvas: HTMLCanvasElement): Promise<Stel>` loads `/stel/stellarium-web-engine.js` (global `StelWebEngine`) with `wasmFile: "/stel/stellarium-web-engine.wasm"`; adds stars, dsos and skyculture `western` from `/skydata/`; sets `core.atmosphere.visible = false`, `core.landscapes.visible = false`, `core.milkyway.visible = false`, `core.time_speed = 0` (time frozen so the observed-frame view does not drift).
  - `setBand(stel: Stel, frame: number): void` calls `core.dss.addDataSource({url: "/hips/spherex/" + frame})` (replaces the previous survey, see `src/modules/dss.c` `dss_add_data_source`).
  - `pointAt(stel: Stel, raDeg: number, decDeg: number, viewFovDeg: number): void` uses `stel.s2c`, `stel.convertFrame(stel.core.observer, "ICRF", "OBSERVED", v)`, `stel.lookAt(v, 1)` and `stel.zoomTo(viewFovDeg * Math.PI / 180, 1)`.

- [ ] **Step 1: Write failing tests** (`web/test/bands.test.js`, reads `tests/fixtures/hips_spherex_properties.txt` with `fs`): `parseWavelengths` returns length 102, first `0.753`, last `4.988`, index 88 `4.533`. `usableFrames()` has length 100 and excludes 50 and 51. `detectorOf(0) === 1`, `detectorOf(16) === 1`, `detectorOf(17) === 2`, `detectorOf(101) === 6`. `bandLabel(88, wl) === "4.533 µm, detector 6"`. `parseWavelengths("")` returns `[]` without throwing.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement `bands.js`.**
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Build the shell**: `index.html` is a full-window sky canvas with a control bar (coordinate form, wavelength slider over `usableFrames()` with `bandLabel` beside it, the background note from Global Constraints, the AGPL footer link). The page reads `band` from the hash and calls `setBand`; moving the slider updates the hash. If `/hips/spherex/{band}/properties` fails, show "The SPHEREx background could not be loaded. Stars and frames still work." and leave the sky running (Review Focus 4).
- [ ] **Step 6: Verify in headless Chromium**: open `http://localhost:8000/#ra=269.4463&dec=4.7677&band=88`, wait for tiles, screenshot. Then `band=10`, screenshot. The two screenshots differ in the background and neither is blank; the server log shows `/hips/spherex/88/...` and `/hips/spherex/10/...` tile requests. Save the screenshots to the scratchpad and say where.
- [ ] **Step 7: Commit** `feat: Stellarium sky with SPHEREx HiPS background`.

---

### Task 10: Frame overlays on the sky, with an orientation check

**Files:**
- Create: `web/js/overlay.js`, `web/test/overlay.test.js`, `web/check/orientation.html`, `scripts/check_orientation.mjs`

**Interfaces:**
- Consumes: `startSky`, `pointAt` (Task 9), `toRGBA` (Task 7).
- Produces (`overlay.js`):
  - `photoCalibration(raDeg: number, decDeg: number, scaleArcsec = 3.075): {ra, dec, pixscale, orientation}` (pure; `orientation` is the constant `ORIENTATION_DEG` the check below pins).
  - `MIRROR: boolean` constant pinned by the check below: whether the RGBA rows/columns must be flipped before upload so the photo shows column 0 to the east and row 0 to the north.
  - `rgbaToUrl(rgba: Uint8ClampedArray, n: number): Promise<string>` draws onto an `OffscreenCanvas` (applying `MIRROR`) and returns a blob URL.
  - `createOverlay(stel: Stel, raDeg: number, decDeg: number): Overlay` where `Overlay = { add(rgba, n): Promise<number>, show(index: number | null): void, clear(): void, count(): number }`. Uses one layer from `stel.createLayer({id: "spherex", z: 7, visible: true})`; `add` creates a photo with `stel.createObj("photo", {})`, sets `calibration` then `url`, starts hidden, returns its index. `show` makes exactly one photo visible (`null` hides all). `clear` removes the photos and revokes the blob URLs.
- [ ] **Step 1: Write failing tests** (`web/test/overlay.test.js`): `photoCalibration(269.4463, 4.7677)` returns `{ra: 269.4463, dec: 4.7677, pixscale: 3.075, orientation: ORIENTATION_DEG}`. `createOverlay` with a fake `stel` (records `createLayer`, `createObj`, attribute sets in order) proves `calibration` is set before `url` on every photo, `show(1)` leaves only photo 1 `visible`, and `clear()` revokes every URL it created (stub `URL.revokeObjectURL`).
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement `overlay.js`** with `ORIENTATION_DEG = 0` and `MIRROR = false` as starting values.
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Write the orientation check** (not by eye, AGENTS rule). `web/check/orientation.html` starts the sky, builds a synthetic 41 x 41 frame, black except a red 3 x 3 block centred at row 2, column 20 (north edge) and a green block centred at row 20, column 2 (east edge), and shows it at RA 180, Dec 0 via `createOverlay`. It exposes `window.lookAtOffset(dNorthArcsec, dEastArcsec)`. `scripts/check_orientation.mjs` (Node, Playwright from the local Chromium) loads the page, calls `lookAtOffset(18 * 3.075, 0)`, screenshots, and asserts the screen-centre pixel is red; then `lookAtOffset(0, 18 * 3.075)` and asserts it is green (east offset uses `dEast / cos(dec)` in RA). It exits non-zero on failure and prints which colour it found.
- [ ] **Step 6: Run** `node scripts/check_orientation.mjs` with the server up. If it fails, change `MIRROR` and/or `ORIENTATION_DEG` (try 0/180 with and without mirror) until it passes. Record the final values and the reason in a comment beside the constants and in `docs/DATA.md` under "SPHEREx all-sky HiPS" as "Stellarium photo orientation (measured)".
- [ ] **Step 7: Measure blink sharpness**: photos fade in about 80 ms (`FADER_DEFAULT_DURATION` 0.3 s at the fixed 0.06 step). In the check page, swap between two photos at 6 fps and take screenshots 40 ms after each swap; report whether both colours are visible at once. If they are, note it in `docs/DATA.md` and cap the default speed to keep each frame fully shown at least half its time. Do not edit the engine.
- [ ] **Step 8: Commit** `feat: SPHEREx frames as Stellarium photo overlays`.

---

### Task 11: Progressive loader and blink player on the sky

Same as the earlier plan's Task 8, but frames go into the Stellarium overlay instead of a 2D canvas.

**Files:**
- Create: `web/js/loader.js`, `web/js/player.js`, `web/js/app.js`, `web/test/loader.test.js`, `web/test/player.test.js`
- Modify: `web/index.html`, `web/css/app.css`

**Interfaces:**
- Consumes: `parseHash`, `serializeHash`, `normalizeFrame`, `toRGBA` (Task 7); `startSky`, `setBand`, `pointAt` (Task 9); `createOverlay` (Task 10).
- Produces:
  - `loadFrames(exposures: Exposure[], fetchFrame: (e: Exposure, signal: AbortSignal) => Promise<Frame>, opts: { concurrency?: number, onFrame: (f: Frame, e: Exposure) => void, signal?: AbortSignal }): Promise<{ loaded: number, skipped: number }>` where `Exposure = {uri, mjd, date, detector}` and `Frame = {data: Float32Array, n: number, meta: object}`. Default concurrency 6.
  - `nextIndex(current: number, visible: number[], dir: 1 | -1): number` wraps around, returns an element of `visible`.
  - `app.js` is the only file that touches the DOM. It reads the hash, starts the sky, points at the patch with a view FOV of `max(4 * fov, 600)` arcsec, fetches `/api/exposures`, then frames via `loadFrames`, adds each to the overlay, and offers play/pause, step, speed, detector chips, stretch, invert and the coordinate form. The date and detector of the shown frame are printed in the control bar.

- [ ] **Step 1: Write failing tests**: loader: with a fake `fetchFrame` that tracks in-flight count, `concurrency: 6` never exceeds 6 in flight across 20 exposures. When 3 of 10 fetches reject, the result is `{loaded: 7, skipped: 3}` and no throw (Review Focus 3). An empty exposure list resolves `{loaded: 0, skipped: 0}` and never calls `fetchFrame` (Review Focus 2). Aborting the signal stops starting new fetches. `onFrame` fires once per loaded frame. Player: `nextIndex(2, [0,2,5], 1) === 5`, `nextIndex(5, [0,2,5], 1) === 0`, `nextIndex(0, [0,2,5], -1) === 5`, and a current value not in `visible` returns the first element.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement `loader.js` and `player.js`** to the signatures.
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Build `app.js`** and wire the controls. A new coordinate entry aborts the running load and calls `overlay.clear()`. When `/api/exposures` returns `count: 0`, show "No SPHEREx images cover this position." and keep the sky. The first frame must show before the last finishes loading. Stretch or invert changes re-render every loaded frame into new photos (calibration is fixed per photo).
- [ ] **Step 6: Verify in headless Chromium**: open `http://localhost:8000/#ra=269.4463&dec=4.7677`, screenshot after the first frame and again later; Barnard's Star shows on the overlay, the loaded count grows, and the overlay sits on the HiPS star field without visible offset (stars in the overlay line up with HiPS stars at the edge).
- [ ] **Step 7: Commit** `feat: progressive loader and blink player on the sky`.

---

### Task 12: View modes: single frame, coadd, difference

The earlier plan's Task 9, unchanged except where it draws: the chosen view is rendered with `toRGBA` (or the diverging scale for difference) and added to the overlay as a photo, which `show` then displays.

**Files:**
- Create: `web/js/windows.js`, `web/js/modes.js`, `web/test/windows.test.js`, `web/test/modes.test.js`
- Modify: `web/js/app.js` (mode buttons, time window slider)

**Interfaces:**
- Consumes: `normalizeFrame`, frames from Task 11, `createOverlay` (Task 10).
- Produces:
  - `groupByWindow(exposures: {mjd: number, detector: number}[], windowDays: number, perDetector: boolean): number[][]` returns groups of indices into `exposures`. `windowDays === 0` gives one singleton group per exposure. Groups are ordered by first `mjd`.
  - `coadd(frames: Float32Array[]): Float32Array` NaN-aware mean per pixel. A pixel that is NaN in every frame stays NaN.
  - `buildView(mode: "frame" | "coadd" | "diff", frames: Float32Array[], selected: number, groups: number[][]): Float32Array`. `frame` returns the normalised selected frame. `coadd` returns the normalised coadd of the group containing `selected`. `diff` returns the normalised coadd of the group containing `selected` minus the normalised coadd of the first group, signed, not clipped.

- [ ] **Step 1: Write failing tests**: `groupByWindow` with mjds `[0,10,200,210]`, `windowDays=100`, `perDetector=false` gives `[[0,1],[2,3]]`. With detectors `[1,2,1,2]` and `perDetector=true` the groups are split by detector. `windowDays=0` gives four singletons. `coadd` of `[NaN,2]` and `[4,NaN]` gives `[4,2]`. A pixel NaN in all frames stays NaN. `buildView("diff", ...)` of two identical frames is all zeros. A frame with a blob at pixel A in group 0 and pixel B in group 1 gives a positive value at B and a negative value at A.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Wire modes and the window slider into `app.js`**. In coadd and diff mode the overlay holds one photo per group, not per frame. Difference uses a diverging colour scale (negative blue, positive red). `win` and `mode` persist in the hash.
- [ ] **Step 6: Verify in headless Chromium** on Barnard's Star: Difference with a 180 day window shows a red and blue pair one to two pixels apart along the north-south direction (about 5 arcsec in 180 days, 1.6 output pixels), and the red one is north of the blue one when the later group is selected.
- [ ] **Step 7: Commit** `feat: coadd and difference view modes`.

---

### Task 13: Acceptance on the five test targets

The earlier plan's Task 10, plus the background check.

**Files:**
- Create: `scripts/smoke_targets.py`, `docs/TEST-TARGETS.md`

**Interfaces:**
- Consumes: the running server and `server.targets.TARGETS`.
- Produces: `docs/TEST-TARGETS.md`, a table of the five targets with exposure count, frames loaded, skipped count, time to first frame, HiPS background loaded yes/no, and a one-line note on what is visible.

- [ ] **Step 1: Write `scripts/smoke_targets.py`**: for each target, call `propagate` at MJD 61000, hit `/api/exposures`, load the first 10 frames with a 126 arcsec FOV, request `/hips/spherex/88/properties`, and print one row. Exit non-zero if any target has zero exposures or zero loaded frames.
- [ ] **Step 2: Run it** against the live server (`SPHEREX_INSECURE_TLS=1` in the sandbox). Expected: five rows, exit 0.
- [ ] **Step 3: Inspect each target in headless Chromium** and record what you see in `docs/TEST-TARGETS.md`, honestly when a target is not visible (WISE 0855 is expected to be too faint in single frames; try coadd and say what happens). Barnard's Star must drift north about 10 arcsec per year over the HiPS background.
- [ ] **Step 4: Commit** `docs: acceptance results for the five test targets`.

**Stop here and ask the user which display ideas to build (Tasks 14 and 15 stay blocked until `docs/DISPLAY-IDEAS.md` status changes from `proposed`).**

---

### Task 14 (BLOCKED, idea B): Drag-to-set motion and shift-and-add

> Carried over from the earlier plan. Pointer gestures now happen on the Stellarium canvas, which has no exposed sky-to-screen call; when this task is unblocked, first add a way to map a pointer position to a frame pixel (for example a transparent 2D canvas over the patch, aligned with the orientation check in Task 10).

**Files:**
- Create: `web/js/motion.js`, `web/test/motion.test.js`
- Modify: `web/js/app.js`

**Interfaces:**
- Consumes: frames with `mjd`, `n`, scale 3.075 arcsec.
- Produces:
  - `impliedProperMotion(dxPx: number, dyPx: number, dtYears: number, scaleArcsec: number): { pmra_masyr: number, pmdec_masyr: number }` where `dxPx, dyPx` are the display drag (x right = west, y down = south). East and north are positive.
  - `shiftAndAdd(frames: { data: Float32Array, mjd: number }[], n: number, vx: number, vy: number, refMjd: number): Float32Array` where `vx, vy` are the object's velocity in pixels per day in display coordinates. Each frame is shifted by `-v * (mjd - refMjd)` with bilinear interpolation and the NaN-aware mean is returned.

- [ ] **Step 1: Write failing tests**: `impliedProperMotion(0, -10, 1, 3.075)` returns `pmdec_masyr` of 30750 and `pmra_masyr` of 0 (dragging 10 px up is north). `impliedProperMotion(-10, 0, 1, 3.075)` returns `pmra_masyr` of 30750 (dragging left is east). `shiftAndAdd` on a synthetic stack where a single bright pixel moves +2 px in x over 100 days, called with the matching velocity, has a peak at least 3 times higher than `coadd` of the same frames, located at the reference-epoch position. With velocity 0 it equals `coadd`.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Add the drag gesture to `app.js`**: dragging on the canvas draws an arrow from where to where, converts it with `impliedProperMotion` using the time span between the first and last frame of the current selection, shows the implied proper motion in arcsec per year, and switches to the shift-and-add view. Store `pmra, pmdec` in the hash.
- [ ] **Step 6: Verify on Barnard's Star** that dragging a northward arrow of the right length makes the star sharpen and the field stars smear, and that the reported proper motion is near 10 arcsec per year north.
- [ ] **Step 7: Commit** `feat: drag-to-set motion with shift-and-add`.

---

### Task 15 (BLOCKED, idea C): Pixel inspector with live spectrum

> Carried over from the earlier plan. Pointer gestures now happen on the Stellarium canvas, which has no exposed sky-to-screen call; when this task is unblocked, first add a way to map a pointer position to a frame pixel (for example a transparent 2D canvas over the patch, aligned with the orientation check in Task 10).

**Files:**
- Create: `web/js/inspector.js`, `web/test/inspector.test.js`
- Modify: `web/js/app.js`

**Interfaces:**
- Consumes: frames carrying `data: Float32Array` (raw MJy/sr), `n`, and `meta.wavelength_um`, `meta.mjd`, `meta.detector`.
- Produces: `pixelSeries(frames: Frame[], x: number, y: number): { wl: number[], value: number[], mjd: number[], detector: number[] }`. Each `value` is the raw pixel minus the median of finite pixels of its frame. Frames where the pixel is NaN are skipped.

- [ ] **Step 1: Write failing tests**: on three synthetic frames with wavelengths 1, 2, 3 and a pixel value that doubles each frame over a constant background, `pixelSeries` returns `wl [1,2,3]` and values `[v, 2v, 4v]` after median subtraction. A frame where the pixel is NaN is skipped, so the result has two entries. A pixel NaN in every frame returns empty arrays and does not throw (NaN rule, AGENTS.md). `x` or `y` outside the grid returns empty arrays.
- [ ] **Step 2: Run** `node --test web/test/`. Expected: FAIL.
- [ ] **Step 3: Implement `pixelSeries`.**
- [ ] **Step 4: Run** `node --test web/test/`. Expected: all pass.
- [ ] **Step 5: Add the inspector panel to `app.js`**: hovering a pixel draws a flux versus wavelength scatter (points coloured by detector) beside the image, with a note that gaps mean masked pixels. Do not label spectral features unless a source is cited in the UI copy.
- [ ] **Step 6: Verify on Barnard's Star** that the spectrum at the star falls toward longer wavelength and shows gaps where the core is masked (compare `docs/DATA.md`).
- [ ] **Step 7: Commit** `feat: pixel inspector with live spectrum`.

---

