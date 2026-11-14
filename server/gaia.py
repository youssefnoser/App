"""Gaia DR3 sources from the IRSA TAP table gaia_dr3_source.

Positions are at the Gaia reference epoch J2016.0; proper motions are in mas/yr
(pmra already includes cos dec). Two-parameter solutions have no proper motion
or parallax: those fields are None, never NaN. No retries: IRSA is shared.
"""

import csv
import io
import re
from dataclasses import asdict, dataclass

import httpx

from server.http import make_client
from server.irsa import TAP_URL

COLUMNS = "source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag"
FAST_PM_MASYR = 100.0
BRIGHT_N = 50
FAST_CAP = 500


class GaiaError(Exception):
    """IRSA did not answer the Gaia query or answered with something unusable."""


@dataclass(frozen=True)
class GaiaSource:
    source_id: str  # string: 19 digits overflow a JavaScript number
    ra: float
    dec: float
    pmra: float | None
    pmdec: float | None
    parallax: float | None
    gmag: float | None
    fast: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _circle(ra: float, dec: float, radius: float) -> str:
    return f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius}))"


def build_bright_query(ra: float, dec: float, radius: float, n: int = BRIGHT_N) -> str:
    """The n brightest sources (smallest G magnitude) in the cone."""
    return (f"SELECT TOP {int(n)} {COLUMNS} FROM gaia_dr3_source "
            f"WHERE {_circle(ra, dec, radius)} AND phot_g_mean_mag IS NOT NULL "
            f"ORDER BY phot_g_mean_mag")


def build_fast_query(ra: float, dec: float, radius: float, pm_min: float = FAST_PM_MASYR) -> str:
    """Sources in the cone whose total proper motion exceeds pm_min mas/yr."""
    return (f"SELECT TOP {FAST_CAP} {COLUMNS} FROM gaia_dr3_source "
            f"WHERE {_circle(ra, dec, radius)} AND pmra*pmra + pmdec*pmdec > {pm_min * pm_min:g}")


def build_id_query(source_id: str) -> str:
    """The query for one source. Raises ValueError unless source_id is 1-19 digits."""
    if not re.fullmatch(r"\d{1,19}", source_id or ""):
        raise ValueError(f"not a Gaia DR3 source_id: {source_id!r}")
    return f"SELECT {COLUMNS} FROM gaia_dr3_source WHERE source_id = {source_id}"


def _num(value: str | None) -> float | None:
    """Empty fields (and NaN) become None."""
    if value is None or not value.strip():
        return None
    number = float(value)
    return None if number != number else number


def _is_fast(pmra: float | None, pmdec: float | None) -> bool:
    if pmra is None or pmdec is None:
        return False
    return pmra * pmra + pmdec * pmdec > FAST_PM_MASYR * FAST_PM_MASYR


def parse_gaia_csv(text: str) -> list[GaiaSource]:
    """Parse the TAP csv answer. Rows keep the server's order."""
    sources = []
    for row in csv.DictReader(io.StringIO(text)):
        pmra, pmdec = _num(row["pmra"]), _num(row["pmdec"])
        sources.append(GaiaSource(
            source_id=row["source_id"].strip(),
            ra=float(row["ra"]),
            dec=float(row["dec"]),
            pmra=pmra,
            pmdec=pmdec,
            parallax=_num(row["parallax"]),
            gmag=_num(row["phot_g_mean_mag"]),
            fast=_is_fast(pmra, pmdec),
        ))
    return sources


def _run(client: httpx.Client, query: str) -> list[GaiaSource]:
    try:
        response = client.post(TAP_URL, data={
            "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query})
        response.raise_for_status()
        return parse_gaia_csv(response.text)
    except httpx.HTTPError as exc:
        raise GaiaError(f"Gaia TAP request failed: {exc}") from exc
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise GaiaError(f"Gaia TAP response could not be parsed: {exc!r}") from exc


def cone(ra: float, dec: float, radius: float, *, client: httpx.Client | None = None) -> list[GaiaSource]:
    """Brightest sources, then fast movers, in the cone; one entry per source_id.

    The two queries run one after the other. Raises GaiaError on failure.
    """
    own_client = client is None
    client = client if client is not None else make_client()
    try:
        merged: dict[str, GaiaSource] = {}
        for query in (build_bright_query(ra, dec, radius), build_fast_query(ra, dec, radius)):
            for s in _run(client, query):
                merged.setdefault(s.source_id, s)
        return list(merged.values())
    finally:
        if own_client:
            client.close()


def source(source_id: str, *, client: httpx.Client | None = None) -> GaiaSource | None:
    """One source by id, or None if Gaia DR3 has no such source.

    Raises ValueError for a malformed id and GaiaError on failure.
    """
    query = build_id_query(source_id)
    own_client = client is None
    client = client if client is not None else make_client()
    try:
        rows = _run(client, query)
        return rows[0] if rows else None
    finally:
        if own_client:
            client.close()
