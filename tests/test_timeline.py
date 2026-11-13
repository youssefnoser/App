"""Offline tests for visit grouping and the first batch."""

import csv
from pathlib import Path

from server.irsa import Exposure
from server.timeline import first_batch, group_visits

FIXTURE = Path(__file__).parent / "fixtures" / "tap_barnard.csv"


def fixture_exposures() -> list[Exposure]:
    """Build Exposures from the TAP csv fixture.

    The fixture has only uri, time_bounds_lower and energy_bandpassname, so
    the helper fills obs_id with "" and leaves the footprint empty.
    """
    rows = csv.DictReader(FIXTURE.read_text().splitlines())
    exposures = [
        Exposure(
            uri=row["uri"],
            mjd=float(row["time_bounds_lower"]),
            detector=int(row["energy_bandpassname"].split("-D")[-1]),
            obs_id="",
            footprint=(),
        )
        for row in rows
    ]
    exposures.sort(key=lambda e: e.mjd)
    return exposures


def test_three_visits():
    exposures = fixture_exposures()
    visits = group_visits(exposures)
    assert len(visits) == 3
    assert [len(v) for v in visits] == [118, 121, 119]
    # The first visit spans MJD 60902 to 60950.
    assert visits[0][0].mjd > 60902
    assert visits[0][0].mjd < 60903
    assert visits[0][-1].mjd > 60949
    assert visits[0][-1].mjd < 60950


def test_first_batch_18():
    exposures = fixture_exposures()
    batch = first_batch(exposures)
    assert len(batch) == 18  # one per (visit, detector): 3 visits x 6 detectors
    uris = {e.uri for e in exposures}
    assert batch <= uris


def test_first_batch_nearest_mid():
    def exposure(uri: str, mjd: float) -> Exposure:
        return Exposure(uri=uri, mjd=mjd, detector=6, obs_id="", footprint=())

    # Midpoint of the visit is (100 + 140) / 2 = 120; 110 is nearest.
    exposures = [exposure("a", 100.0), exposure("b", 110.0), exposure("c", 140.0)]
    assert first_batch(exposures) == {"b"}


def test_empty():
    assert group_visits([]) == []
    assert first_batch([]) == set()
