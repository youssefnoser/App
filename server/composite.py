"""Image maths for the frame filters: every blink frame compared with other visits.

SPHEREx comes back to the same patch of sky every few months (a visit). The
filters process each frame of the blink so the comparison plays in motion:

- `difference(reference, frame)`: the frame minus a reference image (the static
  sky, or the previous visit). What did not change cancels to black; red is light
  only in the reference, blue light only in the frame.
- `trail(layers)`: earlier visits and the frame, each tinted by its date
  (`date_colour`: red earliest, through green, to blue latest). Something in the
  same place every time adds up to white; a mover leaves a trail of colours.

Inputs are images on the same north-up, east-left grid (row 0 north, column 0
east), in MJy/sr, as `server/reproject.py` makes them; outputs keep that
orientation. Both use the fixed asinh stretch of `server/render.py`, so a change
of 10 MJy/sr is as bright as a 10 MJy/sr pixel in a raw frame.
"""

import colorsys
import io

import numpy as np
from PIL import Image

from server.render import STRETCH_MAX, stretch

# Colour of a change at full stretch: red for light only in the reference, blue
# for light only in the frame (the ends of `date_colour`, softened to read on black).
REFERENCE_RGB = np.array([1.0, 0.25, 0.15])
FRAME_RGB = np.array([0.25, 0.55, 1.0])


def date_colour(t: float) -> tuple[float, float, float]:
    """Colour for a date at fraction `t` of the time span (0 earliest, 1 latest):
    hue from red (0) through green (0.5) to blue (1), full saturation. Clamped."""
    t = min(max(float(t), 0.0), 1.0)
    return colorsys.hsv_to_rgb(t * 240.0 / 360.0, 1.0, 1.0)


def _png(rgb: np.ndarray, blank: np.ndarray) -> bytes:
    alpha = np.where(blank, 0, 255).astype(np.uint8)
    rgba = np.concatenate([rgb, alpha[..., None]], axis=-1)
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


def difference(reference: np.ndarray, frame: np.ndarray) -> bytes:
    """RGBA PNG of `frame - reference` on black: red where flux is only in the
    reference, blue where it is only in the frame, brightness from the fixed asinh
    stretch of the size of the change.

    NaN in either input makes the pixel transparent: it cannot be compared.
    """
    change = np.asarray(frame, dtype=np.float64) - np.asarray(reference, dtype=np.float64)
    blank = np.isnan(change)
    size = np.arcsinh(np.clip(np.abs(np.nan_to_num(change)), 0.0, STRETCH_MAX)) / np.arcsinh(STRETCH_MAX)
    colour = np.where((change < 0)[..., None], REFERENCE_RGB, FRAME_RGB)
    rgb = np.round(255.0 * size[..., None] * colour).astype(np.uint8)
    return _png(rgb, blank)


def trail(layers: list[tuple[np.ndarray, tuple[float, float, float]]]) -> bytes:
    """RGBA PNG of (image, colour) layers: each image stretched, tinted by its colour,
    and the layers combined by the brightest value per channel.

    NaN in a layer adds nothing there; a pixel NaN in every layer is transparent.
    Raises ValueError with no layers.
    """
    if not layers:
        raise ValueError("A trail needs at least one image.")
    shape = np.shape(layers[0][0])
    rgb = np.zeros(shape + (3,), dtype=np.uint8)
    blank = np.ones(shape, dtype=bool)
    for image, colour in layers:
        level = stretch(image).astype(np.float64)
        tinted = np.round(level[..., None] * np.asarray(colour)).astype(np.uint8)
        rgb = np.maximum(rgb, tinted)
        blank &= np.isnan(image)
    return _png(rgb, blank)
