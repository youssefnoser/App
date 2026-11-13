"""Offline tests for the five challenge targets and their proper motion."""

import pytest

from server.targets import TARGETS, Target, propagate

KEYS = ["barnards-star", "epsilon-indi-b", "wise-0855", "rw-aurigae", "r-draconis"]


def test_all_five_targets_present():
    assert sorted(TARGETS) == sorted(KEYS)
    for key in KEYS:
        target = TARGETS[key]
        assert 0.0 <= target.ra_deg < 360.0, key
        assert -90.0 <= target.dec_deg <= 90.0, key
        assert target.verified, key


def test_propagate_at_j2000_returns_catalog_position():
    for key in KEYS:
        target = TARGETS[key]
        ra, dec = propagate(target, 51544.5)  # 2000-01-01T12:00 TT
        assert abs(ra - target.ra_deg) < 1e-6, key
        assert abs(dec - target.dec_deg) < 1e-6, key


def test_barnard_at_mjd_61000():
    """The verified 2026 position used by the acceptance run."""
    ra, dec = propagate(TARGETS["barnards-star"], 61000.0)
    assert abs(ra - 269.4463) < 0.001
    assert abs(dec - 4.7677) < 0.001


def test_barnard_moves_north_nearly_ten_arcsec_per_year():
    from astropy.coordinates import SkyCoord
    from astropy import units as u

    a = SkyCoord(*[v * u.deg for v in propagate(TARGETS["barnards-star"], 61000.0)])
    b = SkyCoord(*[v * u.deg for v in propagate(TARGETS["barnards-star"], 61365.25)])
    motion = a.separation(b).arcsec
    assert 10.0 < motion < 11.0
    assert b.dec > a.dec


def test_wise_0855_page_coordinates_are_discovery_epoch():
    """The challenge page gives 08h55m10.831s -7d14m42.53s, which is the 2010 WISE
    position: about 86 arcsec east of where the star was in 2000."""
    from astropy.coordinates import SkyCoord
    from astropy import units as u

    page = SkyCoord(133.7951292 * u.deg, -7.2451472 * u.deg, frame="icrs")
    j2000 = SkyCoord(TARGETS["wise-0855"].ra_deg * u.deg, TARGETS["wise-0855"].dec_deg
                     * u.deg, frame="icrs")
    offset = page.separation(j2000).arcsec
    assert 80.0 < offset < 95.0
    # Still inside a 0.15 degree view, which is why the blink still works.
    assert offset < 0.15 * 3600 / 2


def test_propagate_accepts_float_mjd():
    target = Target("synthetic", 10.0, 20.0, 1000.0, 0.0, "test")
    ra, _ = propagate(target, 51544.5 + 365.25)
    assert ra > 10.0


@pytest.mark.parametrize("key", KEYS)
def test_every_target_reaches_2026(key):
    ra, dec = propagate(TARGETS[key], 61000.0)
    assert abs(ra - TARGETS[key].ra_deg) < 1.0
    assert abs(dec - TARGETS[key].dec_deg) < 1.0
