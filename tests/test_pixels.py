"""Offline tests for the science image (IMAGE - ZODI) and bad-pixel mask."""

from pathlib import Path

import numpy as np
from astropy.io import fits

from server.pixels import BAD_PIXEL_MASK, science_image

CROP = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"

BAD_BITS = [0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29]


def make_hdul(flag: int = 0, shape=(4, 4)) -> fits.HDUList:
    return fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(np.full(shape, 5.0, dtype=np.float32), name="IMAGE"),
            fits.ImageHDU(np.full(shape, flag, dtype=np.int32), name="FLAGS"),
            fits.ImageHDU(np.full(shape, 2.0, dtype=np.float32), name="ZODI"),
        ]
    )


def test_bad_pixel_mask_bits():
    expected = sum(1 << b for b in BAD_BITS)
    assert BAD_PIXEL_MASK == expected
    for absent in (1, 19, 21):
        assert BAD_PIXEL_MASK & (1 << absent) == 0


def test_science_image_subtracts_zodi():
    out = science_image(make_hdul(0))
    assert out.dtype == np.float32
    assert np.all(out == 3.0)


def test_mask_only_bad_bits():
    bloom = science_image(make_hdul(1 << 26), mask=True)
    assert np.isnan(bloom).all()
    source = science_image(make_hdul(1 << 21), mask=True)
    assert np.isfinite(source).all()
    assert np.isfinite(science_image(make_hdul(1 << 26), mask=False)).all()
    assert np.isfinite(science_image(make_hdul(1 << 21), mask=False)).all()


def test_real_crop_mask_count():
    with fits.open(CROP) as hdul:
        assert np.isnan(science_image(hdul, mask=True)).sum() == 29
        assert np.isnan(science_image(hdul, mask=False)).sum() == 0
