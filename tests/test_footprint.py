"""Offline tests for exposure metadata read from a file's first bytes."""

import math
import warnings
from pathlib import Path

import pytest
from astropy.io import fits
from astropy.wcs import WCS

from server.footprint import HeaderError, exposure_from_head, image_header, pixel_to_sky
from server.irsa import parse_tap_csv

FIXTURES = Path(__file__).parent / "fixtures"
HEAD = (FIXTURES / "header_2025W33_2C_0321_1D6.bin").read_bytes()
KEY = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"


def sep_arcsec(a, b):
    ra1, dec1, ra2, dec2 = map(math.radians, (*a, *b))
    c = math.sin(dec1) * math.sin(dec2) + math.cos(dec1) * math.cos(dec2) * math.cos(ra1 - ra2)
    return math.degrees(math.acos(min(1.0, c))) * 3600


def test_fields_match_the_tap_row():
    tap = {e.uri: e for e in parse_tap_csv((FIXTURES / "tap_barnard_poly.csv").read_text())}
    got = exposure_from_head(KEY, HEAD)
    want = tap[got.uri]
    assert got.mjd == pytest.approx(want.mjd, abs=1e-6)
    assert (got.detector, got.obs_id) == (want.detector, want.obs_id)


def test_footprint_matches_the_tap_polygon_within_a_pixel():
    tap = {e.uri: e for e in parse_tap_csv((FIXTURES / "tap_barnard_poly.csv").read_text())}
    got = exposure_from_head(KEY, HEAD)
    want = tap[got.uri].footprint
    assert len(got.footprint) == 4
    for corner in got.footprint:
        assert min(sep_arcsec(corner, w) for w in want) < 6.15


def test_pixel_to_sky_matches_astropy_with_sip():
    header = fits.Header.fromstring(HEAD[2880:25920].decode("ascii"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(header)
        for x, y in [(0, 0), (2039, 0), (1019.5, 1019.5), (300, 1800), (-0.5, 2039.5)]:
            want = tuple(float(v) for v in wcs.pixel_to_world_values(x, y))
            assert sep_arcsec(pixel_to_sky(image_header(HEAD), x, y), want) < 0.01


def test_truncated_header_is_an_error():
    with pytest.raises(HeaderError):
        exposure_from_head(KEY, HEAD[:10_000])


def test_not_fits_is_an_error():
    with pytest.raises(HeaderError):
        exposure_from_head(KEY, b"<html>" + b" " * 6000)


def test_missing_card_is_an_error():
    broken = HEAD.replace(b"MJD-BEG ", b"MJD-XXX ")
    with pytest.raises(HeaderError):
        exposure_from_head(KEY, broken)
