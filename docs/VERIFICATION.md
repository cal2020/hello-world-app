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

All results below are from the final commit on this branch, run in that
environment on 7 October 2026.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | Passed (no errors). |
| Lint | `npm run lint` | Passed (no errors or warnings). |
| Unit tests | `npm test` | **61 passed** in 8 files: content integrity 9, locale completeness 13, quality controller 6, routing 6, scale bar 5, search 6, selection and Escape 9, tour timing and playback 7. |
| Translations | `npm run i18n -- check <lang>` | **0 issues** for each of sr, fr, it, es, ru and zh (same keys and placeholders as English, valid plural categories, no leftover English). |
| Production build | `npm run build` | Passed; **147 pages prerendered** (21 pages × 7 languages) plus the root redirect and the 404 page. Bundle sizes are in [PERFORMANCE.md](PERFORMANCE.md). |
| Browser tests | `npm run test:e2e` | **17 passed** in 9.5 min (list below). |
| Close-up check | `npm run check:closeups` | **21 of 21 views opened**, no console errors, every view showed labels, resources released (table below). |

### Browser tests (Playwright, Chromium + SwiftShader, reduced motion)

| Test | What it does |
| --- | --- |
| no detectable WCAG A/AA violations in the main views | axe-core (WCAG 2.0/2.1 A and AA rules) on the whole cell, a selected structure (nucleus) and the Help dialog; the canvas is excluded |
| keyboard: skip link and search shortcut | the first Tab focuses the skip link; `/` focuses the search field |
| zoom, reset, quality, motion, text atlas and About | zoom in/out and reset; Low vs High quality changes the reported object counts; the reduced-motion setting applies; the text atlas opens and closes; About opens at `/en/about/` and closes back to the structure; no console errors |
| labels, related links, citations, close-up views and the location inset | a label click selects; a related-structure link (nucleus → chromosomes); citations link to https sources; the second close-up view (`detail=nucleosomes`) with an nm scale; “Back to the cell view” |
| tour controls and annotated export | start the tour, next, previous, exit; download an annotated PNG |
| rapid selection, resizing and rotation leave a consistent state | five quick selections end on the last one (centrosome, focused); resizing through phone portrait and landscape, tablet and desktop keeps it, ending in the wide layout; no page errors |
| 3D start-up failure shows the complete text atlas | `?renderer=fail`: failure notice plus the text atlas with all 19 structures |
| a failed language load keeps the page usable and says so | `/fr/?simulate=locale-failure`: English stand-in with a visible notice and `lang="en"` |
| losing the WebGL context offers a restart | `?simulate=context-loss`: notice, then “Restart 3D” brings the scene back |
| without JavaScript › every page is readable as prerendered text | JavaScript disabled: French mitochondria page with `lang`, heading, canonical and `hreflang` links, working next link; English About page |
| main demonstration journey | enter → mitochondria → its close-up, then the ATP-synthase view (internal membranes) → whole cell → search “ribosomes” → translation close-up → start and pause the tour → switch to French → export a clean PNG; no console errors |
| deep links, Back/Forward and Escape | direct load of the nucleus close-up; Escape goes up to the structure; after selecting the Golgi, Back twice returns to the nucleus and then its close-up, Forward twice to the Golgi; Escape goes to the whole cell |
| previous and next wrap around | from the 19th structure, next goes to the first and previous comes back |
| search: synonyms and an empty state | “cell membrane” and “mitochondrion” find their structures; “zzzz” shows the empty state |
| labels toggle and biological freeze | turning labels off hides every label; the freeze control toggles its pressed state (its independence from the tour pause is a unit test) |
| unknown pages fall back to the whole cell with a notice | `/en/not-a-structure/` → whole cell and a notice |
| phone layout: list drawer, bottom sheet and settings | Pixel 7 emulation: compact layout, list drawer selects ribosomes, the bottom sheet expands, quality and motion settings in the “More” menu |

### Close-up views

Quality: low. GPU resources after entering: 58 geometries, 8 textures; after the first pass over all close-ups: 66 geometries, 26 textures (first-visit caches); after the second pass: 66 geometries, 26 textures.

