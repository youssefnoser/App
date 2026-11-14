# Gaia Search and Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search by object name (CDS Sesame) or Gaia DR3 source_id, and draw a real Gaia DR3 overlay (brightest stars + fast movers with motion arrows) on the SPHEREx sky view.

**Architecture:** A new `server/gaia.py` queries IRSA TAP `gaia_dr3_source`. Two FastAPI routes expose it, with a disk cache under `cache_dir()/gaia/`. Pure front-end logic (epoch propagation, query classification, Sesame parsing, tooltip copy) lives in `web/shared/gaia.js`. `SkyExplorer` fetches the sources, and `SkyCanvas` renders a new `GaiaOverlay` that replaces the fake Gaia pin.

**Tech Stack:** Python 3.11 + FastAPI + httpx (pytest, `httpx.MockTransport`); Next.js/React TS; vanilla ES module in `web/shared` (node:test).

**Spec:** `docs/superpowers/specs/2026-11-14-gaia-search-overlay-design.md`

## Global Constraints

- Tests never touch the network. Fixtures live in `tests/fixtures/`.
- IRSA is a shared service: every request has a timeout (`make_client()`), there are no retries, and the two cone queries run one after the other, never in parallel.
- Gaia DR3 positions are at epoch **J2016.0 = MJD 57388.5**. Proper motion is in mas/yr, and `pmra` already includes cos(dec).
- `source_id` is always a **string** end to end (19 digits overflows JS `Number`).
- Missing values (`pmra`, `pmdec`, `parallax`, `gmag` may be empty or NaN) must never throw. Each function says what it does with them.
- UI copy: plain sentences, say what happened and what to do next, and gloss units (mas/yr, mas, G mag).
- New files get a row in the `docs/ARCHITECTURE.md` file table.
- Overlay threshold: **fast = total proper motion > 100 mas/yr**. Brightest **N = 50**. Fast query cap: **TOP 500**.

## Review Focus

1. **A source with no proper motion or parallax** (a 2-parameter Gaia solution) must render as a plain ring with "distance unknown" and must not crash propagation. Covered in Task 1 (parse) and Task 3 (propagate/tooltip).
2. **A view near RA 0/360 or near the celestial pole.** The cone-centre snap must keep RA in 0..360, and propagation must not divide by cos(dec)=0. Covered in Task 2 (snap test at RA 359.99) and Task 3 (dec 90 test).
3. **Gaia ID typed with a prefix or spaces** ("Gaia DR3 4472832130942575872") must resolve as an ID, not be sent to Sesame. Covered in Task 3.
4. **A malicious or garbage ID reaching ADQL.** Anything other than 1–19 digits is rejected before the query is built. Covered in Task 1 (`ValueError`) and Task 2 (422).
5. **IRSA or Sesame down.** The UI shows a plain message, the toggle keeps working, and nothing is cached. Covered in Task 2 (502, no cache file) and Task 3 (`parseSesame` on a "not found" page → `null`).

---

### Task 1: `server/gaia.py` query module

**Files:**
- Create: `server/gaia.py`
- Create: `tests/fixtures/gaia_cone_bright.csv`, `tests/fixtures/gaia_cone_fast.csv`, `tests/fixtures/gaia_id.csv`
- Test: `tests/test_gaia.py`

**Interfaces:**
- Produces:
  - `GaiaError(Exception)`
  - `@dataclass(frozen=True) GaiaSource(source_id: str, ra: float, dec: float, pmra: float|None, pmdec: float|None, parallax: float|None, gmag: float|None, fast: bool = False)` with `to_dict() -> dict`
  - `build_bright_query(ra, dec, radius, n=50) -> str`, `build_fast_query(ra, dec, radius, pm_min=100.0) -> str`, `build_id_query(source_id: str) -> str` (raises `ValueError` unless `re.fullmatch(r"\d{1,19}", source_id)`)
  - `parse_gaia_csv(text: str) -> list[GaiaSource]`
  - `cone(ra, dec, radius, *, client=None) -> list[GaiaSource]`: bright first, then fast; deduplicated by source_id; `fast=True` on any source with total pm > 100
  - `source(source_id: str, *, client=None) -> GaiaSource | None`
  - `TAP_URL` is reused from `server.irsa`.

