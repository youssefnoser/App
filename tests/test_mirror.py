"""Offline tests for whole-exposure download from the AWS mirror and local crops."""

import io
import os
import warnings
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from server import mirror
from server.cutouts import CutoutError
from server.mirror import cut, evict, fetch_exposure, mirror_url

FIXTURE = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"
URI = "ibe/data/spherex/dr1/level2/w/v/6/level2_x.fits"


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path / "cache"))
    return tmp_path / "cache"


def archive_file() -> bytes:
    """The fixture dressed as an archive file: Rice-compressed FLAGS plus unused HDUs."""
    with fits.open(FIXTURE) as hdul:
        out = fits.HDUList([
            fits.PrimaryHDU(header=hdul[0].header),
            fits.ImageHDU(hdul["IMAGE"].data, hdul["IMAGE"].header, name="IMAGE"),
            fits.CompImageHDU(hdul["FLAGS"].data, hdul["FLAGS"].header, name="FLAGS",
                              compression_type="RICE_1"),
            fits.ImageHDU(hdul["IMAGE"].data * 0 + 1, name="VARIANCE"),
            fits.ImageHDU(hdul["ZODI"].data, hdul["ZODI"].header, name="ZODI"),
            fits.ImageHDU(np.zeros((4, 4), dtype=np.float32), name="EPSF"),
            fits.BinTableHDU(hdul["WCS-WAVE"].data, hdul["WCS-WAVE"].header, name="WCS-WAVE"),
        ])
        buf = io.BytesIO()
        out.writeto(buf)
        return buf.getvalue()


def client_serving(body, counter=None, status=200):
    def handler(request):
        if counter is not None:
            counter.append(str(request.url))
        return httpx.Response(status, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_mirror_url_drops_the_ibe_prefix():
    assert mirror_url(URI) == (
        "https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/w/v/6/level2_x.fits"
    )


def test_bad_uri_is_rejected_before_any_request():
    calls = []
    with pytest.raises(ValueError):
        fetch_exposure("http://evil.example/x.fits", client=client_serving(b"", calls))
    assert calls == []


def test_fetch_keeps_only_used_hdus_and_plain_flags():
    path = fetch_exposure(URI, client=client_serving(archive_file()))
    with fits.open(path) as got, fits.open(FIXTURE) as want:
        assert [h.name for h in got] == ["PRIMARY", "IMAGE", "FLAGS", "ZODI", "WCS-WAVE"]
        assert isinstance(got["FLAGS"], fits.ImageHDU)
        np.testing.assert_array_equal(got["FLAGS"].data, want["FLAGS"].data)
        np.testing.assert_array_equal(got["IMAGE"].data, want["IMAGE"].data)
        np.testing.assert_array_equal(got["ZODI"].data, want["ZODI"].data)


def test_second_fetch_uses_the_cache():
    calls = []
    client = client_serving(archive_file(), calls)
    assert fetch_exposure(URI, client=client) == fetch_exposure(URI, client=client)
    assert len(calls) == 1


def test_http_error_is_cutout_error_and_leaves_nothing(isolated_cache):
    with pytest.raises(CutoutError):
        fetch_exposure(URI, client=client_serving(b"gone", status=404))
    assert list(isolated_cache.rglob("*.fits")) == []
    assert list(isolated_cache.rglob("*.tmp")) == []


def test_not_fits_is_cutout_error(isolated_cache):
    with pytest.raises(CutoutError):
        fetch_exposure(URI, client=client_serving(b"<html>nope</html>"))
    assert list(isolated_cache.rglob("*.fits")) == []


def test_evict_drops_least_recently_used_first(isolated_cache, monkeypatch):
    folder = isolated_cache / "exposures"
    folder.mkdir(parents=True)
    for i, name in enumerate(["old", "mid", "new"]):
        p = folder / f"{name}.fits"
        p.write_bytes(b"x" * 1000)
        os.utime(p, (1000 + i, 1000 + i))
    monkeypatch.setattr(mirror, "cache_cap_bytes", lambda: 2500)
    evict()
    assert sorted(p.stem for p in folder.glob("*.fits")) == ["mid", "new"]


def test_evict_never_drops_the_file_just_stored(isolated_cache, monkeypatch):
    folder = isolated_cache / "exposures"
    folder.mkdir(parents=True)
    only = folder / "only.fits"
    only.write_bytes(b"x" * 1000)
    monkeypatch.setattr(mirror, "cache_cap_bytes", lambda: 10)
    evict(keep=only)
    assert only.exists()


def test_cache_hit_refreshes_recency(isolated_cache):
    client = client_serving(archive_file())
    path = fetch_exposure(URI, client=client)
    os.utime(path, (1000, 1000))
    fetch_exposure(URI, client=client)
    assert path.stat().st_mtime > 1000


def sky_of(header, x, y):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ra, dec = WCS(header).pixel_to_world_values(x, y)
    return float(ra), float(dec)


def test_cut_keeps_pixels_and_sky_positions():
    path = fetch_exposure(URI, client=client_serving(archive_file()))
    with fits.open(FIXTURE) as full:
        header = full["IMAGE"].header
        ra, dec = sky_of(header, 20.0, 9.0)
        # 0.004 deg box: half-width ceil(0.002*3600/6.15*1.4143)+2 = 4 px around (20, 9)
        crop = cut(path, ra, dec, 0.004)
        want = full["IMAGE"].data[5:14, 16:25]
        np.testing.assert_array_equal(crop["IMAGE"].data, want)
        np.testing.assert_array_equal(crop["FLAGS"].data, full["FLAGS"].data[5:14, 16:25])
        np.testing.assert_array_equal(crop["ZODI"].data, full["ZODI"].data[5:14, 16:25])
        # pixel (4, 4) of the crop is pixel (20, 9) of the full image: same sky
        got = sky_of(crop["IMAGE"].header, 4.0, 4.0)
        assert got == pytest.approx((ra, dec), abs=1e-7)
        # the wavelength lookup axis is shifted with the pixels
        assert crop["IMAGE"].header["CRPIX1W"] == header["CRPIX1W"] - 16
        assert crop["IMAGE"].header["CRPIX2W"] == header["CRPIX2W"] - 5


def test_cut_clips_at_the_detector_edge():
    path = fetch_exposure(URI, client=client_serving(archive_file()))
    with fits.open(FIXTURE) as full:
        ra, dec = sky_of(full["IMAGE"].header, 1.0, 27.0)
    crop = cut(path, ra, dec, 0.004)
    assert crop["IMAGE"].data.shape == (6, 6)  # rows 23..28, columns 0..5


def test_cut_off_the_detector_is_cutout_error():
    path = fetch_exposure(URI, client=client_serving(archive_file()))
    with fits.open(FIXTURE) as full:
        ra, dec = sky_of(full["IMAGE"].header, 500.0, 500.0)
    with pytest.raises(CutoutError):
        cut(path, ra, dec, 0.004)


def test_cut_gives_the_same_wavelength_as_the_full_file():
    from server.reproject import wavelength_at

    path = fetch_exposure(URI, client=client_serving(archive_file()))
    with fits.open(FIXTURE) as full:
        ra, dec = sky_of(full["IMAGE"].header, 20.0, 9.0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            want = wavelength_at(full, ra, dec)
            got = wavelength_at(cut(path, ra, dec, 0.004), ra, dec)
    assert got == pytest.approx(want, rel=1e-6)
