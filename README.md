# SPHEREx Blink

A web tool for the NASA Space Apps 2026 challenge
[Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Type a sky position, get a playable series of SPHEREx infrared images of that patch, and spot what moves.

Status: working. The Python backend serves real SPHEREx frames; the Next.js app is the main interface; a plain
test bench page is kept for debugging against real data.

## Why this exists

SPHEREx photographs the whole sky every six months in 102 infrared bands. Comets, asteroids, nearby stars and brown dwarfs
reveal themselves by shifting between images, and there is too much data for any one person. This tool makes the flipping easy.

## Setup

### What you need

- Git
- Python 3.11 or newer, and [uv](https://docs.astral.sh/uv/)
- Node.js 22.14 or newer, with npm
- Only for the test bench: [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and
  [SCons](https://scons.org/), to build the sky engine (step 6)

### 1. Get the code

```bash
git clone --recurse-submodules <repo-url>
cd <repo-folder>
```

If you already cloned without `--recurse-submodules`, run `git submodule update --init`. The submodule is our fork of
Stellarium Web Engine in `vendor/`.

### 2. Install the backend

```bash
uv sync
```

### 3. Install the main app

```bash
cd web
npm install
```

### 4. Point the main app at a backend

The main app passes its `/api` requests through to the backend named in `web/.env.local`. To use your own backend
from step 5:

```bash
echo "SPHEREX_BACKEND_URL=http://127.0.0.1:8000" > web/.env.local
```

To use the team's hosted backend instead, run `cp web/.env.example web/.env.local` and skip starting your own.

### 5. Run it

In one terminal, from the repo root:

```bash
uv run uvicorn server.app:app --reload --port 8000
```

In a second terminal:

```bash
cd web
npm run dev
```

Open http://localhost:5173 and pick a target, for example Barnard's Star.

The first view of a patch is slow. The backend downloads whole exposure files from the SPHEREx mirror on AWS (no account
needed), cuts them, and caches the results under `.cache/`. Later views of the same patch are quick.

### 6. Optional: build the sky engine for the test bench

The main app ships a prebuilt engine in `web/public/stellarium/`, but the test bench at http://localhost:8000 needs
the fork in `vendor/` built:

```bash
source <path-to-emsdk>/emsdk_env.sh
cd vendor/stellarium-web-engine
make js
```

The output goes to `vendor/stellarium-web-engine/build/`. Restart the backend afterwards so it serves `/engine`.

### 7. Optional: a local list of exposures

Without a local list, the backend asks the IRSA archive which exposures cover a patch, which can take several seconds
or time out when IRSA is busy. Building the list once makes that lookup instant:

```bash
uv run python scripts/data/snapshot_from_aws.py --targets   # quick: only the five challenge targets
uv run python scripts/data/snapshot_from_aws.py             # whole sky: reads about 1.6 million file headers
```

It is saved to `.cache/meta/exposures.sqlite` and can be resumed if interrupted. `scripts/data/snapshot_metadata.py`
builds the same list from IRSA instead. After a new data release, re-run the script.

### Settings

| Variable | Default | What it does |
|----------|---------|--------------|
| `SPHEREX_CACHE_DIR` | `.cache` | Where downloads, crops and the exposure list are stored |
| `SPHEREX_EXPOSURE_CACHE_GB` | `20` | Size cap for downloaded exposure files; the least recently used are removed first |
| `SPHEREX_SOURCE` | `aws` | `irsa` fetches one cutout per patch from IRSA instead of whole files from AWS |
| `SPHEREX_BACKEND_URL` | team backend (`web/.env.example`) | Set in `web/.env.local`: the backend the main app talks to |
| `SPHEREX_INSECURE_TLS` | off | `1` turns off certificate checks. Only for sandboxes that intercept TLS; never in normal use |

### Tests

```bash
uv run pytest -q          # backend, offline
cd web && npm test        # frontend: shared modules and unit tests
cd web && npm run check   # TypeScript type-check
```

The frontend unit tests are TypeScript run directly by Node, which needs a Node build with type stripping
(`node --experimental-strip-types`). Some Linux distribution packages leave it out; if they fail with
`ERR_NO_TYPESCRIPT`, install Node from nodejs.org or with nvm.

## Layout

| Path | What it is |
|------|------------|
| `server/` | FastAPI backend: finds exposures, cuts and renders frames (Python) |
| `tests/` | Server tests, offline, with fixtures |
| `web/` | Main app (Next.js). `web/shared/` holds modules the test bench also uses; `web/tests/` all frontend tests |
| `testbench/` | Plain debugging page served by the backend at `/` |
| `scripts/data/` | Python tools that fill the exposure snapshot and warm caches (use the network) |
| `scripts/checks/` | Browser checks against a running app (use the network) |
| `docs/` | Spec, data notes, architecture, design ideas, the challenge brief |
| `archive/` | Earlier prototype and spike, kept for reference |
| `vendor/` | Stellarium Web Engine (git submodule) |

## Docs

| File | Purpose |
|------|---------|
| `AGENTS.md` | Rules and commands for coding agents. Start here. |
| `docs/SPEC.md` | What the challenge requires, test targets, optional extras |
| `docs/challenge/brief.md`, `docs/challenge/features.md` | The challenge text and the feature list drawn from it |
| `docs/DATA.md` | How to get SPHEREx data from IRSA, file layout, known gotchas |
| `docs/ARCHITECTURE.md` | Components, HTTP API, URL schema, file map |
| `docs/FRONTEND.md` | Change notes for the Next.js app |
| `docs/DISPLAY-IDEAS.md` | Ideas for new ways to display the images, awaiting a decision |
| `docs/superpowers/` | Design specs and task-by-task plans (history) |
| `docs/reference/README.md` | Index of the SPHEREx Explanatory Supplement (PDF, gitignored) and the IRSA data root |
| `docs/anatomy-of-a-spherex-file.png` | One real SPHEREx file opened up |

## Inspiration

[WiseView](http://byw.tools/wiseview) does this for the older WISE mission. SPHEREx differs: every exposure is nearly one colour,
and each is a different colour, so one patch of sky is seen across both time and wavelength.