Fixture CSV header (all three files): `source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag`. Use these verified rows:
- bright: `4472832165289153024,269.46646068714,4.70557281066,0.578,-8.671,1.8140,11.451174` and `4472831306295694976,269.47673867362,4.68059921623,-6.752,0.192,0.5215,12.767820`, plus a 2-parameter row `4472832000000000001,269.44,4.70,,,,20.9`
- fast: `4472832130942575872,269.44850252544,4.73942005111,-801.551,10362.394,546.9759,8.193974`
- id: the same Barnard row as fast

- [ ] **Step 1: Write failing tests** in `tests/test_gaia.py`:
  - `test_bright_query_orders_by_g_mag`: the query contains `TOP 50`, `gaia_dr3_source`, `CIRCLE('ICRS', 269.45, 4.69, 0.25)`, `ORDER BY phot_g_mean_mag`.
  - `test_fast_query_thresholds_total_pm`: contains `pmra*pmra + pmdec*pmdec > 10000` and `TOP 500`.
  - `test_id_query_rejects_non_digits`: `pytest.raises(ValueError)` for `"1 OR 1=1"`, `""`, `"12345678901234567890"` (20 digits); `"4472832130942575872"` in `build_id_query(...)`.
  - `test_parse_handles_missing_astrometry`: the 2-param row has `pmra is None and parallax is None and gmag == 20.9`; `source_id` is a `str`.
  - `test_cone_merges_and_flags_fast`: a MockTransport returns the bright CSV for a query containing `ORDER BY` and the fast CSV otherwise; the result has 4 sources; Barnard has `fast is True`; the others `False`; exactly 2 requests are made.
  - `test_cone_dedupes`: when the fast CSV also contains a bright row, it appears once.
  - `test_source_found_and_missing`: returns a `GaiaSource` with pmdec 10362.394; a header-only CSV gives `None`.
  - `test_http_error_raises_gaia_error`: a 500 response → `GaiaError`.
- [ ] **Step 2: Run** `uv run pytest tests/test_gaia.py -q`. Expected: fails with ImportError.
- [ ] **Step 3: Implement `server/gaia.py`** following the `find_exposures` pattern in `server/irsa.py` (POST form data, `own_client` close, wrap `httpx.HTTPError` and parse errors in `GaiaError`). Empty CSV fields become `None`.
- [ ] **Step 4: Run** `uv run pytest tests/test_gaia.py -q`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(server): query Gaia DR3 cones and source ids from IRSA`

### Task 2: `/api/gaia` and `/api/gaia/source/{id}` + proxy allowlist

**Files:**
- Modify: `server/app.py` (add the routes after `/api/targets`)
- Modify: `web/app/api/[...path]/route.ts` (allowlist regex)
- Test: `tests/test_gaia_api.py` (new; it reuses the `client` fixture pattern from `tests/test_api.py`)

**Interfaces:**
- Consumes: `gaia.cone`, `gaia.source`, `GaiaError`, `GaiaSource.to_dict` (Task 1); `_write_atomic`, `cache_dir`.
- Produces:
  - `snap_cone(ra, dec, fov) -> tuple[float, float, float]`: centre rounded to a 0.05° grid with RA kept in [0, 360); radius = the smallest of (0.1, 0.25, 0.5, 0.75) ≥ `min(0.75, max(0.05, fov*0.75))`.
  - `GET /api/gaia?ra&dec&fov` → `{"epoch": 2016.0, "ra": snapped, "dec": snapped, "radius": r, "sources": [GaiaSource dicts]}`. Validation: `ra` 0..360, `dec` -90..90, `fov` 0.01..2. Cache file: `cache_dir()/gaia/cone-{ra:.2f}-{dec:+.2f}-{r}.json`.
  - `GET /api/gaia/source/{source_id}` → GaiaSource dict | 404 `{"detail": "No Gaia DR3 source has that ID."}` | 422 for a bad ID.
  - On `GaiaError`, both return 502 `{"detail": "The Gaia service did not answer. Try again in a minute."}`.

- [ ] **Step 1: Write failing tests:**
  - `test_snap_cone_buckets`: `snap_cone(269.4463, 4.7677, 0.15) == (269.45, 4.75, 0.25)`; `snap_cone(359.99, 0, 0.1)[0] == 0.0`; `snap_cone(10, 10, 2)[2] == 0.75`.
  - `test_gaia_cone_cached`: monkeypatch `server.gaia.cone` (count calls, return 2 sources); two GETs give 1 call, the second answer equals the first, and the cache file exists.
  - `test_gaia_cone_empty_not_cached`: the fake returns `[]`; two GETs give 2 calls.
  - `test_gaia_cone_upstream_error`: the fake raises `GaiaError` → 502 and no file under `tmp_path/"gaia"`.
  - `test_gaia_source_ok_404_422`: found → 200 with `source_id` as a string; `None` → 404; `/api/gaia/source/abc` → 422.
- [ ] **Step 2: Run** `uv run pytest tests/test_gaia_api.py -q`. Expected: fails (404 on routes / import).
- [ ] **Step 3: Implement** the routes and `snap_cone` in `server/app.py`. Call through the module (`from server import gaia` then `gaia.cone(...)`) so monkeypatching works. Do not cache empty answers.
- [ ] **Step 4: Update the proxy regex** to `/^(targets|view|sequence|gaia|gaia\/source\/\d{1,19}|frame\.png|patch\/\d+\/frame\.png)$/`.
- [ ] **Step 5: Run** `uv run pytest -q`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(server): Gaia cone and source endpoints with disk cache`

