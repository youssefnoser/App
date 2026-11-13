"""The five challenge test targets, ICRS J2000 with proper motion.

Values from SIMBAD (ICRS, epoch J2000) as reported by `scripts/resolve_targets.py`
on 2026-11-13, which also cross-checks each one against Gaia DR3 (see the
`verified` field: four match a Gaia DR3 source within 0.2 arcsec with proper
motion agreeing to 4.3 mas/yr; WISE 0855 is far too faint for Gaia).

`propagate` is needed because the challenge page publishes a *position*, not a
tracked object: Barnard's Star is 4.5 arcmin from its J2000 place in 2026, and
the WISE 0855 coordinates printed on the page are the discovery-epoch position
(86 arcsec east of J2000). For a 0.15 degree view that changes only the centring,
not the coverage.

The coordinates a user types are still a fixed patch of sky (see docs/SPEC.md),
so proper motion is used only to choose a query centre and to draw the predicted
position, never to move the displayed cutout.
"""

import warnings
from dataclasses import dataclass

from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
from erfa import ErfaWarning

J2000 = Time("J2000", scale="tt")


@dataclass(frozen=True)
class Target:
    name: str
    ra_deg: float  # ICRS, J2000
    dec_deg: float
    pmra_masyr: float  # includes cos(dec)
    pmdec_masyr: float
    verified: str


TARGETS: dict[str, Target] = {
    "barnards-star": Target(
        "Barnard's Star", 269.4520770, 4.6933650, -801.551, 10362.394,
        "Gaia DR3 4472832130942575872, 0.00 arcsec",  # noqa: E501
    ),
    "epsilon-indi-b": Target(
        "Epsilon Indi B", 331.0441466, -56.7828442, 3981.977, -2466.832,
        "Gaia DR3 6412596012146801152, 0.04 arcsec",
    ),
    "wise-0855": Target(
        "WISE 0855", 133.8189082, -7.2470480, -8123.700, 673.200,
        "SIMBAD 2021ApJS..253....7K, no Gaia source (too faint)",
    ),
    "rw-aurigae": Target(
        "RW Aurigae", 76.9565260, 30.4014382, 7.230, -20.330,
        "Gaia DR3 156430817820015232, 0.13 arcsec",
    ),
    "r-draconis": Target(
        "R Draconis", 248.1676108, 66.7549794, -20.643, 6.149,
        "Gaia DR3 1648328016354496384, 0.00 arcsec",
    ),
}


def propagate(target: Target, mjd: float) -> tuple[float, float]:
    """Position (ra, dec) in degrees at the given time, in ICRS."""
    with warnings.catch_warnings():
        # No distance and no radial velocity are used, so ERFA's distance override
        # changes the position by far less than our 3 arcsec pixels.
        warnings.simplefilter("ignore", ErfaWarning)
        moved = SkyCoord(
            target.ra_deg * u.deg,
            target.dec_deg * u.deg,
            pm_ra_cosdec=target.pmra_masyr * u.mas / u.yr,
            pm_dec=target.pmdec_masyr * u.mas / u.yr,
            obstime=J2000,
            frame="icrs",
        ).apply_space_motion(new_obstime=Time(mjd, format="mjd"))
    return float(moved.ra.deg), float(moved.dec.deg)


def position_now(target: Target) -> tuple[float, float]:
    """Position at the current time, for choosing a query centre."""
    return propagate(target, Time.now().mjd)
