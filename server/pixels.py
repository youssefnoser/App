"""Science image: IMAGE minus ZODI, with bad pixels set to NaN.

Bit meanings are ES Table 16, listed in docs/DATA.md. OVERFLOW (1), OUTLIER (19)
and SOURCE (21) are propagated, never masked, as in the IRSA mosaic tool.
"""

import numpy as np

_BAD_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29)

BAD_PIXEL_MASK: int = sum(1 << b for b in _BAD_BITS)


def science_image(hdul, mask: bool = True) -> np.ndarray:
    """Return `IMAGE - ZODI` as float32.

    With `mask=True`, pixels whose FLAGS value has any bit of BAD_PIXEL_MASK set
    become NaN. NaN already present in IMAGE or ZODI stays NaN either way.
    """
    image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
    zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
    out = image - zodi
    if mask:
        flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
        out = np.where((flags & BAD_PIXEL_MASK) != 0, np.float32(np.nan), out)
    return out.astype(np.float32, copy=False)
