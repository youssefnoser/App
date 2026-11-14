"""Offline tests for cropping an exposure from the mirror by byte ranges."""

import warnings
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from server import ranges
from server.cutouts import CutoutError
from server.mirror import cut, fetch_exposure
from server.ranges import fetch_crop
from tests.test_mirror import FIXTURE, URI, archive_file


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    ranges._layouts.clear()


def range_server(body: bytes, log: list | None = None, fail_after: int | None = None):
    """A mock mirror that honours Range headers, including suffix ranges."""
    def handler(request: httpx.Request) -> httpx.Response:
        spec = request.headers["Range"].removeprefix("bytes=")
        if log is not None:
            log.append(spec)
        if fail_after is not None and len(log or []) > fail_after:
            return httpx.Response(503)
        if spec.startswith("-"):
            return httpx.Response(206, content=body[-int(spec[1:]):])
        start, stop = spec.split("-")
        return httpx.Response(206, content=body[int(start):int(stop) + 1])

    return httpx.Client(transport=httpx.MockTransport(handler))


def sky_of(x, y):
    with fits.open(FIXTURE) as full, warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ra, dec = WCS(full["IMAGE"].header).pixel_to_world_values(x, y)
    return float(ra), float(dec)


def whole_file_crop(body, ra, dec, size):
    served = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=body)))
    return cut(fetch_exposure(URI, client=served), ra, dec, size)


@pytest.mark.parametrize("pixel", [(20.0, 9.0), (1.0, 27.0), (14.0, 14.0)])
def test_range_crop_equals_whole_file_crop(pixel):
    body = archive_file()
    ra, dec = sky_of(*pixel)
    want = whole_file_crop(body, ra, dec, 0.004)
    got = fetch_crop(URI, ra, dec, 0.004, http=range_server(body))
    assert [h.name for h in got] == ["PRIMARY", "IMAGE", "FLAGS", "ZODI", "WCS-WAVE"]
    for name in ("IMAGE", "FLAGS", "ZODI"):
        np.testing.assert_array_equal(got[name].data, want[name].data)
        assert got[name].header["CRPIX1"] == want[name].header["CRPIX1"]
        assert got[name].header["CRPIX2"] == want[name].header["CRPIX2"]


def test_range_crop_gives_the_same_wavelength():
    from server.reproject import wavelength_at

    body = archive_file()
    ra, dec = sky_of(20.0, 9.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        want = wavelength_at(whole_file_crop(body, ra, dec, 0.004), ra, dec)
        got = wavelength_at(fetch_crop(URI, ra, dec, 0.004, http=range_server(body)), ra, dec)
    assert got == pytest.approx(want, rel=1e-6)


def test_second_crop_of_a_file_asks_only_for_pixel_rows():
    body = archive_file()
    log = []
    http = range_server(body, log)
    ra, dec = sky_of(20.0, 9.0)
    fetch_crop(URI, ra, dec, 0.004, http=http)
    first = len(log)
    fetch_crop(URI, *sky_of(8.0, 20.0), 0.004, http=http)
    assert len(log) - first == 3  # IMAGE rows, ZODI rows, FLAGS rows
    assert first > 3


def test_never_downloads_the_whole_file():
    body = archive_file()
    log = []
    fetch_crop(URI, *sky_of(20.0, 9.0), 0.004, http=range_server(body, log))
    assert all(spec != "0-" for spec in log)


def test_off_the_detector_is_cutout_error():
    with pytest.raises(CutoutError):
        fetch_crop(URI, *sky_of(500.0, 500.0), 0.004, http=range_server(archive_file()))


def test_mirror_failure_is_cutout_error():
    log = []
    with pytest.raises(CutoutError):
        fetch_crop(URI, *sky_of(20.0, 9.0), 0.004,
                   http=range_server(archive_file(), log, fail_after=2))


def test_bad_uri_is_rejected():
    with pytest.raises(ValueError):
        fetch_crop("http://evil.example/x.fits", 1.0, 1.0, 0.004, http=range_server(b""))
