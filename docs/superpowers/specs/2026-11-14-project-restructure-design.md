# Project restructure: design

Date: 2026-11-14. Status: approved approach, awaiting approval of this document.

## Intent

The repo has grown redundant and confusing: two frontends share one `web/` folder, two frontend test folders differ by one
letter (`web/test/`, `web/tests/`), the challenge brief and frontend notes sit inside `web/`, throwaway work (`prototype/`,
`spike/`) sits at the top level next to live code, and the README says nothing is implemented. The user wants the web side
split into **the main app** (Next.js) and **a test bench** (the vanilla page), and the whole project tidied the same way.

Success: someone opening the repo can tell from folder names alone what is the product, what is the debugging page, what is
shared, what is a script, and what is history. Every existing test and both pages still work.

## Goals

- `web/` is the Next.js main app and nothing else.
- `testbench/` is the vanilla page served by FastAPI at `:8000`, used for debugging and checking against real data.
- Modules used by both live once, in `web/shared/`.
- One frontend test tree, one Node `package.json`.
- Docs live in `docs/`; throwaway work lives in `archive/`; scripts are grouped by kind.
- Every path reference in docs, code comments, usage strings and configs is updated.

## Non-goals

- No change to `server/` modules, the HTTP contract, the URL hash schema or any behaviour. Moves and path fixes only.
- No rewrite of frontend code, no TypeScript conversion of the shared JS, no merging of duplicated logic between
  `testbench/sky.js` and `web/lib/sky.ts` (they drive different engine builds).
- `docs/superpowers/plans/` and existing `specs/` are history: they keep their old paths. Only live docs are updated.

## Anti-goals

- The main app importing from `testbench/`. Dependency only points testbench → web/shared.
- Copying shared modules into two places.
- Breaking `uv run pytest`, the node tests, `tsc`, or either page loading.

## Approaches considered

1. **Shared modules in `web/shared/`, server mounts it for the test bench** (chosen). One copy, the main app owns it,
   the test bench needs no build step.
2. Shared modules in `testbench/`, main app imports from there. Rejected: the product would depend on the debugging page.
3. Copy the shared modules into both. Rejected: adds the redundancy this work is removing.

Earlier, retiring the vanilla page entirely was offered; the user chose to keep it as a test bench.

## Target layout

```
server/                 unchanged (Python package, FastAPI)
tests/                  unchanged (pytest + fixtures)
web/                    Next.js main app (:5173)
  app/ components/ lib/ public/
  shared/               was web/js/ except app.js, sky.js (plain ES modules + .d.ts)
  tests/
    unit/               was web/tests/*.test.ts
    shared/             was web/test/*.test.js (node:test)
    browser/            Playwright, unchanged
testbench/              vanilla page served at :8000 /
  index.html  app.css  app.js  sky.js
scripts/
  data/                 Python: snapshot_*, prewarm*, resolve_targets, check_targets, compare_masks, record_tap_fixture
  checks/               Node: acceptance.mjs, check_band_cache.mjs, check_next_backend.mjs
docs/
  SPEC.md DATA.md ARCHITECTURE.md DISPLAY-IDEAS.md FRONTEND.md
  challenge/            brief.md (was web/project.md), features.md (was web/nasa_space_apps_web_application_features.md)
  reference/ superpowers/ *.png
archive/
  prototype/            was prototype/
  spike/stellarium/     was spike/stellarium/
vendor/                 unchanged (submodule)
```

## Decided details

- **Server** (`server/app.py`): `WEB_DIR` becomes `TESTBENCH_DIR = ROOT / "testbench"` mounted at `/`; add
  `/shared` → `web/shared` mounted before `/`. `/engine`, `/skydata`, `/api` unchanged.
- **Test bench imports:** `testbench/app.js` imports shared modules as `/shared/<name>.js`; `testbench/index.html`
  references `app.css` and `app.js` at their new relative paths.
- **Shared tests run under Node without a server**, so absolute `/shared/` URLs are only in `testbench/`, never in
  `web/shared/` (shared modules import each other with `./`).
- **Next.js imports:** `@/js/...` → `@/shared/...`; `web/lib/backend-bands.ts` `../js/` → `../shared/`.
- **Node tests:** root `package.json` is removed. `web/package.json` `test` runs `node --test tests/shared/` plus the
  existing TS unit tests at `tests/unit/`. Shared test imports change from `../js/` to `../../shared/`.
- **Scripts:** `record_tap_fixture.py` `parents[1]` → `parents[2]`; `check_*.mjs` `../web/node_modules` →
  `../../web/node_modules`; every `Usage:` line gets the new path.
- **Docs:** `README.md` rewritten (status, layout, how to run both pages, docs table). `AGENTS.md` commands and the
  prototype paragraph updated. `ARCHITECTURE.md` file table and Next.js section updated (and the stale rows for
  `stretch.js`, `windows.js`, `loader.js` that no longer exist are removed). `DATA.md`, `server/*.py` docstrings,
  `server/targets.py` comment updated for moved scripts. `web/FRONTEND.md` → `docs/FRONTEND.md`.

## Verification

- `uv run pytest -q` passes.
- `cd web && npm test` passes (shared + unit), `npm run check` passes.
- `uv run uvicorn server.app:app --port 8000`: `/` loads the test bench, `/shared/backend-sky.js` returns 200, no 404s
  in the console (headless Chromium).
- `cd web && npm run build` succeeds; the Next.js page loads.
- `grep` for `web/js`, `web/test/`, `prototype/`, `spike/`, `scripts/<name>` without subfolder finds only history docs.

## Left to the builder

- Use `git mv` so history follows the files. Do it in a few commits (web split, scripts, docs/archive).
- Order within each commit, and exact README wording.

## Calls made without asking (check these)

- Keep the name `web/` for the main app rather than renaming it, to avoid churn in Next config and docs.
- `web/public/skydata` duplicates `vendor/.../test-skydata` byte-for-byte (4.7 MB). Left as is: Next.js needs it under
  `public/`, and deduplicating needs a copy step. Out of scope.
- `.vscode/` left alone.
- The user's uncommitted change to `web/next-env.d.ts` is left untouched.
