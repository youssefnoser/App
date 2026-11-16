"""Local snapshot of the SPHEREx exposure list, so a view does not wait on IRSA TAP.

One SQLite file under cache_dir()/meta/exposures.sqlite holds every exposure's
path, time, detector, obs id and footprint corners, filled by
`scripts/data/snapshot_metadata.py`. `data/exposures.sqlite` is a committed copy
of the same snapshot (Git LFS): it is what deployments read, since they cannot
fill a snapshot themselves; see `db_path()` for which file wins. A lookup keeps
the footprint centres in memory as unit vectors, picks the exposures whose
centre is within their own radius of the point, then runs the exact footprint
test (`patches.footprint_contains`), the same rule the view route uses. NaN
never appears here: rows hold no pixels.
"""

import json
import os
import sqlite3
import threading
from pathlib import Path

import numpy as np

from server.cutouts import cache_dir
from server.irsa import Exposure
from server.patches import cell_unit_vectors, footprint_contains

RADIUS_MARGIN_DEG = 0.01

# The committed copy of the snapshot (Git LFS). Deployments have no .cache to
# fill, so this is what they read, and it is read-only there (Vercel bundle).
REPO_DB = Path(__file__).resolve().parent.parent / "data" / "exposures.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS exposures (
    id INTEGER PRIMARY KEY,
    uri TEXT UNIQUE NOT NULL,
    mjd REAL NOT NULL,
    detector INTEGER NOT NULL,
    obs_id TEXT NOT NULL,
    footprint TEXT NOT NULL,
    cx REAL NOT NULL, cy REAL NOT NULL, cz REAL NOT NULL,
    radius_deg REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS windows (
    start REAL PRIMARY KEY, stop REAL NOT NULL, row_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def db_path() -> Path:
    """Which snapshot a Catalog reads, in order: SPHEREX_CATALOG_DB, the runtime
    snapshot under cache_dir()/meta (what the fill scripts write, and the
    freshest one on a dev machine), the committed copy data/exposures.sqlite
    (what deployments and fresh clones have), and back to the runtime path when
    nothing is on disk yet, so the fill scripts have somewhere to write."""
    env = os.environ.get("SPHEREX_CATALOG_DB")
    if env:
        return Path(env)
    runtime = cache_dir() / "meta" / "exposures.sqlite"
    if runtime.exists():
        return runtime
    if REPO_DB.exists():
        return REPO_DB
    return runtime


def open_db(path: Path | None = None) -> sqlite3.Connection:
    """Open (and create if needed) the snapshot database. Writers (the fill
    scripts and tests) get the runtime snapshot under cache_dir(); the
    committed copy data/exposures.sqlite is only ever read."""
    path = path if path is not None else cache_dir() / "meta" / "exposures.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.executescript(SCHEMA)
    return conn


def _centre_and_radius(footprint) -> tuple[np.ndarray, float]:
    corners = cell_unit_vectors(footprint)
    centre = corners.sum(axis=0)
    centre /= np.linalg.norm(centre)
    radius = float(np.degrees(np.arccos(np.clip(corners @ centre, -1.0, 1.0)).max()))
    return centre, radius + RADIUS_MARGIN_DEG


def add_exposures(conn: sqlite3.Connection, exposures) -> int:
    """Insert or replace exposures. Rows with fewer than 3 corners are skipped.

    Returns the number of rows written. Does not commit.
    """
    rows = []
    for e in exposures:
        if len(e.footprint) < 3:
            continue
        centre, radius = _centre_and_radius(e.footprint)
        rows.append((e.uri, e.mjd, e.detector, e.obs_id, json.dumps(e.footprint),
                     float(centre[0]), float(centre[1]), float(centre[2]), radius))
    conn.executemany(
        "INSERT INTO exposures (uri, mjd, detector, obs_id, footprint, cx, cy, cz, radius_deg)"
        " VALUES (?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(uri) DO UPDATE SET mjd=excluded.mjd, detector=excluded.detector,"
        " obs_id=excluded.obs_id, footprint=excluded.footprint, cx=excluded.cx,"
        " cy=excluded.cy, cz=excluded.cz, radius_deg=excluded.radius_deg",
        rows,
    )
    return len(rows)


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)"
                 " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


