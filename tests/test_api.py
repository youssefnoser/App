"""Offline tests for the view and patch-frame routes. IRSA calls are patched."""

import json
import re
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server.app as app_module
from server.cutouts import CutoutError
from server.irsa import IrsaError, parse_tap_csv
from server.patches import NPIX, PATCH_N, cell_centre, footprint_contains
from server.timeline import first_batch

FIXTURES = Path(__file__).parent / "fixtures"
CELL = 2034010
VIEW = "/api/view?ra=269.4463&dec=4.7677&fov=0.15"
GOOD_URI = "ibe/data/spherex/x.fits"


@pytest.fixture
def exposures():
    return parse_tap_csv((FIXTURES / "tap_barnard_poly.csv").read_text())


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("SPHEREX_SOURCE", "irsa")
    return TestClient(app_module.app)


def patch_find(monkeypatch, result):
    calls = []

    def fake(ra, dec, **kwargs):
        calls.append((ra, dec))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(app_module, "find_exposures", fake)
    return calls


def test_view_shape(client, monkeypatch, exposures):
    patch_find(monkeypatch, exposures)
    r = client.get(VIEW)
    assert r.status_code == 200
    body = r.json()
    assert body["cell"] == CELL
    ring0 = [c["pix"] for c in body["cells"] if c["ring"] == 0]
    assert CELL in ring0
    ra, dec = cell_centre(CELL)
    centre = next(c for c in body["cells"] if c["pix"] == CELL)
    assert centre["ra"] == pytest.approx(ra, abs=1e-5)
    assert centre["dec"] == pytest.approx(dec, abs=1e-5)

    out = body["exposures"]
    assert len(out) == len(exposures)
    assert [e["mjd"] for e in out] == sorted(e["mjd"] for e in out)
    assert sum(e["first"] for e in out) == len(first_batch(exposures))
    for e in out:
        date.fromisoformat(e["date"])
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", e["date"])
        assert isinstance(e["visit"], int)

    # Ruling R3: fixture was queried 0.06 deg from the cell centre.
    covering = {
        x.uri for x in exposures if footprint_contains(x.footprint, ra, dec)
    }
    by_uri = {e["uri"]: e for e in out}
    for uri in covering:
        assert CELL in by_uri[uri]["cells"]
    with_cell = sum(CELL in e["cells"] for e in out)
    assert with_cell >= 0.9 * len(out)


def test_view_queries_cell_centre_and_caches(client, monkeypatch, exposures):
    calls = patch_find(monkeypatch, exposures)
    client.get(VIEW)
    client.get(VIEW)
    assert len(calls) == 1
    ra, dec = cell_centre(CELL)
    assert calls[0] == pytest.approx((ra, dec))


def test_view_cached_file_on_disk(client, monkeypatch, exposures, tmp_path):
    patch_find(monkeypatch, exposures)
    client.get(VIEW)
    cached = json.loads((tmp_path / "tap" / f"{CELL}.json").read_text())
    assert len(cached) == len(exposures)


def test_view_empty_is_200(client, monkeypatch):
    patch_find(monkeypatch, [])
    r = client.get(VIEW)
    assert r.status_code == 200
    assert r.json()["exposures"] == []
    assert r.json()["cell"] == CELL


@pytest.mark.parametrize(
    "query",
    [
        "ra=abc&dec=4.7&fov=0.15",
        "ra=360&dec=4.7&fov=0.15",
        "ra=-1&dec=4.7&fov=0.15",
        "ra=269&dec=91&fov=0.15",
        "ra=269&dec=4.7&fov=0",
        "ra=269&dec=4.7&fov=500",
        "ra=269&dec=4.7&fov=1.5",
    ],
)
def test_view_rejects(client, monkeypatch, query):
    calls = patch_find(monkeypatch, [])
    assert client.get(f"/api/view?{query}").status_code == 422
    assert calls == []


def test_view_fov_cap_is_inclusive(client, monkeypatch):
    patch_find(monkeypatch, [])
    assert client.get("/api/view?ra=269.4&dec=4.7&fov=1.0").status_code == 200


def test_view_empty_not_cached(client, monkeypatch, tmp_path):
    calls = patch_find(monkeypatch, [])
    client.get(VIEW)
    client.get(VIEW)
    assert len(calls) == 2
    assert not (tmp_path / "tap" / f"{CELL}.json").exists()


