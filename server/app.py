"""FastAPI app for the SPHEREx blink viewer.

Routes:
  GET /api/view?ra=&dec=&fov=            which patches and exposures cover a view
  GET /api/patch/{pix}/frame.png?uri=    one patch's crop of one exposure, as a PNG
Static files: /engine and /skydata (Stellarium Web Engine), /shared (web/shared/, modules
the test bench shares with the Next.js app) and / (testbench/), each mounted only if its
directory exists, so the app imports without a vendor build.
"""

import hashlib
import io
import json
import os
import tempfile
import threading
import warnings
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from server.catalog import catalog
from server.cutouts import CutoutError, cache_dir, check_uri, fetch_cutout
from server.irsa import Exposure, IrsaError, find_exposures
from server.mirror import fetch_exposure, open_frame, prefetch
from server.ranges import fetch_crop
from server.wavelengths import exposure_wavelengths
from server.patches import (
    CROP_DEG,
    NPIX,
    PATCH_N,
    cell_centre,
    cell_of,
    cell_unit_vectors,
    cells_covered,
    footprint_contains,
    view_cells,
)
from server.pixels import science_image
from server.render import to_png
from server.targets import TARGETS, propagate
from server.reproject import SCALE_ARCSEC, resample_north_up, wavelength_at
from server.timeline import first_batch, group_visits

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "vendor" / "stellarium-web-engine" / "build"
SKYDATA_DIR = ROOT / "vendor" / "stellarium-web-engine" / "apps" / "test-skydata"
TESTBENCH_DIR = ROOT / "testbench"
SHARED_DIR = ROOT / "web" / "shared"

# Frames only load below 0.5 deg; allow a 2x margin (ruling R14).
MAX_FOV_DEG = 1.0

# Bump when a change alters rendered pixels, so a warmed cache cannot keep serving
# the old look. 2: NaN-aware resampling and the saturation-aware pixel mask.
RENDER_VERSION = 2

app = FastAPI(title="SPHEREx Blink")


def pixel_source() -> str:
    """Where pixels come from: "aws" (whole files from the mirror, cut here; the
    default) or "irsa" (one cutout request per patch). Set with SPHEREX_SOURCE."""
    return "irsa" if os.environ.get("SPHEREX_SOURCE", "aws").lower() == "irsa" else "aws"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/targets")
def targets() -> list[dict]:
    """The five challenge test targets at today's position (proper motion applied)."""
    now = float(Time.now().mjd)
    out = []
    for key, target in TARGETS.items():
        ra, dec = propagate(target, now)
        out.append({"key": key, "name": target.name, "ra": round(ra, 5), "dec": round(dec, 5)})
    return out


