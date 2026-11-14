# SPHEREx Blink

A web tool for the NASA Space Apps 2026 challenge
[Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Type a sky position, get a playable series of SPHEREx infrared images of that patch, and spot what moves.

Status: working. The Python backend serves real SPHEREx frames; the Next.js app is the main interface; a plain
test bench page is kept for debugging against real data.

## Why this exists

SPHEREx photographs the whole sky every six months in 102 infrared bands. Comets, asteroids, nearby stars and brown dwarfs
reveal themselves by shifting between images, and there is too much data for any one person. This tool makes the flipping easy.

## Run it

```bash
uv sync
uv run uvicorn server.app:app --reload --port 8000   # backend, plus the test bench at http://localhost:8000
cd web && npm install && npm run dev                 # main app at http://localhost:5173
```

The main app talks to the backend named by `SPHEREX_BACKEND_URL` (set it in `web/.env.local`, e.g. `http://127.0.0.1:8000`).
Tests: `uv run pytest -q` for the server, `cd web && npm test` for the frontend.

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