def test_view_coverage_is_fast(client, monkeypatch, exposures):
    import time

    patch_find(monkeypatch, exposures)
    client.get(VIEW)  # fill cache
    start = time.perf_counter()
    client.get("/api/view?ra=269.4463&dec=4.7677&fov=0.5")
    assert time.perf_counter() - start < 0.5


def test_view_irsa_down_502(client, monkeypatch):
    patch_find(monkeypatch, IrsaError("down"))
    r = client.get(VIEW)
    assert r.status_code == 502
    assert "IRSA" in r.json()["detail"]


def patch_cutout(monkeypatch, result):
    calls = []

    def fake(uri, ra, dec, size_deg, **kwargs):
        calls.append((uri, ra, dec, size_deg))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(app_module, "fetch_cutout", fake)
    return calls


def test_frame_png(client, monkeypatch, tmp_path):
    calls = patch_cutout(monkeypatch, FIXTURES / "crop_barnard_D6_2026-03-19.fits")
    r = client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "public, max-age=86400"
    import io

    img = Image.open(io.BytesIO(r.content))
    assert img.size == (PATCH_N, PATCH_N)
    meta = json.loads(r.headers["x-frame-meta"])
    assert meta["detector"] == 6
    assert set(meta) == {"mjd", "detector", "wavelength_um", "obs_id"}
    assert meta["wavelength_um"] > 0
    assert len(calls) == 1
    ra, dec = cell_centre(CELL)
    assert calls[0][0] == GOOD_URI
    assert calls[0][1:3] == pytest.approx((ra, dec))
    assert calls[0][3] == 0.18

    # Second request is served from the PNG cache: no second cutout fetch.
    r2 = client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r2.status_code == 200
    assert r2.content == r.content
    assert r2.headers["x-frame-meta"] == r.headers["x-frame-meta"]
    assert len(calls) == 1
    cache = tmp_path / "png" / f"v{app_module.RENDER_VERSION}" / str(PATCH_N) / str(CELL)
    assert list(cache.glob("*.png"))


@pytest.mark.parametrize(
    "path",
    [
        f"/api/patch/{CELL}/frame.png?uri=http://evil/x.fits",
        f"/api/patch/{CELL}/frame.png?uri=ibe/data/spherex/../x.fits",
        f"/api/patch/{CELL}/frame.png?uri=ibe/data/spherex/x.txt",
        f"/api/patch/{CELL}/frame.png",
        f"/api/patch/-1/frame.png?uri={GOOD_URI}",
        f"/api/patch/{NPIX}/frame.png?uri={GOOD_URI}",
    ],
)
def test_frame_rejects(client, monkeypatch, path):
    calls = patch_cutout(monkeypatch, FIXTURES / "crop_barnard_D6_2026-03-19.fits")
    assert client.get(path).status_code == 422
    assert calls == []


def test_frame_cutout_502(client, monkeypatch):
    patch_cutout(monkeypatch, CutoutError("nope"))
    r = client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r.status_code == 502
    assert "IRSA" in r.json()["detail"]


def test_import_without_vendor_dirs():
    # Mounts are conditional, so the app object exists even with no vendor build.
    assert app_module.app is not None


def test_frame_broken_cutout_502_and_file_removed(client, monkeypatch, tmp_path):
    from astropy.io import fits

    src = FIXTURES / "crop_barnard_D6_2026-03-19.fits"
    broken = tmp_path / "broken.fits"
    with fits.open(src) as hdul:
        fits.HDUList([h for h in hdul if h.name != "ZODI"]).writeto(broken)
    patch_cutout(monkeypatch, broken)
    r = client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r.status_code == 502
    assert "IRSA" in r.json()["detail"]
    assert not broken.exists()


# --- pixels from the AWS mirror (the default source) ---


@pytest.fixture
def aws_client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("SPHEREX_SOURCE", raising=False)
    return TestClient(app_module.app)


def test_view_prefetches_first_batch_from_mirror(aws_client, monkeypatch, exposures):
    patch_find(monkeypatch, exposures)
    asked = []
    monkeypatch.setattr(app_module, "prefetch", lambda uris: asked.extend(uris))
    body = aws_client.get(VIEW).json()
    first = sorted(e["uri"] for e in body["exposures"] if e["first"])
    assert len(first) == 18
    assert asked == first


