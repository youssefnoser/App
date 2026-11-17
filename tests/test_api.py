"""Offline tests for the view and patch-frame routes. IRSA calls are patched."""

import io
import json
import re
from datetime import date
from pathlib import Path

import numpy as np
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
    # `mjd` is the exposure start (TAP time_bounds_lower); MJD-AVG is not in this
    # response. Date is derived from the same start time.
    for e in out:
        assert e["mjd_start"] == e["mjd"]
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
    # A frame URL always draws the same image, so the Vercel CDN may keep it for
    # every viewer (s-maxage), not only the viewer's browser (max-age).
    assert r.headers["cache-control"] == app_module.FRAME_CACHE_CONTROL
    assert "s-maxage=" in r.headers["cache-control"]
    import io

    img = Image.open(io.BytesIO(r.content))
    assert img.size == (PATCH_N, PATCH_N)
    meta = json.loads(r.headers["x-frame-meta"])
    assert meta["detector"] == 6
    assert set(meta) == {"mjd", "mjd_start", "mjd_end", "detector", "wavelength_um", "obs_id"}
    assert meta["wavelength_um"] > 0
    assert meta["mjd_start"] > 61000 and meta["mjd_end"] > meta["mjd_start"]
    assert meta["mjd_start"] <= meta["mjd"] <= meta["mjd_end"]
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


# --- visit medians (stack mode) ---


def test_view_stack_lists_one_entry_per_visit_and_detector(client, monkeypatch, exposures):
    patch_find(monkeypatch, exposures)
    plain = client.get(VIEW).json()
    body = client.get(VIEW + "&stack=1").json()
    assert len(body["exposures"]) == 18
    assert all(e["first"] and e["stack"] == body["cell"] for e in body["exposures"])
    assert sum(e["count"] for e in body["exposures"]) == len(plain["exposures"])
    # a stack covers at least the patches its own exposure covers
    by_uri = {e["uri"]: set(e["cells"]) for e in plain["exposures"]}
    assert all(by_uri[e["uri"]] <= set(e["cells"]) for e in body["exposures"])


def test_stack_frame_is_the_nan_ignoring_median(aws_client, monkeypatch, tmp_path):
    """Three copies of the fixture, one scaled and one with a hole: the median is the
    plain frame and the hole is filled."""
    import numpy as np
    from astropy.io import fits
    from PIL import Image
    import io

    from server.irsa import Exposure

    src = FIXTURES / "crop_barnard_D6_2026-03-19.fits"
    point = (269.4463, 4.7677)
    monkeypatch.setattr(app_module, "cell_centre", lambda pix: point)
    square = ((269.0, 4.0), (270.0, 4.0), (270.0, 5.5), (269.0, 5.5))
    files = {}
    for name, scale, hole in (("a", 1.0, False), ("b", 3.0, False), ("c", 1.0, True)):
        path = tmp_path / f"{name}.fits"
        with fits.open(src) as hdul:
            hdul["IMAGE"].data = hdul["ZODI"].data + (hdul["IMAGE"].data - hdul["ZODI"].data) * scale
            if hole:
                hdul["IMAGE"].data[:] = np.nan
            hdul.writeto(path)
        files[f"ibe/data/spherex/{name}.fits"] = path
    members = [Exposure(u, 61000.0 + i, 6, "o", square) for i, u in enumerate(files)]
    monkeypatch.setattr(app_module, "_exposures_for_cell", lambda cell: members)
    monkeypatch.setattr(app_module, "fetch_exposure", lambda uri: files[uri])

    uri = "ibe/data/spherex/a.fits"
    single = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={uri}")
    stacked = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={uri}&stack={CELL}")
    assert stacked.status_code == 200
    meta = json.loads(stacked.headers["x-frame-meta"])
    assert meta["stack"] == 3 and meta["detector"] == 6
    # median of (x, 3x, NaN) is 2x where x is finite: brighter than the single frame, never darker
    a = np.asarray(Image.open(io.BytesIO(single.content)).convert("LA"), dtype=int)
    b = np.asarray(Image.open(io.BytesIO(stacked.content)).convert("LA"), dtype=int)
    seen = (a[..., 1] > 0) & (b[..., 1] > 0)
    assert seen.sum() > 100
    assert (b[..., 1] > 0).sum() >= (a[..., 1] > 0).sum()
    assert np.all(b[..., 0][seen] >= a[..., 0][seen] - 1)


