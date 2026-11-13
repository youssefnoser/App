"""Offline tests for north-up resampling and the wavelength lookup."""

from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from server.reproject import SCALE_ARCSEC, resample_north_up, wavelength_at

CROP = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"

RA0, DEC0 = 150.0, 20.0
NATIVE = 6.2  # arcsec per input pixel (SPHEREx native scale is about 6.2)


def synthetic_wcs(n=80) -> WCS:
    """TAN WCS with the sky rotated 30 degrees against the pixel grid."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA0, DEC0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    s = NATIVE / 3600
    th = np.deg2rad(30)
    w.wcs.cd = [[-s * np.cos(th), s * np.sin(th)], [s * np.sin(th), s * np.cos(th)]]
    return w


def bright_at(w: WCS, dra_arcsec: float, ddec_arcsec: float, n=80) -> np.ndarray:
    """Image with one bright pixel at the position offset from the centre
    (offsets in tangent-plane arcsec, east positive)."""
    dec = DEC0 + ddec_arcsec / 3600
    ra = RA0 + dra_arcsec / 3600 / np.cos(np.deg2rad(DEC0))
    x, y = w.world_to_pixel_values(ra, dec)
    img = np.zeros((n, n), dtype=np.float32)
    img[int(round(float(y))), int(round(float(x)))] = 100.0
    return img


def peak(out: np.ndarray) -> tuple[int, int]:
    r, c = np.unravel_index(np.nanargmax(out), out.shape)
    return int(r), int(c)


def test_orientation_north_and_east():
    w = synthetic_wcs()
    offset_px = 15 / SCALE_ARCSEC  # about 4.9 output pixels
    assert abs(offset_px - 5) < 0.2

    north = resample_north_up(bright_at(w, 0, 15), w, RA0, DEC0, 41)
    r, c = peak(north)
    assert abs(r - (20 - 5)) <= 1 and abs(c - 20) <= 1

    east = resample_north_up(bright_at(w, 15, 0), w, RA0, DEC0, 41)
    r, c = peak(east)
    assert abs(c - (20 - 5)) <= 1 and abs(r - 20) <= 1


def test_output_shape_and_dtype():
    w = synthetic_wcs()
    out = resample_north_up(np.ones((80, 80), dtype=np.float32), w, RA0, DEC0, 41)
    assert out.shape == (41, 41)
    assert out.dtype == np.float32


def test_nan_input():
    w = synthetic_wcs()
    img = np.ones((80, 80), dtype=np.float32)
    img[30:50, 30:50] = np.nan
    out = resample_north_up(img, w, RA0, DEC0, 41)
    assert np.isnan(out).any()
    assert np.isfinite(out).any()


def test_outside_input_is_nan():
    w = synthetic_wcs()
    out = resample_north_up(np.ones((80, 80), dtype=np.float32), w, RA0, DEC0, 301)
    assert np.isnan(out[0, 0]) and np.isnan(out[-1, -1])
    assert out[150, 150] == 1.0


def test_real_crop_wavelength():
    with fits.open(CROP) as hdul:
        wl, bw = wavelength_at(hdul, 269.4463, 4.7677)
    assert abs(wl - 4.551) < 0.01
    assert bw > 0


def test_wavelength_off_crop_is_finite():
    # About 4 arcmin from the centre, well outside the 29 x 29 pixel crop.
    with fits.open(CROP) as hdul:
        wl, bw = wavelength_at(hdul, 269.38477, 4.78019)
    assert np.isfinite(wl) and np.isfinite(bw)
