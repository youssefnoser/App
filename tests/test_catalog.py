"""Offline tests for the local exposure snapshot."""

import os
import sqlite3
from pathlib import Path

import pytest

from server import catalog as cat
from server.irsa import Exposure, parse_tap_csv
from server.patches import footprint_contains

FIXTURES = Path(__file__).parent / "fixtures"
BARNARD = (269.4463, 4.7677)
# tests/conftest.py already hides the committed copy; this file re-points it at
# its own files.


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


def test_status_reads_only_the_summary(tmp_path, exposures, monkeypatch):
    """/health asks for the status often; it must not reload the exposure index
    (slow while the snapshot is being filled) or wait on the lookup lock."""
    path = tmp_path / "snap.sqlite"
    conn = cat.open_db(path)
    cat.add_exposures(conn, exposures)
    cat.set_meta(conn, "complete", "1")
    cat.set_meta(conn, "through_mjd", "61357.5")
    conn.commit()
    conn.close()
    c = cat.Catalog(path)
    monkeypatch.setattr(c, "_load", lambda: pytest.fail("status must not reload the index"))
    import threading

    got = []
    with c._lock:  # a lookup in progress does not block it
        asker = threading.Thread(target=lambda: got.append(c.status()), daemon=True)
        asker.start()
        asker.join(timeout=5)
    assert got, "status() waited on the lookup lock"
    assert got[0] == {"complete": True, "through_mjd": 61357.5, "exposures": len(exposures)}
    assert cat.Catalog(tmp_path / "none.sqlite").status() == {
        "complete": False, "through_mjd": None, "exposures": 0}


# --- the committed copy (data/exposures.sqlite, Git LFS, read-only deploys) ---


def make_repo_copy(path: Path, exposures) -> None:
    """A filled snapshot in WAL mode, like the real one, with no sidecar files:
    a checkout of the committed copy is just the main file."""
    conn = cat.open_db(path)
    cat.add_exposures(conn, exposures)
    cat.set_meta(conn, "complete", "1")
    conn.commit()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    conn.close()
    for suffix in ("-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)


def test_db_path_falls_back_to_the_committed_copy(tmp_path, monkeypatch, exposures):
    """With no runtime snapshot, a Catalog reads data/exposures.sqlite: that is
    what a deployment (or a fresh clone) has."""
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    monkeypatch.setattr(cat, "REPO_DB", repo)
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    assert cat.db_path() == repo
    c = cat.Catalog()
    assert len(c.find(*BARNARD)) > 300
    assert c.complete is True


def test_runtime_snapshot_beats_the_committed_copy(tmp_path, monkeypatch, exposures):
    """Local development keeps its own (fresher) snapshot; the committed copy is
    for places that cannot fill one."""
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    conn = cat.open_db()
    cat.set_meta(conn, "complete", "1")
    conn.commit()
    conn.close()
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    monkeypatch.setattr(cat, "REPO_DB", repo)
    assert cat.db_path() == tmp_path / "cache" / "meta" / "exposures.sqlite"


def test_catalog_db_env_beats_both(tmp_path, monkeypatch, exposures):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    conn = cat.open_db()
    conn.close()
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    monkeypatch.setattr(cat, "REPO_DB", repo)
    custom = tmp_path / "custom.sqlite"
    make_repo_copy(custom, exposures)
    monkeypatch.setenv("SPHEREX_CATALOG_DB", str(custom))
    assert cat.db_path() == custom
    c = cat.Catalog()
    assert len(c.find(*BARNARD)) > 300
    assert c.complete is True


def test_committed_copy_reads_from_a_read_only_directory(tmp_path, monkeypatch, exposures):
    """On Vercel the function bundle is read-only. The snapshot was written in
    WAL mode, so a lookup must not need to create -shm/-wal next to it, and
    must not try to write anything at all."""
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    monkeypatch.setattr(cat, "REPO_DB", repo)
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    try:
        repo.chmod(0o444)
        repo.parent.chmod(0o555)
        c = cat.Catalog()
        assert len(c.find(*BARNARD)) > 300
        assert c.complete is True
        assert c.status()["exposures"] == len(exposures)
    finally:
        repo.parent.chmod(0o755)
        repo.chmod(0o644)
    assert not list(repo.parent.glob("exposures.sqlite-*"))


def test_read_only_open_matches_the_plain_one(tmp_path, monkeypatch, exposures):
    """The committed copy answers exactly like a writable snapshot would."""
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    monkeypatch.setattr(cat, "REPO_DB", repo)
    runtime = tmp_path / "cache" / "meta" / "exposures.sqlite"
    runtime.parent.mkdir(parents=True)
    make_repo_copy(runtime, exposures)
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    got = cat.Catalog().find(*BARNARD)
    assert got == cat.Catalog(runtime).find(*BARNARD)


def test_open_db_never_writes_the_committed_copy(tmp_path, monkeypatch, exposures):
    """The fill scripts and tests write the runtime snapshot. data/
    exposures.sqlite is committed (Git LFS); it is only ever read."""
    repo = tmp_path / "data" / "exposures.sqlite"
    repo.parent.mkdir()
    make_repo_copy(repo, exposures)
    before = repo.read_bytes()
    monkeypatch.setattr(cat, "REPO_DB", repo)
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    conn = cat.open_db()  # a fill run, with no runtime snapshot yet
    cat.add_exposures(conn, exposures)
    cat.set_meta(conn, "through_mjd", "1.0")
    conn.commit()
    conn.close()
    assert cat.db_path() == tmp_path / "cache" / "meta" / "exposures.sqlite"
    assert repo.read_bytes() == before
    assert cat.Catalog().status() == {
        "complete": False, "through_mjd": 1.0, "exposures": len(exposures)}
    # the committed copy was neither written nor overwritten
    assert cat.Catalog(cat.REPO_DB).status() == {
        "complete": True, "through_mjd": None, "exposures": len(exposures)}