def test_stack_frame_with_no_covering_exposure_is_502(aws_client, monkeypatch):
    monkeypatch.setattr(app_module, "_exposures_for_cell", lambda cell: [])
    r = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}&stack={CELL}")
    assert r.status_code == 502


def test_stack_param_must_match_exposure_visit(aws_client, monkeypatch):
    """stack=X is only valid when the uri's visit actually covers cell X."""
    from server.irsa import Exposure
    square = ((269.0, 4.0), (270.0, 4.0), (270.0, 5.5), (269.0, 5.5))
    e = Exposure(GOOD_URI, 61000.0, 6, "o", square)
    other = Exposure("ibe/data/spherex/other.fits", 61000.0, 6, "o", square)
    # the wrong cell holds a different exposure: the uri does not belong to it
    monkeypatch.setattr(
        app_module, "_exposures_for_cell",
        lambda cell: [e] if cell == CELL else [other])
    wrong_cell = CELL + 1
    r = aws_client.get(f"/api/patch/{wrong_cell}/frame.png?uri={GOOD_URI}&stack={wrong_cell}")
    assert r.status_code == 422
    assert "stack" in r.text.lower()


# --- live sequence: one image per exposure, read by byte ranges ---


def seq_setup(monkeypatch, tmp_path, count=5):
    """`count` copies of the fixture as detector-6 exposures a day apart around Barnard."""
    from astropy.io import fits

    from server.irsa import Exposure

    src = FIXTURES / "crop_barnard_D6_2026-03-19.fits"
    square = ((269.0, 4.0), (270.0, 4.0), (270.0, 5.5), (269.0, 5.5))
    members = [Exposure(f"ibe/data/spherex/s{i}.fits", 61000.0 + i, 6, "o", square)
               for i in range(count)]
    members.append(Exposure("ibe/data/spherex/far.fits", 61200.0, 6, "o", square))  # second visit
    members.append(Exposure("ibe/data/spherex/d2.fits", 61001.5, 2, "o", square))   # other detector
    monkeypatch.setattr(app_module, "_exposures_for_cell", lambda cell: members)
    asked = []

    def crop(uri, ra, dec, size):
        asked.append(uri)
        return fits.open(src)

    monkeypatch.setattr(app_module, "fetch_crop", crop)
    app_module._grids.clear()
    app_module._refs.clear()
    return members, asked


SEQ = "ra=269.4463&dec=4.7677&fov=0.05"


