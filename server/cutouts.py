"""Download SPHEREx image cutouts from IRSA and keep a trimmed copy on disk.

A cutout is cached under cache_dir()/cutouts/, keyed by the exposure URI and the
requested sky box. Only the extensions the tool uses are kept (the full
cutouts carry large PSF tables we never read). Files are written under a
temporary name and renamed, so an interrupted download leaves nothing behind.
"""

import hashlib
import io
import os
import re
import tempfile
import threading
from pathlib import Path

import httpx
from astropy.io import fits

from server import diskcache
from server.http import make_client

IRSA_BASE = "https://irsa.ipac.caltech.edu"
URI_RE = re.compile(r"^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$")
KEEP_HDUS = ("PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")

# IRSA is a shared public service: never more than 8 downloads at once.
DOWNLOADS = threading.Semaphore(8)


class CutoutError(Exception):
    """IRSA did not return a usable cutout."""


def check_uri(uri: str) -> None:
    """Raise ValueError unless uri is a SPHEREx file path under ibe/data/spherex/."""
    if not URI_RE.fullmatch(uri) or ".." in uri:
        raise ValueError(f"Not a SPHEREx file path: {uri!r}")


def cutout_url(uri: str, ra: float, dec: float, size_deg: float) -> str:
    return f"{IRSA_BASE}/{uri}?center={ra},{dec}d&size={size_deg}"


def cache_dir() -> Path:
    """Where the disk caches live: SPHEREX_CACHE_DIR, default `.cache` beside the
    code. A Vercel function bundle is read-only and /tmp is the only writable
    place (ephemeral, empty on cold start), so a Vercel function defaults to
    /tmp/spherex-cache."""
    env = os.environ.get("SPHEREX_CACHE_DIR")
    if env:
        return Path(env)
    if os.environ.get("VERCEL"):
        return Path("/tmp/spherex-cache")
    return Path(".cache")


def _cache_path(uri: str, ra: float, dec: float, size_deg: float) -> Path:
    key = hashlib.sha1(f"{uri}|{ra:.6f}|{dec:.6f}|{size_deg:.4f}".encode()).hexdigest()
    return cache_dir() / "cutouts" / f"{key}.fits"


def _trim(body: bytes) -> bytes:
    """Return FITS bytes holding only the HDUs in KEEP_HDUS that are present."""
    try:
        with fits.open(io.BytesIO(body)) as hdul:
            kept = fits.HDUList([h.copy() for h in hdul if h.name in KEEP_HDUS])
            if "IMAGE" not in [h.name for h in kept]:
                raise CutoutError("IRSA returned a file with no IMAGE extension.")
            out = io.BytesIO()
            kept.writeto(out)
            return out.getvalue()
    except CutoutError:
        raise
    except Exception as exc:
        raise CutoutError(f"IRSA returned a file that is not valid FITS: {exc}") from exc


def fetch_cutout(
    uri: str, ra: float, dec: float, size_deg: float, *, client: httpx.Client | None = None
) -> Path:
    """Return the path of the cached cutout, downloading it first if needed.

    Raises ValueError for a bad uri and CutoutError if IRSA fails or times out.
    """
    check_uri(uri)
    path = _cache_path(uri, ra, dec, size_deg)
    if path.exists():
        diskcache.touch(path)
        return path

    own_client = client is None
    client = client if client is not None else make_client()
    try:
        with DOWNLOADS:
            response = client.get(cutout_url(uri, ra, dec, size_deg))
            response.raise_for_status()
            body = response.content
    except httpx.HTTPError as exc:
        raise CutoutError(f"IRSA did not return the cutout for {uri}: {exc!r}") from exc
    finally:
        if own_client:
            client.close()

    data = _trim(body)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    diskcache.note_write(lambda: diskcache.prune_in_background(cache_dir()))
    return path
