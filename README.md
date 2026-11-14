# SPHEREx Blink

Our entry for the NASA Space Apps 2026 challenge
[Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).

You type a position on the sky, and the tool plays the SPHEREx infrared images of that spot like a short video, so you
can see what moves. Nearby stars, brown dwarfs, asteroids and comets all shift position between images taken months apart.

SPHEREx photographs the whole sky every six months in 102 infrared bands, which is far too much data for any one person
to search. This tool makes flipping through it quick enough that anyone can try.

## What it does

- Finds every SPHEREx exposure that covers the position you choose. You can type RA and Dec in degrees, or pick one of the preset object names.
- Shows those exposures in time order, so you can play them, pause, or step through one frame at a time.
- Lets you choose which wavelengths go into the sequence, because each SPHEREx exposure sees a slightly different colour.
- Keeps the five challenge test targets one click away: Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and
  R Draconis.

Barnard's Star is a good first check: it should move north, by about 10 arcseconds per year.

## How it fits together

```
browser ── main app (web/, Next.js, :5173) ──┐
        └─ test bench (testbench/, :8000) ───┤  /api
                                             ▼
                        backend (server/, Python + FastAPI, :8000)
                                             │
             SPHEREx files: AWS mirror (default) or the IRSA archive
```

The backend does all the astronomy. It finds the exposures, cuts out the patch, subtracts the zodiacal background
(the glow of dust in the solar system) and turns the result north-up. The browser only displays and animates the frames.

There are two pages:

- **The main app**: the interface people use.
- **The test bench**: a plain page the backend serves, for checking the data and debugging.

## Run it

There are two pages, the **main app** and the **test bench**, and both need a backend. You can use the team's hosted
backend or run your own.

| | Hosted backend (`http://130.61.174.88:8000`) | Local backend (`http://localhost:8000`) |
|---|---|---|
| Test bench | Open http://130.61.174.88:8000/. Nothing to install. | Run the backend, then open http://localhost:8000/ |
| Main app | Node only, no Python | Python and Node |

The hosted backend runs whatever version was last deployed to it, so it can be behind this repo.

### Prerequisites