def _write_atomic(path: Path, data: bytes) -> None:
    """Write bytes under a temporary name, then rename, so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _exposures_for_cell(cell: int) -> list[Exposure]:
    """Exposures covering the cell centre: per-cell disk cache, then the local
    snapshot (server/catalog.py), then IRSA TAP."""
    path = cache_dir() / "tap" / f"{cell}.json"
    try:
        rows = json.loads(path.read_text())
        return [
            Exposure(r["uri"], r["mjd"], r["detector"], r["obs_id"],
                     tuple(tuple(p) for p in r["footprint"]))
            for r in rows
        ]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    snapshot = catalog()
    exposures = snapshot.find(*cell_centre(cell))
    if exposures is None or not snapshot.complete:
        # No local snapshot, or it is still being filled (its answer may be
        # missing exposures): ask IRSA.
        exposures = find_exposures(*cell_centre(cell))
    rows = [
        {"uri": e.uri, "mjd": e.mjd, "detector": e.detector, "obs_id": e.obs_id,
         "footprint": [list(p) for p in e.footprint]}
        for e in exposures
    ]
    if rows:  # an empty answer may be a gap in the service, so it is not kept
        _write_atomic(path, json.dumps(rows).encode())
    return exposures


@app.get("/api/view")
def view(
    ra: float = Query(ge=0, lt=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(gt=0, le=MAX_FOV_DEG),
    stack: bool = Query(False),
) -> dict:
    """Patches and exposures for a view.

    With `stack=1` only the first-batch exposures are listed, and each stands for
    the median of every exposure of its visit and detector (see `_render_stack`):
    its `cells` are the patches any of those exposures covers.
    """
    cell = cell_of(ra, dec)
    cells = view_cells(ra, dec, fov)
    pixes = sorted(cells)
    centres = {pix: cell_centre(pix) for pix in pixes}
    centre_xyz = cell_unit_vectors([centres[pix] for pix in pixes])
    try:
        exposures = _exposures_for_cell(cell)
    except IrsaError as err:
        raise HTTPException(502, "IRSA did not answer. Try again in a moment.") from err

    visit_of = {}
    for index, visit in enumerate(group_visits(exposures)):
        for e in visit:
            visit_of[e.uri] = index
    first = first_batch(exposures)
    if pixel_source() == "aws" and not stack:
        prefetch(sorted(first))
    groups: dict[tuple[int, int], list[Exposure]] = {}
    for e in exposures:
        groups.setdefault((visit_of[e.uri], e.detector), []).append(e)
    out = []
    for e in sorted(exposures, key=lambda e: e.mjd):
        if stack and e.uri not in first:
            continue
        members = groups[(visit_of[e.uri], e.detector)] if stack else [e]
        mask = cells_covered(members[0].footprint, centre_xyz)
        for other in members[1:]:
            mask = mask | cells_covered(other.footprint, centre_xyz)
        covered = [pix for pix, hit in zip(pixes, mask) if hit]
        out.append({
            **({"stack": cell, "count": len(members)} if stack else {}),
            "uri": e.uri,
            "obs_id": e.obs_id,
            "mjd": e.mjd,
            "date": Time(e.mjd, format="mjd").iso[:10],
            "detector": e.detector,
            "visit": visit_of[e.uri],
            "first": e.uri in first,
            "cells": covered,
        })
    return {
        "cell": cell,
        "cells": [
            {"pix": pix, "ra": round(centres[pix][0], 5), "dec": round(centres[pix][1], 5),
             "ring": ring}
            for pix, ring in sorted(cells.items())
        ],
        "exposures": out,
    }


def _frame_paths(pix: int, uri: str, kind: str = "") -> tuple[Path, Path]:
    base = (
        cache_dir()
        / "png"
        / f"v{RENDER_VERSION}{kind}"
        / str(PATCH_N)
        / str(pix)
        / hashlib.sha1(uri.encode()).hexdigest()
    )
    return base.with_suffix(".png"), base.with_suffix(".json")


def _render_from_mirror(pix: int, uri: str) -> tuple[bytes, dict]:
    """Render one patch from a whole exposure held in the mirror cache."""
    ra, dec = cell_centre(pix)
    frame = open_frame(fetch_exposure(uri))
    try:
        image, origin = frame.science_crop(ra, dec, CROP_DEG)
        with frame.lock:
            grid = resample_north_up(image, frame.sky, ra, dec, PATCH_N, origin=origin)
        wavelength_um, _ = frame.wavelength(ra, dec)
        return to_png(grid), {**frame.meta, "wavelength_um": wavelength_um}
    except CutoutError:
        raise
    except Exception as err:
        raise CutoutError(f"Frame could not be rendered: {err}") from err


def _render_frame(pix: int, uri: str) -> tuple[bytes, dict]:
    """Get the crop and render it. An IRSA cutout that cannot be rendered is deleted
    from the cache and reported as CutoutError, so the next request refetches."""
    if pixel_source() == "aws":
        return _render_from_mirror(pix, uri)
    ra, dec = cell_centre(pix)
    path = fetch_cutout(uri, ra, dec, CROP_DEG)
    try:
        with fits.open(path) as hdul:
            header = hdul["IMAGE"].header
            image = science_image(hdul)
            with warnings.catch_warnings():
                # astropy complains about SIP coefficients without a -SIP CTYPE on every
                # frame; applying them is intended.
                warnings.simplefilter("ignore")
                grid = resample_north_up(image, WCS(header), ra, dec, PATCH_N)
                wavelength_um, _ = wavelength_at(hdul, ra, dec)
            meta = {
                "mjd": float(header["MJD-AVG"]),
                "detector": int(header["DETECTOR"]),
                "wavelength_um": wavelength_um,
                "obs_id": str(header["OBSID"]),
            }
        return to_png(grid), meta
    except Exception as err:  # corrupt or incomplete file: KeyError, ValueError, OSError, astropy errors
        Path(path).unlink(missing_ok=True)
        raise CutoutError(f"Cutout could not be rendered: {err}") from err


def render_frame_cached(pix: int, uri: str) -> tuple[bytes, dict]:
    """PNG bytes and metadata for one patch and one exposure, from disk when warm.

    Shared by the HTTP route and `scripts/prewarm.py`, so a prewarmed frame is
    byte-identical to one fetched by the browser.
    """
    png_path, meta_path = _frame_paths(pix, uri)
    try:
        return png_path.read_bytes(), json.loads(meta_path.read_text())
    except (OSError, ValueError):
        pass
    png, meta = _render_frame(pix, uri)
    _write_atomic(meta_path, json.dumps(meta).encode())
    _write_atomic(png_path, png)
    return png, meta


def _stack_members(cell: int, uri: str) -> list[Exposure]:
    """Every exposure of the same visit and detector as `uri`, from `cell`'s list."""
    for visit in group_visits(_exposures_for_cell(cell)):
        detector = next((e.detector for e in visit if e.uri == uri), None)
        if detector is not None:
            return [e for e in visit if e.detector == detector]
    return []


