"""Tests for the fixed-stretch PNG renderer (server/render.py)."""

import io

import numpy as np
import pytest
from PIL import Image

from server.render import stretch, to_png


def decode_png(png_bytes: bytes) -> np.ndarray:
    """Decode PNG bytes to an HxWx4 uint8 RGBA array."""
    img = Image.open(io.BytesIO(png_bytes))
    assert img.format == "PNG"
    assert img.mode == "RGBA"
    return np.asarray(img, dtype=np.uint8)


def test_stretch_endpoints():
    out = stretch(np.array([0.0, 40.0, -3.0, 1000.0], dtype=np.float64))
    assert out.dtype == np.uint8
    assert out.tolist() == [0, 255, 0, 255]


def test_stretch_mid():
    from math import asinh

    assert stretch(np.array([10.0]))[0] == round(255 * asinh(10) / asinh(40))


def test_stretch_nan_is_zero():
    """NaN must come out as byte 0, never an undefined cast."""
    out = stretch(np.array([np.nan]))
    assert out[0] == 0


def test_png_alpha_from_nan():
    arr = np.ones((3, 3), dtype=np.float64)
    arr[1, 1] = np.nan
    rgba = decode_png(to_png(arr))
    assert rgba[1, 1, 3] == 0  # centre transparent
    assert (rgba[:, :, 3] == 255).sum() == 8  # every other pixel opaque


def test_png_all_nan_transparent():
    arr = np.full((211, 211), np.nan, dtype=np.float64)
    rgba = decode_png(to_png(arr))  # must not raise
    assert rgba.shape == (211, 211, 4)
    assert (rgba[:, :, 3] == 0).all()


def test_same_value_same_byte():
    a = np.array([[5.0, 20.0]], dtype=np.float64)
    b = np.array([[20.0, 5.0]], dtype=np.float64)
    ra = decode_png(to_png(a))
    rb = decode_png(to_png(b))
    assert ra[0, 1, :3].tolist() == rb[0, 0, :3].tolist()  # value 20.0
    assert ra[0, 0, :3].tolist() == rb[0, 1, :3].tolist()  # value 5.0