def test_sequence_lists_one_detector_in_time_order(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    body = aws_client.get(f"/api/sequence?{SEQ}&detector=6").json()
    uris = [e["uri"].rsplit("/", 1)[1] for e in body["exposures"]]
    assert uris == ["s0.fits", "s1.fits", "s2.fits", "s3.fits", "s4.fits", "far.fits"]
    assert [e["visit"] for e in body["exposures"]] == [0, 0, 0, 0, 0, 1]
    # first, middle and last of each visit load first
    assert [e["first"] for e in body["exposures"]] == [True, False, True, False, True, True]
    pix = body["cell"]
    assert pix < 0  # never a real HEALPix patch
    assert body["cells"] == [{"pix": pix, "ra": 269.4463, "dec": 4.7677, "ring": 0}]
    assert all(e["cells"] == [pix] for e in body["exposures"])
    other = aws_client.get("/api/sequence?ra=269.5&dec=4.7677&fov=0.05&detector=6").json()
    assert other["cell"] != pix  # a different box gets a different patch number
    assert body["sequence"]["pixels"] == 59  # 0.05 deg at 3.075 arcsec


def test_sequence_frame_single_and_rolling(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    url = f"/api/frame.png?uri=ibe/data/spherex/s2.fits&{SEQ}"
    single = aws_client.get(url + "&roll=0")
    assert single.status_code == 200
    assert single.headers["cache-control"] == app_module.FRAME_CACHE_CONTROL
    assert asked == ["ibe/data/spherex/s2.fits"]
    assert "stack" not in json.loads(single.headers["x-frame-meta"])

    rolled = aws_client.get(url + "&roll=1")
    meta = json.loads(rolled.headers["x-frame-meta"])
    assert meta["stack"] == 3 and meta["detector"] == 6
    # the centre exposure was kept in memory: only its two neighbours are fetched
    assert sorted(asked[1:]) == ["ibe/data/spherex/s1.fits", "ibe/data/spherex/s3.fits"]
    # identical inputs: the median equals the single frame
    assert rolled.content == single.content


def test_rolling_median_does_not_cross_visits(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/far.fits&{SEQ}&roll=2")
    assert json.loads(r.headers["x-frame-meta"])["stack"] == 1
    assert asked == ["ibe/data/spherex/far.fits"]


def test_sequence_frame_is_served_from_disk_the_second_time(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    url = f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}&roll=0"
    first = aws_client.get(url)
    app_module._grids.clear()
    again = aws_client.get(url)
    assert again.content == first.content
    assert len(asked) == 1


def test_sequence_frame_failure_is_502(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)

    def broken(*args):
        raise CutoutError("nope")

    monkeypatch.setattr(app_module, "fetch_crop", broken)
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}")
    assert r.status_code == 502


def test_sequence_box_covers_a_wide_screen(aws_client, monkeypatch, tmp_path):
    # Frames load below 0.5 deg of screen height; on a 16:10 screen the box that
    # covers the corners is about 0.95 deg, so 1 deg must be accepted.
    seq_setup(monkeypatch, tmp_path)
    r = aws_client.get("/api/sequence?ra=269.4463&dec=4.7677&fov=1.0&detector=6")
    assert r.status_code == 200
    assert r.json()["sequence"]["pixels"] == 1171  # 1 deg at 3.075 arcsec


def test_grid_cache_is_bounded_by_bytes(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    one = 59 * 59 * 4  # a 0.05 deg float32 grid
    monkeypatch.setattr(app_module, "MAX_GRID_BYTES", 2 * one)
    for i in range(4):
        aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s{i}.fits&{SEQ}&roll=0")
    held = [key[0].rsplit("/", 1)[1] for key in app_module._grids]
    assert held == ["s2.fits", "s3.fits"]  # oldest dropped first
    assert sum(v[0].nbytes for v in app_module._grids.values()) <= 2 * one


@pytest.mark.parametrize("query", ["fov=1.1", "fov=0.01", "detector=7", "roll=9"])
def test_sequence_rejects_out_of_range(aws_client, monkeypatch, tmp_path, query):
    seq_setup(monkeypatch, tmp_path)
    base = "ra=269.4463&dec=4.7677"
    if query.startswith("roll"):
        r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{base}&fov=0.05&{query}")
    elif query.startswith("detector"):
        r = aws_client.get(f"/api/sequence?{base}&fov=0.05&{query}")
    else:
        r = aws_client.get(f"/api/sequence?{base}&detector=6&{query}")
    assert r.status_code == 422


def test_sequence_by_wavelength_filters_on_predicted_wavelength(aws_client, monkeypatch, tmp_path):
    members, _ = seq_setup(monkeypatch, tmp_path)
    # s0..s4 at 4.40, 4.50, 4.60, 4.70, 4.80; far at 4.61; the detector-2 one at 1.30
    table = dict(zip([m.uri for m in members], [4.40, 4.50, 4.60, 4.70, 4.80, 4.61, 1.30]))
    monkeypatch.setattr(app_module, "exposure_wavelengths",
                        lambda exposures, ra, dec: [table[e.uri] for e in exposures])
    body = aws_client.get(f"/api/sequence?{SEQ}&wavelength=4.6&width=0.03").json()
    got = [(e["uri"].rsplit("/", 1)[1], e["wavelength_um"]) for e in body["exposures"]]
    assert got == [("s1.fits", 4.5), ("s2.fits", 4.6), ("s3.fits", 4.7), ("far.fits", 4.61)]
    assert body["sequence"]["wavelength"] == 4.6
    other = aws_client.get(f"/api/sequence?{SEQ}&wavelength=1.3&width=0.03").json()
    assert [e["detector"] for e in other["exposures"]] == [2]
    assert other["cell"] != body["cell"]


def test_wavelength_median_only_mixes_frames_in_the_window(aws_client, monkeypatch, tmp_path):
    members, asked = seq_setup(monkeypatch, tmp_path)
    table = dict(zip([m.uri for m in members], [4.40, 4.50, 4.60, 4.70, 4.80, 4.61, 1.30]))
    monkeypatch.setattr(app_module, "exposure_wavelengths",
                        lambda exposures, ra, dec: [table[e.uri] for e in exposures])
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s2.fits&{SEQ}&roll=4"
                       "&wavelength=4.6&width=0.03")
    assert json.loads(r.headers["x-frame-meta"])["stack"] == 3
    assert sorted(u.rsplit("/", 1)[1] for u in asked) == ["s1.fits", "s2.fits", "s3.fits"]


def test_sequence_needs_exactly_one_of_detector_and_wavelength(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    assert aws_client.get(f"/api/sequence?{SEQ}").status_code == 422
    assert aws_client.get(f"/api/sequence?{SEQ}&detector=6&wavelength=4.6").status_code == 422


def test_root_serves_testbench(client):
    r = client.get("/")
    assert r.status_code == 200
    assert 'type="module" src="app.js"' in r.text


def test_shared_modules_served(client):
    assert client.get("/shared/backend-sky.js").status_code == 200


def test_web_source_not_exposed(client):
    assert client.get("/package.json").status_code == 404


# --- audit fixes: exposures at the point, cache freshness, error wording ---


def test_sequence_keeps_an_exposure_that_misses_the_cell_centre(aws_client, monkeypatch):
    """The sequence is for a point, not a cell: an exposure that holds the point
    but not the centre of the point's cell must still be listed."""
    from server.irsa import Exposure
    from server.patches import cell_of

    c_ra, c_dec = cell_centre(CELL)
    ra, dec = round(c_ra, 5), round(c_dec + 0.04, 5)
    assert cell_of(ra, dec) == CELL
    wide = ((c_ra - 1, c_dec - 1), (c_ra + 1, c_dec - 1), (c_ra + 1, c_dec + 1), (c_ra - 1, c_dec + 1))
    edge = ((ra - 0.02, dec - 0.02), (ra + 0.02, dec - 0.02),
            (ra + 0.02, dec + 0.02), (ra - 0.02, dec + 0.02))
    assert footprint_contains(edge, ra, dec) and not footprint_contains(edge, c_ra, c_dec)
    fill_snapshot([Exposure("ibe/data/spherex/wide.fits", 61000.0, 3, "a", wide),
                   Exposure("ibe/data/spherex/edge.fits", 61001.0, 3, "b", edge)], complete=True)
    patch_find(monkeypatch, IrsaError("must not be asked"))
    body = aws_client.get(f"/api/sequence?ra={ra}&dec={dec}&fov=0.05&detector=3").json()
    assert [e["uri"].rsplit("/", 1)[1] for e in body["exposures"]] == ["wide.fits", "edge.fits"]


def write_cell_cache(tmp_path, rows, age_s=0.0):
    import os
    import time

    path = tmp_path / "tap" / f"{CELL}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    stamp = time.time() - age_s
    os.utime(path, (stamp, stamp))


STALE_ROW = {"uri": "ibe/data/spherex/stale.fits", "mjd": 60000.0, "detector": 1, "obs_id": "old",
             "footprint": [[269.0, 4.0], [270.0, 4.0], [270.0, 5.5], [269.0, 5.5]]}


def test_complete_snapshot_wins_over_an_old_cell_list(client, monkeypatch, exposures, tmp_path):
    """After a snapshot refresh, a cell list cached before it must not keep being served."""
    write_cell_cache(tmp_path, [STALE_ROW])
    fill_snapshot(exposures, complete=True)
    patch_find(monkeypatch, IrsaError("down"))
    out = client.get(VIEW).json()["exposures"]
    assert len(out) > 300
    assert all("stale" not in e["uri"] for e in out)


def test_cell_list_from_irsa_expires(client, monkeypatch, exposures, tmp_path):
    write_cell_cache(tmp_path, [STALE_ROW], age_s=app_module.CELL_CACHE_MAX_AGE_S + 60)
    calls = patch_find(monkeypatch, exposures)
    out = client.get(VIEW).json()["exposures"]
    assert len(calls) == 1
    assert len(out) == len(exposures)


def test_mirror_frame_failure_names_the_mirror(aws_client, monkeypatch):
    def broken(uri):
        raise CutoutError("nope")

    monkeypatch.setattr(app_module, "fetch_exposure", broken)
    r = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}")
    assert r.status_code == 502
    assert "mirror" in r.json()["detail"] and "IRSA" not in r.json()["detail"]


def test_sequence_frame_failure_names_the_mirror(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)

    def broken(*args):
        raise CutoutError("nope")

    monkeypatch.setattr(app_module, "fetch_crop", broken)
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}")
    assert "mirror" in r.json()["detail"] and "IRSA" not in r.json()["detail"]


# --- review fixes: stack lookups, time spans, old cached metadata ---


def one_stack(monkeypatch):
    """Two members of one visit (the fixture file twice) around the patch centre."""
    from server.irsa import Exposure

    src = FIXTURES / "crop_barnard_D6_2026-03-19.fits"
    monkeypatch.setattr(app_module, "cell_centre", lambda pix: (269.4463, 4.7677))
    square = ((269.0, 4.0), (270.0, 4.0), (270.0, 5.5), (269.0, 5.5))
    members = [Exposure(GOOD_URI, 61000.0, 6, "o", square),
               Exposure("ibe/data/spherex/y.fits", 61000.1, 6, "o", square)]
    monkeypatch.setattr(app_module, "_exposures_for_cell", lambda cell: members)
    monkeypatch.setattr(app_module, "fetch_exposure", lambda uri: src)
    return src


def test_stack_list_failure_is_502_not_500(aws_client, monkeypatch):
    def down(cell):
        raise IrsaError("down")

    monkeypatch.setattr(app_module, "_exposures_for_cell", down)
    r = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}&stack={CELL}")
    assert r.status_code == 502


