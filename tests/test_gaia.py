"""Offline tests for the Gaia DR3 queries. IRSA is replaced by httpx.MockTransport."""

from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from server.gaia import (
    GaiaError,
    build_bright_query,
    build_fast_query,
    build_id_query,
    cone,
    parse_gaia_csv,
    source,
)

FIXTURES = Path(__file__).parent / "fixtures"
BARNARD = "4472832130942575872"
HEADER = "source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag\n"


def _query(request: httpx.Request) -> str:
    return parse_qs(request.content.decode())["QUERY"][0]


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_bright_query_orders_by_g_mag():
    q = build_bright_query(269.45, 4.69, 0.25)
    assert "TOP 50" in q
    assert "gaia_dr3_source" in q
    assert "CIRCLE('ICRS', 269.45, 4.69, 0.25)" in q
    assert "ORDER BY phot_g_mean_mag" in q


def test_fast_query_thresholds_total_pm():
    q = build_fast_query(269.45, 4.69, 0.25)
    assert "pmra*pmra + pmdec*pmdec > 10000" in q
    assert "TOP 500" in q


def test_id_query_rejects_non_digits():
    for bad in ["1 OR 1=1", "", "12345678901234567890"]:
        with pytest.raises(ValueError):
            build_id_query(bad)
    assert BARNARD in build_id_query(BARNARD)


def test_parse_handles_missing_astrometry():
    sources = parse_gaia_csv((FIXTURES / "gaia_cone_bright.csv").read_text())
    two_param = sources[-1]
    assert two_param.pmra is None and two_param.parallax is None
    assert two_param.gmag == 20.9
    assert isinstance(two_param.source_id, str)


def test_cone_merges_and_flags_fast():
    calls = []

    def handler(request):
        calls.append(request)
        name = "gaia_cone_bright.csv" if "ORDER BY" in _query(request) else "gaia_cone_fast.csv"
        return httpx.Response(200, text=(FIXTURES / name).read_text())

    result = cone(269.45, 4.69, 0.25, client=_client(handler))
    assert len(result) == 4
    assert len(calls) == 2
    by_id = {s.source_id: s for s in result}
    assert by_id[BARNARD].fast is True
    assert sum(s.fast for s in result) == 1


def test_cone_dedupes():
    bright = (FIXTURES / "gaia_cone_bright.csv").read_text()
    fast = bright + (FIXTURES / "gaia_cone_fast.csv").read_text().splitlines()[1] + "\n"

    def handler(request):
        return httpx.Response(200, text=bright if "ORDER BY" in _query(request) else fast)

    result = cone(269.45, 4.69, 0.25, client=_client(handler))
    ids = [s.source_id for s in result]
    assert len(ids) == len(set(ids)) == 4


def test_source_found_and_missing():
    found = source(BARNARD, client=_client(
        lambda r: httpx.Response(200, text=(FIXTURES / "gaia_id.csv").read_text())))
    assert found is not None and found.pmdec == 10362.394
    missing = source(BARNARD, client=_client(lambda r: httpx.Response(200, text=HEADER)))
    assert missing is None


def test_http_error_raises_gaia_error():
    with pytest.raises(GaiaError):
        cone(269.45, 4.69, 0.25, client=_client(lambda r: httpx.Response(500, text="down")))