### Task 3: `web/shared/gaia.js` pure helpers

**Files:**
- Create: `web/shared/gaia.js`, `web/shared/gaia.d.ts`
- Create: `web/tests/shared/fixtures/sesame_barnard.xml` (the real `-oxp` answer: `<jradeg>269.4520769586187</jradeg><jdedeg>4.69336496657667</jdedeg><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE>` inside `<Resolver>`, `<oname>` Barnard's Star) and `sesame_notfound.xml` (a `<Target>` with no `<Resolver>`)
- Test: `web/tests/shared/gaia.test.js` (it is picked up by the existing `tests/shared/*.test.js` glob)

**Interfaces:**
- Produces (named exports):
  - `GAIA_EPOCH_MJD = 57388.5`, `FAST_PM_MASYR = 100`
  - `mjdNow(now = Date.now()) -> number`: `now/86400000 + 40587`
  - `J2000_MJD = 51544.5`
  - `propagate(src, mjd, epochMjd = GAIA_EPOCH_MJD) -> {ra, dec}`: linear from `epochMjd`; if pmra/pmdec are null or non-finite, returns src.ra/src.dec; |cos dec| is clamped to ≥ 1e-6; RA is wrapped to [0, 360).
  - `totalPm(src) -> number | null`
  - `markerKind(src) -> 'fast' | 'bright'`
  - `classifyQuery(text) -> {kind:'coords', ra, dec} | {kind:'coords-invalid'} | {kind:'gaia-id', id: string} | {kind:'name', name} | {kind:'empty'}`. Coordinates use the same regex and range rules as `SkyExplorer.search()`, which then calls this helper instead. A Gaia ID matches `/^(?:gaia\s*(?:dr3)?\s*)?(\d{15,19})$/i` after trimming.
  - `sesameUrl(name) -> string`: `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?` + `encodeURIComponent(name)`
  - `parseSesame(xmlText) -> {name, ra, dec, pmra: number|null, pmdec: number|null} | null`: regex on the tags (no DOMParser in node); `null` if there is no `<jradeg>`.
  - `tooltipLines(src) -> string[]`, exact copy:
    - `Gaia DR3 ${source_id}`
    - `Brightness: G ${gmag.toFixed(1)} (Gaia magnitude, smaller is brighter)` or `Brightness: unknown`
    - `Motion: ${(pm/1000).toFixed(2)}″ per year across the sky` or `Motion: not measured`
    - `Parallax ${plx.toFixed(1)} mas, about ${(1000/plx) < 100 ? (1000/plx).toFixed(1) : Math.round(1000/plx)} parsecs away` when plx > 0, otherwise `Distance: unknown`

- [ ] **Step 1: Write failing tests:**
  - `propagate moves Barnard north ~93″ in 9 years`: the Barnard source at mjd `57388.5 + 9*365.25` → `(dec' - dec)*3600` is within 0.5 of `93.26`; RA decreases.
  - `propagate leaves 2-parameter sources alone`: pmra null → the same ra/dec; pmra NaN → the same.
  - `propagate at the pole does not explode`: dec 90 → finite ra in [0, 360).
  - `classifyQuery`: `"269.45, 4.69"` → coords; `"Gaia DR3 4472832130942575872"` and `" 4472832130942575872 "` → gaia-id with a string id; `"Barnard's Star"` → name; `"   "` → empty; `"400, 0"` → `{kind:'coords-invalid'}`.
  - `parseSesame`: the Barnard fixture → ra 269.45207…, pmdec 10362.394; notfound → `null`.
  - `tooltipLines`: Barnard → exactly `["Gaia DR3 4472832130942575872", "Brightness: G 8.2 (Gaia magnitude, smaller is brighter)", "Motion: 10.39″ per year across the sky", "Parallax 547.0 mas, about 1.8 parsecs away"]`; a 2-parameter source → contains `"Motion: not measured"` and `"Distance: unknown"`; parallax -0.3 → `"Distance: unknown"`.
  - `markerKind`: Barnard → fast; pm 50 → bright; null pm → bright.
- [ ] **Step 2: Run** `cd web && node --test tests/shared/gaia.test.js`. Expected: fails with module not found.
- [ ] **Step 3: Implement** `gaia.js` + `gaia.d.ts` (`GaiaSource` type: `{source_id:string; ra:number; dec:number; pmra:number|null; pmdec:number|null; parallax:number|null; gmag:number|null; fast?:boolean}`).
- [ ] **Step 4: Run** `cd web && npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): Gaia helpers for epoch, search parsing and tooltips`

### Task 4: Name and Gaia ID search

**Files:**
- Create: `web/lib/resolve.ts`
- Modify: `web/components/SkyExplorer.tsx` (`search()` around line 256)
- Test: `web/tests/unit/resolve.test.ts` (add it to the `test` script in `web/package.json`)

**Interfaces:**
- Consumes: `classifyQuery`, `sesameUrl`, `parseSesame`, `propagate`, `mjdNow` (Task 3); `/api/gaia/source/{id}` (Task 2).
- Produces: `resolveQuery(text: string, fetchFn: typeof fetch = fetch, now = Date.now()) -> Promise<{ok:true, name:string, type:string, ra:number, dec:number} | {ok:false, message:string}>`
  - gaia-id: GET `/api/gaia/source/${id}`. The result position is propagated to today; name `Gaia DR3 ${id}`, type `GAIA DR3`. 404 → `No Gaia DR3 source has the ID ${id}. Check the number and try again.`
  - name: GET `sesameUrl(name)`. Sesame J2000 positions with pm are propagated to today with `propagate(result, mjdNow(now), J2000_MJD)`. Type `SIMBAD`. A `null` parse → `No object called “${name}” was found. Check the spelling, or enter RA, Dec in degrees.`
  - A network failure or a status ≥ 500 → `The name service did not answer. Try again, or enter RA, Dec in degrees.` (for an ID: `The Gaia service did not answer. Try again in a minute.`)

- [ ] **Step 1: Write failing tests** with a fake `fetchFn`: a Sesame Barnard XML gives a position whose dec is larger than 4.6934 by between 0.07 and 0.08 deg at `now = 2026-11-14`; not found gives `ok:false` and the exact copy; fetch rejects gives the name-service copy; a gaia-id 404 gives the exact copy; a gaia-id 200 gives the name `Gaia DR3 4472832130942575872`.
- [ ] **Step 2: Run** `cd web && node --experimental-strip-types tests/unit/resolve.test.ts`. Expected: fails.
- [ ] **Step 3: Implement `resolve.ts`**, then change `search()`: keep the coords branch and the built-in-target branch as they are; otherwise set the message to `Looking up ${text}…`, `await resolveQuery`, and on `ok` call `updateCoordinates`, `saveHistoryItem({query:text, name, type, ra, dec})`, `setSelected(-1)` and the message `Exploring ${name}`; on failure set the message.
- [ ] **Step 4: Run** `cd web && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit** `feat(web): search by object name or Gaia DR3 ID`

### Task 5: Gaia overlay

**Files:**
- Create: `web/lib/projection.ts` (move `projectSkyToScreen` from `SkyCanvas.tsx:63` unchanged and export it)
- Create: `web/components/GaiaOverlay.tsx`
- Create: `web/lib/gaiaFetch.ts`
- Modify: `web/components/SkyCanvas.tsx` (import the projection; delete the fake Gaia pin at lines 481–497; add the `gaiaSources` and `onRecentre` props; bump `viewTick` state inside `updateReticlePosition`; render `<GaiaOverlay>`)
- Modify: `web/components/SkyExplorer.tsx` (fetch effect, pass the props)
- Modify: `web/app/globals.css` (next to `.catalog-pin`, line ~667)
- Test: `web/tests/unit/gaiaFetch.test.ts` (add it to the `test` script)

**Interfaces:**
- Consumes: Task 3 helpers; `/api/gaia` (Task 2); `cachedFetch`.
- Produces:
  - `needsRefetch(last: {ra,dec,radius}|null, view: {ra,dec,fov}) -> boolean`: true if `last` is null, if the angular separation between the view centre and `last` + `fov/2` > `last.radius`, or if `snapRadius(fov) !== last.radius`. `snapRadius` mirrors the server buckets (0.1/0.25/0.5/0.75).
  - `GaiaOverlay` props: `{stel: any; width: number; height: number; viewTick: number; sources: GaiaSource[]; observationMjd?: number; onRecentre(ra: number, dec: number): void}`
- Behaviour:
  - Each source is drawn at `propagate(src, observationMjd ?? mjdNow())`.
  - A `bright` source is a ring of diameter `clamp(22 - 1.2*(gmag-8), 8, 22)` px (gmag null → 8).
  - A `fast` source is a ring + an arrow whose direction is `project(propagate(src, mjd+365.25)) - project(pos)`, normalised to 24 px. If the projected direction is under 0.01 px, the arrow is skipped.
  - The tooltip uses `tooltipLines` and shows on hover/focus. Each marker is a `<button>` with `aria-label` = the first two lines joined. Click → `onRecentre(pos.ra, pos.dec)`.
  - Markers with `visible === false` are skipped.
  - SkyExplorer fetch: only while `gaiaEnabled`. Debounced 400 ms on `[viewCoordinates, fovDeg, gaiaEnabled]`, and only if `needsRefetch`. Clear the sources when turned off. On error, set the message to `Gaia stars could not be loaded. They will load again when you move the view.` and do not update `last`.
  - `onRecentre` → `updateCoordinates`.

- [ ] **Step 1: Write failing tests** for `needsRefetch`: null → true; same centre and same bucket → false; moved 0.3° with radius 0.25 → true; fov 0.15→0.6 (bucket change) → true; RA 359.9 vs `last` at RA 0.05 radius 0.25, fov 0.1 → false (the separation must wrap).
- [ ] **Step 2: Run** it and expect a failure. Then implement `gaiaFetch.ts`; the tests pass.
- [ ] **Step 3: Move the projection** to `web/lib/projection.ts`; `npx tsc --noEmit` and `npm test` pass with no change in behaviour.
- [ ] **Step 4: Implement `GaiaOverlay.tsx`**, the SkyCanvas/SkyExplorer wiring and the CSS (Gaia colour: reuse the `.gaia-dot` colour from globals.css).
- [ ] **Step 5: Run** `cd web && npm test && npx tsc --noEmit && npm run build`. Expected: pass.
- [ ] **Step 6: Browser check** (backend at :8000, `npm run dev`, headless Chromium at the path in AGENTS.md): Barnard's Star view → Gaia on → rings plus one arrow on Barnard pointing up (north); step the frames → the marker stays on the star; pan → the pins follow; hover → the tooltip text matches Task 3; click a ring → the view re-centres. Save screenshots to the scratchpad.
- [ ] **Step 7: Commit** `feat(web): Gaia DR3 overlay with fast-mover arrows`

### Task 6: Docs

**Files:** `docs/ARCHITECTURE.md`, `docs/DATA.md`, `docs/SPEC.md`

- [ ] **Step 1: Update the docs.** In ARCHITECTURE: file-table rows for `server/gaia.py`, `web/shared/gaia.js`, `web/lib/resolve.ts`, `web/lib/gaiaFetch.ts`, `web/lib/projection.ts`, `web/components/GaiaOverlay.tsx`, and the two endpoints. In DATA.md: a "Gaia DR3" section with the facts verified on 2026-11-14 (IRSA table `gaia_dr3_source`, its columns, ref_epoch 2016.0; Sesame `-oxp` gives J2000 with CORS `*`; IRSA and ESA TAP have no CORS). In SPEC: O6 "Gaia done, WISE not yet".
- [ ] **Step 2: Run** `uv run pytest -q && (cd web && npm test)`. Expected: pass.
- [ ] **Step 3: Commit** `docs: Gaia search and overlay`