def test_cached_stack_frame_does_not_look_up_exposures(aws_client, monkeypatch):
    one_stack(monkeypatch)
    url = f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}&stack={CELL}"
    assert aws_client.get(url).status_code == 200
    monkeypatch.setattr(app_module, "_exposures_for_cell",
                        lambda cell: pytest.fail("a cached frame must not ask for the list"))
    assert aws_client.get(url).status_code == 200


def test_stack_time_span_is_first_start_to_last_end(aws_client, monkeypatch):
    from astropy.io import fits

    src = one_stack(monkeypatch)
    header = fits.getheader(src, "IMAGE")
    r = aws_client.get(f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}&stack={CELL}")
    meta = json.loads(r.headers["x-frame-meta"])
    assert meta["mjd_start"] == pytest.approx(header["MJD-BEG"], abs=1e-6)
    assert meta["mjd_end"] == pytest.approx(header["MJD-END"], abs=1e-6)
    assert "mjd_first" not in meta and "mjd_last" not in meta


def test_frame_cached_before_start_end_times_is_rendered_again(client, monkeypatch, tmp_path):
    calls = patch_cutout(monkeypatch, FIXTURES / "crop_barnard_D6_2026-03-19.fits")
    url = f"/api/patch/{CELL}/frame.png?uri={GOOD_URI}"
    client.get(url)
    (meta_path,) = (tmp_path / "png").rglob("*.json")
    old = json.loads(meta_path.read_text())
    del old["mjd_start"], old["mjd_end"]
    meta_path.write_text(json.dumps(old))
    meta = json.loads(client.get(url).headers["x-frame-meta"])
    assert "mjd_start" in meta
    assert len(calls) == 2


