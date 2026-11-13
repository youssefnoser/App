# Reference material

Authoritative external sources for this project. Read these before making any claim about SPHEREx data.

| Source | URL | Local copy |
|--------|-----|------------|
| SPHEREx Explanatory Supplement, v2.1 (2026-11-10), 84 pages | https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf | `SPHEREx_Expsupp.pdf` (30 MB) and `Expsupp.txt` (pdftotext -layout). Both gitignored. |
| IRSA IBE data root for SPHEREx files | https://irsa.ipac.caltech.edu/ibe/data/spherex | Not browsable (404). It is the path prefix of every exposure file URL. Discover files with the TAP query in `docs/DATA.md`. |

Re-download the PDF:

```bash
mkdir -p docs/reference && curl -L -o docs/reference/SPHEREx_Expsupp.pdf https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf
pdftotext -layout docs/reference/SPHEREx_Expsupp.pdf docs/reference/Expsupp.txt
```

(Add `-k` to curl only inside the Claude Code sandbox, see `docs/DATA.md`.)

## Where things are in the supplement (page numbers are PDF pages)

| Topic | Section |
|-------|---------|
| Instrument parameters, detector bands | Table 2 (p. 6) |
| File format and extensions | 2.2 |
| Filename convention | Table 3 |
| Pixel flag bits | Table 16 (p. 33) |
| Flag masking for photometry | "Flag usage" (p. 44) |
| Zodi model | 3.2.11 |
| Mosaic recipe (`IMAGE - ZODI`, bad pixel list) | 3.4.3 |
| Astrometry (Gaia proper motions) | 3.2.8 |
| Spectral WCS files | 4.3.1 |
| Known data issues (bloom, snowballs, ghosts, streaks) | Section 3.1 pages 17 to 24 region |

Search the text copy with `grep -n -i <term> docs/reference/Expsupp.txt`.
