"""PgCatalog: the exposure snapshot read from PostgreSQL (server/catalog_pg.py).

No database here: a fake connection records each query and answers with fixed
rows, so these tests check what PgCatalog asks for and what it does with the
answer, never the network.
"""

import json
import logging

import numpy as np
import psycopg
import pytest

from server import catalog as cat
from server import catalog_pg
from server.catalog_pg import PgCatalog

# A 1 x 1 degree footprint around (10, 20) and one around (50, 20).
NEAR = [[9.5, 19.5], [10.5, 19.5], [10.5, 20.5], [9.5, 20.5]]
FAR = [[49.5, 19.5], [50.5, 19.5], [50.5, 20.5], [49.5, 20.5]]


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConn:
    """Answers `exposures` queries with `rows` and `meta` queries with `meta`."""

    def __init__(self, rows=(), meta=None, max_id=0, fail=False):
        self.rows, self.meta, self.max_id, self.fail = rows, meta or {}, max_id, fail
        self.queries = []
        self.closed = False

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        if self.fail:
            raise psycopg.OperationalError("server closed the connection")
        if "FROM meta" in sql:
            return FakeCursor([(self.meta[params[0]],)] if params[0] in self.meta else [])
        if "max(id)" in sql:
            return FakeCursor([(self.max_id,)])
        return FakeCursor(self.rows)

    def close(self):
        self.closed = True


def row(uri, mjd, footprint):
    return (uri, mjd, 2, f"obs-{uri}", json.dumps(footprint))


def make(conn_or_list):
    """A PgCatalog whose connect() hands out the given fake connection(s) in turn."""
    conns = conn_or_list if isinstance(conn_or_list, list) else [conn_or_list]
    handed = []

    def connect(url):
        handed.append(url)
        return conns[len(handed) - 1]

    return PgCatalog("postgresql://example/db", connect=connect), handed


def test_find_filters_by_cone_in_sql_then_by_footprint_and_sorts_by_mjd():
    conn = FakeConn(rows=[row("b", 61000.5, NEAR), row("far", 60990.0, FAR),
                          row("a", 60900.0, NEAR)])
    catalog, _ = make(conn)
    found = catalog.find(10.0, 20.0)
    assert [e.uri for e in found] == ["a", "b"]  # "far" fails the exact footprint test
    assert found[0].detector == 2 and found[0].obs_id == "obs-a"
    assert found[0].footprint == tuple(tuple(p) for p in NEAR)
    sql, params = conn.queries[0]
    assert "cos(radians(radius_deg))" in sql
    # The point's unit vector, so the database keeps footprints whose centre is
    # within their own radius of it: the same cone test as Catalog.find.
    expected = [np.cos(np.radians(20)) * np.cos(np.radians(10)),
                np.cos(np.radians(20)) * np.sin(np.radians(10)), np.sin(np.radians(20))]
    assert np.allclose(params, expected)


def test_find_is_cached_per_point():
    conn = FakeConn(rows=[row("a", 60900.0, NEAR)])
    catalog, _ = make(conn)
    assert catalog.find(10.0, 20.0) == catalog.find(10.0, 20.0)
    assert len(conn.queries) == 1


def test_find_logs_and_returns_none_when_the_database_fails_then_reconnects(caplog):
    broken = FakeConn(fail=True)
    good = FakeConn(rows=[row("a", 60900.0, NEAR)])
    catalog, handed = make([broken, good])
    with caplog.at_level(logging.ERROR, logger=catalog_pg.__name__):
        assert catalog.find(10.0, 20.0) is None
    assert "exposure database" in caplog.text
    assert broken.closed
    assert [e.uri for e in catalog.find(10.0, 20.0)] == ["a"]
    assert len(handed) == 2


def test_complete_comes_from_the_meta_table():
    catalog, _ = make(FakeConn(meta={"complete": "1"}))
    assert catalog.complete is True
    catalog, _ = make(FakeConn(meta={}))
    assert catalog.complete is False


def test_complete_is_false_when_the_database_fails():
    catalog, _ = make([FakeConn(fail=True)])
    assert catalog.complete is False


def test_status_reports_meta_and_row_count():
    conn = FakeConn(meta={"complete": "1", "through_mjd": "61357.993"}, max_id=1628230)
    catalog, _ = make(conn)
    assert catalog.status() == {"complete": True, "through_mjd": 61357.993,
                                "exposures": 1628230}


def test_status_is_empty_when_the_database_fails():
    catalog, _ = make([FakeConn(fail=True)])
    assert catalog.status() == {"complete": False, "through_mjd": None, "exposures": 0}


def test_catalog_uses_postgres_when_the_url_is_set(monkeypatch):
    monkeypatch.setenv("SPHEREX_CATALOG_URL", "postgresql://example/db")
    monkeypatch.setattr(cat, "_pg_catalog", None)
    chosen = cat.catalog()
    assert isinstance(chosen, PgCatalog)
    assert cat.catalog() is chosen


def test_catalog_uses_sqlite_without_the_url():
    assert isinstance(cat.catalog(), cat.Catalog)
