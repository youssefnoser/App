# Gaia DR3 lookup + Gaia overlay

## Context

Two things are wanted: a search box that finds objects by **name or Gaia DR3 source_id** (today it only takes decimal RA/Dec or the five built-in target names, see `search()` in `web/components/SkyExplorer.tsx:256`), and a **real Gaia overlay** that marks the important Gaia stars in the field. This is SPEC optional item O6. The existing "Gaia DR3" toggle is fake: `SkyCanvas.tsx:481-497` draws a fixed pill next to the target label, and `web/lib/spectral.ts:getExternalCatalogMatches` makes up its matches. The goal is to help people find and recognise things in the SPHEREx blink, especially stars that move.

### Decisions made with the user
- **Search:** look up by name or Gaia DR3 ID.
- **Overlay set:** about the 50 brightest Gaia stars in view, plus every star with total proper motion above 100 mas/yr, each with a motion arrow.
- **Marker interaction:** hover shows a tooltip (ID, G mag, proper motion, parallax, each with a short gloss). Click re-centres the view on the star.
- **Architecture:** names go **from the browser to CDS Sesame**. Gaia queries go **through a new FastAPI endpoint** to IRSA TAP and are cached on disk.

### Verified on 2026-11-14 (curl from this machine)
- CDS Sesame `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?<name>` sends `Access-Control-Allow-Origin: *`. For Barnard's Star it returned jradeg 269.452, jdedeg 4.693, pmRA -801.551. Coordinates are J2000.
- IRSA TAP `gaia_dr3_source` answers ADQL with the columns `source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ref_epoch`, and `ref_epoch` is 2016.0. Lookup by `source_id=4472832130942575872` returns Barnard's Star (pmdec 10362 mas/yr).
- IRSA TAP and ESA Gaia TAP send **no CORS header**, so the browser cannot call them directly. That is why Gaia goes through FastAPI.

## Approaches considered
1. **FastAPI relay for Gaia + Sesame from the browser (chosen).** Gaia answers are cached per cone on disk, there is a rate cap, and the code follows the same pattern as `server/irsa.py`. Tests run offline with `httpx.MockTransport`.
2. Next.js route relay: the test bench could not use it and there would be no disk cache.
3. Everything from the browser: blocked by CORS on IRSA and ESA, as checked above.
4. Aladin Lite panel: it would be a second sky view rather than an overlay on the blink, and DISPLAY-IDEAS idea G is still `proposed`.

## Design

### Backend: `server/gaia.py` (new, modelled on `server/irsa.py`)
- `GaiaSource` dataclass with `source_id: str` (kept as a string because a 19-digit ID overflows JS numbers), `ra`, `dec`, `pmra`, `pmdec`, `parallax`, `gmag`. `pm*` and `parallax` may be `None`, since 2-parameter solutions have none.
- `build_bright_query(ra, dec, radius, n=50)`: `SELECT TOP n … WHERE CONTAINS(POINT, CIRCLE) ORDER BY phot_g_mean_mag`.
- `build_fast_query(ra, dec, radius, pm_min=100)`: the same cone with `pmra*pmra+pmdec*pmdec > pm_min²`, `TOP 500` as a safety cap.
- `build_id_query(source_id)`: the ID is validated as 1–19 digits before it is put into the ADQL string.
- `parse_gaia_csv(text) -> list[GaiaSource]`: empty fields become `None`.
- `cone(ra, dec, radius, *, client=None)`: the two queries, merged and deduplicated by source_id, each with a `fast: bool` flag. `source(source_id, *, client=None)` returns one source or `None`. Both raise `GaiaError` on failure, with no retries, and use the `make_client()` timeout.

### Backend endpoints (`server/app.py`)
- `GET /api/gaia?ra&dec&fov` → `{epoch: 2016.0, radius, sources: [...]}`. Radius = `min(0.75, max(0.05, fov*0.75))` deg. **My call:** the cache key snaps the centre to a 0.05° grid and the radius to steps of {0.1, 0.25, 0.5, 0.75}, stored at `cache_dir()/gaia/cone-{ra}-{dec}-{r}.json` and written with `_write_atomic`. Gaia DR3 never changes, so the cache never expires, but empty answers are not cached (same rule as `_exposures_for_cell`). If IRSA fails, the endpoint returns 502 with a plain message.
- `GET /api/gaia/source/{source_id}` → one source, or 404 "No Gaia DR3 source has that ID."
- Proxy allowlist in `web/app/api/[...path]/route.ts`: add `gaia` and `gaia\/source\/\d+`.

