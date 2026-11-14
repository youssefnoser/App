"""Crop an exposure straight from the AWS mirror with byte-range requests.

A whole Level-2 file is about 65 MB, but a view needs a few hundred rows of
three arrays. This module reads only those: about 4 MB for a 0.3 degree view,
so a detector's whole time sequence loads in seconds without a prepared cache.

What is fetched for one crop:
  1. the first 28,800 bytes (primary and IMAGE headers), to place the box;
  2. the IMAGE rows of the box (uncompressed float32, one contiguous range);
  3. the FLAGS header and its row index, then the compressed rows of the box
     (FLAGS is a Rice-compressed image, one tile per row);
  4. the VARIANCE and ZODI headers (to find where ZODI starts), then ZODI rows;
  5. the last 5,760 bytes, which hold the WCS-WAVE lookup table.
Where each part starts is the same every time for one file, so that layout is
remembered in memory and later crops of the same file skip the header requests.

`fetch_crop` returns the same thing as `mirror.cut`: an in-memory HDUList with
IMAGE, FLAGS, ZODI (cropped, WCS shifted) and WCS-WAVE. NaN in the file stays NaN.
"""

import io
import threading
import warnings
from dataclasses import dataclass

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from server.cutouts import CutoutError
from server.http import tls_verify
from server.mirror import _box, _shifted, mirror_url

BLOCK = 2880
HEAD_BYTES = 28_800
TAIL_BYTES = 5_760
MAX_LAYOUTS = 4096

_client: httpx.Client | None = None
_client_guard = threading.Lock()


def client() -> httpx.Client:
    """One shared keep-alive client: a new TLS handshake per range would cost a second."""
    global _client
    with _client_guard:
        if _client is None:
            limits = httpx.Limits(max_connections=32, max_keepalive_connections=32)
            _client = httpx.Client(timeout=60.0, verify=tls_verify(), limits=limits)
        return _client


@dataclass
class Layout:
    """Where the parts of one archive file are, plus the headers already parsed."""
    primary: fits.Header
    image: fits.Header
    image_data: int
    flags_header_bytes: bytes
    flags: fits.Header          # the compressed table's own header
    flags_table: int            # offset of the row index
    flags_index: np.ndarray     # (rows, 2) int: byte length and heap offset per row
    flags_heap: int             # offset of the compressed rows
    zodi: fits.Header
    zodi_data: int
    wave: fits.BinTableHDU
    sky: WCS
    lock: threading.Lock


_layouts: dict[str, Layout] = {}
_layouts_guard = threading.Lock()


def _get(http: httpx.Client, url: str, start: int, stop: int) -> bytes:
    """Bytes start..stop-1 of the file. Raises CutoutError on any HTTP failure."""
    try:
        response = http.get(url, headers={"Range": f"bytes={start}-{stop - 1}"})
        response.raise_for_status()
        return response.content
    except httpx.HTTPError as exc:
        raise CutoutError(f"The mirror did not return part of the file: {exc!r}") from exc


