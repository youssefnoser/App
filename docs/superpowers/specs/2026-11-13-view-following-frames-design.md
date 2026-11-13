# Design: SPHEREx frames that follow the view

Date: 2026-11-13. Status: draft for approval.

## Intent

The user pans and zooms a real sky (Stellarium Web Engine, with the SPHEREx DR1 all-sky
mosaic as background). Wherever they look closely, the individual SPHEREx exposures of
that sky load in and can be blinked, so anything that moves or changes stands out
(challenge R3, R4). It should feel like one continuous sky, not a square patch pasted
on a map: panning reveals more blinkable sky without visible joins.

Why: the spike (`spike/stellarium/`) proved Stellarium can show the mosaic and blink our
own frames with correct orientation, but only inside one 6 arcmin square around
Barnard's Star. Outside it the sky is static. The user wants the whole close-up view to
be live.

## Goals

- G1. Any sky position: when the view is zoomed in and settles, blinkable frames
  appear for what is on screen, first ones within about 10 s.
- G2. Continuous feel: patches load around the view before the user pans there, and
  neighbouring patches join without seams.
- G3. One blink step shows one real exposure across the whole view (same date, same
  detector everywhere on screen).
- G4. Polite to IRSA: at most 8 parallel downloads, a timeout on every request,
  everything cached on disk, no retry storms (AGENTS.md).
- G5. Still correct: science image is IMAGE - ZODI, flagged pixels masked, NaN shown as
  transparent, north-up east-left verified with a synthetic image.

## Non-goals (this design)

- User-chosen crop or patch size (challenge O5). Planned later as an optimisation, see
  "Later".
- Precomputed frames for the five test targets (option C). Can be added later; nothing
  here blocks it.
- Contrast controls, frame differencing, mosaic subtraction, spectra. Separate designs.
- Automatic detection of movers (out of scope in `SPEC.md`).

## Anti-goals (failure even if it technically works)

- Seams or flicker where patches meet while blinking.
- A pan that starts hundreds of downloads the user never sees.
- Frames that look brighter or darker than their neighbours because each was stretched
  on its own.
- Silent waiting: the user cannot tell whether frames are loading, missing or failed.

## Constraints

- IRSA cutout and TAP responses have no CORS header, so a server fetches them
  (`DATA.md`). The SPHEREx HiPS mosaic has `Access-Control-Allow-Origin: *`, so the
  browser streams it directly.
- One TAP query takes about 4 s. One cutout takes under a second; 358 took 284 s with
  8 threads (measured, `DATA.md`).
- Each exposure covers about 3.5 x 3.5 deg (2040 px at 6.15 arcsec).
- Stellarium Web Engine is AGPL-3.0 and needs our patch
  (`spike/stellarium/stellarium-web-engine-spike.patch`): photo calibration fix, photo
  warp fix, photos drawn in FRAME_ASTROM, instant switch, HiPS cube frame, emscripten 7
  build. Lives in a fork, not upstream.
- Data never goes in git (`.gitignore` covers `.cache/`, `data/`, `*.fits`).

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Load when the view settles, best frames first, rest streams behind | Few seconds' wait at a new spot; simple; polite to IRSA | **Chosen**, extended with surrounding prefetch (user, 2026-11-13) |
| B | Fixed sky cells loaded independently as you pan | Smoother pan, but seams where cells hold different dates; more code | Rejected. Its cell grid is reused inside A, its seam problem is solved by G3 |
| C | Precompute the five test targets | Demo never waits on IRSA | Deferred, compatible |

## Design

### Patches on a fixed grid

