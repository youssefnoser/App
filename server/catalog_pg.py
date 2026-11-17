"""The exposure snapshot read from PostgreSQL, for deployments that cannot ship
data/exposures.sqlite: it is 804 MB, Vercel's Python bundle limit is 500 MB, and
the dependencies already take 243 MB of it.

The database holds the same `exposures` and `meta` tables as server/catalog.py,
filled from the same snapshot. Its user is read-only and cannot add indexes, so a
lookup is one query whose cone test (footprint centre within its own radius of
the point, as in Catalog.find) runs on the database as a scan of 1.6 million
rows: about 150 ms once the table is cached, several seconds when it is not.
The exact footprint test then runs here. The snapshot never changes under a
deployment, so answers are cached per point. NaN never appears: rows hold no
pixels.

Chosen by server.catalog.catalog() when SPHEREX_CATALOG_URL is set.
"""

import json
import logging
import threading
from collections import OrderedDict

from server.irsa import Exposure
from server.patches import cell_unit_vectors, footprint_contains

log = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 10
STATEMENT_TIMEOUT_MS = 20_000
MAX_CACHED_POINTS = 512

FIND_SQL = (
    "SELECT uri, mjd, detector, obs_id, footprint FROM exposures"
    " WHERE cx * %s + cy * %s + cz * %s >= cos(radians(radius_deg))"
)
META_SQL = "SELECT value FROM meta WHERE key = %s"
COUNT_SQL = "SELECT coalesce(max(id), 0) FROM exposures"


def _connect(url: str):
    import psycopg

    return psycopg.connect(
        url, autocommit=True, connect_timeout=CONNECT_TIMEOUT_S,
        options=f"-c statement_timeout={STATEMENT_TIMEOUT_MS}")


class PgCatalog:
    """Same answers as server.catalog.Catalog (find, complete, status), from
    PostgreSQL. One connection per process, opened on first use; a failed query
    closes it, and the next call opens a new one. No retry within a call."""

    def __init__(self, url: str, connect=_connect):
        self.url = url
        self._connect = connect
        self._conn = None
        self._lock = threading.Lock()
        self._complete: bool | None = None
        self._found: OrderedDict[tuple[float, float], list[Exposure]] = OrderedDict()

    def _query(self, sql: str, params=None) -> list[tuple]:
        """Rows of one query. On a database error the connection is dropped and
        the error raised."""
        with self._lock:
            try:
                if self._conn is None or self._conn.closed:
                    self._conn = self._connect(self.url)
                return self._conn.execute(sql, params).fetchall()
            except Exception:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    except Exception:
                        pass
                self._conn = None
                raise

    def _meta(self, key: str) -> str | None:
        rows = self._query(META_SQL, (key,))
        return rows[0][0] if rows else None

    @property
    def complete(self) -> bool:
        """Whether the snapshot lists every exposure. False when the database
        cannot be reached (callers then ask IRSA)."""
        if self._complete is None:
            try:
                self._complete = self._meta("complete") == "1"
            except Exception:
                log.exception("The exposure database did not answer (meta.complete).")
                return False
        return self._complete

    def find(self, ra: float, dec: float) -> list[Exposure] | None:
        """Exposures whose footprint contains (ra, dec), sorted by mjd. None
        when the database cannot be reached; the error is logged."""
        key = (ra, dec)
        with self._lock:
            hit = self._found.get(key)
            if hit is not None:
                self._found.move_to_end(key)
                return hit
        point = cell_unit_vectors([(ra, dec)])[0]
        try:
            rows = self._query(FIND_SQL, [float(v) for v in point])
        except Exception:
            log.exception("The exposure database did not answer (find %s, %s).", ra, dec)
            return None
        out = []
        for uri, mjd, detector, obs_id, footprint in rows:
            corners = tuple(tuple(p) for p in json.loads(footprint))
            if footprint_contains(corners, ra, dec):
                out.append(Exposure(uri, mjd, detector, obs_id, corners))
        out.sort(key=lambda e: e.mjd)
        with self._lock:
            self._found[key] = out
            while len(self._found) > MAX_CACHED_POINTS:
                self._found.popitem(last=False)
        return out

    def status(self) -> dict:
        """What the snapshot holds, for /health; empty when the database cannot
        be reached."""
        try:
            through = self._meta("through_mjd")
            return {
                "complete": self._meta("complete") == "1",
                "through_mjd": float(through) if through else None,
                "exposures": int(self._query(COUNT_SQL)[0][0]),
            }
        except Exception:
            log.exception("The exposure database did not answer (status).")
            return {"complete": False, "through_mjd": None, "exposures": 0}