def _header_at(http: httpx.Client, url: str, offset: int, first: bytes = b""):
    """(header, raw header bytes, offset of the data) for the HDU starting at `offset`."""
    raw = first
    while True:
        end = -1
        for i in range(0, len(raw) - 79, 80):
            if raw[i:i + 8] == b"END     ":
                end = i
                break
        if end >= 0:
            length = (end // BLOCK + 1) * BLOCK
            if len(raw) < length:
                raw += _get(http, url, offset + len(raw), offset + length)
            text = raw[:length].decode("ascii", "replace")
            return fits.Header.fromstring(text), raw[:length], offset + length
        if len(raw) > 40 * BLOCK:
            raise CutoutError("The archive file has a header with no END card.")
        raw += _get(http, url, offset + len(raw), offset + len(raw) + 6 * BLOCK)


def _data_bytes(header: fits.Header) -> int:
    """Padded size of an HDU's data from its header."""
    size = abs(int(header["BITPIX"])) // 8
    for axis in range(1, int(header["NAXIS"]) + 1):
        size *= int(header[f"NAXIS{axis}"])
    if int(header["NAXIS"]) == 0:
        size = 0
    size += int(header.get("PCOUNT", 0))
    return (size + BLOCK - 1) // BLOCK * BLOCK


def _layout(http: httpx.Client, url: str) -> Layout:
    with _layouts_guard:
        known = _layouts.get(url)
    if known is not None:
        return known
    try:
        head = _get(http, url, 0, HEAD_BYTES)
        primary, _, offset = _header_at(http, url, 0, head)
        image, _, image_data = _header_at(http, url, offset, head[offset:])
        if image.get("EXTNAME") != "IMAGE" or int(image["BITPIX"]) != -32:
            raise CutoutError("The archive file does not start with a float IMAGE extension.")
        offset = image_data + _data_bytes(image)
        flags, flags_raw, flags_table = _header_at(http, url, offset)
        if flags.get("EXTNAME") != "FLAGS" or not flags.get("ZIMAGE", False):
            raise CutoutError("FLAGS is not a compressed image as expected.")
        if int(flags.get("ZTILE1", flags["ZNAXIS1"])) != int(flags["ZNAXIS1"]) \
                or int(flags.get("ZTILE2", 1)) != 1 or int(flags["TFIELDS"]) != 1:
            raise CutoutError("FLAGS is not compressed one row per tile.")
        rows, width = int(flags["NAXIS2"]), int(flags["NAXIS1"])
        if width != 8:
            raise CutoutError("FLAGS row index has an unexpected layout.")
        index = np.frombuffer(_get(http, url, flags_table, flags_table + rows * width),
                              dtype=">i4").reshape(rows, 2).astype(np.int64)
        flags_heap = flags_table + int(flags.get("THEAP", rows * width))
        offset = flags_table + _data_bytes(flags)
        name = ""
        for _ in range(4):  # VARIANCE normally sits between FLAGS and ZODI
            header, _, data = _header_at(http, url, offset)
            name = header.get("EXTNAME", "")
            if name == "ZODI":
                break
            offset = data + _data_bytes(header)
        if name != "ZODI" or int(header["BITPIX"]) != -32:
            raise CutoutError("The archive file has no float ZODI extension where expected.")
        try:
            tail = http.get(url, headers={"Range": f"bytes=-{TAIL_BYTES}"})
            tail.raise_for_status()
        except httpx.HTTPError as exc:
            raise CutoutError(f"The mirror did not return part of the file: {exc!r}") from exc
        stub = fits.PrimaryHDU().header.tostring().encode()
        with fits.open(io.BytesIO(stub + tail.content)) as hdul:
            table = hdul[1]
            if table.name != "WCS-WAVE":
                raise CutoutError("The archive file does not end with the WCS-WAVE table.")
            wave = fits.BinTableHDU(table.data.copy(), table.header.copy(), name="WCS-WAVE")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # SIP without -SIP CTYPE; applying it is intended
            sky = WCS(image)
    except CutoutError:
        raise
    except Exception as exc:
        raise CutoutError(f"The archive file could not be read: {exc}") from exc
    layout = Layout(primary, image, image_data, flags_raw, flags, flags_table, index,
                    flags_heap, header, data, wave, sky, threading.Lock())
    with _layouts_guard:
        if len(_layouts) >= MAX_LAYOUTS:
            _layouts.pop(next(iter(_layouts)))
        _layouts[url] = layout
    return layout


def _float_rows(http, url, data: int, nx: int, y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
    raw = _get(http, url, data + y0 * nx * 4, data + y1 * nx * 4)
    return np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, nx)[:, x0:x1].astype(np.float32)


def _flag_rows(http, url, layout: Layout, y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
    """Decompress FLAGS rows y0..y1-1 by handing astropy a small file holding only them."""
    index = layout.flags_index[y0:y1]
    start = int(index[:, 1].min())
    stop = int((index[:, 1] + index[:, 0]).max())
    heap = _get(http, url, layout.flags_heap + start, layout.flags_heap + stop)
    header = layout.flags.copy()
    rows = y1 - y0
    header["NAXIS2"] = rows
    header["ZNAXIS2"] = rows
    header["PCOUNT"] = len(heap)
    header.remove("THEAP", ignore_missing=True)
    table = index.copy()
    table[:, 1] -= start
    body = table.astype(">i4").tobytes() + heap
    body += b"\0" * (-len(body) % BLOCK)
    stub = fits.PrimaryHDU().header.tostring().encode()
    with fits.open(io.BytesIO(stub + header.tostring().encode() + body)) as hdul:
        return np.asarray(hdul[1].data, dtype=np.int32)[:, x0:x1].copy()


def fetch_crop(
    uri: str, ra: float, dec: float, size_deg: float, *, http: httpx.Client | None = None
) -> fits.HDUList:
    """Crop of one exposure around (ra, dec), read from the mirror by byte ranges.

    Same box and same result as `mirror.cut`. Raises ValueError for a bad uri and
    CutoutError when the position is off the detector or the mirror fails. No retries.
    """
    url = mirror_url(uri)
    http = http if http is not None else client()
    layout = _layout(http, url)
    ny, nx = int(layout.image["NAXIS2"]), int(layout.image["NAXIS1"])
    with layout.lock:
        x, y = layout.sky.world_to_pixel_values(ra, dec)
    (x0, x1), (y0, y1) = _box(float(x), float(y), size_deg, (ny, nx))
    try:
        image = _float_rows(http, url, layout.image_data, nx, y0, y1, x0, x1)
        zodi = _float_rows(http, url, layout.zodi_data, nx, y0, y1, x0, x1)
        flags = _flag_rows(http, url, layout, y0, y1, x0, x1)
    except CutoutError:
        raise
    except Exception as exc:
        raise CutoutError(f"The exposure rows could not be read: {exc}") from exc
    flags_header = layout.image.copy()
    return fits.HDUList([
        fits.PrimaryHDU(header=layout.primary.copy()),
        fits.ImageHDU(image, _shifted(layout.image, x0, y0), name="IMAGE"),
        fits.ImageHDU(flags, _shifted(flags_header, x0, y0), name="FLAGS"),
        fits.ImageHDU(zodi, _shifted(layout.zodi, x0, y0), name="ZODI"),
        fits.BinTableHDU(layout.wave.data.copy(), layout.wave.header.copy(), name="WCS-WAVE"),
    ])