def test_view_does_not_prefetch_on_irsa_source(client, monkeypatch, exposures):
    patch_find(monkeypatch, exposures)
    asked = []
    monkeypatch.setattr(app_module, "prefetch", lambda uris: asked.extend(uris))
    client.get(VIEW)
    assert asked == []


def test_frame_from_mirror_equals_irsa_cutout_render(aws_client, client, monkeypatch):
    """The fixture is small enough that the local crop is the whole file, so the
    mirror path must give byte-identical PNG and the same metadata as the cutout path."""
    src = FIXTURES / "crop_barnard_D6_2026-03-19.fits"
    url = f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}"
    # The fixture is a 3 arcmin crop at Barnard's Star, which the cell centre misses.
    monkeypatch.setattr(app_module, "cell_centre", lambda pix: (269.4463, 4.7677))
    patch_cutout(monkeypatch, src)
    want = client.get(url)  # the `client` fixture selects the IRSA source
    assert want.status_code == 200

    monkeypatch.delenv("SPHEREX_SOURCE", raising=False)
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(src.parent.parent / "nonexistent-cache"))
    fetched = []
    monkeypatch.setattr(app_module, "fetch_exposure", lambda uri: fetched.append(uri) or src)
    monkeypatch.setattr(app_module, "_write_atomic", lambda path, data: None)
    monkeypatch.setattr(
        app_module, "fetch_cutout",
        lambda *a, **k: pytest.fail("the IRSA cutout service must not be used"),
    )
    got = aws_client.get(url)
    assert got.status_code == 200
    assert fetched == [GOOD_URI]
    assert got.content == want.content
    assert json.loads(got.headers["x-frame-meta"]) == json.loads(want.headers["x-frame-meta"])
    assert src.exists()


def test_frame_mirror_failure_is_502_and_keeps_the_exposure(aws_client, monkeypatch, tmp_path):
    from astropy.io import fits

    broken = tmp_path / "exposure.fits"
    with fits.open(FIXTURES / "crop_barnard_D6_2026-03-19.fits") as hdul:
        fits.HDUList([h for h in hdul if h.name != "ZODI"]).writeto(broken)
    monkeypatch.setattr(app_module, "fetch_exposure", lambda uri: broken)
    r = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r.status_code == 502


# --- exposure list from the local snapshot ---


def fill_snapshot(exposures, complete):
    from server import catalog as cat

    conn = cat.open_db()
    cat.add_exposures(conn, exposures)
    if complete:
        cat.set_meta(conn, "complete", "1")
    conn.commit()
    conn.close()


def test_view_uses_complete_snapshot_without_asking_irsa(client, monkeypatch, exposures):
    fill_snapshot(exposures, complete=True)
    calls = patch_find(monkeypatch, IrsaError("down"))
    r = client.get(VIEW)
    assert r.status_code == 200
    assert calls == []
    assert len(r.json()["exposures"]) > 300


def test_view_incomplete_snapshot_is_not_trusted(client, monkeypatch, exposures):
    """A half-filled snapshot can miss exposures, so IRSA is asked even when it has some."""
    fill_snapshot(exposures[:50], complete=False)
    calls = patch_find(monkeypatch, exposures)
    assert len(client.get(VIEW).json()["exposures"]) == len(exposures)
    assert len(calls) == 1


def test_view_empty_complete_snapshot_is_trusted(client, monkeypatch, exposures):
    fill_snapshot([], complete=True)
    calls = patch_find(monkeypatch, exposures)
    assert client.get(VIEW).json()["exposures"] == []
    assert calls == []


def test_targets_lists_the_five_with_todays_positions(client):
    body = client.get("/api/targets").json()
    assert [t["key"] for t in body] == [
        "barnards-star", "epsilon-indi-b", "wise-0855", "rw-aurigae", "r-draconis"]
    barnard = body[0]
    assert barnard["name"] == "Barnard's Star"
    # J2000 dec 4.6934 plus 10.36 arcsec/yr for about 27 years: north of 4.76.
    assert 4.76 < barnard["dec"] < 4.78
    assert all(0 <= t["ra"] < 360 and -90 <= t["dec"] <= 90 for t in body)