### Shared front end logic: `web/shared/gaia.js` (+ `.d.ts`), pure and also usable by the test bench
- `propagate(src, mjd)`: linear proper motion from J2016.0 (MJD 57388.5). `dec' = dec + pmdec·dt/3.6e6`, `ra' = ra + pmra·dt/(3.6e6·cos dec)`. Sources with no pm are returned unchanged. A note says parallax and radial velocity are ignored, which is fine at arcsecond level.
- `classifyQuery(text)` → `{kind:'coords'|'gaia-id'|'name', …}`. A Gaia ID is 15–19 digits, optionally prefixed "Gaia DR3".
- `parseSesame(xml)` → `{name, ra, dec, pmra?, pmdec?}` or `null`. **To check while building:** whether `-oJ` JSON output is cleaner than XML; use XML if JSON is unreliable.
- `markerKind(src)`: `fast` if total pm > 100, otherwise `bright`. `formatTooltip(src)` returns plain-language lines (e.g. "Proper motion: 10.4″/yr (how far it drifts across the sky each year)", "Parallax 546 mas, about 1.8 pc away"). Parallax that is ≤ 0 or missing gives "distance unknown".

### Search (`SkyExplorer.tsx` `search()`)
The order is: coordinates (unchanged), then built-in target name (unchanged), then **Gaia ID** → `/api/gaia/source/{id}`, then **name** → Sesame from the browser. **My call:** a name or Gaia result is centred on its position **today**, using the returned proper motion. That matches how `/api/targets` propagates the built-in targets, so a fast mover lands in the SPHEREx frames. Results go into the existing search history. While a lookup is running the message reads "Looking up …". On failure it reads "No object called X was found. Check the spelling, or enter RA, Dec in degrees." If Sesame is down: "The name service did not answer. Try again, or enter RA, Dec."

### Overlay
- Move `projectSkyToScreen` out of `SkyCanvas.tsx` into `web/lib/projection.ts` (unchanged code, exported) so the overlay can use it.
- New `web/components/GaiaOverlay.tsx`. It receives `sources`, `observationMjd`, `stel`, size and a `viewTick`. It propagates each source to the frame's MJD, or to today if there is no frame, then projects it. Bright stars get a ring sized by G mag. Fast movers get a ring and an arrow along the motion: the arrow's screen direction comes from projecting the star's position and the position 1 yr later, and its length is fixed at about 24 px. Hover shows the tooltip; click calls `onRecentre(ra, dec)`.
- The `SkyCanvas` RAF/drag loop (`updateReticlePosition`) also bumps `viewTick` so the pins follow pans.
- Fetching happens in `SkyExplorer`, only while `gaiaEnabled`. It is debounced by 400 ms after the view settles, and it re-fetches only when the view centre leaves the last cone or the radius bucket changes. It goes through `cachedFetch`. On error it shows the message "Gaia stars could not be loaded. They will load again when you move the view." and the toggle stays usable.
- Remove the fake Gaia pin (`SkyCanvas.tsx:481-497`). The WISE pin and `spectral.ts` are left alone; they are out of scope.

### Non-goals
WISE overlay, the filterable explorer, Aladin, test bench UI, searching by proper motion or parallax.

## Tasks (test first, one at a time)
0. Write the design doc `docs/superpowers/specs/2026-11-14-gaia-search-overlay-design.md` from this plan. Then use superpowers:writing-plans to turn the tasks below into `docs/superpowers/plans/2026-11-14-gaia-search-overlay.md`.
1. `tests/test_gaia.py` + fixtures `tests/fixtures/gaia_cone_bright.csv`, `gaia_cone_fast.csv`, `gaia_id.csv` (hand-made from the verified rows above, including one row with empty pm and parallax). Then `server/gaia.py`.
2. API tests in `tests/test_api.py` (monkeypatch `gaia.cone`/`gaia.source`, tmp cache; check the cache hit, that empty answers are not cached, the 502 and the 404, and that a bad ID gives 422). Then the endpoints. Then the proxy regex.
3. `web/tests/shared/gaia.test.js` (propagation of Barnard's Star from 2016.0 by 9 yr → ~+93″ north; ID/coords/name classification; Sesame XML fixture parsing; tooltip copy with NaN or missing values). Then `web/shared/gaia.js`. Add it to the `npm test` script if files are listed there.
4. Move the projection into `web/lib/projection.ts`, with no change in behaviour; the existing tests must still pass.
5. Search flow in `SkyExplorer.tsx`.
6. `GaiaOverlay.tsx`, wiring, removal of the fake pin, and CSS in the existing stylesheet.
7. Docs: an `ARCHITECTURE.md` file-table row for each new file and the new endpoints; a Gaia section in `DATA.md` with the verified facts above and the CORS finding; mark SPEC O6 as Gaia done.

## Verification
- `uv run pytest -q` and `cd web && npm test` all pass, offline.
- Run the backend with `uv run uvicorn server.app:app --port 8000`, then `npm run dev`. In headless Chromium:
  - search "Barnard's Star" via Sesame and `4472832130942575872` via Gaia ID → both centre on the star;
  - turn on Gaia → about 50 rings plus a fast-mover arrow on Barnard's Star pointing **north** (up, given north-up);
  - step through the blink frames → the Barnard's Star marker follows the star across frames, about 10″/yr;
  - check that the tooltip text is correct;
  - pan → the pins follow;
  - search "not a star xyz" → shows the plain error.
- Request counts: one IRSA pair per cone bucket, and the second visit is served from `.cache/gaia/`.
