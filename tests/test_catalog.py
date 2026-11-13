"""Offline tests for the local exposure snapshot."""

from pathlib import Path

import pytest

from server import catalog as cat
from server.irsa import Exposure, parse_tap_csv
from server.patches import footprint_contains

FIXTURES = Path(__file__).parent / "fixtures"
BARNARD = (269.4463, 4.7677)


@pytest.fixture
def exposures():
    return parse_tap_csv((FIXTURES / "tap_barnard_poly.csv").read_text())


@pytest.fixture
def db(tmp_path, monkeypatch, exposures):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    conn = cat.open_db()
    cat.add_exposures(conn, exposures)
    conn.commit()
    conn.close()
    return cat.Catalog()


def test_no_snapshot_is_none(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    assert cat.Catalog().find(*BARNARD) is None


def test_find_matches_the_exact_footprint_rule(db, exposures):
    want = [e for e in exposures if footprint_contains(e.footprint, *BARNARD)]
    got = db.find(*BARNARD)
    assert len(want) > 300
    assert got == sorted(want, key=lambda e: e.mjd)


def test_find_far_away_is_empty(db):
    assert db.find(90.0, -60.0) == []


def test_find_near_a_footprint_edge_agrees(db, exposures):
    # A point 1.5 deg off: only some of the exposures still cover it.
    point = (BARNARD[0] + 1.5, BARNARD[1] + 1.0)
    want = {e.uri for e in exposures if footprint_contains(e.footprint, *point)}
    assert 0 < len(want) < len(exposures)
    assert {e.uri for e in db.find(*point)} == want


def test_adding_twice_does_not_duplicate(tmp_path, monkeypatch, exposures):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    conn = cat.open_db()
    cat.add_exposures(conn, exposures)
    cat.add_exposures(conn, exposures)
    assert conn.execute("SELECT COUNT(*) FROM exposures").fetchone()[0] == len(exposures)


def test_rows_without_a_footprint_are_skipped(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    conn = cat.open_db()
    assert cat.add_exposures(conn, [Exposure("ibe/data/spherex/x.fits", 1.0, 1, "o", ())]) == 0


def test_complete_flag_and_reload(db, exposures):
    assert db.complete is False
    conn = cat.open_db()
    cat.set_meta(conn, "complete", "1")
    conn.commit()
    conn.close()
    db.find(*BARNARD)
    assert db.complete is True


def test_wraps_ra_zero(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    square = ((359.0, -1.0), (1.0, -1.0), (1.0, 1.0), (359.0, 1.0))
    conn = cat.open_db()
    cat.add_exposures(conn, [Exposure("ibe/data/spherex/z.fits", 5.0, 2, "o", square)])
    conn.commit()
    conn.close()
    c = cat.Catalog()
    assert [e.uri for e in c.find(0.2, 0.3)] == ["ibe/data/spherex/z.fits"]
    assert [e.uri for e in c.find(359.7, -0.3)] == ["ibe/data/spherex/z.fits"]
    assert c.find(3.0, 0.0) == []
