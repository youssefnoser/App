"""Exposure metadata straight from the first bytes of an archive file.

Used to build the local snapshot from the AWS mirror when IRSA's search services
do not answer. The first 28,800 bytes of a Level-2 file hold the primary header
and the whole IMAGE header (25,920 bytes in DR1). From the IMAGE header come the
time (MJD-BEG, which is TAP's `time_bounds_lower`), detector, obs id and the sky
position of the four detector corners, computed with the TAN projection and the
SIP distortion polynomial. The cards are parsed by hand: building an astropy WCS
for 1.6 million files would take hours of CPU.
"""

import math

from server.irsa import Exposure

BLOCK = 2880
HEAD_BYTES = 28_800
URI_PREFIX = "ibe/data/spherex/"


class HeaderError(Exception):
    """The bytes do not hold a complete, usable IMAGE header."""


def _cards(block: bytes) -> tuple[dict[str, str], bool]:
    """Keyword -> raw value text for one header, and whether its END card was seen."""
    out: dict[str, str] = {}
    for i in range(0, len(block) - 79, 80):
        card = block[i:i + 80]
        key = card[:8].decode("ascii", "replace").strip()
        if key == "END":
            return out, True
        if card[8:10] != b"= ":
            continue
        value = card[10:].decode("ascii", "replace")
        if value.lstrip().startswith("'"):
            text = value.lstrip()[1:]
            out[key] = text[:text.find("'")].strip() if "'" in text else text.strip()
        else:
            out[key] = value.split("/", 1)[0].strip()
    return out, False


def image_header(head: bytes) -> dict[str, str]:
    """The IMAGE extension's cards from the first bytes of a file."""
    _, ended = _cards(head[:BLOCK])
    if not head.startswith(b"SIMPLE") or not ended:
        raise HeaderError("not a FITS file with a one-block primary header")
    cards, ended = _cards(head[BLOCK:])
    if not ended:
        raise HeaderError("IMAGE header is longer than the bytes fetched")
    if cards.get("EXTNAME") != "IMAGE":
        raise HeaderError("first extension is not IMAGE")
    return cards


def _sip(cards: dict[str, str], prefix: str, u: float, v: float) -> float:
    order = int(cards.get(f"{prefix}_ORDER", "0"))
    total = 0.0
    for p in range(order + 1):
        for q in range(order + 1 - p):
            value = cards.get(f"{prefix}_{p}_{q}")
            if value is not None:
                total += float(value) * u**p * v**q
    return total


def pixel_to_sky(cards: dict[str, str], x: float, y: float) -> tuple[float, float]:
    """(ra, dec) in degrees of a 0-based pixel position: SIP, then linear, then TAN."""
    if not (cards.get("CTYPE1", "").startswith("RA---TAN")
            and cards.get("CTYPE2", "").startswith("DEC--TAN")):
        raise HeaderError("sky projection is not TAN")
    u = x + 1.0 - float(cards["CRPIX1"])
    v = y + 1.0 - float(cards["CRPIX2"])
    f = u + _sip(cards, "A", u, v)
    g = v + _sip(cards, "B", u, v)
    if "CD1_1" in cards:
        m = [float(cards.get(k, "0")) for k in ("CD1_1", "CD1_2", "CD2_1", "CD2_2")]
    else:
        d1, d2 = float(cards.get("CDELT1", "1")), float(cards.get("CDELT2", "1"))
        m = [d1 * float(cards.get("PC1_1", "1")), d1 * float(cards.get("PC1_2", "0")),
             d2 * float(cards.get("PC2_1", "0")), d2 * float(cards.get("PC2_2", "1"))]
    xi = math.radians(m[0] * f + m[1] * g)
    eta = math.radians(m[2] * f + m[3] * g)
    ra0, dec0 = math.radians(float(cards["CRVAL1"])), math.radians(float(cards["CRVAL2"]))
    denom = math.cos(dec0) - eta * math.sin(dec0)
    ra = ra0 + math.atan2(xi, denom)
    dec = math.atan2(math.sin(dec0) + eta * math.cos(dec0), math.hypot(xi, denom))
    return math.degrees(ra) % 360.0, math.degrees(dec)


def exposure_from_head(key: str, head: bytes) -> Exposure:
    """The Exposure for bucket key `key` from the file's first bytes.

    The footprint is the outer edge of the four corner pixels. Raises HeaderError
    when the header is incomplete or lacks a needed card.
    """
    cards = image_header(head)
    try:
        nx, ny = int(cards["NAXIS1"]), int(cards["NAXIS2"])
        corners = [(-0.5, -0.5), (nx - 0.5, -0.5), (nx - 0.5, ny - 0.5), (-0.5, ny - 0.5)]
        footprint = tuple(pixel_to_sky(cards, x, y) for x, y in corners)
        return Exposure(
            uri=URI_PREFIX + key,
            mjd=float(cards["MJD-BEG"]),
            detector=int(cards["DETECTOR"]),
            obs_id=cards["OBSID"],
            footprint=footprint,
        )
    except (KeyError, ValueError) as exc:
        raise HeaderError(f"missing or bad card: {exc!r}") from exc
