"""Size cap and expiry for the rendered caches under cache_dir().

The folders this module owns are `png/` (rendered frames and their metadata),
`grids/` (resampled float grids), `cutouts/` (IRSA cutouts) and `tap/` (cell
exposure lists fetched from IRSA). Together they are held under
`cap_bytes()` (SPHEREX_RENDER_CACHE_GB, default 10) by deleting the least
recently used files first. A cache hit calls `touch`, so "used" means read or
written, not only written.

`exposures/` (whole files, capped by server/mirror.py) and `meta/` (the
exposure snapshot) are never touched here.

A prune also deletes cell lists older than their reuse age and `.tmp` files
left behind by a writer that died. Readers already treat a missing file as a
miss and render again, so deleting under a live server is safe.
"""

import math
import os
import threading
import time
from pathlib import Path

DEFAULT_CAP_GB = 10.0
FOLDERS = ("png", "grids", "cutouts", "tap")
# A prune walks every file, so it runs after PRUNE_EVERY writes and never more
# often than PRUNE_MIN_INTERVAL_S: a few seconds of disk reads per ten minutes
# at most, even with millions of small frames.
PRUNE_EVERY = 500
PRUNE_MIN_INTERVAL_S = 600.0
TMP_MAX_AGE_S = 3600.0
# A cell's exposure list fetched from IRSA is reused for a day (server/app.py).
TAP_MAX_AGE_S = 86400.0

_writes = 0
_last_prune = float("-inf")
_guard = threading.Lock()
_running = threading.Lock()


def cap_bytes() -> int:
    """Size limit of the rendered caches: SPHEREX_RENDER_CACHE_GB, default 10.
    A value that is not a finite number falls back to the default."""
    try:
        gb = float(os.environ.get("SPHEREX_RENDER_CACHE_GB", DEFAULT_CAP_GB))
    except ValueError:
        gb = DEFAULT_CAP_GB
    if not math.isfinite(gb):
        gb = DEFAULT_CAP_GB
    return int(max(gb, 0.0) * 1e9)


def touch(path: Path) -> None:
    """Mark a cached file as just used. A file deleted meanwhile is ignored."""
    try:
        os.utime(path)
    except OSError:
        pass


def prune(root: Path, cap_bytes: int, tap_max_age_s: float) -> None:
    """Delete expired files, then least recently used ones until under `cap_bytes`."""
    now = time.time()
    entries = []
    for folder in FOLDERS:
        for dirpath, _, names in os.walk(root / folder):
            for name in names:
                path = Path(dirpath) / name
                try:
                    stat = path.stat()
                except OSError:
                    continue
                age = now - stat.st_mtime
                expired = (name.endswith(".tmp") and age > TMP_MAX_AGE_S) or (
                    folder == "tap" and age > tap_max_age_s)
                if expired:
                    path.unlink(missing_ok=True)
                elif not name.endswith(".tmp"):
                    entries.append((stat.st_mtime, stat.st_size, path))
    total = sum(size for _, size, _ in entries)
    for _, size, path in sorted(entries, key=lambda e: e[0]):
        if total <= cap_bytes:
            break
        path.unlink(missing_ok=True)
        total -= size


def prune_in_background(root: Path, tap_max_age_s: float = TAP_MAX_AGE_S) -> None:
    """Start a prune on a daemon thread unless one is already running. Counts as
    the latest prune for `note_write`, so the startup prune is not followed by
    another one 500 writes later."""
    global _last_prune
    if not _running.acquire(blocking=False):
        return
    with _guard:
        _last_prune = time.monotonic()

    def run():
        try:
            prune(root, cap_bytes(), tap_max_age_s)
        finally:
            _running.release()

    threading.Thread(target=run, name="cache-prune", daemon=True).start()


def note_write(spawn) -> None:
    """Count one cache write; once PRUNE_EVERY writes have piled up and the last
    prune is at least PRUNE_MIN_INTERVAL_S old, call `spawn()` (which starts one)."""
    global _writes, _last_prune
    with _guard:
        _writes += 1
        now = time.monotonic()
        due = _writes >= PRUNE_EVERY and now - _last_prune >= PRUNE_MIN_INTERVAL_S
        if due:
            _writes, _last_prune = 0, now
    if due:
        spawn()
