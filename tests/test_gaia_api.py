"""Offline tests for /api/gaia and /api/gaia/source/{id}. Gaia queries are patched."""

import pytest
from fastapi.testclient import TestClient

import server.app as app_module
from server import gaia
from server.app import snap_cone
from server.gaia import GaiaError, GaiaSource

BARNARD = GaiaSource("4472832130942575872", 269.4485, 4.7394, -801.551, 10362.394, 546.9759, 8.19, True)
OTHER = GaiaSource("4472832165289153024", 269.4665, 4.7056, 0.578, -8.671, 1.814, 11.45, False)
CONE = "/api/gaia?ra=269.4463&dec=4.7677&fov=0.15"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    return TestClient(app_module.app)


def patch_cone(monkeypatch, result):
    calls = []

    def fake(ra, dec, radius, **kwargs):
        calls.append((ra, dec, radius))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(gaia, "cone", fake)
    return calls


def test_snap_cone_buckets():
    assert snap_cone(269.4463, 4.7677, 0.15) == (269.45, 4.75, 0.25)
    assert snap_cone(359.99, 0, 0.1)[0] == 0.0
    assert snap_cone(10, 10, 2)[2] == 0.75


def test_gaia_cone_cached(client, monkeypatch, tmp_path):
    calls = patch_cone(monkeypatch, [BARNARD, OTHER])
    first = client.get(CONE)
    second = client.get(CONE)
    assert first.status_code == 200
    assert second.json() == first.json()
    assert len(calls) == 1
    body = first.json()
    assert body["epoch"] == 2016.0 and body["radius"] == 0.25
    assert body["sources"][0]["source_id"] == "4472832130942575872"
    assert list((tmp_path / "gaia").glob("cone-*.json"))


def test_gaia_cone_empty_not_cached(client, monkeypatch):
    calls = patch_cone(monkeypatch, [])
    client.get(CONE)
    client.get(CONE)
    assert len(calls) == 2


def test_gaia_cone_upstream_error(client, monkeypatch, tmp_path):
    patch_cone(monkeypatch, GaiaError("down"))
    response = client.get(CONE)
    assert response.status_code == 502
    assert response.json()["detail"] == "The Gaia service did not answer. Try again in a minute."
    assert not list((tmp_path / "gaia").glob("*.json")) if (tmp_path / "gaia").exists() else True


def test_gaia_source_ok_404_422(client, monkeypatch):
    monkeypatch.setattr(gaia, "source", lambda sid, **kw: BARNARD if sid == BARNARD.source_id else None)
    ok = client.get(f"/api/gaia/source/{BARNARD.source_id}")
    assert ok.status_code == 200 and ok.json()["source_id"] == BARNARD.source_id
    missing = client.get("/api/gaia/source/123")
    assert missing.status_code == 404
    assert missing.json()["detail"] == "No Gaia DR3 source has that ID."
    assert client.get("/api/gaia/source/abc").status_code == 422