| Close-up view | Opened | Load | Draw calls | Triangles | Labels shown | Resources after leaving | Console errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| plasma-membrane | ok | 13.5 s | 11 | 110,114 | 9 | released | – |
| cytoplasm | ok | 3.9 s | 25 | 53,818 | 6 | released | – |
| nucleus | ok | 5.6 s | 14 | 27,262 | 8 | released | – |
| chromosomes / metaphase | ok | 5.6 s | 10 | 72,530 | 4 | released | – |
| chromosomes / nucleosomes | ok | 8.2 s | 8 | 84,146 | 3 | released | – |
| telomeres | ok | 7.2 s | 14 | 50,158 | 5 | released | – |
| nucleolus | ok | 4.8 s | 19 | 56,590 | 8 | released | – |
| ribosomes | ok | 5.3 s | 15 | 19,574 | 6 | released | – |
| rough-er | ok | 4.3 s | 29 | 26,028 | 7 | released | – |
| smooth-er | ok | 5.5 s | 13 | 25,602 | 8 | released | – |
| golgi | ok | 5.3 s | 18 | 94,050 | 8 | released | – |
| vesicles-motors | ok | 4.6 s | 18 | 85,870 | 9 | released | – |
| mitochondria / organelle | ok | 6.7 s | 7 | 59,424 | 7 | released | – |
| mitochondria / atp-synthase | ok | 5.1 s | 19 | 34,494 | 7 | released | – |
| lysosomes | ok | 5.1 s | 22 | 84,146 | 6 | released | – |
| endosomes | ok | 5.7 s | 20 | 24,136 | 7 | released | – |
| peroxisomes | ok | 5.8 s | 19 | 31,546 | 8 | released | – |
| microtubules | ok | 5.6 s | 2 | 99,042 | 6 | released | – |
| actin | ok | 5.8 s | 29 | 91,734 | 6 | released | – |
| intermediate-filaments | ok | 6.3 s | 6 | 87,890 | 2 | released | – |
| centrosome | ok | 4.9 s | 10 | 11,210 | 7 | released | – |

Load times include fetching and building the close-up in software rendering
on a shared 4-core container; the first close-up opened also compiles shared
shaders. "Released" means a second visit to every view left no more geometries
or textures behind than there were before it (the first pass fills small
bounded caches: one background texture per close-up colour and a few shared
shapes).

SCREENSHOTS_RESULTS

## 3. Browser inspection

Screens were inspected at desktop (1440×900 and 1280×800), tablet (1024×1366)
and phone (390×844) sizes in English and in other languages; the images are in
[docs/screenshots/](screenshots/). Live animation could only be inspected at the
low frame rates of software rendering (a few frames per second); motion timing
was therefore also checked through the code's pure time functions (close-up
animations are functions of biological time, so frozen frames are exact).

What was checked by looking at rendered pages: the 18 screenshots in
[docs/screenshots/](screenshots/), a contact sheet of all 21 close-up views
frozen at their poster moments (as a reduced-motion reader sees them), the 20
text-atlas illustrations, and extra checks of each fix below.

| Area | Observed |
| --- | --- |
| Entry and overview | Title card with “Enter the cell” and the text-atlas link; after entering, the cut-open cell with labels, the structure list on the left and the overview text on the right; scale bar in µm. |
| Focused structures | Mitochondria “In the cell”: the selected mitochondrion is cut open in place (outer and inner membrane, cristae, matrix labelled) and nearer mitochondria dissolve out of the way. Nucleus: envelope opened, chromatin territories and nucleoli visible, pores labelled. Golgi: an oblique view of the stack with cis → trans labels in order. |
| Close-ups | All 21 views open with their labels; frozen, each shows its poster moment. Scale bars switch to nm and state the enlargement relative to the whole cell (×210 for ATP synthase, ×260 for the ribosome, ×270 for the membrane). |
| Teaching animations | Playing frames show the intended events: ATP leaving ATP synthase, a tRNA in the ribosome with the chain leaving the exit tunnel, kinesin on the microtubule with plus-end chevrons and dynein going the other way, export through the nuclear pore. |
| Languages | French, Chinese, Spanish, Serbian, Russian and Italian pages show fully translated panels, labels, controls and scale text; Chinese uses its own font. |
| Fallback | `?renderer=fail` shows the failure notice and the text atlas with contents and an illustration for every structure. |
| Tablet and phone | Tablet: list in a drawer, reading panel on the right, toolbar and zoom buttons beside it. Phone: bottom sheet with a drag handle, compact toolbar, scale box and location inset. |

**Defects found in this review and fixed** (commit “Fix layout and framing
problems found in the screenshot review”):

1. The text atlas slid 20 px under the structure list on wide screens (first
   letters of headings hidden) — it now starts beside the list.
2. On tablets in Spanish, Russian and Serbian the longer toolbar labels pushed
   the zoom buttons over the reading panel — the toolbar now wraps, and its
   export button is icon-only on tablets.
3. On phones the scale box overlapped the first toolbar button — the bar is
   capped at 80 px there; the location inset's “Back to the cell view” button
   text now wraps instead of being clipped (Italian).
4. The Golgi “In the cell” view looked straight into the cup of the stack, so
   cis, medial and trans labels overlapped. Cause: the stack's own pick sphere
   was a hair inside the engine's “clear” margin, so the stack counted as
   blocking its own view and the camera swung round. The framing now looks
   obliquely across the ribbon with a radius that keeps the margin clear.
5. The kinesin close-up let the vesicle run up behind the top bar — the view
   now leaves room for it.
6. The French search placeholder was clipped (“« membrane c…”) — French and
   Russian examples were shortened.
7. With motion frozen, the intermediate-filament close-up opened without any
   labels and several others without their event captions — close-ups now
   open on a labelled poster moment (see “Close-up views” above).

Known compromises: the scene deliberately fills the window behind translucent
panels, so large objects can pass behind a panel; in a browser with hardware
compositing the panels blur what is behind them. Live motion was only seen at
the low frame rates of software rendering.
