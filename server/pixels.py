"""Science image: IMAGE minus ZODI, with bad pixels set to NaN.

Bit meanings are ES Table 16, listed in docs/DATA.md. There are two masks:

- `BAD_PIXEL_MASK` is the IRSA mosaic rule (ES 3.4.3): set to NaN if any of
  TRANSIENT, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, PHANMISS,
  NONLINEAR, PERSIST, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK, BLOOM,
  SNOWBALL, HALO, SATELLITE_HALO. It is correct for a stacked mosaic, where a
  flagged frame is outvoted by the others. Kept here because it documents what
  the archive's own products do; `science_image` does not use it.
- `HARD_PIXEL_MASK` plus the saturation rule below is what a *single* exposure
  gets. ES 3.2.1: a star bright enough to saturate flags its core as an early
  transient or early overflow, then blooms outward and leaves a ring of late
  transients. Blanking every flagged pixel therefore deletes the brightest
  source in the frame, which is the point of a blink, so TRANSIENT and SUR_ERROR
  mask only where nothing saturated is next to them.

OVERFLOW (1), OUTLIER (19) and SOURCE (21) are propagated, never masked, as in
the IRSA mosaic tool.
"""

import numpy as np
from scipy.ndimage import binary_dilation

_IRSA_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29)
_HARD_BITS = (6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 27, 28, 29)
_SOFT_BITS = (0, 2)  # TRANSIENT, SUR_ERROR
_SATURATED_BITS = (1, 26)  # OVERFLOW, BLOOM

BAD_PIXEL_MASK: int = sum(1 << b for b in _IRSA_BITS)
HARD_PIXEL_MASK: int = sum(1 << b for b in _HARD_BITS)
SOFT_PIXEL_MASK: int = sum(1 << b for b in _SOFT_BITS)
SATURATED_MASK: int = sum(1 << b for b in _SATURATED_BITS)

_NEIGHBOURS = np.ones((3, 3), dtype=bool)


def masked_pixels(flags: np.ndarray) -> np.ndarray:
    """Boolean mask of pixels to blank, from a FLAGS array.

    Unusable bits always mask. TRANSIENT and SUR_ERROR mask only when no pixel
    within one pixel is flagged OVERFLOW or BLOOM, so a blooming star keeps its
    core while a lone cosmic ray on blank sky stays blank.
    """
    flags = np.asarray(flags, dtype=np.int64)
    blocked = (flags & HARD_PIXEL_MASK) != 0
    soft = (flags & SOFT_PIXEL_MASK) != 0
    if soft.any():
        near_saturation = binary_dilation((flags & SATURATED_MASK) != 0, _NEIGHBOURS)
        blocked |= soft & ~near_saturation
    return blocked


def science_image(hdul, mask: bool = True) -> np.ndarray:
    """Return `IMAGE - ZODI` as float32.

    With `mask=True`, pixels that `masked_pixels` blanks become NaN. NaN already
    present in IMAGE or ZODI stays NaN either way.
    """
    image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
    zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
    out = image - zodi
    if mask:
        flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
        out = np.where(masked_pixels(flags), np.float32(np.nan), out)
    return out.astype(np.float32, copy=False)