The sky is divided into HEALPix cells of order 9 (about 6.9 arcmin across, NESTED
numbering). A patch is one cell. A fixed grid gives stable cache keys, deterministic
neighbours, and no distortion near the poles. Stellarium and the HiPS mosaic already
use HEALPix. (Builder's call: order 9 is the starting value. Order 9 matches the
spike's 0.1 deg crop.)

Each patch is served as a square crop centred on the cell centre. HEALPix cells are
diamonds, so the square must cover the cell's diagonal, not its side: for order 9 the
side is 0.115 deg and the diagonal about 0.162 deg, so the crop is about 0.18 deg
(diagonal plus 10 %). A square only slightly larger than the side would leave gaps at
the corners. Neighbouring crops of the same exposure therefore overlap and show the same
sky from the same exposure. They are resampled on slightly different grids, so values
can differ by a fraction of a pixel at the join. That should be invisible. The browser
check below verifies it.

### The blink timeline is built from exposures, not patches

1. When the view settles, the server finds the exposures covering the view centre
   (one TAP query, cached per patch).
2. These exposures, sorted by time, are the **timeline**. A blink step is one exposure
   (one `obs_id` and one detector).
3. At each step every loaded patch shows its crop of that same exposure. Most
   neighbours are covered by the same exposure because exposures are ~3.5 deg wide.
4. A patch the step's exposure does not cover shows nothing at that step, so the
   mosaic shows through. The patch never shows a different exposure in its place,
   which would put two dates on screen at once (G3).
5. As the view moves, exposures that cover the new centre but are missing from the
   timeline are merged in by time. The current step stays on the same exposure if it
   still covers the view.

### Load order

The client keeps a priority queue of `(patch, exposure)` crops. Highest first:

1. The view-centre patch, **first batch**: one exposure per visit per detector (a visit
   is a run of exposures with no gap over 60 days; about 3 visits x 6 detectors = 18
   crops). Within a group, take the exposure nearest the middle of the visit.
2. The other patches on screen, same first-batch exposures.
3. **Ring 1**: patches just outside the view, same first-batch exposures. This is what
   makes a short pan feel continuous.
4. All remaining exposures, on-screen patches first.
5. Ring 1, remaining exposures.
6. Ring 2, first batch, only when the queue is otherwise empty.

Concurrency: the client sends at most 8 crop requests at a time, and the server also
enforces a global limit of 8 IRSA downloads. Crops already cached are not counted
against IRSA.

Coverage without extra queries: the TAP query also returns each exposure's footprint
(`p.poly`, hex WKB polygon, SRID 4326, longitudes -180..180). The server tests which
patch centres each exposure covers and returns that with the view (plan amendment: the
server, not the client, because it already has astropy and HEALPix), so neighbouring
patches need no TAP query of their own. A new TAP query runs only when the view centre
moves into a cell that has not been queried, and its new exposures merge into the
timeline (see above).

Load budget (estimate from measured ~0.8 s per crop with 8 in parallel, about 10 crops
per second):

| View | Patches on screen + ring 1 | First batch (18 exposures) | Everything (~350) |
|---|---|---|---|
| 0.15 deg | about 4 + 12 | about 290 crops, ~30 s | ~5600 crops, ~9 min |
| 0.5 deg | about 19 + 20 | about 700 crops, ~70 s | too many; not attempted |

The centre patch's first batch (18 crops plus one TAP query) still lands within about
10 s at any zoom (G1). Rings fill behind it. The 0.5 deg start threshold is a starting
value to tune from real timings. A lower threshold reduces load.

### When loading starts and stops

- Loading starts when the field of view is under 0.5 deg and the view has been still
  for 300 ms.
- A pan cancels queued requests for patches that leave view + ring 1 (AbortController
  on the client). Finished crops stay in the disk cache.
- Above 0.5 deg the frame layer fades out and the mosaic alone is shown. Loading
  pauses.
- No automatic retry. A failed crop is counted and shown. One "Try again" action
  re-queues failures.

### Server

Two routes besides the existing exposure search:

- `GET /api/patch/{pix}/exposures` returns the exposures covering the cell centre:
  `obs_id`, detector, MJD, uri, visit index. Cached on disk per cell. This is the
  existing TAP query from `DATA.md` with the cell centre as the point.
- `GET /api/patch/{pix}/frame.png?uri=...` returns the north-up east-left crop of that
  cell from that exposure.
  - Pipeline: cutout (size = cell + margin) -> IMAGE - ZODI -> bad-pixel mask (rule in
    `DATA.md`) -> resample to the patch grid (3.075 arcsec) -> PNG.
  - Stretch is fixed in physical units for every patch and every frame: asinh,
    0 to 40 MJy/sr, the same as the IRSA mosaic. So frames match each other and the
    background (anti-goal 3). NaN becomes alpha 0. Measured on three Barnard's Star
    detector 6 frames: background about 0.1 MJy/sr, 99th percentile 6 to 8 MJy/sr,
    bright star cores above 1000. So the cut keeps faint stars visible, and bright
    cores clip as they do in the mosaic.
  - The `uri` must match the pattern already in `ARCHITECTURE.md`, so the server can
    never be made to fetch arbitrary URLs.
  - Cache key is cell + uri. The trimmed FITS (IMAGE, FLAGS, VARIANCE, ZODI, WCS-WAVE)
    and the PNG are both cached under `.cache/`.

PNG is used because Stellarium photos take an image URL. Raw float frames for contrast
and differencing are a later design (see "Later").

### Client (Stellarium page)

- One Stellarium layer for frames. One `photo` per loaded `(patch, exposure)`, with
  calibration from the cell centre (ra, dec), `orientation: 0`, `pixscale: 3.075`,
  `instant: true`.
- A blink step sets `visible = true` on the photos for that exposure and false on the
  rest.
- Photo objects are created lazily and capped. Keep the current step and the next few
  steps, and drop the least recently used beyond a limit. (Builder's call: start at
  600, measure.)
- View is north-up (equatorial mount), not alt-az, so motion directions read naturally.
  Not done in the spike; needs checking in the engine.
- State in the URL hash: ra, dec, fov, step (challenge O7).
- A coordinate box (RA, Dec in degrees) flies the view there (challenge R2; added
  while planning).

### What the user sees (states)

- Zoomed out: mosaic only. A one-line hint: "Zoom in to load SPHEREx frames for this
  part of the sky."
- Loading: "Loading frames for this spot: 12 of 18." Blinking can start as soon as two
  frames exist.
- No coverage: "SPHEREx has no exposures here yet. The background map is still shown."
- Error: "IRSA did not answer for 4 frames. Try again." Playback continues with what
  loaded.
- During blink: date, detector and wavelength of the current exposure.

## Testing

All tests offline, using `tests/fixtures/` (AGENTS.md):

- Grid: cell centre, neighbours and rings for known positions, including near a pole.
- Timeline: visits and first-batch selection from `tap_barnard.csv`. Merging a second
  patch's exposures keeps the step on the same exposure.
- Priority queue: order as listed above. Cancelling a patch removes only its items.
- Server crop: synthetic FITS with a marker in the north-east corner comes out at row 0
  (north), column 0 (east). NaN in gives alpha 0 out. Fixed stretch gives identical PNG
  values for identical MJy/sr.
- Browser check on real data: Barnard's Star drifts north about 10 arcsec/yr across
  visits, and a pan of one patch shows no seam while blinking (screenshot diff across
  the boundary).

## Later (planned, not in this design)

- **Crop and patch size as an optimisation.** Bigger patches mean fewer requests but
  more bytes per request. Tune order and margin from measured load times. Possibly let
  the user choose (O5).
- Precomputed test targets (option C).
- Raw float frames so contrast, differencing and mosaic subtraction run in the browser.
- Detector filter (blink one band only).

## Decided by the user (2026-11-13)

1. Server: Python with FastAPI.
2. Frontend framework: the user has no preference. The assistant's call is plain ES
   modules with no build step. The UI around the canvas is small, and the existing
   `node --test` setup already fits it. Revisit if the UI grows.
3. Stellarium fork: `github.com/youssefnoser/stellarium-web-engine`, branch `spherex`.
   The App collaborators are invited with write access. The App submodule points to
   that branch.

## Decided by the assistant (check these)

- HEALPix order 9 patches, crop side = cell diagonal + 10 % (about 0.18 deg).
- Blink step = one exposure across all patches. Uncovered patches show the mosaic, never
  another date.
- First batch = one exposure per visit per detector, nearest mid-visit.
- Ring 1 prefetch of the first batch. Ring 2 only when idle.
- Fixed asinh 0 to 40 MJy/sr stretch, matching the mosaic.
- Loading starts below 0.5 deg field of view after 300 ms still.
- No automatic retries.
