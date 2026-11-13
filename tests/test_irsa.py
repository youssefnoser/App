"""Offline tests for the IRSA TAP search and the app scaffold."""

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from server.app import app
from server.http import tls_verify
from server.irsa import (
    IrsaError,
    build_query,
    decode_footprint,
    find_exposures,
    parse_tap_csv,
)

FIXTURE = Path(__file__).parent / "fixtures" / "tap_barnard_poly.csv"

# Polygon WKB (hex, little-endian, SRID 4326): a closed ring of 5 points.
HEX_WKB = (
    "0103000020E61000000100000005000000441C9DF6505357C0B377EA0CCFE31540"
    "9080217FA67456C0BA6A07DF12991440E05C94022C8056C0484AFBBBAA8FFA3FE8"
    "4775D0EC5F57C0EF4810B4D2D8FF3F441C9DF6505357C0B377EA0CCFE31540"
)

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"


def fixture_rows() -> int:
    lines = FIXTURE.read_text().splitlines()
    return len(lines) - 1  # minus header


def test_health_ok():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_decode_footprint_known():
    corners = decode_footprint(HEX_WKB)
    assert len(corners) == 4
    assert corners[0][0] == (corners[0][0] % 360)  # ra in 0..360
    assert abs(corners[0][0] - 266.698183) < 1e-5
    assert abs(corners[0][1] - 5.472470) < 1e-5
    assert abs(corners[2][0] - 269.997314) < 1e-5
    assert abs(corners[2][1] - 1.660075) < 1e-5


def test_decode_footprint_rejects_big_endian():
    big_endian_hex = "00" + HEX_WKB[2:]
    with pytest.raises(ValueError):
        decode_footprint(big_endian_hex)


def test_parse_fixture():
    rows = fixture_rows()
    exposures = parse_tap_csv(FIXTURE.read_text())
    assert len(exposures) == rows
    mjds = [e.mjd for e in exposures]
    assert mjds == sorted(mjds)
    assert {e.detector for e in exposures} == {1, 2, 3, 4, 5, 6}
    assert exposures[0].obs_id == "2025W33_2C_0321_1"
    assert all(len(e.footprint) == 4 for e in exposures)


def test_build_query_has_position():
    query = build_query(269.4463, 4.7677)
    assert "CONTAINS(POINT('ICRS', 269.4463, 4.7677)" in query
    assert "p.poly" in query


def test_find_exposures_uses_client():
    body_text = FIXTURE.read_text()

    def handler(request: httpx.Request) -> httpx.Response:
        assert "QUERY=" in request.content.decode()
        assert request.url == httpx.URL(TAP_URL)
        return httpx.Response(200, text=body_text)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        exposures = find_exposures(269.4463, 4.7677, client=client)
    assert len(exposures) == fixture_rows()


def test_find_exposures_http_error_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(IrsaError):
            find_exposures(269.4463, 4.7677, client=client)


def test_find_exposures_malformed_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not,a,tap\n1,2,3")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(IrsaError):
            find_exposures(269.4463, 4.7677, client=client)


def test_tls_verify_env(monkeypatch):
    monkeypatch.delenv("SPHEREX_INSECURE_TLS", raising=False)
    assert tls_verify() is True
    monkeypatch.setenv("SPHEREX_INSECURE_TLS", "1")
    assert tls_verify() is False
