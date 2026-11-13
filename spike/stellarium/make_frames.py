"""THROWAWAY SPIKE. Fetch a few real Barnard's Star SPHEREx crops and write
north-up, east-left PNGs plus frames.json for the Stellarium photo overlay test.

Network use is allowed here (scripts/manual checks only, never in tests).
Output goes to .cache/spike-frames/ (gitignored).

Run: uv run --with numpy --with astropy --with scipy --with pillow \
         python spike/stellarium/make_frames.py
"""
import csv
import json
import pathlib
import urllib.request
import warnings

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
import astropy.units as u
from PIL import Image
from scipy.ndimage import map_coordinates

warnings.filterwarnings("ignore")

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache" / "spike-frames"
OUT.mkdir(parents=True, exist_ok=True)

# Barnard's Star, same values the prototype used (prototype/fetch.py).
# Only used to pick a query centre; the patch itself is fixed sky.
STAR = SkyCoord(269.45207 * u.deg, 4.69339 * u.deg,
                pm_ra_cosdec=-798.58 * u.mas / u.yr, pm_dec=10328.12 * u.mas / u.yr,
                obstime=Time("J2000"))
CENTRE = STAR.apply_space_motion(new_obstime=Time(61000, format="mjd"))
RA, DEC = CENTRE.ra.deg, CENTRE.dec.deg

SIZE_DEG = 0.1           # cutout size, ~58 native pixels: enough neighbour stars to check alignment
N = 117                  # output grid, odd
SCALE = 3.075 / 3600     # deg per output pixel (ARCHITECTURE.md decision 5)


def pick_rows():
    rows = list(csv.DictReader(open(ROOT / "tests/fixtures/tap_barnard.csv")))
    d6 = [r for r in rows if r["energy_bandpassname"] == "SPHEREx-D6"]
    d6.sort(key=lambda r: float(r["time_bounds_lower"]))
    # first two exposures of each of the three main visits (gaps > 60 days)
    visits, picked = [], []
    for r in d6:
        t = float(r["time_bounds_lower"])
        if not visits or t - visits[-1][-1] > 60:
            visits.append([t])
            picked.append([r])
        else:
            visits[-1].append(t)
            picked[-1].append(r)
    return [r for group in picked if len(group) > 5 for r in group[:2]]


def fetch(uri, dest):
    if dest.exists():
        return
    url = f"https://irsa.ipac.caltech.edu/{uri}?center={RA},{DEC}d&size={SIZE_DEG}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        dest.write_bytes(resp.read())


def output_wcs():
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [(N + 1) / 2, (N + 1) / 2]
    w.wcs.cdelt = [-SCALE, SCALE]   # RA increases to the left (east-left)
    return w


def reproject(path, ow):
    with fits.open(path) as h:
        sci = h["IMAGE"].data.astype(float) - h["ZODI"].data.astype(float)  # science image = IMAGE - ZODI
        w = WCS(h["IMAGE"].header)
        mjd = h["IMAGE"].header["MJD-AVG"]
    yy, xx = np.mgrid[0:N, 0:N]
    px, py = w.world_to_pixel(ow.pixel_to_world(xx, yy))
    # NaN in -> NaN out (bilinear spreads NaN to neighbours; fine for a visual spike)
    out = map_coordinates(sci, [py, px], order=1, mode="constant", cval=np.nan)
    # WCS row 0 is the SOUTH edge. Flip so array row 0 is NORTH, the PNG/API convention.
    return out[::-1, :], mjd


def to_png(arr, lo, hi, dest):
    x = np.clip((arr - lo) / (hi - lo), 0, 1)
    x = np.arcsinh(10 * x) / np.arcsinh(10)
    g = np.nan_to_num(x * 255).astype(np.uint8)
    alpha = np.where(np.isnan(arr), 0, 255).astype(np.uint8)  # NaN -> transparent
    Image.fromarray(np.dstack([g, g, g, alpha]), "RGBA").save(dest)


def main():
    rows = pick_rows()
    ow = output_wcs()
    frames = []
    for i, r in enumerate(rows):
        fits_path = OUT / f"{i:02d}.fits"
        fetch(r["uri"], fits_path)
        arr, mjd = reproject(fits_path, ow)
        frames.append((arr, mjd))
        print(f"frame {i}: mjd {mjd:.2f}")
    allpix = np.concatenate([a[np.isfinite(a)] for a, _ in frames])
    lo, hi = np.percentile(allpix, [20, 99.0])   # one stretch for every frame so the blink is fair
    meta = []
    for i, (arr, mjd) in enumerate(frames):
        to_png(arr, lo, hi, OUT / f"{i:02d}.png")
        meta.append({"png": f"{i:02d}.png", "mjd": mjd,
                     "date": Time(mjd, format="mjd").iso[:10]})
    json.dump({"ra": RA, "dec": DEC, "pixscale_arcsec": SCALE * 3600, "n": N,
               "frames": meta}, open(OUT / "frames.json", "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
