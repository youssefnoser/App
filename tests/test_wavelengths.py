"""Offline tests for placing a sky point on a detector from its footprint."""

from pathlib import Path

import pytest

from server.footprint import exposure_from_head, image_header, pixel_to_sky
from server.wavelengths import pixel_in_footprint

HEAD = (Path(__file__).parent / "fixtures" / "header_2025W33_2C_0321_1D6.bin").read_bytes()
KEY = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"


@pytest.mark.parametrize("pixel", [(1019.5, 1019.5), (100.0, 100.0), (1900.0, 300.0),
                                   (400.0, 1950.0), (0.0, 2039.0)])
def test_pixel_from_footprint_matches_the_real_wcs_within_a_few_pixels(pixel):
    """The footprint knows nothing of the SIP distortion, so allow about ten pixels."""
    exposure = exposure_from_head(KEY, HEAD)
    ra, dec = pixel_to_sky(image_header(HEAD), *pixel)
    x, y = pixel_in_footprint(exposure.footprint, ra, dec)
    assert x == pytest.approx(pixel[0], abs=12.0)
    assert y == pytest.approx(pixel[1], abs=12.0)


def test_point_outside_the_footprint_lands_outside_the_detector():
    exposure = exposure_from_head(KEY, HEAD)
    ra, dec = pixel_to_sky(image_header(HEAD), 2500.0, 1000.0)
    x, _ = pixel_in_footprint(exposure.footprint, ra, dec)
    assert x > 2040


def test_works_across_ra_zero():
    square = ((359.0, -1.0), (1.0, -1.0), (1.0, 1.0), (359.0, 1.0))
    x, y = pixel_in_footprint(square, 0.5, 0.5, size=100)
    assert x == pytest.approx(74.5, abs=0.1)
    assert y == pytest.approx(74.5, abs=0.1)