- **Main app:** Node.js 22.14 or newer, with npm.
- **Local backend:** Python 3.11 or newer, with [uv](https://docs.astral.sh/uv/).
- **Test bench on a local backend:** also [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
  and [SCons](https://scons.org/), to build the sky engine once.

Get the code:

```bash
git clone --recurse-submodules <repo-url>
cd <repo-folder>
```

If you cloned without `--recurse-submodules`, run `git submodule update --init`.

### A. Use the hosted backend

**Test bench:** open http://130.61.174.88:8000/ in a browser. That's all.

**Main app:**

```bash
cd web
npm install
echo "SPHEREX_BACKEND_URL=http://130.61.174.88:8000" > .env.local
npm run dev
```

Open http://localhost:5173. Next.js passes the app's `/api` requests on to the hosted backend, so the browser never
talks to it directly. The hosted backend is also the default when `web/.env.local` is missing.

### B. Run the backend locally

**1. Start the backend.** From the repo root:

```bash
uv sync                                               # first time only
uv run uvicorn server.app:app --reload --port 8000
```

It is ready when it prints `Application startup complete`. Check it at http://localhost:8000/health, and stop it
with Ctrl+C.

The first view of a spot is slow. The backend downloads whole exposure files from the public SPHEREx mirror on AWS (no
account needed) and caches them in `.cache/`. Later views of the same spot are quick.

**2. Test bench.** The backend serves the test bench itself, at http://localhost:8000/. The first time, build the sky
engine it uses (our Stellarium Web Engine fork in `vendor/`):

```bash
source <path-to-emsdk>/emsdk_env.sh
cd vendor/stellarium-web-engine
make js
```

Then restart the backend. Without this build, the page opens but the sky view doesn't load. The main app doesn't
need the build, because it ships its own copy in `web/public/stellarium/`.

**3. Main app.** In a second terminal:

```bash
cd web
npm install                                           # first time only
echo "SPHEREX_BACKEND_URL=http://127.0.0.1:8000" > .env.local
npm run dev
```

Open http://localhost:5173. For a production build, use `npm run build && npm start` on the same port.

### Switching the main app between backends

Edit `SPHEREX_BACKEND_URL` in `web/.env.local`, then stop and restart `npm run dev`.

### Tests

```bash
uv run pytest -q             # backend; offline, uses tests/fixtures/
cd web && npm test           # frontend: shared modules and unit tests
cd web && npm run check      # TypeScript type-check
```

The frontend unit tests are TypeScript run directly by Node. Some Linux distribution builds of Node can't do that. If
the tests fail with `ERR_NO_TYPESCRIPT`, install Node from nodejs.org or with nvm.

## Optional: a local list of exposures

When the backend has no local list of exposures, it asks the IRSA archive which exposures cover a spot. That can take
several seconds, or time out when IRSA is busy. Building a local list once makes the lookup instant:

```bash
uv run python scripts/data/snapshot_from_aws.py --targets   # quick: only the five challenge targets
uv run python scripts/data/snapshot_from_aws.py             # whole sky: reads about 1.6 million file headers
```

The list is saved to `.cache/meta/exposures.sqlite`, and the script picks up where it left off if it's interrupted.
Re-run it after each new SPHEREx data release. `scripts/data/snapshot_metadata.py` builds the same list from IRSA
instead of from AWS.

## Settings

| Variable | Default | What it does |
|----------|---------|--------------|
| `SPHEREX_BACKEND_URL` | `http://130.61.174.88:8000` | Set in `web/.env.local`. The backend the main app talks to. |
| `SPHEREX_CACHE_DIR` | `.cache` | Where downloads, cut-outs and the exposure list are stored. |
| `SPHEREX_EXPOSURE_CACHE_GB` | `6` | Size limit for downloaded exposure files. The least recently used are removed first. |
| `SPHEREX_RENDER_CACHE_GB` | `3` | Size limit for rendered frames and resampled grids. With the defaults and the exposure list, the cache folder stays under 10 GB. |
| `SPHEREX_SOURCE` | `aws` | Set to `irsa` to fetch one small cut-out per patch from IRSA instead of whole files from AWS. |
| `SPHEREX_INSECURE_TLS` | off | Set to `1` to turn off certificate checks. Only for sandboxes that intercept TLS; never in normal use. |

## Project layout

| Path | What it is |
|------|------------|
| `server/` | Backend (Python, FastAPI): finds exposures, cuts and renders frames |
| `tests/` | Backend tests, offline, with fixtures |
| `web/` | Main app (Next.js) |
| `web/shared/` | Plain JavaScript modules used by both the main app and the test bench |
| `web/tests/` | All frontend tests: `shared/`, `unit/`, `browser/` (Playwright) |
| `testbench/` | The test bench page, served by the backend at `/` |
| `scripts/data/` | Python tools that build the exposure list and warm the caches (use the network) |
| `scripts/checks/` | Browser checks against a running app (use the network) |
| `docs/` | Spec, data notes, architecture, design ideas, the challenge brief |
| `archive/` | The first prototype and the Stellarium spike, kept for reference |
| `vendor/` | Our Stellarium Web Engine fork (git submodule) |

## Further reading

| File | What's in it |
|------|--------------|
| `AGENTS.md` | Rules and commands for anyone (or any coding agent) changing the code. Read it before you start. |
| `docs/SPEC.md` | What the challenge requires, the five test targets, optional extras |
| `docs/challenge/` | The challenge text and the feature list we drew from it |
| `docs/DATA.md` | How SPHEREx data is fetched and what goes wrong |
| `docs/ARCHITECTURE.md` | Components, HTTP API, URL format, a map of every file |
| `docs/FRONTEND.md` | Change notes for the main app |
| `docs/DISPLAY-IDEAS.md` | Proposed new ways to display the images |
| `docs/reference/README.md` | Index of the SPHEREx Explanatory Supplement, the mission's data handbook |

## Credits

- SPHEREx data: NASA, Caltech/JPL, distributed by [NASA/IPAC IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html).
- Sky display: [Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine) (AGPL-3.0).
- Inspired by [WiseView](http://byw.tools/wiseview), which does the same for the WISE mission. SPHEREx is different:
  each exposure covers a narrow slice of wavelengths, and each one a different slice, so one patch of sky is seen across
  both time and wavelength.
