# Project Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `web/` into the Next.js main app and a `testbench/` vanilla page with one shared module folder, and tidy scripts, docs and throwaway work.

**Architecture:** File moves with `git mv` plus path fixes. The only code change is two static mounts in `server/app.py`
(`/shared` → `web/shared`, `/` → `testbench`). No behaviour, contract or module logic changes.

**Tech Stack:** Python 3.11 + FastAPI + uv; Next.js 16 / TypeScript; vanilla ES modules; node:test; Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-project-restructure-design.md`

## Global Constraints

- Moves only; no change to `server/` logic, the HTTP contract, or the URL hash schema.
- Dependency direction: `testbench/` → `web/shared/`. Nothing under `web/` imports from `testbench/`.
- `web/shared/` modules import each other with `./`; absolute `/shared/...` URLs appear only in `testbench/`.
- `docs/superpowers/plans/*` and existing `docs/superpowers/specs/*` keep their old paths (history).
- Do not touch the uncommitted change in `web/next-env.d.ts`; never `git add -A`.
- Use `git mv` for every move.

## Review Focus

1. Test bench loaded through the server: every module request (`/shared/*.js`, `app.js`, `app.css`, `sky.js`) returns 200. Pinned by the pytest in Task 1 and the browser check in Task 1 Step 7.
2. Next.js type-check and build after `@/js` → `@/shared`: `npm run check` and `npm run build` pass. Task 2.
3. Old `/` mount exposed all of `web/` (source, `node_modules`) over HTTP; after the change `/package.json` must be 404. Pinned in Task 1.
4. Scripts run from their new folder: `record_tap_fixture.py` root resolution and `check_*.mjs` Playwright import. Task 3 Step 3.
5. Stale paths in live docs and usage strings. Final grep in Task 4.

---

### Task 1: Test bench and shared modules

**Files:**
- Move: `web/js/{app.js,sky.js}` → `testbench/`; `web/index.html` → `testbench/index.html`; `web/css/app.css` → `testbench/app.css`
- Move: remaining `web/js/*` (`backend-sky.js/.d.ts`, `frame-assets.js`, `frontend-cache.js/.d.ts`, `photos.js`, `queue.js`, `state.js`, `timeline.js`, `viewbox.js`) → `web/shared/`
- Move: `web/test/*.test.js` → `web/tests/shared/`
- Modify: `server/app.py:56,587-588` (and module docstring line 6)
- Modify: `testbench/index.html:11,66`, `testbench/app.js:7-11`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `web/shared/<module>.js` (same exports as before); server routes `/` (testbench, `html=True`) and `/shared/*`.

- [ ] **Step 1: Write the failing tests** in `tests/test_api.py`, using the existing app client fixture/pattern in that file:
  - `test_root_serves_testbench`: `GET /` → 200 and body contains `type="module" src="app.js"`.
  - `test_shared_modules_served`: `GET /shared/backend-sky.js` → 200.
  - `test_web_source_not_exposed`: `GET /package.json` → 404.
- [ ] **Step 2: Run** `uv run pytest tests/test_api.py -q`. Expected: the three new tests FAIL.
- [ ] **Step 3: Move files** with `git mv` as listed above (`mkdir -p testbench web/shared web/tests/shared` first); remove empty `web/js`, `web/css`, `web/test`.
- [ ] **Step 4: Fix paths.**
  - `server/app.py`: `TESTBENCH_DIR = ROOT / "testbench"`, `SHARED_DIR = ROOT / "web" / "shared"`; mount `/shared` (name `shared`) before `/` (name `testbench`), each guarded by `.is_dir()`. Update the docstring.
  - `testbench/index.html`: `href="app.css"`, `src="app.js"`.
  - `testbench/app.js`: shared imports → `/shared/queue.js`, `/shared/timeline.js`, `/shared/photos.js`, `/shared/state.js`, `/shared/viewbox.js`; `./sky.js` stays.
  - `web/tests/shared/*.test.js`: `'../js/` → `'../../shared/`.
- [ ] **Step 5: Run** `uv run pytest -q` → all pass; `node --test web/tests/shared/` → all pass.
- [ ] **Step 6: Run the server** `uv run uvicorn server.app:app --port 8000` and load `http://127.0.0.1:8000/#ra=269.4463&dec=4.7677` in headless Chromium (path in AGENTS.md). Expected: no 404 or module errors in the console; the page renders frames.
- [ ] **Step 7: Commit** `refactor: split vanilla page into testbench/, shared modules into web/shared/` (add only the moved/edited paths).

### Task 2: Next.js app on the new paths

**Files:**
- Modify: `web/components/SkyExplorer.tsx:13-14`, `web/components/SkyCanvas.tsx:3`, `web/lib/backend-bands.ts:2`
- Move: `web/tests/{backend,observations,sky,spectral}.test.ts` → `web/tests/unit/`
- Modify: `web/package.json` `scripts.test`; delete root `package.json`

**Interfaces:**
- Consumes: `web/shared/*` from Task 1.

- [ ] **Step 1: Run** `cd web && npm run check`. Expected: FAIL, cannot resolve `@/js/...`.
- [ ] **Step 2: Fix imports**: `@/js/` → `@/shared/`; `../js/backend-sky.js` → `../shared/backend-sky.js`.
- [ ] **Step 3: Move TS unit tests** to `web/tests/unit/`; in each, `'../lib/` → `'../../lib/`, `'../app/` → `'../../app/`.
- [ ] **Step 4: Set** `web/package.json` `"test": "node --test tests/shared/ && node --experimental-strip-types tests/unit/sky.test.ts && node --experimental-strip-types tests/unit/observations.test.ts && node --experimental-strip-types tests/unit/spectral.test.ts && node --experimental-strip-types tests/unit/backend.test.ts"`. `git rm package.json` at the root.
- [ ] **Step 5: Run** `cd web && npm run check && npm test && npm run build`. Expected: all pass. If `backend.test.ts` fails, check whether it also failed before this task (`git stash` is not allowed because of `next-env.d.ts`; use `git worktree` at HEAD~1) and report rather than fix.
- [ ] **Step 6: Load** `next start -p 5173` in headless Chromium; the explorer renders without console errors.
- [ ] **Step 7: Commit** `refactor: Next.js app imports from web/shared, one test tree`.

### Task 3: Scripts and archive

**Files:**
- Move: `scripts/*.py` → `scripts/data/`; `scripts/*.mjs` → `scripts/checks/`
- Move: `prototype/` → `archive/prototype/`; `spike/` → `archive/spike/`
- Modify: `scripts/data/record_tap_fixture.py:12` (`parents[1]` → `parents[2]`); `scripts/checks/check_band_cache.mjs:1`, `check_next_backend.mjs:1` (`../web/` → `../../web/`); every `Usage:` docstring line; `archive/spike/stellarium/make_frames.py:27` (`parents[2]` → `parents[3]`) and its usage line; `archive/spike/stellarium/shoot.mjs:2` usage.

- [ ] **Step 1: Move** with `git mv`.
- [ ] **Step 2: Fix** the paths above.
- [ ] **Step 3: Check offline** (none of these touch the network):
  - `uv run python scripts/data/prewarm.py --help` prints usage.
  - Do **not** run `record_tap_fixture.py` (no argparse; it queries IRSA immediately). Instead confirm
    `uv run python -c "from pathlib import Path; print(Path('scripts/data/record_tap_fixture.py').resolve().parents[2])"` prints the repo root.
  - `for f in scripts/checks/*.mjs; do node --check "$f"; done` passes, and `web/node_modules/@playwright/test/index.mjs` exists (the relative import target).
- [ ] **Step 4: Commit** `chore: group scripts by kind, move prototype and spike to archive/`.

### Task 4: Docs

**Files:**
- Move: `web/FRONTEND.md` → `docs/FRONTEND.md`; `web/project.md` → `docs/challenge/brief.md`; `web/nasa_space_apps_web_application_features.md` → `docs/challenge/features.md`
- Modify: `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DATA.md`, `server/catalog.py:5`, `server/app.py:256`, `server/targets.py:3`

- [ ] **Step 1: Move** with `git mv`.
- [ ] **Step 2: Rewrite `README.md`**: one-paragraph purpose (keep "Why this exists" and "Inspiration"), status (backend + Next.js app + test bench working), a layout table matching the spec's target layout, run commands for the server/test bench (`:8000`) and Next.js (`cd web && npm run dev`, `:5173`), docs table including the new `docs/FRONTEND.md` and `docs/challenge/`.
- [ ] **Step 3: Update `AGENTS.md`**: commands block (`cd web && npm test` replaces `node --test web/test/`; add `npm run dev`), Prototype section → `archive/`, `scripts/` → `scripts/data/` in the IRSA rule.
- [ ] **Step 4: Update `docs/ARCHITECTURE.md`**: diagram header (`browser (testbench/ and web/)`), file table rows for `testbench/*`, `web/shared/*`, `scripts/data/*`, `scripts/checks/*`, `archive/`; delete the rows for `stretch.js`, `windows.js`, `loader.js` (files do not exist); Next.js section paths and the offline-check commands.
- [ ] **Step 5: Update** script paths in `docs/DATA.md` and the three `server/*.py` comments.
- [ ] **Step 6: Verify** `git grep -nE "web/js|web/test/|web/css|web/index|(^|[^/])prototype/|(^|[^/])spike/|scripts/[a-z_]+\.(py|mjs)" -- ':!docs/superpowers' ':!archive'` returns nothing. Then `uv run pytest -q` and `cd web && npm test` pass.
- [ ] **Step 7: Commit** `docs: match the new layout, rewrite README`.
