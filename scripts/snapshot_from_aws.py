"""Build the local exposure snapshot from the AWS mirror alone, without IRSA.

Network: the public bucket `nasa-irsa-spherex` only. Usage:

    uv run python scripts/snapshot_from_aws.py [--releases dr1 qr3] [--threads 48]
                                               [--processes 3] [--limit N]

Step 1 lists every Level-2 file of the releases (DR1 and QR3 together are the
current uniform set; QR2 is superseded). Step 2 reads the first 28,800 bytes of
each file not yet in the database and stores the exposure's time, detector, obs
id and footprint (`server/footprint.py`). Re-running skips what is stored, so it
can be stopped and resumed. `--targets` limits the work to pointings near the
five challenge targets: one file per pointing is read to learn where it points,
then every detector of the pointings within 12 degrees of a target. A file whose header cannot be read is logged and
retried on the next run; the snapshot is marked complete only when none failed.
"""

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool

import httpx
from astropy.time import Time

from server import catalog
from server.footprint import HEAD_BYTES, URI_PREFIX, HeaderError, exposure_from_head
from server.http import tls_verify
from server.mirror import MIRROR_BASE

CHUNK = 600
_client: httpx.Client | None = None
_threads = 48


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def client() -> httpx.Client:
    global _client
    if _client is None:
        limits = httpx.Limits(max_connections=_threads, max_keepalive_connections=_threads)
        _client = httpx.Client(timeout=60.0, verify=tls_verify(), limits=limits)
    return _client


def list_prefix(prefix: str) -> list[str]:
    """Every .fits key under a bucket prefix."""
    keys, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        response = client().get(MIRROR_BASE + "/", params=params)
        response.raise_for_status()
        keys += [k for k in re.findall(r"<Key>([^<]+)</Key>", response.text) if k.endswith(".fits")]
        more = re.search(r"<NextContinuationToken>([^<]+)<", response.text)
        if not more:
            return keys
        token = more.group(1)


def week_prefixes(release: str) -> list[str]:
    response = client().get(MIRROR_BASE + "/", params={
        "list-type": "2", "delimiter": "/", "prefix": f"{release}/level2/"})
    response.raise_for_status()
    return re.findall(r"<Prefix>([^<]+/level2/[^<]+)</Prefix>", response.text)


def read_one(key: str):
    """(key, Exposure or None, problem or None). One retry on a network error."""
    for attempt in (0, 1):
        try:
            response = client().get(f"{MIRROR_BASE}/{key}",
                                    headers={"Range": f"bytes=0-{HEAD_BYTES - 1}"})
            response.raise_for_status()
            return key, exposure_from_head(key, response.content), None
        except HeaderError as exc:
            return key, None, str(exc)
        except httpx.HTTPError as exc:
            if attempt:
                return key, None, repr(exc)


def read_chunk(args):
    keys, threads = args
    global _threads
    _threads = threads
    with ThreadPoolExecutor(threads) as pool:
        return list(pool.map(read_one, keys))


OBS_RE = re.compile(r"level2_(.+)D([1-6])_spx_")
NEAR_DEG = 12.0  # the six detectors of one pointing lie within about 10 deg of each other


def read_all(conn, todo: list[str], args) -> int:
    """Read and store the headers of `todo`. Returns how many could not be read."""
    chunks = [(todo[i:i + CHUNK], args.threads) for i in range(0, len(todo), CHUNK)]
    done = failed = 0
    started = time.time()
    with Pool(args.processes) as pool:
        for n, results in enumerate(pool.imap_unordered(read_chunk, chunks), 1):
            good = [e for _, e, _ in results if e is not None]
            catalog.add_exposures(conn, good)
            conn.commit()
            done += len(good)
            for key, exposure, problem in results:
                if exposure is None:
                    failed += 1
                    if failed <= 50:
                        log(f"  skipped {key}: {problem}")
            if n % 20 == 0 or n == len(chunks):
                rate = (done + failed) / max(time.time() - started, 1e-9)
                left = (len(todo) - done - failed) / max(rate, 1e-9)
                log(f"{done} stored, {failed} skipped, {rate:.0f} files/s, about {left / 60:.0f} min left")
    return failed


