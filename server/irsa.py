"""Find SPHEREx exposures that cover a sky position via the IRSA TAP service.

The query is live metadata (never baked in), so a new SPHEREx release shows up
without any change here. Footprints come back as hex WKB polygons and are
decoded to (ra, dec) corner tuples. Rows are always returned sorted by MJD.
"""

import csv
import io
import struct
from dataclasses import dataclass

import httpx

from server.http import make_client

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"

QUERY_TEMPLATE = """SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname, p.obs_publisher_did, p.poly
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
ORDER BY p.time_bounds_lower"""


class IrsaError(Exception):
    """IRSA did not answer or answered with something unusable."""


@dataclass(frozen=True)
class Exposure:
    uri: str
    mjd: float
    detector: int
    obs_id: str
    footprint: tuple[tuple[float, float], ...]  # corners as (ra 0..360, dec), closing point dropped


def build_query(ra: float, dec: float) -> str:
    """The ADQL query for exposures whose footprint contains (ra, dec)."""
    return QUERY_TEMPLATE.format(ra=ra, dec=dec)


def decode_footprint(hex_wkb: str) -> tuple[tuple[float, float], ...]:
    """Decode a hex WKB polygon to corner (ra, dec) tuples.

    Little-endian WKB: header is <BIII (byte order, geometry type, SRID),
    then a <I point count, then <dd (lon, lat) pairs. RA is stored as a
    longitude in -180..180 and normalised to 0..360 here. The closing point
    (equal to the first) is dropped.
    """
    data = bytes.fromhex(hex_wkb.strip())
    if not data or data[0] != 1:
        raise ValueError("footprint WKB is not little-endian")
    struct.unpack_from("<BIII", data, 0)  # header: byte order, type, SRID, ring count
    (count,) = struct.unpack_from("<I", data, 13)
    points = []
    offset = 17
    for _ in range(count):
        lon, lat = struct.unpack_from("<dd", data, offset)
        points.append((lon % 360.0, lat))
        offset += 16
    if len(points) > 1 and points[0] == points[-1]:
        points = points[:-1]
    return tuple(points)


def _obs_id(obs_publisher_did: str) -> str:
    """The obs id is the part of the publisher DID after '?', before '/'."""
    return obs_publisher_did.split("?", 1)[1].split("/", 1)[0]


def parse_tap_csv(text: str, skip_bad: bool = False) -> list[Exposure]:
    """Parse the TAP csv response into Exposures, sorted by mjd.

    A row that cannot be parsed raises, unless `skip_bad` is True (bulk snapshots,
    where one odd row should not lose the other thousands); then it is dropped.
    """
    rows = csv.DictReader(io.StringIO(text))
    exposures = []
    for row in rows:
        try:
            exposures.append(
                Exposure(
                    uri=row["uri"],
                    mjd=float(row["time_bounds_lower"]),
                    detector=int(row["energy_bandpassname"].split("-D")[-1]),
                    obs_id=_obs_id(row["obs_publisher_did"]),
                    footprint=decode_footprint(row["poly"]),
                )
            )
        except (KeyError, ValueError, IndexError, TypeError, struct.error):
            if not skip_bad:
                raise
    exposures.sort(key=lambda e: e.mjd)
    return exposures


def find_exposures(ra: float, dec: float, *, client: httpx.Client | None = None) -> list[Exposure]:
    """Query IRSA TAP for exposures covering (ra, dec), sorted by mjd.

    Raises IrsaError if the request fails, IRSA answers with an error
    status, or the response cannot be parsed. No retries: IRSA is a shared public service.
    """
    own_client = client is None
    client = client if client is not None else make_client()
    try:
        response = client.post(
            TAP_URL,
            data={
                "REQUEST": "doQuery",
                "LANG": "ADQL",
                "FORMAT": "csv",
                "QUERY": build_query(ra, dec),
            },
        )
        response.raise_for_status()
        return parse_tap_csv(response.text)
    except httpx.HTTPError as exc:
        raise IrsaError(f"IRSA TAP request failed: {exc}") from exc
    except (KeyError, ValueError, IndexError, struct.error) as exc:
        raise IrsaError(f"IRSA TAP response could not be parsed: {exc!r}") from exc
    finally:
        if own_client:
            client.close()
