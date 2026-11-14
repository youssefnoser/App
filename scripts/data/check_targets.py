"""Check that IRSA has exposures for each of the five challenge targets.

Network, not part of the test suite. Usage:

    uv run python scripts/data/check_targets.py [key ...]

Prints, per target, how many exposures cover the propagated 2026 position, how
they group into visits, which detectors are present, and the date range. `SPHEREX_INSECURE_TLS=1`
disables TLS verification inside the development sandbox.
"""

import sys
import time

from astropy.time import Time

from server.irsa import IrsaError, find_exposures
from server.targets import TARGETS, propagate
from server.timeline import first_batch, group_visits


def main() -> int:
    keys = sys.argv[1:] or list(TARGETS)
    mjd_now = Time.now().mjd
    failures = 0
    print(f"{'target':16s} {'ra, dec (2026)':28s} {'exp':>4s} {'visits':>6s} {'det':>4s} "
          f"{'dates':25s} {'first':>5s}  s")
    for key in keys:
        target = TARGETS.get(key)
        if target is None:
            print(f"{key}: unknown target", file=sys.stderr)
            failures += 1
            continue
        ra, dec = propagate(target, mjd_now)
        start = time.monotonic()
        try:
            exposures = find_exposures(ra, dec)
        except IrsaError as err:
            print(f"{key}: IRSA error: {err}", file=sys.stderr)
            failures += 1
            continue
        elapsed = time.monotonic() - start
        visits = group_visits(exposures)
        detectors = sorted({e.detector for e in exposures})
        dates = Time([e.mjd for e in exposures], format="mjd").iso
        span = f"{dates[0][:10]} to {dates[-1][:10]}" if len(dates) else "-"
        print(
            f"{key:16s} {ra:9.4f},{dec:9.4f}      {len(exposures):4d} {len(visits):6d} "
            f"{len(detectors):4d} {span:25s} {len(first_batch(exposures)):5d}  {elapsed:.1f}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
