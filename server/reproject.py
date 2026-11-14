"""Resample a SPHEREx frame onto a north-up, east-left grid, and look up wavelength.

Output arrays have row 0 at the north edge and column 0 at the east edge, with
a pixel scale of 3.075 arcsec, the same grid for every frame of a patch.
"""

import numpy as np
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

SCALE_ARCSEC = 3.075


def resample_north_up(
    image: np.ndarray, wcs: WCS, ra: float, dec: float, n: int, min_weight: float = 0.5,
    origin: tuple[int, int] = (0, 0),
) -> np.ndarray:
    """Resample `image` onto an (n, n) TAN grid centred on (ra, dec) in degrees.

    Returns float32 with row 0 north and column 0 east. Output pixels outside the
    input are NaN. NaN in the input is interpolated *around*: each output pixel is
    the bilinear average of its valid input neighbours only, and is NaN when less
    than `min_weight` (default a half) of the bilinear weight is valid. So one
    masked input pixel becomes one masked output pixel instead of a smeared block.

    `origin` is the (x, y) pixel of `wcs` that `image[0, 0]` sits on, for an image
    that is a slice of a larger frame whose WCS is passed unchanged.
    """
    scale = SCALE_ARCSEC / 3600.0
    out_wcs = WCS(naxis=2)
    out_wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    out_wcs.wcs.crval = [ra, dec]
    out_wcs.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    out_wcs.wcs.cdelt = [-scale, scale]  # RA grows to the left: east-left

    yy, xx = np.mgrid[0:n, 0:n]
    world_ra, world_dec = out_wcs.pixel_to_world_values(xx, yy)
    px, py = wcs.world_to_pixel_values(world_ra, world_dec)
    px, py = px - origin[0], py - origin[1]

    data = np.asarray(image, dtype=np.float64)
    valid = np.isfinite(data)
    coords = [py, px]
    weight = map_coordinates(
        valid.astype(np.float64), coords, order=1, mode="constant", cval=0.0
    )
    total = map_coordinates(
        np.where(valid, data, 0.0), coords, order=1, mode="constant", cval=0.0
    )
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(weight >= min_weight, total / weight, np.nan)
    # Output row 0 of the WCS grid is the south edge. Flip so row 0 is north.
    return out[::-1, :].astype(np.float32)


def wavelength_at(hdul, ra: float, dec: float) -> tuple[float, float]:
    """Wavelength and bandwidth in micrometres at a sky position.

    Uses the WCS-WAVE lookup table (docs/DATA.md). The pixel position is clamped to
    the image bounds first, so a point off the crop returns the nearest edge value
    instead of raising. Fine for display, not for science (ES 4.3.1).
    """
    image_wcs = WCS(hdul["IMAGE"].header)
    ny, nx = hdul["IMAGE"].data.shape
    x, y = image_wcs.world_to_pixel_values(ra, dec)
    x = float(np.clip(x, 0, nx - 1))
    y = float(np.clip(y, 0, ny - 1))

    wave = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
    wave.sip = None
    wl, bw = wave.pixel_to_world(x, y)
    return float(getattr(wl, "value", wl)), float(getattr(bw, "value", bw))
