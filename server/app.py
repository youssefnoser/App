"""FastAPI app for the SPHEREx blink viewer.

Routes:
  GET /api/view?ra=&dec=&fov=            which patches and exposures cover a view
  GET /api/patch/{pix}/frame.png?uri=    one patch's crop of one exposure, as a PNG
Static files: /engine and /skydata (Stellarium Web Engine) and / (web/), each
mounted only if its directory exists, so the app imports without a vendor build.
"""

import hashlib
import json
import os
import tempfile
from pathlib import Path

from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from server.cutouts import CutoutError, cache_dir, check_uri, fetch_cutout
from server.irsa import Exposure, IrsaError, find_exposures
from server.patches import (
    CROP_DEG,
    NPIX,
    PATCH_N,
    cell_centre,
    cell_of,
    footprint_contains,
    view_cells,
)
from server.pixels import science_image
from server.render import to_png
from server.reproject import resample_north_up, wavelength_at
from server.timeline import first_batch, group_visits

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "vendor" / "stellarium-web-engine" / "build"
SKYDATA_DIR = ROOT / "vendor" / "stellarium-web-engine" / "apps" / "test-skydata"
WEB_DIR = ROOT / "web"

app = FastAPI(title="SPHEREx Blink")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    """Exposures covering the cell centre, from the disk cache or IRSA TAP."""
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
    exposures = find_exposures(*cell_centre(cell))
    rows = [
        {"uri": e.uri, "mjd": e.mjd, "detector": e.detector, "obs_id": e.obs_id,
         "footprint": [list(p) for p in e.footprint]}
        for e in exposures
    ]
    _write_atomic(path, json.dumps(rows).encode())
    return exposures


@app.get("/api/view")
def view(
    ra: float = Query(ge=0, lt=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(gt=0, le=180),
) -> dict:
    cell = cell_of(ra, dec)
    cells = view_cells(ra, dec, fov)
    centres = {pix: cell_centre(pix) for pix in cells}
    try:
        exposures = _exposures_for_cell(cell)
    except IrsaError as err:
        raise HTTPException(502, "IRSA did not answer. Try again in a moment.") from err

    visit_of = {}
    for index, visit in enumerate(group_visits(exposures)):
        for e in visit:
            visit_of[e.uri] = index
    first = first_batch(exposures)
    out = []
    for e in sorted(exposures, key=lambda e: e.mjd):
        covered = [pix for pix, (cra, cdec) in centres.items()
                   if footprint_contains(e.footprint, cra, cdec)]
        out.append({
            "uri": e.uri,
            "obs_id": e.obs_id,
            "mjd": e.mjd,
            "date": Time(e.mjd, format="mjd").iso[:10],
            "detector": e.detector,
            "visit": visit_of[e.uri],
            "first": e.uri in first,
            "cells": sorted(covered),
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


def _frame_paths(pix: int, uri: str) -> tuple[Path, Path]:
    base = cache_dir() / "png" / str(pix) / hashlib.sha1(uri.encode()).hexdigest()
    return base.with_suffix(".png"), base.with_suffix(".json")


def _render_frame(pix: int, uri: str) -> tuple[bytes, dict]:
    ra, dec = cell_centre(pix)
    path = fetch_cutout(uri, ra, dec, CROP_DEG)
    with fits.open(path) as hdul:
        header = hdul["IMAGE"].header
        image = science_image(hdul)
        grid = resample_north_up(image, WCS(header), ra, dec, PATCH_N)
        wavelength_um, _ = wavelength_at(hdul, ra, dec)
        meta = {
            "mjd": float(header["MJD-AVG"]),
            "detector": int(header["DETECTOR"]),
            "wavelength_um": wavelength_um,
            "obs_id": str(header["OBSID"]),
        }
    return to_png(grid), meta


@app.get("/api/patch/{pix}/frame.png")
def patch_frame(pix: int, uri: str = Query()) -> Response:
    if not 0 <= pix < NPIX:
        raise HTTPException(422, f"Patch number must be between 0 and {NPIX - 1}.")
    try:
        check_uri(uri)
    except ValueError as err:
        raise HTTPException(422, "That is not a SPHEREx file path.") from err

    png_path, meta_path = _frame_paths(pix, uri)
    try:
        png, meta = png_path.read_bytes(), json.loads(meta_path.read_text())
    except (OSError, ValueError):
        try:
            png, meta = _render_frame(pix, uri)
        except CutoutError as err:
            raise HTTPException(502, "IRSA did not return this frame. Try again.") from err
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
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
