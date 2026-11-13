"""HEALPix patch grid and footprint coverage.

Patches are HEALPix order 9 cells (nside 512), NESTED, ICRS. Pure geometry:
no pixels, so NaN does not arise here.
"""
import math

import astropy.units as u
import numpy as np
from astropy_healpix import HEALPix

ORDER = 9
NSIDE = 512
NPIX = 12 * NSIDE**2
CROP_DEG = 0.18
PATCH_N = 211

_HP = HEALPix(nside=NSIDE, order="nested")


def cell_of(ra: float, dec: float) -> int:
    """Return the patch cell that contains (ra, dec), in degrees."""
    return int(_HP.lonlat_to_healpix(ra * u.deg, dec * u.deg))


def cell_centre(pix: int) -> tuple[float, float]:
    """Return the centre of a cell as (ra 0..360, dec) in degrees."""
    lon, lat = _HP.healpix_to_lonlat(pix)
    return float(lon.to_value(u.deg)) % 360.0, float(lat.to_value(u.deg))


def _neighbours(pixels: set[int]) -> set[int]:
    """Return all valid neighbours of the given cells (missing ones are dropped)."""
    if not pixels:
        return set()
    found = _HP.neighbours(np.array(sorted(pixels), dtype=np.int64))
    return {int(p) for p in np.asarray(found).ravel() if p >= 0}


def view_cells(ra: float, dec: float, fov_deg: float) -> dict[int, int]:
    """Map cell to ring for a view centred on (ra, dec) with the given field of view.

    Ring 0: the centre cell plus cells whose centre lies within fov_deg / 2 of the
    view centre. Ring 1: neighbours of ring 0 not in ring 0. Ring 2: neighbours of
    ring 1 not already listed.
    """
    ring0 = {cell_of(ra, dec)}
    found = _HP.cone_search_lonlat(ra * u.deg, dec * u.deg, (fov_deg / 2) * u.deg)
    ring0.update(int(p) for p in found)
    cells = dict.fromkeys(ring0, 0)
    ring1 = _neighbours(ring0) - cells.keys()
    cells.update(dict.fromkeys(ring1, 1))
    ring2 = _neighbours(ring1) - cells.keys()
    cells.update(dict.fromkeys(ring2, 2))
    return cells


def _unit(ra: float, dec: float) -> np.ndarray:
    r, d = math.radians(ra), math.radians(dec)
    return np.array([math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d)])


def footprint_contains(footprint, ra: float, dec: float) -> bool:
    """Return True if (ra, dec) lies inside the spherical convex quad.

    The point is inside when every triple product (c[i] x c[i+1]) . p has the same
    sign, whichever way the corners are ordered. Unit vectors make this correct
    across RA 0/360. The point must also be on the same hemisphere as the quad,
    so the antipode is not accepted.
    """
    corners = [_unit(r, d) for r, d in footprint]
    p = _unit(ra, dec)
    if float(np.dot(sum(corners), p)) <= 0.0:
        return False
    signs = [
        float(np.dot(np.cross(corners[i], corners[(i + 1) % len(corners)]), p))
        for i in range(len(corners))
    ]
    return all(s > 0 for s in signs) or all(s < 0 for s in signs)
