"""Render one target's first visit twice: archive mask rule vs the mask we use.

Answers "what did the fix change?" with pixels rather than words. Usage:

    uv run python scripts/compare_masks.py [key] [--out .cache/compare]

Row 1 is the IRSA mosaic rule (ES 3.4.3, blank every flagged pixel); row 2 is
what the page now draws (unusable bits only, plus TRANSIENT/SUR_ERROR kept where
they sit next to saturation). Columns are the six detectors of the first visit,
so a difference in core visibility shows per band. Also prints, per detector, the
masked fraction and the peak flux under each rule.
"""

import argparse
import io
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image, ImageDraw

from server.app import _exposures_for_cell, _render_frame
from server.cutouts import cache_dir, fetch_cutout
from server.patches import CROP_DEG, PATCH_N, cell_centre, cell_of
from server.pixels import BAD_PIXEL_MASK, science_image
from server.render import to_png
from server.targets import TARGETS, propagate
from server.timeline import first_batch, group_visits
from astropy.time import Time


def tiles_for(key: str) -> tuple[str, list[tuple[int, np.ndarray, np.ndarray]]]:
    target = TARGETS[key]
    ra, dec = propagate(target, Time.now().mjd)
    cell = cell_of(ra, dec)
    exposures = _exposures_for_cell(cell)
    visit = group_visits(exposures)[0]
    batch = first_batch(visit)
    chosen = sorted((e for e in visit if e.uri in batch), key=lambda e: e.detector)
    tiles = []
    for exposure in chosen:
        path = fetch_cutout(exposure.uri, *cell_centre(cell), CROP_DEG)
        with fits.open(path) as hdul:
            image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
            zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
            flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
            raw = image - zodi
            old = np.where((flags & BAD_PIXEL_MASK) != 0, np.float32(np.nan), raw)
            new = science_image(hdul)
            wcs = WCS(hdul["IMAGE"].header)
        from server.reproject import resample_north_up

        centre = cell_centre(cell)
        old_grid = resample_north_up(old, wcs, *centre, PATCH_N)
        new_grid = resample_north_up(new, wcs, *centre, PATCH_N)
        tiles.append((exposure.detector, old_grid, new_grid))
        print(
            f"  D{exposure.detector} mjd {exposure.mjd:.3f}: masked "
            f"{100 * np.isnan(old).mean():5.1f}% -> {100 * np.isnan(new).mean():5.1f}%, "
            f"peak {np.nanmax(old) if np.isfinite(old).any() else float('nan'):8.1f} -> "
            f"{np.nanmax(new) if np.isfinite(new).any() else float('nan'):8.1f} MJy/sr"
        )
    return target.name, tiles


def sheet(name: str, tiles: list[tuple[int, np.ndarray, np.ndarray]], out: Path) -> Path:
    n = len(tiles)
    header, label = 18, 12
    sheet = Image.new("RGB", (n * PATCH_N, 2 * PATCH_N + header + 2 * label), "black")
    draw = ImageDraw.Draw(sheet)
    draw.text((4, 4), f"{name}: archive mask (top) vs page mask (bottom)", fill="white")
    for column, (detector, old, new) in enumerate(tiles):
        x = column * PATCH_N
        for row, grid in enumerate((old, new)):
            y = header + row * (PATCH_N + label) + label
            tile = Image.open(io.BytesIO(to_png(grid))).convert("RGBA")
            sheet.paste(tile, (x, y), tile)
            draw.text((x + 4, y - label + 2), f"D{detector}", fill="white")
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("key", nargs="?", default="barnards-star")
    parser.add_argument("--out", default=str(cache_dir() / "compare"))
    args = parser.parse_args()
    name, tiles = tiles_for(args.key)
    path = sheet(name, tiles, Path(args.out) / f"{args.key}-mask.png")
    print(f"{name}: wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
