# AGENTS.md

Guide for any coding agent working in this directory. Read this first, then the doc that matches your task.

## What this project is

A web tool for the NASA Space Apps 2026 challenge "Planet X and SPHEREx". The user enters a sky position (RA, Dec);
the tool shows SPHEREx infrared images of that patch over time as a blink, so moving objects stand out. A second goal is
to innovate on how the images are displayed rather than clone WiseView.

## Read in this order

1. `docs/SPEC.md`: what is required (R1 to R5), optional (O1 to O9), the five test targets.
2. `docs/DATA.md`: how to get SPHEREx data and what is known to go wrong. Verified facts and UNVERIFIED items are marked.
   Authoritative source behind it: the SPHEREx Explanatory Supplement, indexed in `docs/reference/README.md` (PDF is gitignored, re-download command is there).
3. `docs/ARCHITECTURE.md`: components, HTTP contract, URL schema. Contract changes need the user's agreement.
4. `docs/DISPLAY-IDEAS.md`: proposed display innovations. Status `proposed` means do not build yet.
5. `docs/superpowers/plans/2026-11-13-spherex-blink-tool.md`: the task list. Work one task at a time, in order.

## Stack and commands

Python 3.11+ with uv. Main app: Next.js in `web/`. Test bench: vanilla ES modules in `testbench/`, no build step.
Modules both use live in `web/shared/`. Node 22 for tests.

```bash
uv sync                          # install
uv run pytest -q                 # server tests (offline)
cd web && npm install && npm test   # frontend tests (web/tests/shared, web/tests/unit)
uv run uvicorn server.app:app --reload --port 8000   # backend + test bench at :8000
cd web && npm run dev            # main app at :5173 (SPHEREX_BACKEND_URL in web/.env.local)
```

## Rules

- **Test first.** Each plan task starts with a failing test. Tests never touch the network. Use `tests/fixtures/`.
  Network only in `scripts/` or manual checks, never in the test suite.
- **Do not guess astronomy facts.** Check the Explanatory Supplement (`grep -n -i <term> docs/reference/Expsupp.txt`) first.
  Flag bits, detector bands and zodi handling are now sourced in `docs/DATA.md`. If something there is still marked UNVERIFIED
  (WISE 0855 proper motion, target coordinates), verify it and update `DATA.md`, or say you did not.
  Never state a flag meaning in UI copy that is not in ES Table 16.
- **Science image is `IMAGE - ZODI`.** IMAGE alone still contains the zodiacal background. Never drop the ZODI extension from the cache.
- **NaN is normal.** Bright stars have masked core pixels. Every function that touches pixels must accept NaN and say what it does with it.
- **Sky orientation:** frames from the API are north-up (row 0 north), east-left (column 0 east). The prototype was the other way round and
  hid a bug for a while. Test orientation with a synthetic image, not by eye.
- **Moving targets:** coordinates the user types are a fixed patch of sky. Proper motion only matters for the predicted-position marker and
  for choosing the query centre of the test targets in `server/targets.py`.
- **TLS verification stays on.** Only `SPHEREX_INSECURE_TLS=1` disables it, and only for the Claude Code sandbox where interception breaks it.
- **IRSA is a shared public service.** Cap parallel downloads at 8, set a timeout on every request, no retry storms.
  Pixels come from the AWS mirror by default (whole exposure files, cut locally, size-capped cache: `server/mirror.py`), and the
  exposure list from the local snapshot (`server/catalog.py`). IRSA is asked only when the snapshot has no answer, and by
  `scripts/data/snapshot_metadata.py`, which polls queued TAP jobs every 10 s until they answer (user decision, 2026-11-13).
- **Do not commit data.** `data/`, `.cache/`, `*.fits` are ignored. A full Barnard's Star crop set is 1.4 GB.
- **Keep files small and single-purpose.** The file table in `docs/ARCHITECTURE.md` is the map. Add a row when you add a file.
- **Copy and tone for UI text:** plain sentences, say what happened and what to do next, no jargon without a gloss (MJy/sr, PSF, MJD).

## Verifying work

A task is done when its tests pass and, for anything visible, you have looked at it in a browser (headless Chromium is at
`~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux-arm64/chrome-headless-shell`) and checked the result against
real data, for example Barnard's Star should drift north, about 10 arcsec per year.

## Archive

`archive/` holds throwaway work. `archive/spike/stellarium/` proved the Stellarium canvas.
`archive/prototype/` holds the scripts that proved the pipeline for Barnard's Star (`fetch.py`, `process.py`) and a standalone viewer page
(`viewer_template.html`). They are references. They hard-code one target and write into the working directory.