def _render_stack(pix: int, uri: str, cell: int) -> tuple[bytes, dict]:
    """Median of one patch over every exposure of `uri`'s visit and detector.

    Each exposure is cut and resampled like a single frame, then the per-pixel
    median ignores NaN, so a pixel blanked in some exposures is filled by the
    others and stays NaN only where every exposure is blank. Exposures that do not
    reach the patch or cannot be fetched are left out; with none left it raises
    CutoutError. The wavelength reported is the median over the exposures: a stack
    mixes the wavelengths one detector sees at this position.
    """
    ra, dec = cell_centre(pix)
    members = [e for e in _stack_members(cell, uri) if footprint_contains(e.footprint, ra, dec)]

    def one(e: Exposure):
        try:
            frame = open_frame(fetch_exposure(e.uri))
            image, origin = frame.science_crop(ra, dec, CROP_DEG)
            with frame.lock:
                grid = resample_north_up(image, frame.sky, ra, dec, PATCH_N, origin=origin)
            return grid, frame.wavelength(ra, dec)[0], frame.meta
        except CutoutError:
            return None

    with ThreadPoolExecutor(8) as pool:
        done = [r for r in pool.map(one, members) if r is not None]
    if not done:
        raise CutoutError("No exposure of this visit reaches the patch.")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels stay NaN
        median = np.nanmedian(np.stack([d[0] for d in done]), axis=0)
    times = sorted(d[2]["mjd"] for d in done)
    meta = {
        "mjd": float(np.median(times)),
        "mjd_first": times[0],
        "mjd_last": times[-1],
        "detector": done[0][2]["detector"],
        "wavelength_um": float(np.median([d[1] for d in done])),
        "obs_id": "",
        "stack": len(done),
    }
    return to_png(median.astype(np.float32)), meta


def render_stack_cached(pix: int, uri: str, cell: int) -> tuple[bytes, dict]:
    """As `render_frame_cached`, for the visit median."""
    png_path, meta_path = _frame_paths(pix, uri, kind=f"-stack/{cell}")
    try:
        return png_path.read_bytes(), json.loads(meta_path.read_text())
    except (OSError, ValueError):
        pass
    png, meta = _render_stack(pix, uri, cell)
    _write_atomic(meta_path, json.dumps(meta).encode())
    _write_atomic(png_path, png)
    return png, meta


