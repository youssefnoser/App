"""Copy the SPHEREx exposure list from IRSA TAP into the local snapshot database.

Network: IRSA TAP only. Usage:

    uv run python scripts/snapshot_metadata.py [--days 30] [--jobs 4] [--poll 10]

The table is pulled in time windows (default 30 days of `time_bounds_lower`) as
queued TAP jobs, at most `--jobs` at once. IRSA's job queue can be slow and its
proxy sometimes answers 502, so every request is simply tried again after
`--poll` seconds until it answers. Finished windows and running job addresses are
stored in the database, so stopping and re-running picks up where it left off.
When every window up to today is stored, the snapshot is marked complete and
`server/catalog.py` trusts an empty answer from it.

Re-run after a new data release with `--refresh` to pull every window again.
"""

import argparse
import sys
import time

import httpx
from astropy.time import Time

from server import catalog
from server.http import make_client
from server.irsa import parse_tap_csv

ASYNC_URL = "https://irsa.ipac.caltech.edu/TAP/async"
FIRST_MJD = 60790.0  # late April 2025, before the first survey exposures
MAXREC = 10_000_000
QUERY = """SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname, p.obs_publisher_did, p.poly
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE p.time_bounds_lower >= {lo} AND p.time_bounds_lower < {hi}"""


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def ask(client: httpx.Client, method: str, url: str, poll: float, **kwargs) -> httpx.Response:
    """One request, tried again every `poll` seconds until IRSA answers below 500."""
    while True:
        try:
            response = client.request(method, url, **kwargs)
            if response.status_code < 500:
                return response
            problem = f"HTTP {response.status_code}"
        except httpx.HTTPError as exc:
            problem = type(exc).__name__
        log(f"  {method} {url.rsplit('/TAP/', 1)[-1]}: {problem}, trying again")
        time.sleep(poll)


def submit(client: httpx.Client, lo: float, hi: float, poll: float) -> str:
    response = ask(client, "POST", ASYNC_URL, poll, data={
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "PHASE": "RUN",
        "MAXREC": str(MAXREC), "QUERY": QUERY.format(lo=lo, hi=hi),
    })
    location = response.headers.get("location")
    if response.status_code != 303 or not location:
        raise SystemExit(f"IRSA refused the job: HTTP {response.status_code} {response.text[:200]}")
    return location


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--days", type=float, default=30.0)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--poll", type=float, default=10.0)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    conn = catalog.open_db()
    if args.refresh:
        conn.execute("DELETE FROM windows")
        conn.execute("DELETE FROM meta WHERE key LIKE 'job:%' OR key = 'complete'")
        conn.commit()
    now = float(Time.now().mjd)
    done = {row[0] for row in conn.execute("SELECT start FROM windows")}
    todo = []
    lo = FIRST_MJD
    while lo < now:
        if lo not in done:
            todo.append((lo, lo + args.days))
        lo += args.days
    log(f"{len(todo)} windows to fetch, {len(done)} already stored")

    running: dict[float, tuple[float, str]] = {}
    with make_client() as client:
        while todo or running:
            while todo and len(running) < args.jobs:
                lo, hi = todo.pop(0)
                job = catalog.get_meta(conn, f"job:{lo}")
                if job is None:
                    job = submit(client, lo, hi, args.poll)
                    catalog.set_meta(conn, f"job:{lo}", job)
                    conn.commit()
                    log(f"window {lo:.0f}-{hi:.0f}: queued as {job.rsplit('/', 1)[-1]}")
                running[lo] = (hi, job)
            for lo, (hi, job) in list(running.items()):
                phase = ask(client, "GET", f"{job}/phase", args.poll).text.strip()
                if phase == "COMPLETED":
                    text = ask(client, "GET", f"{job}/results/result", args.poll,
                               follow_redirects=True).text
                    lines = max(text.count("\n") - 1, 0)
                    exposures = parse_tap_csv(text, skip_bad=True)
                    stored = catalog.add_exposures(conn, exposures)
                    conn.execute("INSERT OR REPLACE INTO windows VALUES (?, ?, ?)",
                                 (lo, hi, stored))
                    conn.execute("DELETE FROM meta WHERE key = ?", (f"job:{lo}",))
                    conn.commit()
                    note = "" if stored == lines else f" ({lines - stored} rows skipped)"
                    if lines >= MAXREC:
                        note += " HIT THE ROW LIMIT, use a smaller --days"
                    log(f"window {lo:.0f}-{hi:.0f}: {stored} exposures stored{note}")
                    del running[lo]
                elif phase in ("ERROR", "ABORTED") or phase.startswith("<") or not phase:
                    # A lost or failed job: forget it so the next pass queues a new one.
                    detail = ask(client, "GET", f"{job}/error", args.poll).text[:200]
                    log(f"window {lo:.0f}-{hi:.0f}: job {phase[:20]!r}: {detail!r}; queuing again")
                    conn.execute("DELETE FROM meta WHERE key = ?", (f"job:{lo}",))
                    conn.commit()
                    todo.append((lo, hi))
                    del running[lo]
            if running:
                time.sleep(args.poll)

    total = conn.execute("SELECT COUNT(*) FROM exposures").fetchone()[0]
    catalog.set_meta(conn, "complete", "1")
    catalog.set_meta(conn, "through_mjd", f"{now:.3f}")
    conn.commit()
    log(f"snapshot complete: {total} exposures, {catalog.db_path().stat().st_size / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
