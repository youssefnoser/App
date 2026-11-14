"""Record the IRSA TAP fixture used by offline tests.

Network script, not part of the test suite. Runs the footprint query for
Barnard's Star and saves the raw csv response to tests/fixtures/.

    uv run python scripts/data/record_tap_fixture.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from server.http import make_client
from server.irsa import TAP_URL, build_query

# Barnard's Star (ra, dec in degrees). See docs/DATA.md.
RA, DEC = 269.4463, 4.7677
OUT = REPO_ROOT / "tests" / "fixtures" / "tap_barnard_poly.csv"


def main() -> None:
    data = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "csv",
        "QUERY": build_query(RA, DEC),
    }
    with make_client() as client:
        response = client.post(TAP_URL, data=data)
        response.raise_for_status()
    OUT.write_text(response.text)
    lines = response.text.splitlines()
    print(f"wrote {OUT}: {len(lines) - 1} data rows, header: {lines[0]}")


if __name__ == "__main__":
    main()