class Catalog:
    """In-memory index over the snapshot. Reloads when the file changes."""

    def __init__(self, path: Path | None = None):
        self.path = path if path is not None else db_path()
        self._lock = threading.Lock()
        self._stamp = None
        self._ids = np.zeros(0, dtype=np.int64)
        self._centres = np.zeros((0, 3))
        self._cos_radius = np.zeros(0)
        self.complete = False

    def _connect(self, timeout_s: float = 30) -> sqlite3.Connection:
        """Open the snapshot for reading. The committed copy (data/
        exposures.sqlite) is opened immutable: a deployment bundle is read-only,
        and SQLite in WAL mode wants to create -shm/-wal next to the file, which
        fails there. immutable needs no side files and no locks; the file never
        changes during a deployment. The runtime snapshot can change while the
        server runs, so it keeps its normal (reloadable) connection.
        """
        if self.path == REPO_DB:
            return sqlite3.connect(
                f"file:{self.path}?mode=ro&immutable=1", uri=True, timeout=timeout_s)
        return sqlite3.connect(self.path, timeout=timeout_s)

    def _load(self) -> bool:
        try:
            stat = self.path.stat()
        except OSError:
            return False
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp == self._stamp:
            return True
        conn = self._connect()
        try:
            data = conn.execute("SELECT id, cx, cy, cz, radius_deg FROM exposures").fetchall()
            self.complete = get_meta(conn, "complete") == "1"
        except sqlite3.Error:
            return False
        finally:
            conn.close()
        table = np.array(data, dtype=np.float64).reshape(-1, 5)
        self._ids = table[:, 0].astype(np.int64)
        self._centres = table[:, 1:4]
        self._cos_radius = np.cos(np.radians(table[:, 4]))
        self._stamp = stamp
        return True

    def status(self) -> dict:
        """What the snapshot holds, for /health: whether it is complete, the date
        (MJD) it was filled up to, and how many exposures it lists. With no
        snapshot, or one locked by a writer for over a second: not complete, no
        date, no exposures.

        Reads the meta table and a row count only. It neither reloads the lookup
        index nor takes the lookup lock, so a health probe while the snapshot is
        being filled cannot stall /api/view.
        """
        empty = {"complete": False, "through_mjd": None, "exposures": 0}
        if not self.path.exists():
            return empty
        try:
            conn = self._connect(timeout_s=1)
        except sqlite3.Error:
            return empty
        try:
            through = get_meta(conn, "through_mjd")
            return {
                "complete": get_meta(conn, "complete") == "1",
                "through_mjd": float(through) if through else None,
                # max(id) equals the row count, since rows are only ever added or
                # updated in place, and it is one index lookup where count(*)
                # reads the whole table (2 s on the 1.6 million row snapshot).
                "exposures": int(conn.execute(
                    "SELECT coalesce(max(id), 0) FROM exposures").fetchone()[0]),
            }
        except (sqlite3.Error, ValueError):
            return empty
        finally:
            conn.close()

    def find(self, ra: float, dec: float) -> list[Exposure] | None:
        """Exposures whose footprint contains (ra, dec), sorted by mjd.

        Returns None when there is no snapshot. An empty list means the snapshot
        has nothing there; trust that only when `complete` is True.
        """
        with self._lock:
            if not self._load():
                return None
            point = cell_unit_vectors([(ra, dec)])[0]
            near = self._ids[self._centres @ point >= self._cos_radius]
        if near.size == 0:
            return []
        conn = self._connect()
        try:
            found = []
            ids = [int(i) for i in near]
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                marks = ",".join("?" * len(chunk))
                found += conn.execute(
                    "SELECT uri, mjd, detector, obs_id, footprint FROM exposures"
                    f" WHERE id IN ({marks})", chunk).fetchall()
        finally:
            conn.close()
        out = []
        for uri, mjd, detector, obs_id, footprint in found:
            corners = tuple(tuple(p) for p in json.loads(footprint))
            if footprint_contains(corners, ra, dec):
                out.append(Exposure(uri, mjd, detector, obs_id, corners))
        out.sort(key=lambda e: e.mjd)
        return out


_catalogs: dict[Path, Catalog] = {}


def catalog() -> Catalog:
    """The shared Catalog for the current cache directory."""
    path = db_path()
    if path not in _catalogs:
        _catalogs[path] = Catalog(path)
    return _catalogs[path]