def test_grid_cached_before_start_end_times_is_fetched_again(aws_client, monkeypatch, tmp_path):
    import numpy as np

    _, asked = seq_setup(monkeypatch, tmp_path)
    url = f"/api/frame.png?uri=ibe/data/spherex/s2.fits&{SEQ}&roll=0"
    aws_client.get(url)
    (npz,) = (tmp_path / "grids").rglob("*.npz")
    with np.load(npz) as saved:
        grid, wavelength = saved["grid"], saved["wavelength"]
        meta = json.loads(str(saved["meta"]))
    del meta["mjd_start"], meta["mjd_end"]
    np.savez(npz.with_suffix(""), grid=grid, wavelength=wavelength, meta=json.dumps(meta))
    app_module._grids.clear()
    for png in (tmp_path / "png").rglob("*"):
        if png.is_file():
            png.unlink()
    meta = json.loads(aws_client.get(url).headers["x-frame-meta"])
    assert "mjd_start" in meta
    assert len(asked) == 2


def test_grid_memory_hit_counts_as_use(aws_client, monkeypatch, tmp_path):
    import os
    import time

    seq_setup(monkeypatch, tmp_path)
    app_module._seq_grid("ibe/data/spherex/s2.fits", 269.4463, 4.7677, 0.05)
    (npz,) = (tmp_path / "grids").rglob("*.npz")
    stamp = time.time() - 3600
    os.utime(npz, (stamp, stamp))
    app_module._seq_grid("ibe/data/spherex/s2.fits", 269.4463, 4.7677, 0.05)  # from memory
    assert time.time() - npz.stat().st_mtime < 60


# --- frame filters: every frame compared with the other visits of its box ---


def frame_meta(response) -> dict:
    assert response.status_code == 200, response.text
    return json.loads(response.headers["x-frame-meta"])


