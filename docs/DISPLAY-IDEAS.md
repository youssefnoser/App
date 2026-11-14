# Display ideas (proposals, not decisions)

Goal G1: go beyond WiseView. WiseView (http://byw.tools/wiseview) already has: coordinate box, FOV, blink speed,
zoom, stretch and invert, a sliding time window (0.5 yr), colour panel, difference imaging, shift and add, Gaia overlay,
URL-encoded state. A plain copy meets R1 to R5 but is not new.

What is different about SPHEREx, and so where a new idea can come from: each exposure is almost one colour, and every
exposure is a different colour. The same patch is seen at many dates AND many wavelengths. WiseView has two bands.
We have a time by wavelength grid.

Status column: `proposed` until the user decides. Nothing here should be built before R1 to R5 work (plan Tasks 1 to 10).

| ID | Idea | What the user sees | Why it helps find movers | Requirement link | Cost | Status |
|----|------|--------------------|--------------------------|------------------|------|--------|
| A | **Spectral blink**: group exposures by detector and time window, coadd each group, blink the groups with a colour chip showing wavelength | Fewer, cleaner frames, each labelled with its band | Higher signal to noise per frame, faint movers survive | O2 | low | proposed |
| B | **Drag-to-set motion**: drag a vector on the image from "where it was" to "where it is"; all frames shift to follow that motion and stack | A mover sharpens, everything else smears | Turns shift-and-add from a slider into a direct gesture, shows the implied proper motion in arcsec/yr | R4, O4 | medium | proposed |
| C | **Pixel inspector with live spectrum**: hover or click any pixel and see flux versus wavelength from all exposures at that sky position | A small spectrum chart follows the cursor | Distinguishes a brown dwarf (water/methane features) from a star or galaxy without leaving the page | O3 | medium | proposed |
| D | **Time by wavelength contact sheet**: a grid of thumbnails, x = date, y = wavelength, click a cell to open it | The whole dataset at a glance, gaps visible | Shows data coverage honestly, picks the cleanest frames | R3, O2 | medium | proposed |
| E | **Onion skin trail**: previous N frames drawn faded under the current one | Motion visible in a single still | Works in screenshots and slides, no playback needed | R4 | low | proposed |
| F | **Light curve at a click**: aperture flux versus date for a clicked source | A chart under the image | Needed for the variable test targets RW Aur and R Dra | R5 | medium | proposed |
| G | **Aladin Lite context panel** (CDS) with Gaia DR3 and WISE overlays | A sky map beside the blink | Identifies known stars so the unknown stand out | O6, O9 | medium | superseded: the main display is now the Stellarium sky with the SPHEREx HiPS (see `docs/superpowers/specs/2026-11-13-stellarium-spherex-design.md`) |

## Recommendation (the plan agent's opinion, not a decision)

Build baseline blink (A-lite: per-detector coadd) first, then B and C. B is the strongest candidate for "new" because
the gesture is direct and the output is a measured proper motion. C is the one that only SPHEREx can offer (many colours per
position). F is required in practice for the two variable-star test targets, so pick it up if time allows.

## Open questions for the user

1. Which of A to G do you want built after the baseline? (The plan includes B and C as Tasks 11 and 12, marked blocked until you decide.)
2. Is the tool judged on discovery power, polish, or novelty? The challenge page does not say.
3. Where will it be hosted (the server needs somewhere to run)?
