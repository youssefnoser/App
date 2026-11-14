"""Warm the frame cache for the challenge targets, and report what it cost.

Network on a cold cache (IRSA cutout service), nothing else. Usage:

    uv run python scripts/data/prewarm.py [key ...] [--fov 0.15] [--workers 8]

For each target it takes the position for the current date, asks `_exposures_for_cell`
(disk index first, IRSA TAP second), picks the first batch (one exposure per
visit and detector), and renders every (patch, exposure) pair the browser would
ask for: one PNG per patch of the view, for every first-batch exposure that
covers it. Frames already cached cost nothing, so re-running is cheap.

Prints, per target: exposures, first-batch frames, how many were already warm,
PNG and cutout bytes added, and the slowest frame. Fails loudly if the exposure
index is unavailable, because then nothing can be warmed.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from astropy.time import Time

from server.app import _exposures_for_cell, render_frame_cached
from server.cutouts import CutoutError, cache_dir
from server.irsa import IrsaError
from server.patches import cell_centre, cell_of, footprint_contains, view_cells
from server.targets import TARGETS, propagate
from server.timeline import first_batch

FOV_DEG = 0.15


def dir_bytes(path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def warm(target_key: str, fov: float, workers: int) -> bool:
    target = TARGETS.get(target_key)
    if target is None:
        print(f"{target_key}: unknown target", file=sys.stderr)
        return False
    ra, dec = propagate(target, Time.now().mjd)
    cell = cell_of(ra, dec)
    start = time.monotonic()
    try:
        exposures = _exposures_for_cell(cell)
    except IrsaError as err:
        print(f"{target.name}: exposure index unavailable for cell {cell}: {err}")
        return False
    batch = first_batch(exposures)
    cells = view_cells(ra, dec, fov)
    centres = {pix: cell_centre(pix) for pix in cells}

    pairs = [
        (pix, uri)
        for uri, e in {e.uri: e for e in exposures if e.uri in batch}.items()
        for pix in cells
        if footprint_contains(e.footprint, *centres[pix])
    ]
    before = dir_bytes(cache_dir() / "png") + dir_bytes(cache_dir() / "cutouts")
    durations: list[float] = []
    failures = 0

    def one(pair):
        pix, uri = pair
        t0 = time.monotonic()
        try:
            render_frame_cached(pix, uri)
        except CutoutError:
            return time.monotonic() - t0, False
        return time.monotonic() - t0, True

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for took, ok in pool.map(one, pairs):
            durations.append(took)
            failures += 0 if ok else 1

    after = dir_bytes(cache_dir() / "png") + dir_bytes(cache_dir() / "cutouts")
    elapsed = time.monotonic() - start
    print(
        f"{target.name}: {len(exposures)} exposures, {len(batch)} first-batch frames, "
        f"{len(cells)} patches, {len(pairs)} pairs -> {len(pairs) - failures} good, "
        f"{failures} failed in {elapsed:.1f} s "
        f"({elapsed / max(len(pairs), 1):.2f} s/pair, slowest {max(durations, default=0):.1f} s), "
        f"+{(after - before) / 1e6:.0f} MB on disk at cell {cell}"
    )
    return failures == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("keys", nargs="*", default=None)
    parser.add_argument("--fov", type=float, default=FOV_DEG)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    keys = args.keys or list(TARGETS)
    ok = True
    for key in keys:
        ok = warm(key, args.fov, args.workers) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
