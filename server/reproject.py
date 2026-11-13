"""Resample a SPHEREx frame onto a north-up, east-left grid, and look up wavelength.

Output arrays have row 0 at the north edge and column 0 at the east edge, with
a pixel scale of 3.075 arcsec, the same grid for every frame of a patch.
"""

import numpy as np
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

SCALE_ARCSEC = 3.075


def resample_north_up(
    image: np.ndarray, wcs: WCS, ra: float, dec: float, n: int
) -> np.ndarray:
    """Resample `image` onto an (n, n) TAN grid centred on (ra, dec) in degrees.

    Returns float32 with row 0 north and column 0 east. Output pixels outside the
    input are NaN. NaN in the input stays NaN, and because the interpolation is
    bilinear each input NaN also turns the output pixels that touch it to NaN
    (the bad region grows by up to one input pixel).
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
    out = map_coordinates(
        np.asarray(image, dtype=np.float64),
        [py, px],
        order=1,
        mode="constant",
        cval=np.nan,
    )
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
