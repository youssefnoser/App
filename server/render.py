"""Fixed-stretch rendering of MJy/sr science pixels to RGBA PNG bytes.

The stretch is identical for every patch and frame so that a moving object
can be blinked against frames from different dates: asinh, 0 to 40 MJy/sr.
NaN pixels (masked by BAD_PIXEL_MASK, or where IMAGE - ZODI is undefined)
are kept visible as such: they stretch to byte 0 and render as fully
transparent in the PNG, never as a false dark background.
"""

import io

import numpy as np
from PIL import Image

STRETCH_MAX = 40.0  # MJy/sr, top of the fixed stretch


def stretch(arr: np.ndarray) -> np.ndarray:
    """Map MJy/sr values to bytes 0..255 with the fixed asinh stretch.

    `t = asinh(clip(x, 0, 40)) / asinh(40)`, byte `round(255 * t)`.
    Values below 0 clip to 0 and above 40 clip to 40, so every frame maps
    through the same transfer curve. NaN gives 0 (transparent when rendered).
    """
    x = np.nan_to_num(np.asarray(arr, dtype=np.float64), nan=0.0)
    t = np.arcsinh(np.clip(x, 0.0, STRETCH_MAX)) / np.arcsinh(STRETCH_MAX)
    return np.round(255.0 * t).astype(np.uint8)


def to_png(arr: np.ndarray) -> bytes:
    """Render an MJy/sr array to RGBA PNG bytes (grey + alpha).

    NaN pixels are fully transparent (alpha 0) so the background map shows
    through; every other pixel is opaque (alpha 255) grey from `stretch`.
    """
    grey = stretch(arr)
    alpha = np.where(np.isnan(arr), 0, 255).astype(np.uint8)
    rgba = np.stack([grey, grey, grey, alpha], axis=-1)
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()