def near_targets(conn, keys: list[str], args) -> tuple[list[str], int]:
    """Keys of every pointing that could cover a challenge target, and read failures.

    Reads one file per pointing first (a sixth of the archive), keeps the pointings
    whose footprint centre is within NEAR_DEG of a target, and returns all files of
    those pointings that are not stored yet.
    """
    import numpy as np

    from server.patches import cell_unit_vectors
    from server.targets import TARGETS, propagate

    by_obs: dict[str, list[str]] = {}
    for key in keys:
        match = OBS_RE.search(key)
        if match:
            by_obs.setdefault(key.rsplit("/", 2)[0] + "|" + match.group(1), []).append(key)
    stored = {row[0] for row in conn.execute("SELECT uri FROM exposures")}
    probes = [files[0] for files in by_obs.values()
              if not any(URI_PREFIX + k in stored for k in files)]
    log(f"{len(by_obs)} pointings, reading one file for {len(probes)} of them")
    failed = read_all(conn, probes, args)

    now = float(Time.now().mjd)
    targets = cell_unit_vectors([propagate(t, now) for t in TARGETS.values()])
    rows = conn.execute("SELECT uri, cx, cy, cz FROM exposures").fetchall()
    centres = np.array([r[1:] for r in rows], dtype=float).reshape(-1, 3)
    close = (centres @ targets.T >= np.cos(np.radians(NEAR_DEG))).any(axis=1)
    wanted_obs = set()
    for (uri, *_), hit in zip(rows, close):
        match = OBS_RE.search(uri)
        if hit and match:
            key = uri[len(URI_PREFIX):]
            wanted_obs.add(key.rsplit("/", 2)[0] + "|" + match.group(1))
    stored = {r[0] for r in rows}
    todo = [k for obs in wanted_obs for k in by_obs.get(obs, []) if URI_PREFIX + k not in stored]
    log(f"{len(wanted_obs)} pointings lie within {NEAR_DEG:.0f} deg of a target")
    return todo, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--releases", nargs="+", default=["dr1", "qr3"])
    parser.add_argument("--threads", type=int, default=48)
    parser.add_argument("--processes", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0, help="stop after N files (for a trial run)")
    parser.add_argument("--targets", action="store_true",
                        help="only the pointings near the five challenge targets (server/targets.py)")
    args = parser.parse_args()

    conn = catalog.open_db()
    conn.execute("PRAGMA journal_mode=WAL")
    log("listing the bucket")
    weeks = [w for release in args.releases for w in week_prefixes(release)]
    with ThreadPoolExecutor(16) as pool:
        keys = [k for part in pool.map(list_prefix, weeks) for k in part]
    failed = 0
    if args.targets:
        todo, failed = near_targets(conn, keys, args)
    else:
        stored = {row[0] for row in conn.execute("SELECT uri FROM exposures")}
        todo = [k for k in keys if URI_PREFIX + k not in stored]
    log(f"{len(keys)} files in {len(weeks)} weeks, {len(todo)} to read")
    if args.limit:
        todo = todo[:args.limit]
    failed += read_all(conn, todo, args)

    total = conn.execute("SELECT COUNT(*) FROM exposures").fetchone()[0]
    whole = not args.limit and not args.targets and failed == 0
    if whole:
        catalog.set_meta(conn, "complete", "1")
        catalog.set_meta(conn, "through_mjd", f"{float(Time.now().mjd):.3f}")
        catalog.set_meta(conn, "source", "aws headers")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    state = "complete" if whole else ("targets only" if args.targets else "NOT complete, run again")
    log(f"{total} exposures in the snapshot ({state}), "
        f"{catalog.db_path().stat().st_size / 1e6:.0f} MB")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
