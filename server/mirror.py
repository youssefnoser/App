"""Whole SPHEREx exposures from the public AWS mirror, with a size-capped disk cache.

The mirror (`nasa-irsa-spherex`, AWS Open Data) holds the same files as IRSA but
has no cutout service, so an exposure is downloaded whole (about 65 MB) and the
patches are cut from it here. One exposure is about 3.5 deg wide, so one download
serves every patch on screen for that blink step.

Kept on disk under cache_dir()/exposures/: IMAGE, FLAGS, ZODI and WCS-WAVE only,
with FLAGS stored uncompressed so a crop reads just the rows it needs (about
50 MB per exposure). When the folder passes `cache_cap_bytes()` the least
recently used files are deleted. The rendered PNGs live elsewhere and are kept.
"""

import fcntl
import hashlib
import math
import os
import tempfile
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from server.cutouts import CutoutError, cache_dir, check_uri
from server.http import make_client
from server.pixels import masked_pixels

MIRROR_BASE = "https://nasa-irsa-spherex.s3.amazonaws.com"
URI_PREFIX = "ibe/data/spherex/"
KEEP_HDUS = ("IMAGE", "FLAGS", "ZODI", "WCS-WAVE")
PIXEL_ARCSEC = 6.15
# 6 GB here, 3 GB of rendered caches (server/diskcache.py) and the ~0.8 GB
# exposure snapshot (meta/) keep the whole cache folder under 10 GB.
DEFAULT_CAP_GB = 6.0
# A download's .tmp files older than this were left by a server killed mid-download.
TMP_MAX_AGE_S = 3600.0

# Never more than 8 file downloads at once, the same cap the IRSA path uses.
MAX_DOWNLOADS = 8
DOWNLOADS = threading.Semaphore(MAX_DOWNLOADS)

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_evict_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=MAX_DOWNLOADS, thread_name_prefix="mirror")
_queued: set[str] = set()


def mirror_url(uri: str) -> str:
    """The mirror address of an archive path: the bucket key drops `ibe/data/spherex/`."""
    check_uri(uri)
    return f"{MIRROR_BASE}/{uri[len(URI_PREFIX):]}"


def cache_cap_bytes() -> int:
    """Size limit of the exposure cache: SPHEREX_EXPOSURE_CACHE_GB, default 6.
    A value that is not a finite number falls back to the default."""
    try:
        gb = float(os.environ.get("SPHEREX_EXPOSURE_CACHE_GB", DEFAULT_CAP_GB))
    except ValueError:
        gb = DEFAULT_CAP_GB
    if not math.isfinite(gb):
        gb = DEFAULT_CAP_GB
    return int(max(gb, 0.0) * 1e9)


def _folder() -> Path:
    return cache_dir() / "exposures"


def _cache_path(uri: str) -> Path:
    return _folder() / f"{hashlib.sha1(uri.encode()).hexdigest()}.fits"