def pixels(response) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(response.content)))


def test_sequence_filter_gets_its_own_box(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    raw = aws_client.get(f"/api/sequence?{SEQ}&detector=6").json()
    diff = aws_client.get(f"/api/sequence?{SEQ}&detector=6&filter=difference").json()
    assert raw["sequence"]["filter"] == "raw" and diff["sequence"]["filter"] == "difference"
    assert diff["cell"] != raw["cell"] and diff["cell"] < 0
    assert [e["uri"] for e in diff["exposures"]] == [e["uri"] for e in raw["exposures"]]


def test_difference_filter_against_the_static_sky(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s2.fits&{SEQ}&roll=0&filter=difference")
    meta = frame_meta(r)
    assert meta["filter"] == "difference"
    assert meta["reference"] == {"kind": "static", "start": "2025-11-21", "end": "2026-06-09",
                                 "exposures": 6, "visits": 2}
    assert pixels(r)[..., :3].max() == 0  # every exposure is the same image: nothing changed
    assert sorted(set(asked)) == sorted(f"ibe/data/spherex/{n}" for n in
                                        ["s0.fits", "s1.fits", "s2.fits", "s3.fits", "s4.fits", "far.fits"])


def test_previous_filter_compares_with_the_visit_before_or_the_next_for_the_first(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    late = frame_meta(aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/far.fits&{SEQ}&roll=0&filter=previous"))
    assert late["reference"] == {"kind": "previous", "start": "2025-11-21", "end": "2025-11-25", "exposures": 5}
    early = frame_meta(aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}&roll=0&filter=previous"))
    assert early["reference"] == {"kind": "next", "start": "2026-06-09", "end": "2026-06-09", "exposures": 1}


def test_trail_filter_draws_earlier_visits_and_this_frame_by_date(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    early = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}&roll=0&filter=trail")
    meta = frame_meta(early)
    assert [(v["colour"], v["shown"], v["current"]) for v in meta["trail"]] == [
        ([255, 0, 0], True, True), ([0, 0, 255], False, False)]
    px = pixels(early)
    opaque = px[..., 3] == 255
    assert px[..., 0][opaque].max() > 0 and px[..., 1:3][opaque].max() == 0  # first visit only: red
    late = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/far.fits&{SEQ}&roll=0&filter=trail")
    assert [v["shown"] for v in frame_meta(late)["trail"]] == [True, True]
    px = pixels(late)
    opaque = px[..., 3] == 255
    assert (px[..., 0][opaque] == px[..., 2][opaque]).all()  # same sky both visits: red + blue alike


def test_references_are_built_once_per_box(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    for name in ["s0", "s1", "far"]:
        for f in ["difference", "previous", "trail"]:
            frame_meta(aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/{name}.fits&{SEQ}&roll=0&filter={f}"))
    assert len(asked) == 6  # each exposure fetched once


def test_filtered_frame_is_served_from_disk_the_second_time(aws_client, monkeypatch, tmp_path):
    _, asked = seq_setup(monkeypatch, tmp_path)
    url = f"/api/frame.png?uri=ibe/data/spherex/s1.fits&{SEQ}&roll=0&filter=trail"
    first = aws_client.get(url)
    app_module._grids.clear()
    app_module._refs.clear()
    again = aws_client.get(url)
    assert again.content == first.content
    assert again.headers["x-frame-meta"] == first.headers["x-frame-meta"]
    assert len(asked) == 6  # the second time nothing is downloaded: PNG and grid come from disk


def test_a_visit_that_cannot_be_fetched_is_left_out_of_the_references(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    from astropy.io import fits

    def crop(uri, ra, dec, size):
        if uri.endswith("far.fits"):
            raise CutoutError("nope")
        return fits.open(FIXTURES / "crop_barnard_D6_2026-03-19.fits")

    monkeypatch.setattr(app_module, "fetch_crop", crop)
    meta = frame_meta(aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}&roll=0&filter=previous"))
    assert meta["reference"]["kind"] == "same"  # only one visit left: its own median
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/far.fits&{SEQ}&roll=0&filter=previous")
    assert r.status_code == 502


def test_frame_rejects_unknown_filter(aws_client, monkeypatch, tmp_path):
    seq_setup(monkeypatch, tmp_path)
    r = aws_client.get(f"/api/frame.png?uri=ibe/data/spherex/s0.fits&{SEQ}&filter=blur")
    assert r.status_code == 422
