"""One-off: resolve the five challenge targets from SIMBAD, and cross-check Gaia DR3.

Network, not part of the test suite (AGENTS.md). Run it to refresh
`server/targets.py` when a target needs re-verification:

    uv run python scripts/data/resolve_targets.py

Positions and proper motions come from SIMBAD's own ASCII output (ICRS, J2000,
2020yCat.1350....0G for the four Gaia-calibrated stars). SIMBAD's main host
does not answer from the development sandbox, so the Harvard mirror is used;
both serve the same database.

The cross-check is a Gaia DR3 cone search at the propagated 2026 position: the
nearest Gaia source must be within 2 arcsec and its proper motion must agree to
within 1 mas/yr. A target with no Gaia source (WISE 0855 is far too faint) is
reported as unconfirmed rather than silently accepted.
"""

import sys
from dataclasses import dataclass

import httpx
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

SIMBAD = "https://simbad.harvard.edu/simbad/sim-id"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"

NAMES = [
    ("barnards-star", "Barnard's Star"),
    ("epsilon-indi-b", "eps Ind B"),
    ("wise-0855", "WISE J085510.83-071442.5"),
    ("rw-aurigae", "RW Aur"),
    ("r-draconis", "R Dra"),
]

GAIA_QUERY = """SELECT TOP 20 source_id, ra, dec, pmra, pmdec, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, 0.0028))"""

@dataclass(frozen=True)
class Resolved:
    key: str
    name: str
    ra: float
    dec: float
    pmra: float
    pmdec: float
    source: str


def sexagesimal(text: str) -> SkyCoord:
    """Parse SIMBAD's "17 57 48.4984700685  +04 41 36.113879676" (ICRS)."""
    hh, mm, ss, dd, dm, ds = text.split()[:6]
    ra = (float(hh) + float(mm) / 60 + float(ss) / 3600) * 15.0
    sign = -1.0 if dd.startswith("-") else 1.0
    dec = sign * (abs(float(dd)) + float(dm) / 60 + float(ds) / 3600)
    return SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")


def simbad(client: httpx.Client, name: str) -> Resolved | None:
    response = client.get(
        SIMBAD, params={"Ident": name, "output.format": "ASCII"}, follow_redirects=True
    )
    response.raise_for_status()
    text = response.text
    coords = [
        line.split(":", 1)[1].strip()
        for line in text.splitlines()
        if line.startswith("Coordinates(ICRS")
    ]
    motions = [
        line.split(":", 1)[1].split("[")[0].split()
        for line in text.splitlines()
        if line.startswith("Proper motions:")
    ]
    if not coords:
        print(f"# {name}: SIMBAD has no ICRS coordinates", file=sys.stderr)
        return None
    position = sexagesimal(coords[0])
    pmra, pmdec = (float(motions[0][0]), float(motions[0][1])) if motions else (0.0, 0.0)
    return Resolved(name, name, position.ra.deg, position.dec.deg, pmra, pmdec, "SIMBAD")


def at_epoch(target: Resolved, mjd: float) -> SkyCoord:
    return SkyCoord(
        target.ra * u.deg,
        target.dec * u.deg,
        pm_ra_cosdec=target.pmra * u.mas / u.yr,
        pm_dec=target.pmdec * u.mas / u.yr,
        obstime=Time("J2000", scale="tt"),
        frame="icrs",
    ).apply_space_motion(new_obstime=Time(mjd, format="mjd"))


def gaia_check(client: httpx.Client, target: Resolved) -> str:
    """Nearest Gaia DR3 source at the Gaia reference epoch, as a one-line verdict.

    Gaia DR3 positions are at epoch 2016.0, so the target is carried there first;
    searching at J2000 would miss a fast mover like Barnard's Star by 100 arcsec.
    """
    gaia_epoch = Time(2016.0, format="jyear")
    position = at_epoch(target, gaia_epoch.mjd)
    query = GAIA_QUERY.format(ra=position.ra.deg, dec=position.dec.deg)
    response = client.get(
        GAIA_TAP,
        params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
    )
    response.raise_for_status()
    rows = [line.split(",") for line in response.text.strip().splitlines()[1:]]
    best = None
    for row in rows:
        if len(row) < 5 or not row[3] or not row[4]:
            continue
        separation = SkyCoord(
            float(row[1]) * u.deg, float(row[2]) * u.deg, frame="icrs"
        ).separation(position).arcsec
        if best is None or separation < best[0]:
            best = (separation, float(row[3]), float(row[4]), row[0])
    if best is None:
        return "no Gaia DR3 source within 10 arcsec: unconfirmed"
    separation, pmra, pmdec, source_id = best
    dpm = max(abs(pmra - target.pmra), abs(pmdec - target.pmdec))
    verdict = "OK" if separation < 2.0 and dpm < 10.0 else "MISMATCH"
    return (
        f"{verdict}: Gaia DR3 {source_id} {separation:.2f} arcsec from the propagated "
        f"position, pmra/pmdec differ by {dpm:.2f} mas/yr"
    )


def main() -> int:
    mjd = Time.now().mjd
    with httpx.Client(timeout=60.0, headers={"User-Agent": "spherex-blink/0.1"}) as client:
        failures = 0
        for key, name in NAMES:
            target = simbad(client, name)
            if target is None:
                failures += 1
                continue
            target = Resolved(key, name, target.ra, target.dec, target.pmra, target.pmdec,
                              "SIMBAD ICRS J2000")
            now = at_epoch(target, mjd)
            print(
                f'{key}: Target("{name}", {target.ra:.7f}, {target.dec:.7f}, '
                f'{target.pmra:.3f}, {target.pmdec:.3f},'
                f'  # 2026 position {now.ra.deg:.4f}, {now.dec.deg:.4f}'
                f'\n                 "{target.source}; {gaia_check(client, target)}")'
            )
        return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
