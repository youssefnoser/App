"""THROWAWAY SPIKE: measure how well the frame overlay lines up with the survey.

Compares two same-view screenshots (survey only, frame only). Barnard's Star is
masked out so the neighbour stars decide. Reports the best shift and whether a
mirrored frame (east/west flipped) matches better than the frame as drawn.

Usage: uv run --no-project --with numpy --with pillow python align_check.py survey.png frame.png
"""
import sys

import numpy as np
from PIL import Image


def load(path):
    a = np.asarray(Image.open(path).convert("L"), dtype=float)
    h, w = a.shape
    a = a[h // 2 - 190:h // 2 + 190, w // 2 - 190:w // 2 + 190]   # centre box, clear of the control panel
    a = np.pad(a, ((60, 60), (60, 60)))                          # back to 500x500 for the FFT
    yy, xx = np.mgrid[:500, :500]
    a[np.hypot(yy - 250, xx - 250) < 70] = 0                     # mask Barnard's Star core and halo
    thr = np.percentile(a[a > 0], 97.0)                          # brightest 3% of lit pixels = stars
    a = (a >= thr).astype(float)
    # light 5x5 box blur so 3" and 13" pixels can overlap
    k = np.ones(5) / 5
    a = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, a)
    a = np.apply_along_axis(lambda c: np.convolve(c, k, "same"), 0, a)
    return a / (np.linalg.norm(a) + 1e-9)   # no mean subtraction: it made the masked disk correlate


def best_shift(a, b):
    """Peak of the circular cross-correlation: (dy, dx, strength)."""
    c = np.fft.irfft2(np.fft.rfft2(a) * np.conj(np.fft.rfft2(b)), s=a.shape)
    dy, dx = np.unravel_index(np.argmax(c), c.shape)
    dy = dy - 500 if dy > 250 else dy
    dx = dx - 500 if dx > 250 else dx
    return int(dy), int(dx), float(c.max())


survey, frame = load(sys.argv[1]), load(sys.argv[2])
dy, dx, s = best_shift(survey, frame)
_, _, s_lr = best_shift(survey, frame[:, ::-1])
_, _, s_ud = best_shift(survey, frame[::-1, :])
print(f"shift (screen px): dy={dy} dx={dx}  correlation={s:.3f}")
print(f"mirrored left-right: {s_lr:.3f}   mirrored up-down: {s_ud:.3f}")
print("PARITY OK" if s > 1.3 * max(s_lr, s_ud) else "PARITY UNCLEAR OR FLIPPED")
