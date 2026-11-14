"""Tests for the frame filters' image maths (server/composite.py), on synthetic images."""

import io
import math

import numpy as np
import pytest
from PIL import Image

from server.composite import date_colour, difference, trail
from server.render import STRETCH_MAX, stretch


def rgba(png: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(png))
    assert img.format == "PNG" and img.mode == "RGBA"
    return np.asarray(img, dtype=np.uint8)


def star(at: tuple[int, int], size: int = 21, flux: float = STRETCH_MAX) -> np.ndarray:
    """A blank field with one bright pixel."""
    out = np.zeros((size, size), dtype=np.float32)
    out[at] = flux
    return out


@pytest.mark.parametrize("t, want", [(0.0, (1, 0, 0)), (0.5, (0, 1, 0)), (1.0, (0, 0, 1))])
def test_date_colour_runs_red_to_green_to_blue(t, want):
    assert date_colour(t) == pytest.approx(want)


def test_date_colour_clamps():
    assert date_colour(-1) == date_colour(0) and date_colour(2) == date_colour(1)


# --- difference: a frame against a reference image ---


def test_difference_cancels_what_did_not_change():
    fixed = star((3, 3), flux=25.0)
    out = rgba(difference(fixed, fixed.copy()))
    assert out[..., :3].max() == 0
    assert (out[..., 3] == 255).all()


def test_difference_marks_reference_place_red_and_frame_place_blue():
    reference, frame = star((10, 10)), star((6, 10))  # moved north (towards row 0)
    out = rgba(difference(reference, frame))
    gone, new = out[10, 10], out[6, 10]
    assert gone[0] == 255 and gone[2] < gone[0]  # red: only in the reference
    assert new[2] == 255 and new[0] < new[2]  # blue: only in this frame
    assert out[0, 0, :3].tolist() == [0, 0, 0]


def test_difference_keeps_orientation():
    """Row 0 is north and column 0 east in every input, so the output must not flip."""
    reference = np.zeros((5, 7), dtype=np.float32)
    frame = reference.copy()
    frame[0, 6] = STRETCH_MAX  # north-west corner
    out = rgba(difference(reference, frame))
    assert out.shape == (5, 7, 4)
    assert out[0, 6, 2] == 255 and out[4, 0, 2] == 0


def test_difference_uses_the_fixed_asinh_stretch_on_the_size_of_the_change():
    reference = np.zeros((1, 3), dtype=np.float32)
    frame = np.array([[10.0, -10.0, 2 * STRETCH_MAX]], dtype=np.float32)
    out = rgba(difference(reference, frame))
    level = round(255 * math.asinh(10) / math.asinh(STRETCH_MAX))
    assert out[0, 0, 2] == level  # +10 MJy/sr: blue at the level of a 10 MJy/sr frame pixel
    assert out[0, 1, 0] == level  # -10 MJy/sr: red at that level
    assert out[0, 2, 2] == 255  # beyond the stretch: clipped


def test_difference_is_transparent_where_either_image_is_blank():
    reference, frame = star((5, 5)), star((5, 5))
    frame[2, 2] = np.nan
    out = rgba(difference(reference, frame))
    assert out[2, 2, 3] == 0
    assert out[5, 5, 3] == 255


# --- trail: earlier visits and this frame, each tinted by its date ---


def test_trail_static_star_adds_up_to_white_and_a_mover_keeps_its_colours():
    fixed = star((3, 3))
    layers = []
    for row, t in ((10, 0.0), (12, 0.5), (14, 1.0)):  # one step south per visit
        image = fixed.copy()
        image[row, 10] = STRETCH_MAX
        layers.append((image, date_colour(t)))
    out = rgba(trail(layers))
    assert out[3, 3].tolist() == [255, 255, 255, 255]  # there every time: all colours, white
    assert out[10, 10].tolist() == [255, 0, 0, 255]  # first date only: red
    assert out[12, 10].tolist() == [0, 255, 0, 255]
    assert out[14, 10].tolist() == [0, 0, 255, 255]
    assert out[0, 0].tolist() == [0, 0, 0, 255]  # empty sky stays black and opaque


def test_trail_brightness_follows_the_fixed_stretch():
    image = np.array([[10.0]], dtype=np.float32)
    out = rgba(trail([(image, (1.0, 0.0, 0.0))]))
    assert out[0, 0, 0] == stretch(np.array([10.0]))[0]


def test_trail_shows_a_pixel_any_layer_has_and_hides_one_none_has():
    """A pixel blank in one date still shows the dates that saw it; blank in all is transparent."""
    first, second = star((5, 5)), star((5, 5))
    second[5, 5] = np.nan
    first[1, 1] = second[1, 1] = np.nan
    out = rgba(trail([(first, (1.0, 0.0, 0.0)), (second, (0.0, 0.0, 1.0))]))
    assert out[5, 5].tolist() == [255, 0, 0, 255]
    assert out[1, 1, 3] == 0


def test_trail_needs_a_layer():
    with pytest.raises(ValueError):
        trail([])