def _lock_for(uri: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(uri, threading.Lock())


def _touch(path: Path) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


def _trim(raw: Path, out: Path) -> None:
    """Write the kept HDUs of `raw` to `out`, FLAGS as a plain int32 image."""
    try:
        with fits.open(raw, memmap=True) as hdul:
            names = [h.name for h in hdul]
            # all four are needed to draw a frame: Frame builds the wavelength
            # WCS from WCS-WAVE, so a file without it must not be cached
            missing = [n for n in KEEP_HDUS if n not in names]
            if missing:
                raise CutoutError(f"The archive file has no {', '.join(missing)} extension.")
            kept = [fits.PrimaryHDU(header=hdul[0].header)]
            for hdu in hdul[1:]:
                if hdu.name not in KEEP_HDUS:
                    continue
                if hdu.name == "FLAGS":
                    kept.append(fits.ImageHDU(np.asarray(hdu.data, dtype=np.int32),
                                              hdu.header, name="FLAGS"))
                elif hdu.name == "WCS-WAVE":
                    kept.append(fits.BinTableHDU(hdu.data, hdu.header, name="WCS-WAVE"))
                else:
                    kept.append(fits.ImageHDU(hdu.data, hdu.header, name=hdu.name))
            fits.HDUList(kept).writeto(out, overwrite=True)
    except CutoutError:
        raise
    except Exception as exc:
        raise CutoutError(f"The archive file is not valid FITS: {exc}") from exc


def fetch_exposure(uri: str, *, client: httpx.Client | None = None) -> Path:
    """Return the cached, trimmed exposure file, downloading it first if needed.

    Two requests for the same exposure share one download, across threads and
    across server worker processes. Raises ValueError for a
    bad uri and CutoutError if the mirror fails, times out or sends a broken file.
    No retries.
    """
    url = mirror_url(uri)
    path = _cache_path(uri)
    if path.exists():
        _touch(path)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    # Thread lock for this process, file lock for other server workers.
    with _lock_for(uri), open(path.with_suffix(".lock"), "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        if path.exists():
            _touch(path)
            return path
        fd, raw_name = tempfile.mkstemp(dir=path.parent, suffix=".raw.tmp")
        fd2, out_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        os.close(fd2)
        own_client = client is None
        client = client if client is not None else make_client()
        try:
            with os.fdopen(fd, "wb") as handle, DOWNLOADS:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    for chunk in response.iter_bytes(1 << 20):
                        handle.write(chunk)
            _trim(Path(raw_name), Path(out_name))
            os.replace(out_name, path)
        except (httpx.HTTPError, httpx.StreamError) as exc:
            raise CutoutError(f"The mirror did not return {uri}: {exc!r}") from exc
        except OSError as exc:  # disk full or a write error while storing it
            raise CutoutError(f"{uri} could not be stored in the cache: {exc}") from exc
        finally:
            Path(raw_name).unlink(missing_ok=True)
            Path(out_name).unlink(missing_ok=True)
            if own_client:
                client.close()
    evict(keep=path)
    return path


def evict(keep: Path | None = None) -> None:
    """Delete least recently used exposures until the cache is under its cap.

    `keep` is never deleted, so a cap smaller than one file still serves requests.
    Download `.tmp` files older than TMP_MAX_AGE_S are deleted (their server was
    killed mid-download); newer ones are downloads in progress and count towards
    the cap but are left alone.
    """
    with _evict_lock:
        entries, in_progress = [], 0
        now = time.time()
        for p in _folder().glob("*.tmp"):
            try:
                stat = p.stat()
            except OSError:
                continue
            if now - stat.st_mtime > TMP_MAX_AGE_S:
                p.unlink(missing_ok=True)
            else:
                in_progress += stat.st_size
        for p in _folder().glob("*.fits"):
            try:
                stat = p.stat()
            except OSError:
                continue
            entries.append((stat.st_mtime, stat.st_size, p))
        total = in_progress + sum(size for _, size, _ in entries)
        cap = cache_cap_bytes()
        for _, size, p in sorted(entries, key=lambda e: e[0]):
            if total <= cap:
                break
            if keep is not None and p == keep:
                continue
            p.unlink(missing_ok=True)
            _forget_frames(p)  # an open memmap would keep the deleted file on disk
            total -= size


def _shifted(header: fits.Header, x0: int, y0: int) -> fits.Header:
    """Copy of `header` whose every WCS (sky, 'A', wavelength 'W') follows the crop."""
    out = header.copy()
    for key in list(out.keys()):
        if key.startswith("CRPIX1"):
            out[key] = out[key] - x0
        elif key.startswith("CRPIX2"):
            out[key] = out[key] - y0
    return out


def _box(x: float, y: float, size_deg: float, shape: tuple[int, int]):
    """Detector-aligned crop bounds ((x0, x1), (y0, y1)) around pixel (x, y), clipped."""
    ny, nx = shape
    if not (np.isfinite(x) and np.isfinite(y)):
        raise CutoutError("This exposure does not cover that position.")
    half = int(np.ceil(size_deg * 3600.0 / 2.0 / PIXEL_ARCSEC * np.sqrt(2.0))) + 2
    cx, cy = int(round(x)), int(round(y))
    x0, x1 = max(cx - half, 0), min(cx + half + 1, nx)
    y0, y1 = max(cy - half, 0), min(cy + half + 1, ny)
    if x0 >= x1 or y0 >= y1:
        raise CutoutError("This exposure does not cover that position.")
    return (x0, x1), (y0, y1)


def cut(path: Path, ra: float, dec: float, size_deg: float) -> fits.HDUList:
    """Crop a cached exposure around (ra, dec) and return it as an in-memory HDUList.

    The box is detector-aligned and wide enough to hold a `size_deg` square at any
    roll angle (half-width = size/2 * sqrt(2), plus 2 pixels). It is clipped at the
    detector edge. NaN in the file stays NaN. Raises CutoutError when the position
    is off the detector or the file is unreadable (for example evicted meanwhile).
    """
    try:
        with fits.open(path, memmap=True) as hdul:
            header = hdul["IMAGE"].header
            ny, nx = int(header["NAXIS2"]), int(header["NAXIS1"])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # SIP without -SIP CTYPE, as in app.py
                x, y = WCS(header).world_to_pixel_values(ra, dec)
            (x0, x1), (y0, y1) = _box(float(x), float(y), size_deg, (ny, nx))
            out = [fits.PrimaryHDU(header=hdul[0].header.copy())]
            for name in ("IMAGE", "FLAGS", "ZODI"):
                data = np.array(hdul[name].data[y0:y1, x0:x1])
                out.append(fits.ImageHDU(data, _shifted(hdul[name].header, x0, y0), name=name))
            if "WCS-WAVE" in hdul:
                wave = hdul["WCS-WAVE"]
                out.append(fits.BinTableHDU(wave.data.copy(), wave.header.copy(), name="WCS-WAVE"))
            return fits.HDUList(out)
    except CutoutError:
        raise
    except Exception as exc:
        raise CutoutError(f"The cached exposure could not be read: {exc}") from exc


def frame_meta(header) -> dict:
    """The X-Frame-Meta fields an exposure's IMAGE header gives, the same for the
    mirror, IRSA and sequence paths. `mjd` is the average (MJD-AVG); `mjd_start`
    and `mjd_end` are MJD-BEG and MJD-END. Exposure lists use the start."""
    return {
        "mjd": float(header["MJD-AVG"]),
        "mjd_start": float(header["MJD-BEG"]),
        "mjd_end": float(header["MJD-END"]),
        "detector": int(header["DETECTOR"]),
        "obs_id": str(header["OBSID"]),
    }


class Frame:
    """One cached exposure, opened once: WCS objects built and pixel arrays mapped.

    Parsing the 275-card header and building the WCS costs far more than reading a
    patch, so a Frame is kept per file (`open_frame`) and every patch of that
    exposure reuses it. The lock serialises WCS calls, which are not thread-safe.
    """

    def __init__(self, path: Path):
        self.lock = threading.Lock()
        with fits.open(path, memmap=True) as hdul, warnings.catch_warnings():
            warnings.simplefilter("ignore")  # SIP without -SIP CTYPE; applying it is intended
            header = hdul["IMAGE"].header
            self.shape = (int(header["NAXIS2"]), int(header["NAXIS1"]))
            self.meta = frame_meta(header)
            self.sky = WCS(header)
            self.wave = WCS(header, fobj=hdul, key="W")
            self.wave.sip = None
            self._maps = {}
            for name, dtype in (("IMAGE", ">f4"), ("FLAGS", ">i4"), ("ZODI", ">f4")):
                hdu = hdul[name]
                if hdu.header["BITPIX"] != (-32 if dtype == ">f4" else 32) or "BZERO" in hdu.header:
                    raise CutoutError(f"Unexpected pixel format in {name}.")
                self._maps[name] = np.memmap(path, dtype=dtype, mode="r",
                                             offset=hdu.fileinfo()["datLoc"], shape=self.shape)

    def science_crop(self, ra: float, dec: float, size_deg: float):
        """`IMAGE - ZODI` with bad pixels NaN around (ra, dec), and its (x0, y0) origin.

        Same box as `cut`, same masking as `pixels.science_image`. Raises CutoutError
        when the position is off the detector.
        """
        with self.lock:
            x, y = self.sky.world_to_pixel_values(ra, dec)
        box = _box(float(x), float(y), size_deg, self.shape)
        (x0, x1), (y0, y1) = box
        image = np.array(self._maps["IMAGE"][y0:y1, x0:x1], dtype=np.float32)
        zodi = np.array(self._maps["ZODI"][y0:y1, x0:x1], dtype=np.float32)
        flags = np.array(self._maps["FLAGS"][y0:y1, x0:x1], dtype=np.int64)
        out = np.where(masked_pixels(flags), np.float32(np.nan), image - zodi)
        return out.astype(np.float32, copy=False), (x0, y0)

    def wavelength(self, ra: float, dec: float) -> tuple[float, float]:
        """Wavelength and bandwidth in micrometres, as `reproject.wavelength_at`."""
        ny, nx = self.shape
        with self.lock:
            x, y = self.sky.world_to_pixel_values(ra, dec)
            x = float(np.clip(x, 0, nx - 1))
            y = float(np.clip(y, 0, ny - 1))
            wl, bw = self.wave.pixel_to_world_values(x, y)
        return float(wl), float(bw)


_frames: dict[tuple[str, int], Frame] = {}
_frames_guard = threading.Lock()
MAX_OPEN_FRAMES = 48


def _forget_frames(path: Path) -> None:
    """Drop the open Frames of a file, so their memmaps (and the disk space of a
    deleted file) are released once no request is still using them."""
    with _frames_guard:
        for key in [k for k in _frames if k[0] == str(path)]:
            del _frames[key]


def open_frame(path: Path) -> Frame:
    """The shared Frame for a cached exposure file. Raises CutoutError if unreadable.

    A new Frame is built outside the shared lock (it parses the header and builds
    two WCS), so threads opening other files, or files already open, do not wait
    on it. Two threads building the same Frame at once keep the first one stored.
    A cached file that cannot be read is deleted, so the next request downloads
    it again instead of failing on it until it is evicted.
    """
    try:
        key = (str(path), path.stat().st_ino)
    except OSError as exc:  # evicted meanwhile
        raise CutoutError(f"The cached exposure could not be read: {exc}") from exc
    with _frames_guard:
        frame = _frames.pop(key, None)
        if frame is not None:
            _frames[key] = frame  # most recently used last
            return frame
    try:
        built = Frame(path)
    except Exception as exc:
        if path.parent == _folder():  # only ever delete our own cache files
            path.unlink(missing_ok=True)
        if isinstance(exc, CutoutError):
            raise
        raise CutoutError(f"The cached exposure could not be read: {exc}") from exc
    with _frames_guard:
        frame = _frames.pop(key, built)
        _frames[key] = frame
        while len(_frames) > MAX_OPEN_FRAMES:
            _frames.pop(next(iter(_frames)))
    return frame


def prefetch(uris) -> None:
    """Start background downloads so the first requests do not queue behind one file.

    Returns at once. Failures are dropped here: the request that needs the file
    will try once more and report the error to the user.
    """
    def job(uri: str) -> None:
        try:
            fetch_exposure(uri)
        except (CutoutError, ValueError):
            pass
        finally:
            _queued.discard(uri)

    for uri in uris:
        if uri in _queued or _cache_path(uri).exists():
            continue
        _queued.add(uri)
        _pool.submit(job, uri)
