"""Wavelength an exposure records at a sky position, without downloading its pixels.

Each detector sits behind a filter whose colour changes steadily across it, so
the wavelength an exposure sees at a point depends only on which detector it is
and where on the detector the point lands. The landing pixel comes from the
exposure's footprint (four corners, in the order pixel (0,0), (nx,0), (nx,ny),
(0,ny), as IRSA's `poly` and `server/footprint.py` both give them). The
pixel-to-wavelength map is the detector's WCS-WAVE table, read once per detector
from any one of its files (a few kilobytes by range request).

Good to a few pixels (the footprint ignores optical distortion inside the
detector), which is under 0.002 micron. Fine for choosing frames, not for science.
"""

import math
import threading
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from server import ranges
from server.mirror import mirror_url

DETECTOR_PIXELS = 2040

_maps: dict[int, tuple[WCS, threading.Lock]] = {}
_maps_guard = threading.Lock()


def _plane(ra: float, dec: float, ra0: float, dec0: float) -> tuple[float, float]:
    """Gnomonic (tangent plane) coordinates of a point about (ra0, dec0), in radians."""
    a, d, a0, d0 = map(math.radians, (ra, dec, ra0, dec0))
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    return (math.cos(d) * math.sin(a - a0) / cosc,
            (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / cosc)


def pixel_in_footprint(footprint, ra: float, dec: float,
                       size: int = DETECTOR_PIXELS) -> tuple[float, float]:
    """Detector pixel (x, y), 0-based, where (ra, dec) lands in a four-corner footprint.

    Solves the bilinear map of the unit square onto the footprint on the tangent
    plane at the point. A point outside the footprint gives a pixel outside 0..size.
    """
    p00, p10, p11, p01 = (_plane(r, d, ra, dec) for r, d in footprint)
    s = t = 0.5
    for _ in range(20):
        fx = (1 - s) * (1 - t) * p00[0] + s * (1 - t) * p10[0] + s * t * p11[0] + (1 - s) * t * p01[0]
        fy = (1 - s) * (1 - t) * p00[1] + s * (1 - t) * p10[1] + s * t * p11[1] + (1 - s) * t * p01[1]
        dxs = (1 - t) * (p10[0] - p00[0]) + t * (p11[0] - p01[0])
        dxt = (1 - s) * (p01[0] - p00[0]) + s * (p11[0] - p10[0])
        dys = (1 - t) * (p10[1] - p00[1]) + t * (p11[1] - p01[1])
        dyt = (1 - s) * (p01[1] - p00[1]) + s * (p11[1] - p10[1])
        det = dxs * dyt - dxt * dys
        if det == 0.0:
            break
        ds = (-fx * dyt + fy * dxt) / det
        dt = (-fy * dxs + fx * dys) / det
        s, t = s + ds, t + dt
        if abs(ds) + abs(dt) < 1e-10:
            break
    return s * size - 0.5, t * size - 0.5


def _wave_map(detector: int, uri: str) -> tuple[WCS, threading.Lock]:
    """The detector's pixel-to-wavelength WCS, built once from the file `uri`."""
    with _maps_guard:
        known = _maps.get(detector)
    if known is not None:
        return known
    layout = ranges._layout(ranges.client(), mirror_url(uri))
    hdul = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=layout.image, name="IMAGE"),
                         layout.wave])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wave = WCS(layout.image, fobj=hdul, key="W")
    wave.sip = None
    entry = (wave, threading.Lock())
    with _maps_guard:
        _maps[detector] = entry
    return entry


def exposure_wavelengths(exposures, ra: float, dec: float) -> list[float]:
    """Wavelength in micron each exposure records at (ra, dec), in the same order.

    The pixel is clamped to the detector, so an exposure that only just misses
    the point gets its edge value. Raises CutoutError if a detector's map cannot
    be fetched from the mirror.
    """
    out = [0.0] * len(exposures)
    by_detector: dict[int, list[int]] = {}
    for i, e in enumerate(exposures):
        by_detector.setdefault(e.detector, []).append(i)
    for detector, members in by_detector.items():
        wave, lock = _wave_map(detector, exposures[members[0]].uri)
        pixels = np.array([pixel_in_footprint(exposures[i].footprint, ra, dec) for i in members])
        pixels = np.clip(pixels, 0, DETECTOR_PIXELS - 1)
        with lock:
            values, _ = wave.pixel_to_world_values(pixels[:, 0], pixels[:, 1])
        for i, value in zip(members, np.atleast_1d(values)):
            out[i] = float(value)
    return out