@app.get("/api/patch/{pix}/frame.png")
def patch_frame(
    pix: int, uri: str = Query(), stack: int | None = Query(None, ge=0, lt=NPIX)
) -> Response:
    if not 0 <= pix < NPIX:
        raise HTTPException(422, f"Patch number must be between 0 and {NPIX - 1}.")
    try:
        check_uri(uri)
    except ValueError as err:
        raise HTTPException(422, "That is not a SPHEREx file path.") from err

    try:
        if stack is None:
            png, meta = render_frame_cached(pix, uri)
        else:
            png, meta = render_stack_cached(pix, uri, stack)
    except IrsaError as err:
        raise HTTPException(502, "IRSA did not answer. Try again in a moment.") from err
    except CutoutError as err:
        raise HTTPException(502, "The SPHEREx archive (IRSA) did not return this frame. Try again.") from err
    return Response(
        png,
        media_type="image/png",
        headers={"X-Frame-Meta": json.dumps(meta), "Cache-Control": "public, max-age=86400"},
    )


# ---------------------------------------------------------------- live sequence
#
# One image per exposure for a fixed sky box, read from the mirror by byte ranges
# (server/ranges.py). The page treats the box as a single patch, so its queue,
# blink and photo code are the same as for the patch grid.

# The page sends the side of the square box that covers its whole canvas. Frames
# load below 0.5 deg of screen height, and the corners of a 16:10 screen are then
# about 0.95 deg apart, so the box gets the same 2x margin as /api/view.
SEQ_MIN_FOV, SEQ_MAX_FOV = 0.05, MAX_FOV_DEG
SEQ_MAX_ROLL = 4
_grids: dict[tuple, tuple] = {}
_grids_guard = threading.Lock()
# Bounded by bytes, not count: a 1 deg grid is 16 times a 0.25 deg one. The budget
# is what the old 600-grid limit allowed at 0.5 deg (585 px float32 grids).
MAX_GRID_BYTES = 600 * 585 * 585 * 4


def _seq_pix(ra: float, dec: float, fov: float, detector) -> int:
    """The page's patch number for one sequence box: negative, so it can never be a
    real HEALPix patch, and different for every box so cached photos do not mix."""
    return -1 - zlib.crc32(f"{ra}|{dec}|{fov}|{detector}".encode()) % 2_000_000_000


def _seq_size(fov: float) -> int:
    """Side of the sequence image in pixels at the patch grid's 3.075 arcsec scale."""
    return int(round(fov * 3600.0 / SCALE_ARCSEC))


_grid_locks: dict[tuple, threading.Lock] = {}


def _seq_grid(uri: str, ra: float, dec: float, fov: float) -> tuple:
    """(north-up grid, wavelength, metadata) of one exposure for the box.

    Kept in memory and on disk (cache_dir()/grids), so the neighbours a rolling
    median needs are fetched from the mirror once, whichever server worker asks,
    and two requests for the same exposure share one fetch.
    """
    key = (uri, ra, dec, fov)
    with _grids_guard:
        hit = _grids.pop(key, None)
        if hit is not None:
            _grids[key] = hit
            return hit
        lock = _grid_locks.setdefault(key, threading.Lock())
    name = hashlib.sha1(f"{uri}|{ra}|{dec}|{fov}".encode()).hexdigest()
    path = cache_dir() / "grids" / f"v{RENDER_VERSION}" / name[:2] / f"{name}.npz"
    with lock:
        with _grids_guard:
            hit = _grids.get(key)
        if hit is not None:
            return hit
        try:
            with np.load(path) as saved:
                out = (saved["grid"], float(saved["wavelength"]), json.loads(str(saved["meta"])))
        except (OSError, ValueError, KeyError):
            with fetch_crop(uri, ra, dec, fov) as hdul, warnings.catch_warnings():
                warnings.simplefilter("ignore")  # SIP without -SIP CTYPE; applying it is intended
                header = hdul["IMAGE"].header
                grid = resample_north_up(
                    science_image(hdul), WCS(header), ra, dec, _seq_size(fov))
                wavelength_um, _ = wavelength_at(hdul, ra, dec)
                meta = {"mjd": float(header["MJD-AVG"]), "detector": int(header["DETECTOR"]),
                        "obs_id": str(header["OBSID"])}
            out = (grid, wavelength_um, meta)
            buffer = io.BytesIO()
            np.savez(buffer, grid=grid, wavelength=wavelength_um, meta=json.dumps(meta))
            _write_atomic(path, buffer.getvalue())
        with _grids_guard:
            _grids[key] = out
            _grid_locks.pop(key, None)
            held = sum(g.nbytes for g, _, _ in _grids.values())
            while held > MAX_GRID_BYTES and len(_grids) > 1:
                held -= _grids.pop(next(iter(_grids)))[0].nbytes
    return out


