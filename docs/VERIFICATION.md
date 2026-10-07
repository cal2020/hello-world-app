# Verification record

This file records how the scientific content was checked and which automated
and manual checks were run on the application, with their actual results.

## 1. Scientific sources

### Method

The content model keeps every number in `src/content/science.ts` together
with the sources that support it; prose lives in the locale files. Each source
in `src/content/sources.ts` has a `status` and a `note` saying what the evidence
was. **All 100 sources are verified**, and no statement carries the
“Verification pending” flag.

- The source's bibliographic data (authors, title, journal, volume, pages, year,
  DOI or URL) and the statement it supports were confirmed through
  search-engine records: PubMed / PubMed Central abstracts, publisher and
  institutional repository pages, NCBI Bookshelf pages, BioNumbers entries and
  structure databases (RCSB PDB). Each `note` names the record and what it
  showed (for example *“PubMed Central record (PMC145537) confirmed the
  citation; the abstract reports translocation rates on the order of 10³ events
  per second”*).
- Opening the pages directly was not possible: the build environment's network
  policy blocks NCBI, doi.org, publishers, BioNumbers and Wikipedia, both for
  scripts and for the page-fetching tool. The search record is therefore the
  evidence. A few chapter-level textbook citations (Molecular Biology of the
  Cell, The Cell) were confirmed through records of standard references for
  the exact value, as their notes say.
- Verification happened in two rounds. The first confirmed 73 sources; the
  second (27 sources, 51 statements) was completed once search was available
  again.

Numbers keep their measurement context (cell type, species, experimental
setting) next to the value; the content tests check that every claim cites an
existing source and that every source is cited. The interface can still flag a
source as “not yet verified” and its statements as “Verification pending”
(`status: 'pending'` / `pending: true`) for future content.

### Corrections made during verification

| Statement | Before | After | Evidence |
| --- | --- | --- | --- |
| Telomere loss per cell division (`telomeres.facts.shortening`) | about 50 bp | 50–200 bp | BioNumbers BNID 104276 quotes Harley et al. (1990) for 50–200 bp lost per replication cycle. |
| Diameter of ER tubules in mammalian cells (`smooth-er.typicalSize`) | 30–50 nm | about 50 nm | Hu, Prinz & Rapoport (2011) and related records: about 50 nm in mammals, about 30 nm in yeast. |
| GTP cap (`microtubules.facts.gtp-cap`) | textbook only | + Mitchison & Kirschner (1984) | The dynamic-instability paper links the switch to shrinkage with loss of the GTP cap. |

Two values were checked against the measured numbers and kept, with the detail
in the source note: kinesin heads move about 16 nm per step (measured
17.3 ± 3.3 nm by Yildiz et al., 2004, i.e. twice the 8-nm step), and the
vertebrate nuclear pore complex is about 120 nm wide (records give an outer
diameter of 120–145 nm).

### What is left for a maintainer

1. Run `npm run check:links` from a machine with normal internet access. It
   checks all 100 URLs plus DOIs, reports broken links and lists the ones that
   publishers block for automated requests ("check manually").
2. Optionally re-read the full texts behind the search records (the notes in
   `src/content/sources.ts` say which record was used), especially for the
   chapter-level textbook citations.

## 2. Automated checks

Environment: Linux container, Node.js 22.22.0, npm 10, Chromium 141
(Playwright 1.56.1 build 1194) with **SwiftShader software WebGL** (no GPU).

RESULTS_PLACEHOLDER

## 3. Browser inspection

Screens were inspected at desktop (1440×900 and 1280×800), tablet (1024×1366)
and phone (390×844) sizes in English and in other languages; the images are in
[docs/screenshots/](screenshots/). Live animation could only be inspected at the
low frame rates of software rendering (a few frames per second); motion timing
was therefore also checked through the code's pure time functions (close-up
animations are functions of biological time, so frozen frames are exact).

INSPECTION_PLACEHOLDER
