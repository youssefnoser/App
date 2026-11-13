"""Prepare the visit-median frames of the challenge targets through a running server.

Network: the local server only (which downloads from the AWS mirror). Usage:

    uv run python scripts/prewarm_stacks.py [key ...] [--server http://127.0.0.1:8000]
                                            [--fov 0.15] [--workers 6]

For each target it asks `/api/view?stack=1` at today's position and requests every
(patch, visit median) frame the page would, one visit-and-detector group at a time
so the exposures a group needs are in the cache together. Frames already saved
return at once. Prints one line per target with counts, failures and time.
"""

import argparse
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import json
from concurrent.futures import ThreadPoolExecutor


def get(url: str, timeout: float = 1800.0) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, b""
    except OSError:
        return 0, b""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("keys", nargs="*")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--fov", type=float, default=0.15)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    status, body = get(f"{args.server}/api/targets")
    if status != 200:
        print(f"The server at {args.server} did not answer (HTTP {status}).", file=sys.stderr)
        return 1
    targets = [t for t in json.loads(body) if not args.keys or t["key"] in args.keys]
    ok = True
    for target in targets:
        started = time.monotonic()
        status, body = get(f"{args.server}/api/view?ra={target['ra']}&dec={target['dec']}"
                           f"&fov={args.fov}&stack=1")
        if status != 200:
            print(f"{target['name']}: view failed (HTTP {status})", flush=True)
            ok = False
            continue
        view = json.loads(body)
        on_screen = {c["pix"] for c in view["cells"] if c["ring"] <= 1}
        good = failed = exposures = 0
        for e in view["exposures"]:
            exposures += e["count"]
            urls = [f"{args.server}/api/patch/{pix}/frame.png?uri={urllib.parse.quote(e['uri'])}"
                    f"&stack={e['stack']}" for pix in e["cells"] if pix in on_screen]
            with ThreadPoolExecutor(args.workers) as pool:
                for code, _ in pool.map(get, urls):
                    good += code == 200
                    failed += code != 200
        ok = ok and failed == 0
        print(f"{target['name']}: {len(view['exposures'])} visit medians from {exposures} exposures, "
              f"{len(on_screen)} patches, {good} frames saved, {failed} failed, "
              f"{time.monotonic() - started:.0f} s", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