def _sequence(ra: float, dec: float, detector: int | None = None,
              wavelength: float | None = None, width: float = 0.05,
              ) -> list[tuple[Exposure, int, float | None]]:
    """(exposure, visit index, wavelength) for every exposure whose footprint holds
    the point, in time order, kept if it is on `detector` or, when `wavelength` is
    given, if the wavelength it records at the point is within the fraction `width`
    of it (0.05 keeps 5 % either side). Wavelength is None in detector mode."""
    covering = []
    for index, visit in enumerate(group_visits(_exposures_for_cell(cell_of(ra, dec)))):
        covering += [(e, index) for e in visit if footprint_contains(e.footprint, ra, dec)]
    if wavelength is None:
        return [(e, v, None) for e, v in covering if e.detector == detector]
    seen = exposure_wavelengths([e for e, _ in covering], ra, dec)
    return [(e, v, w) for (e, v), w in zip(covering, seen)
            if abs(w - wavelength) <= wavelength * width]


@app.get("/api/sequence")
def sequence(
    ra: float = Query(ge=0, lt=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(ge=SEQ_MIN_FOV, le=SEQ_MAX_FOV),
    detector: int | None = Query(None, ge=1, le=6),
    wavelength: float | None = Query(None, ge=0.7, le=5.1),
    width: float = Query(0.05, gt=0, le=0.5),
) -> dict:
    """The time sequence of one detector at a point, shaped like `/api/view` with a
    single patch. `first` marks the first, middle and last exposure of each visit:
    the page loads those before the rest, so a blink across the whole time span is
    possible after a few frames."""
    ra, dec, fov = round(ra, 5), round(dec, 5), round(fov, 3)
    if (detector is None) == (wavelength is None):
        raise HTTPException(422, "Give either a detector or a wavelength.")
    try:
        items = _sequence(ra, dec, detector, wavelength, width)
    except IrsaError as err:
        raise HTTPException(502, "IRSA did not answer. Try again in a moment.") from err
    except CutoutError as err:
        raise HTTPException(
            502, "The SPHEREx archive (IRSA) did not return the wavelength map. Try again.") from err
    by_visit: dict[int, list[Exposure]] = {}
    for e, visit, _ in items:
        by_visit.setdefault(visit, []).append(e)
    coarse = set()
    for members in by_visit.values():
        coarse.update(m.uri for m in (members[0], members[len(members) // 2], members[-1]))
    pix = _seq_pix(ra, dec, fov, f"{detector}|{wavelength}|{width}")
    return {
        "cell": pix,
        "sequence": {"ra": ra, "dec": dec, "fov": fov, "detector": detector,
                     "wavelength": wavelength, "width": width, "pixels": _seq_size(fov)},
        "cells": [{"pix": pix, "ra": ra, "dec": dec, "ring": 0}],
        "exposures": [
            {"uri": e.uri, "obs_id": e.obs_id, "mjd": e.mjd,
             "date": Time(e.mjd, format="mjd").iso[:10], "detector": e.detector,
             "visit": visit, "first": e.uri in coarse, "cells": [pix],
             **({} if seen is None else {"wavelength_um": round(seen, 4)})}
            for e, visit, seen in items
        ],
    }


def _render_sequence_frame(uri: str, ra: float, dec: float, fov: float, roll: int,
                           wavelength: float | None = None, width: float = 0.05):
    """One sequence image: the exposure itself (`roll=0`) or the NaN-ignoring median
    of it and up to `roll` exposures either side from the same visit and detector.
    Neighbours that fail or miss the box are left out; the exposure itself must work."""
    grid, wavelength_um, meta = _seq_grid(uri, ra, dec, fov)
    if roll == 0:
        return to_png(grid), {**meta, "wavelength_um": wavelength_um}
    # Neighbours come from the same filtered sequence the page is showing, so in
    # wavelength mode the median only mixes exposures of nearly the same colour.
    items = [(e, v) for e, v, _ in (
        _sequence(ra, dec, None, wavelength, width) if wavelength is not None
        else _sequence(ra, dec, meta["detector"]))]
    uris = [e.uri for e, _ in items]
    grids, waves = [grid], [wavelength_um]
    if uri in uris:
        at = uris.index(uri)
        visit = items[at][1]
        near = [e.uri for e, v in items[max(at - roll, 0):at + roll + 1]
                if v == visit and e.uri != uri]

        def one(other: str):
            try:
                return _seq_grid(other, ra, dec, fov)
            except CutoutError:
                return None

        with ThreadPoolExecutor(8) as pool:
            for result in pool.map(one, near):
                if result is not None:
                    grids.append(result[0])
                    waves.append(result[1])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels stay NaN
        median = np.nanmedian(np.stack(grids), axis=0).astype(np.float32)
    return to_png(median), {**meta, "wavelength_um": float(np.median(waves)),
                            "stack": len(grids)}


@app.get("/api/frame.png")
def sequence_frame(
    uri: str = Query(),
    ra: float = Query(ge=0, lt=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(ge=SEQ_MIN_FOV, le=SEQ_MAX_FOV),
    roll: int = Query(2, ge=0, le=SEQ_MAX_ROLL),
    wavelength: float | None = Query(None, ge=0.7, le=5.1),
    width: float = Query(0.05, gt=0, le=0.5),
) -> Response:
    try:
        check_uri(uri)
    except ValueError as err:
        raise HTTPException(422, "That is not a SPHEREx file path.") from err
    ra, dec, fov = round(ra, 5), round(dec, 5), round(fov, 3)
    mix = f"|{wavelength}|{width}" if wavelength is not None and roll else ""
    name = hashlib.sha1(f"{uri}|{ra}|{dec}|{fov}|{roll}{mix}".encode()).hexdigest()
    base = cache_dir() / "png" / f"v{RENDER_VERSION}-seq" / name[:2] / name
    png_path, meta_path = base.with_suffix(".png"), base.with_suffix(".json")
    try:
        png, meta = png_path.read_bytes(), json.loads(meta_path.read_text())
    except (OSError, ValueError):
        try:
            png, meta = _render_sequence_frame(uri, ra, dec, fov, roll, wavelength, width)
        except IrsaError as err:
            raise HTTPException(502, "IRSA did not answer. Try again in a moment.") from err
        except CutoutError as err:
            raise HTTPException(
                502, "The SPHEREx archive (IRSA) did not return this frame. Try again.") from err
        except Exception as err:  # a file the pipeline cannot read
            raise HTTPException(
                502, "The SPHEREx archive (IRSA) returned a frame that could not be drawn.") from err
        _write_atomic(meta_path, json.dumps(meta).encode())
        _write_atomic(png_path, png)
    return Response(
        png,
        media_type="image/png",
        headers={"X-Frame-Meta": json.dumps(meta), "Cache-Control": "public, max-age=86400"},
    )


# Static mounts last so /api and /health win. Skip any directory that is missing.
if ENGINE_DIR.is_dir():
    app.mount("/engine", StaticFiles(directory=ENGINE_DIR), name="engine")
if SKYDATA_DIR.is_dir():
    app.mount("/skydata", StaticFiles(directory=SKYDATA_DIR), name="skydata")
if SHARED_DIR.is_dir():
    app.mount("/shared", StaticFiles(directory=SHARED_DIR), name="shared")
if TESTBENCH_DIR.is_dir():
    app.mount("/", StaticFiles(directory=TESTBENCH_DIR, html=True), name="testbench")
