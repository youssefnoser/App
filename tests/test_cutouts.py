"""Offline tests for cutout download and the trimmed disk cache."""

import io
from pathlib import Path

import httpx
import pytest
from astropy.io import fits

from server import cutouts
from server.cutouts import CutoutError, check_uri, cutout_url, fetch_cutout

FIXTURE = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"
URI = "ibe/data/spherex/qr2/level2/x/y/spherex_level2_x.fits"


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    return tmp_path / "cache"


def client_serving(body: bytes, counter: list | None = None) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if counter is not None:
            counter.append(request)
        return httpx.Response(200, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_cutout_url():
    assert cutout_url("ibe/x.fits", 269.4463, 4.7677, 0.18) == (
        "https://irsa.ipac.caltech.edu/ibe/x.fits?center=269.4463,4.7677d&size=0.18"
    )


@pytest.mark.parametrize(
    "uri",
    [
        "http://evil.example/x.fits",
        "ibe/data/spherex/../../etc/passwd.fits",
        "ibe/data/spherex/a b.fits",
    ],
)
def test_check_uri_rejects(uri):
    with pytest.raises(ValueError):
        check_uri(uri)


def test_check_uri_accepts():
    check_uri(URI)


def test_fetch_caches_once(isolated_cache):
    calls: list = []
    client = client_serving(FIXTURE.read_bytes(), calls)
    first = fetch_cutout(URI, 269.4463, 4.7677, 0.18, client=client)
    second = fetch_cutout(URI, 269.4463, 4.7677, 0.18, client=client)
    assert first == second
    assert len(calls) == 1
    assert first.is_relative_to(isolated_cache / "cutouts")
    with fits.open(first) as hdul:
        assert "IMAGE" in [h.name for h in hdul]


def test_fetch_drops_epsf():
    with fits.open(FIXTURE) as hdul:
        extended = fits.HDUList([h.copy() for h in hdul])
    extended.append(fits.BinTableHDU.from_columns([fits.Column("a", "J", array=[1])], name="EPSF"))
    buf = io.BytesIO()
    extended.writeto(buf)
    path = fetch_cutout(URI, 1.0, 2.0, 0.18, client=client_serving(buf.getvalue()))
    with fits.open(path) as hdul:
        names = [h.name for h in hdul]
    assert "EPSF" not in names
    assert names == ["PRIMARY", "IMAGE", "FLAGS", "ZODI", "WCS-WAVE"]


def test_fetch_timeout_no_partial(isolated_cache):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(CutoutError):
        fetch_cutout(URI, 1.0, 2.0, 0.18, client=client)
    cache = isolated_cache / "cutouts"
    assert not cache.exists() or list(cache.iterdir()) == []


def test_downloads_semaphore_is_eight():
    assert cutouts.DOWNLOADS._value == 8
