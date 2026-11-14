"""Size cap and expiry for the rendered-frame caches (server/diskcache.py). Offline."""

import os
import time

import pytest

from server import diskcache


def put(root, rel, size, age_s):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    stamp = time.time() - age_s
    os.utime(path, (stamp, stamp))
    return path


def test_prune_deletes_least_recently_used_until_under_cap(tmp_path):
    old = put(tmp_path, "png/v2/a.png", 400, age_s=300)
    mid = put(tmp_path, "grids/v2/ab/b.npz", 400, age_s=200)
    new = put(tmp_path, "cutouts/c.fits", 400, age_s=100)
    diskcache.prune(tmp_path, cap_bytes=900, tap_max_age_s=1e9)
    assert not old.exists()
    assert mid.exists() and new.exists()


def test_prune_never_touches_the_snapshot_or_the_exposure_cache(tmp_path):
    snapshot = put(tmp_path, "meta/exposures.sqlite", 1000, age_s=10_000)
    exposure = put(tmp_path, "exposures/e.fits", 1000, age_s=10_000)
    put(tmp_path, "png/v2/a.png", 10, age_s=1)
    diskcache.prune(tmp_path, cap_bytes=0, tap_max_age_s=1e9)
    assert snapshot.exists() and exposure.exists()


def test_prune_deletes_expired_cell_lists_even_under_cap(tmp_path):
    stale = put(tmp_path, "tap/1.json", 10, age_s=2 * 86400)
    fresh = put(tmp_path, "tap/2.json", 10, age_s=60)
    diskcache.prune(tmp_path, cap_bytes=10**9, tap_max_age_s=86400)
    assert not stale.exists() and fresh.exists()


def test_prune_deletes_abandoned_temporary_files_only(tmp_path):
    abandoned = put(tmp_path, "png/v2/x.tmp", 10, age_s=2 * 3600)
    writing = put(tmp_path, "png/v2/y.tmp", 10, age_s=5)
    diskcache.prune(tmp_path, cap_bytes=10**9, tap_max_age_s=1e9)
    assert not abandoned.exists() and writing.exists()


def test_prune_without_cache_folders_is_harmless(tmp_path):
    diskcache.prune(tmp_path / "missing", cap_bytes=0, tap_max_age_s=0)


def test_cap_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("SPHEREX_RENDER_CACHE_GB", "2.5")
    assert diskcache.cap_bytes() == 2_500_000_000
    for bad in ("lots", "nan", "inf", "-inf"):
        monkeypatch.setenv("SPHEREX_RENDER_CACHE_GB", bad)
        assert diskcache.cap_bytes() == int(diskcache.DEFAULT_CAP_GB * 1e9)


def test_touch_marks_a_file_as_recently_used(tmp_path):
    path = put(tmp_path, "png/v2/a.png", 10, age_s=3600)
    diskcache.touch(path)
    assert time.time() - path.stat().st_mtime < 60
    diskcache.touch(tmp_path / "gone.png")  # a file deleted meanwhile is not an error


def test_writes_trigger_a_prune_every_so_often(monkeypatch):
    runs = []
    clock = [1000.0]
    monkeypatch.setattr(diskcache, "PRUNE_EVERY", 3)
    monkeypatch.setattr(diskcache, "PRUNE_MIN_INTERVAL_S", 60.0)
    monkeypatch.setattr(diskcache, "_writes", 0)
    monkeypatch.setattr(diskcache, "_last_prune", 0.0)
    monkeypatch.setattr(diskcache.time, "monotonic", lambda: clock[0])
    for _ in range(7):
        diskcache.note_write(spawn=lambda: runs.append(1))
    assert len(runs) == 1  # the second batch of 3 came within a minute
    clock[0] += 61
    for _ in range(3):
        diskcache.note_write(spawn=lambda: runs.append(1))
    assert len(runs) == 2


def test_a_started_prune_resets_the_interval(monkeypatch, tmp_path):
    runs = []
    monkeypatch.setattr(diskcache, "PRUNE_EVERY", 1)
    monkeypatch.setattr(diskcache, "_writes", 0)
    monkeypatch.setattr(diskcache, "_last_prune", float("-inf"))
    monkeypatch.setattr(diskcache, "prune", lambda *a: None)
    diskcache.prune_in_background(tmp_path)  # e.g. the one at server start
    diskcache.note_write(spawn=lambda: runs.append(1))
    assert runs == []


def test_frame_cache_hit_counts_as_use(tmp_path, monkeypatch):
    """A frame served from disk is marked as used, so the prune keeps it longest."""
    from pathlib import Path

    from fastapi.testclient import TestClient

    import server.app as app_module

    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("SPHEREX_SOURCE", "irsa")
    fixture = Path(__file__).parent / "fixtures" / "crop_barnard_D6_2026-03-19.fits"
    monkeypatch.setattr(app_module, "fetch_cutout", lambda *a, **k: fixture)
    client = TestClient(app_module.app)
    url = "/api/patch/2034010/frame.png?uri=ibe/data/spherex/x.fits"
    assert client.get(url).status_code == 200
    (png,) = (tmp_path / "png").rglob("*.png")
    stamp = time.time() - 3600
    os.utime(png, (stamp, stamp))
    assert client.get(url).status_code == 200
    assert png.stat().st_mtime == pytest.approx(time.time(), abs=60)
