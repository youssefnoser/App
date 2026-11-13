# SPHEREx Blink

A web tool for the NASA Space Apps 2026 challenge
[Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
Type a sky position, get a playable series of SPHEREx infrared images of that patch, and spot what moves.

Status: planning. Nothing is implemented yet. A one-target prototype is in `prototype/`.

## Why this exists

SPHEREx photographs the whole sky every six months in 102 infrared bands. Comets, asteroids, nearby stars and brown dwarfs
reveal themselves by shifting between images, and there is too much data for any one person. This tool makes the flipping easy.

## Docs

| File | Purpose |
|------|---------|
| `AGENTS.md` | Rules and commands for coding agents. Start here. |
| `docs/SPEC.md` | What the challenge requires, test targets, optional extras |
| `docs/DATA.md` | How to get SPHEREx data from IRSA, file layout, known gotchas |
| `docs/ARCHITECTURE.md` | Components, HTTP API, URL schema |
| `docs/DISPLAY-IDEAS.md` | Ideas for new ways to display the images, awaiting a decision |
| `docs/superpowers/plans/2026-11-13-spherex-blink-tool.md` | Task-by-task implementation plan |
| `docs/reference/README.md` | Index of the SPHEREx Explanatory Supplement (PDF, gitignored) and the IRSA data root |
| `docs/anatomy-of-a-spherex-file.png` | One real SPHEREx file opened up |

## Inspiration

[WiseView](http://byw.tools/wiseview) does this for the older WISE mission. SPHEREx differs: every exposure is nearly one colour,
and each is a different colour, so one patch of sky is seen across both time and wavelength.
