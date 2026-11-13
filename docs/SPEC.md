# Spec: "Planet X and SPHEREx" web tool

Source: NASA Space Apps Challenge 2026, challenge page
https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/
(read 2026-11-13). The page says more resources may be added before the hackathon begins, so re-read it.
Judging criteria are not stated on the page. Do not invent any.

## The ask, in one sentence

Build a public-facing web tool that displays images of the sky from the SPHEREx mission so anyone can
quickly see how they change over time. The user enters a sky position (RA, Dec). The tool shows a series
of images of that patch like a little video, so moving objects are easy to spot.

## Required (from the page)

| ID | Requirement |
|----|-------------|
| R1 | Public-facing web tool (no login, runs in a normal browser). |
| R2 | User enters RA and Dec of a sky patch. |
| R3 | Tool displays a time series of SPHEREx images of that patch, playable like a video. |
| R4 | The display makes moving objects easy to spot. |
| R5 | Works on the test targets below. |

### Test targets (R5)

The page lists five, not six:

| Target | Notes from the page |
|--------|---------------------|
| Barnard's Star | Nearby star, high proper motion (about 10.3 arcsec/yr). |
| Epsilon Indi B | A pair of brown dwarfs orbiting a star. |
| WISE 0855 | Fast-moving brown dwarf. RA 08h55m10.831s, Dec -7d14m42.53s. |
| RW Aurigae | Variable star. |
| R Draconis | Variable star. |

## Optional ("you may consider", all explicitly not required)

| ID | Suggestion |
|----|------------|
| O1 | Easy to update when new SPHEREx data releases arrive. |
| O2 | Creative use of the 102 bands. Example: sum the data from each of the six detector arrays separately to raise signal-to-noise. |
| O3 | Generate spectra on the fly ("extra kudos"). |
| O4 | Let users add or subtract images taken at different times. |
| O5 | User-chosen field of view (larger FOV tracks faster movers, costs transfer time). |
| O6 | Overlay other telescopes: Gaia (use DR3) and WISE. |
| O7 | Query by URL (coordinates in the URL) so the tool can be embedded. |
| O8 | Show metadata such as contamination flags. |
| O9 | Use existing tools: Astropy for data, Aladin (CDS) for display. |

## Resources the page links

- NASA/IPAC IRSA SPHEREx: https://irsa.ipac.caltech.edu/Missions/spherex.html
- SPHEREx tutorial notebooks: https://caltech-ipac.github.io/irsa-tutorials/spherex/
  (the `spherex-cutouts` notebook is the template for our pipeline)
- WiseView, the model tool for WISE data: http://byw.tools/wiseview
- Gaia data (use DR3): https://archive.stsci.edu/missions-and-data/gaia
- SPHEREx Explanatory Supplement (PDF, v2.1): https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf
  (added by the user; authoritative for file format, flags, bands. Index in `docs/reference/README.md`)
- IRSA IBE SPHEREx data root: https://irsa.ipac.caltech.edu/ibe/data/spherex (added by the user; path prefix of exposure file URLs, not browsable)
- Partner resources (CSA): NEOSSat pages and dataset, Canadian Astronomy Data Centre. Not needed for the core tool.

## Project goals beyond the page

These come from the user, not from the challenge page.

- G1: Innovate on how the images are displayed, not just clone WiseView. Candidate ideas live in
  `docs/DISPLAY-IDEAS.md`. They are proposals until the user picks.
- G2: Everything required (R1 to R5) must work before any innovation is built.

## Out of scope

- Discovering new objects automatically (detection algorithms). The tool helps humans see motion.
- Accounts, saved sessions, or any user data storage.
- Mobile-native app. The page should still be usable on a phone.
