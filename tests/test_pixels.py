"""Offline tests for the science image (IMAGE - ZODI) and bad-pixel masking."""

from pathlib import Path

import numpy as np
from astropy.io import fits

from server.pixels import (
    BAD_PIXEL_MASK,
    HARD_PIXEL_MASK,
    science_image,
)

CROP = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"

# The IRSA mosaic rule (ES 3.4.3), kept for reference and for the cache.
BAD_BITS = [0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29]
# Bits that make a pixel unusable for display no matter where it sits.
HARD_BITS = [6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 27, 28, 29]

TRANSIENT, OVERFLOW, SUR_ERROR = 1 << 0, 1 << 1, 1 << 2
BLOOM, SOURCE = 1 << 26, 1 << 21


def make_hdul(flag=0, shape=(4, 4), flags=None) -> fits.HDUList:
    if flags is not None:
        flags = np.asarray(flags)
        shape = flags.shape
    else:
        flags = np.full(shape, flag)
    return fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(np.full(shape, 5.0, dtype=np.float32), name="IMAGE"),
            fits.ImageHDU(flags.astype(np.int32), name="FLAGS"),
            fits.ImageHDU(np.full(shape, 2.0, dtype=np.float32), name="ZODI"),
        ]
    )


def test_bad_pixel_mask_bits():
    assert BAD_PIXEL_MASK == sum(1 << b for b in BAD_BITS)
    assert HARD_PIXEL_MASK == sum(1 << b for b in HARD_BITS)
    for absent in (0, 1, 2, 19, 21, 26):
        assert HARD_PIXEL_MASK & (1 << absent) == 0


def test_science_image_subtracts_zodi():
    out = science_image(make_hdul(0))
    assert out.dtype == np.float32
    assert np.all(out == 3.0)


def test_source_and_overflow_are_kept():
    assert np.isfinite(science_image(make_hdul(SOURCE))).all()
    assert np.isfinite(science_image(make_hdul(OVERFLOW))).all()
    assert np.isfinite(science_image(make_hdul(SOURCE | OVERFLOW | BLOOM))).all()


def test_hard_bits_are_masked():
    for bit in HARD_BITS:
        assert np.isnan(science_image(make_hdul(1 << bit))).all(), bit
    # Hard bits win even inside a saturated region.
    flags = np.zeros((4, 4), dtype=np.int64)
    flags[:] = OVERFLOW
    flags[1, 1] = OVERFLOW | (1 << 6)  # NONFUNC
    out = science_image(make_hdul(flags=flags))
    assert np.isnan(out[1, 1]) and np.isfinite(out[0, 0])


def test_bloomed_core_stays_visible():
    """A saturated star core (ES 3.2.1: early transient plus bloom) must not be blanked."""
    core = SOURCE | BLOOM | TRANSIENT | SUR_ERROR
    out = science_image(make_hdul(core))
    assert np.isfinite(out).all()
    assert np.all(out == 3.0)


def test_isolated_transient_is_still_masked():
    """A cosmic ray on blank sky must stay masked, or it blinks as a false mover."""
    assert np.isnan(science_image(make_hdul(TRANSIENT))).all()
    assert np.isnan(science_image(make_hdul(SUR_ERROR))).all()

    flags = np.zeros((5, 5), dtype=np.int64)
    flags[:, :] = SUR_ERROR
    flags[2, 2] = TRANSIENT  # a lone cosmic ray, nothing saturated nearby
    assert np.isnan(science_image(make_hdul(flags=flags))).all()


def test_transient_beside_saturation_is_kept():
    """ES 3.2.1: the ring around a saturating source is flagged TRANSIENT by the bloom
    itself, so it is signal, not a cosmic ray."""
    flags = np.zeros((5, 5), dtype=np.int64)
    flags[2, 2] = OVERFLOW
    flags[1:4, 1:4] = OVERFLOW | TRANSIENT | SUR_ERROR
    flags[2, 2] = OVERFLOW | BLOOM
    out = science_image(make_hdul(flags=flags))
    assert np.isfinite(out).all()


def test_mask_false_shows_everything():
    assert np.isfinite(science_image(make_hdul(TRANSIENT), mask=False)).all()
    assert np.isfinite(science_image(make_hdul(BLOOM), mask=False)).all()


def test_nan_in_image_is_kept():
    hdul = make_hdul(0)
    hdul["IMAGE"].data[1, 1] = np.nan
    assert np.isnan(science_image(hdul)).sum() == 1


def test_real_crop_mask_count():
    with fits.open(CROP) as hdul:
        irsa = np.isnan(science_image(hdul, mask=True)).sum()
        none = np.isnan(science_image(hdul, mask=False)).sum()
        before = int(((np.asarray(hdul["FLAGS"].data, np.int64) & BAD_PIXEL_MASK) != 0).sum())
    assert none == 0
    # The crop is a bright star core: the mosaic rule would empty it.
    assert before == 29
    assert irsa < before / 2
    assert irsa > 0  # some pixels are genuinely unusable
