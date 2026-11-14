"""Throwaway dev server for the Stellarium + SPHEREx HiPS spike. Standard library only.

Serves the repo root as static files and proxies one SPHEREx HiPS cube slice at a time as a flat survey:

    /hips/spherex/properties                 upstream properties, unchanged (for the wavelength list)
    /hips/spherex/{frame}/properties         properties rewritten as a flat survey
    /hips/spherex/{frame}/Norder{k}/...png   upstream tile with the cube suffix (frame 0 unsuffixed, k>0 "_k")

Tiles are cached under .cache/hips/. At most 8 upstream downloads at a time, 60 s timeout, TLS verified unless
SPHEREX_INSECURE_TLS=1. The real implementation is plan Task 8 (server/hips.py); this file is a spike.

Run from the repo root:  python3 prototype/sky_debug/serve.py   then open http://localhost:8000/prototype/sky_debug/
"""

import os
import re
import ssl
import sys
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HIPS_BASE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
FRAME_COUNT = 102
ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get("SPHEREX_HIPS_CACHE_DIR", ROOT / ".cache" / "hips"))
TILE_RE = re.compile(r"^Norder\d{1,2}/(Dir\d+/Npix\d+|Allsky)\.png$")
ROUTE_RE = re.compile(r"^/hips/spherex/(\d{1,3})/(.+)$")
DROP_PREFIXES = ("dataproduct_type", "hips_cube_", "data_cube_", "custom_tile_format")

_downloads = threading.Semaphore(8)
_ssl = ssl.create_default_context()
if os.environ.get("SPHEREX_INSECURE_TLS") == "1":
    _ssl.check_hostname = False
    _ssl.verify_mode = ssl.CERT_NONE


class NotFound(Exception):
    pass


def fetch_cached(rel: str) -> bytes:
    """Return upstream HIPS_BASE/rel, from the disk cache when present. Failures are never cached."""
    path = CACHE / rel
    if path.is_file():
        return path.read_bytes()
    with _downloads:
        try:
            with urllib.request.urlopen(f"{HIPS_BASE}/{rel}", timeout=60, context=_ssl) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(rel) from e
            raise
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(body)
    tmp.replace(path)
    return body


def tile_path(frame: int, tile: str) -> str:
    if not 0 <= frame < FRAME_COUNT or not TILE_RE.match(tile):
        raise ValueError(tile)
    return tile if frame == 0 else tile[: -len(".png")] + f"_{frame}.png"


def flat_properties(text: str, frame: int, service_url: str) -> str:
    wl = []
    out = []
    for line in text.splitlines():
        key = line.split("=", 1)[0].strip()
        if key == "data_cube_crval3_arr":
            wl = [float(x) for x in line.split("=", 1)[1].split()]
        if key.startswith(DROP_PREFIXES):
            continue
        if key == "hips_service_url":
            line = f"hips_service_url     = {service_url}"
        elif key == "creator_did":
            line = f"creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube/{frame}"
        out.append(line)
    if wl:
        out = [l + f" - {wl[frame]:.3f} um" if l.split("=", 1)[0].strip() == "obs_title" else l for l in out]
    return "\n".join(out) + "\n"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/hips/spherex/"):
            return super().do_GET()
        try:
            if path == "/hips/spherex/properties":
                return self._send(200, "text/plain", fetch_cached("properties"))
            m = ROUTE_RE.match(path)
            if not m:
                return self._send(422, "text/plain", b"bad hips path\n")
            frame, rest = int(m.group(1)), m.group(2)
            if not 0 <= frame < FRAME_COUNT:
                return self._send(422, "text/plain", b"frame must be 0 to 101\n")
            if rest == "properties":
                host = self.headers.get("Host", "localhost")
                text = flat_properties(fetch_cached("properties").decode(), frame,
                                       f"http://{host}/hips/spherex/{frame}")
                return self._send(200, "text/plain", text.encode())
            try:
                rel = tile_path(frame, rest)
            except ValueError:
                return self._send(422, "text/plain", b"bad tile path\n")
            return self._send(200, "image/png", fetch_cached(rel))
        except NotFound:
            return self._send(404, "text/plain", b"no such tile upstream\n")
        except Exception as e:  # upstream failure: 502, never a 500 stack trace
            self.log_error("upstream failed: %r", e)
            return self._send(502, "text/plain", b"IRSA did not answer\n")

    def _send(self, code: int, ctype: str, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if code == 200:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/hips/"):
            self.send_header("Cache-Control", "no-store")  # dev: always serve fresh page code
        super().end_headers()


Handler.extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
    print(f"open http://localhost:{port}/prototype/sky_debug/   (cache: {CACHE})")
    httpd.serve_forever()
