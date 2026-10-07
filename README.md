# Human Cell Atlas

An illustrative, explorable 3D model of a representative human cell, about
14 µm across, with all 19 major structures. You can enter the cell, select any
structure (in the scene, from the list, by its label or by search), open a
molecular close-up with teaching animations, and take a 19-stop guided tour.
The whole atlas is available in seven languages and as readable text without
3D or JavaScript.

The concept is inspired by the Cellula Humana experience
(<https://cellulahumana.com/>). All code, geometry, illustrations and text in
this repository are original; see [Limitations](#limitations) for what could
and could not be checked against the reference.

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Commands](#commands)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Scientific model and simplifications](#scientific-model-and-simplifications)
- [Languages](#languages)
- [Accessibility](#accessibility)
- [Performance](#performance)
- [Testing and verification](#testing-and-verification)
- [Limitations](#limitations)
- [Licences](#licences)

## Quick start

Requirements: **Node.js 22.12 or newer** (Vite 8 and Vitest 5 require it) and npm.

```bash
npm ci                 # install exactly the locked dependency versions
npm run dev            # development server → http://localhost:5173/
```

Production build and local preview:

```bash
npm run build          # type check, Vite build, prerender 147 static pages
npm run preview        # → http://localhost:4173/
```

Opening `/` redirects to the saved language or the browser's language
(`/en/`, `/sr/`, `/fr/`, `/it/`, `/es/`, `/ru/`, `/zh/`).

## What it does

**Main scene.** A cut-open cell (1 scene unit = 1 µm) built by seeded procedural
generation, so every visit shows the same arrangement: plasma membrane,
cytoplasm, nucleus with chromatin territories, telomeres and two nucleoli,
ribosomes (free, in polysome spirals and on the rough ER), rough ER sheets
continuous with the nuclear envelope and the smooth ER tubules, a Golgi stack
beside the centrosome, transport vesicles riding microtubules, mitochondria,
lysosomes, endosomes, peroxisomes, a radial microtubule network with dynamic
instability, an actin cortex and a vimentin intermediate-filament cage around
the nucleus.

**Interaction.**

| Feature | How it works |
| --- | --- |
| Entry | Real loading progress, a preview illustration and “Enter the cell”, which opens the cutaway (instant with reduced motion). |
| Selection | Clicking geometry, a label, a list entry or a search result all call the same action: camera, explanation, selection state and address change together. Drags never count as clicks. |
| Focus (“In the cell”) | The structure is framed beside the reading panel; everything else fades. Faded structures cannot be clicked (the same 0.3-opacity rule drives visuals and picking). The camera avoids directions blocked by other copies of the structure, and objects close to the camera dissolve. |
| Close-up | A separate, lazily loaded scene at molecular or organelle scale for every structure (21 views), with labels, a scale bar in nm, the magnification relative to the whole cell, a location inset that leads back to the cell, and teaching animations. Mitochondria and chromosomes have two close-up views each. |
| Navigation | Persistent “Whole cell”, breadcrumb, previous/next (wraps from the last structure to the first), arrow keys, Escape (closes a dialog first, then goes close-up → in the cell → whole cell). |
| Search | Names, synonyms and part names in the current language plus English (e.g. “cell membrane”, “mitochondrion”, “ER”), small typos tolerated, with an empty state and suggestions. |
| Guided tour | 19 stops; the 14-second reading timer starts when the camera arrives; pause keeps the stop and the remaining time; previous/next/exit; choosing a structure yourself ends the tour. Tour steps replace (not add) history entries. |
| Freeze | Stops biological motion only; camera, reading and selection keep working. Independent of the tour's pause. |
| Labels | Screen-space labels with leader lines, overlap avoidance, occlusion checks and viewport clamping; labels select their structure; hover feedback on desktop. |
| Scale bar | Computed from the camera's field of view, the distance to the focus point and the current scene's unit (µm in the cell, nm in close-ups); switches between nm, µm and mm; notes enlargement factors. |
| Image export | “Save image” downloads a PNG of the current view: clean, or annotated with labels, the physical scale bar and a caption. |
| Settings | Labels on/off, quality (Auto/Low/Medium/High), motion (follow system/reduce/allow), language; saved locally. |
| Help and About | Shortcuts, how everything works, a filterable list of all sources, the model's assumptions and simplifications, credits and licences. |
| Text atlas | The complete content as text (all 19 structures, numbers, sources); shown automatically when 3D cannot start. |
| Static pages | Every route is prerendered as a real HTML page with its own title, description, canonical and hreflang links, readable without JavaScript. |

**Close-ups and what they teach** (scale per view; slow-down where a single factor applies):

| Structure | Close-up (scale) | Teaching animation |
| --- | --- | --- |
| Plasma membrane | Lipid bilayer, 40 nm patch (1 nm/unit) | Individual phospholipids and cholesterol jiggle and drift; an ion channel lets bursts of ions in; receptor, glycocalyx, actin cortex. |
| Cytoplasm | Crowded cytosol, 100 nm cube (1 nm/unit) | Proteins, ribosomes on an mRNA, tRNAs and an actin filament jostling. |
| Nucleus | Nuclear pore complex, cut in half (1 nm/unit) | Import (cargo + importin, in) and export (mRNA package, out) through the pore; lamina. |
| Chromosomes | Metaphase chromosome (10 nm/unit) · DNA packaging (1 nm/unit) | Sister chromatids, centromere, kinetochores with spindle microtubules, telomeres · nucleosomes as beads on a string. |
| Telomeres | T-loop (1 nm/unit) | TTAGGG repeats, the 3′ overhang tucked into the duplex, shelterin. |
| Nucleolus | Subunit assembly (10 nm/unit) | rDNA “Christmas tree” transcription, processing, 40S and 60S subunits leaving. |
| Ribosomes | Translation (1 nm/unit, ×10 slower) | Codon-by-codon elongation: tRNA arrival, peptide bond, translocation, growing chain in the exit tunnel. |
| Rough ER | Translocation (1 nm/unit) | Chain through the translocon, signal cleavage, glycosylation, folding with BiP, COPII budding. |
| Smooth ER | Calcium store (1 nm/unit) | SERCA pumps load calcium (two ions per ATP); release channels open in bursts. |
| Golgi apparatus | Through the stack (10 nm/unit) | Cisternal maturation cis → trans, COPII in, COPI back, secretory and lysosomal vesicles out. |
| Vesicles and motors | Kinesin walking (1 nm/unit, ×50 slower) | Hand-over-hand 8 nm steps toward the plus end, one ATP per step; dynein the other way. |
| Mitochondria | Inside a mitochondrion (10 nm/unit) · ATP synthase (1 nm/unit, ×100 slower) | Membranes, cristae, matrix, mtDNA · proton pumping and the rotary synthase releasing 3 ATP per turn. |
| Lysosomes | Digestion (1 nm/unit) | V-ATPases acidify; a late endosome fuses; hydrolases cut cargo down to amino acids, which leave via transporters. |
| Endosomes | Sort, recycle or degrade (1 nm/unit) | 1 uptake through a clathrin-coated pit, 2 receptor recycling, 3 maturation and fusion with a lysosome. |
| Peroxisomes | Oxidation and detoxification (1 nm/unit) | Oxidase makes H₂O₂, catalase splits it; a fatty acid is shortened; PEX5 imports an enzyme. |
| Microtubules | Dynamic instability (1 nm/unit) | GTP cap growth, catastrophe with curling protofilaments, fast shrinkage, rescue. |
| Actin filaments | Treadmilling and branching (1 nm/unit) | ATP-actin added at barbed ends, ADP-actin lost at pointed ends, Arp2/3 branches at ~70°. |
| Intermediate filaments | Rope-like assembly (1 nm/unit) | Dimer → tetramer → unit-length filament → mature filament, then stretching without breaking. |
| Centrosome | Centrioles (10 nm/unit) | Nine-triplet centrioles at right angles, appendages, γ-tubulin rings nucleating microtubules. |

**Implementation improvements** (required additions beyond the reference experience,
also labelled in the About panel): structure **search** with synonyms, a visible
**rendering-quality** control, and an explicit **reduced-motion** setting.

**Keyboard shortcuts** (ignored while typing in a field): `/` search · `T` tour
start/pause · `L` labels · `F` freeze · `O` whole cell · `C` in the cell ↔ close-up ·
`←`/`→` previous/next · `+`/`−` zoom · `0` reset view · `?` help · `Esc` back/close.

**Addresses.** `/{lang}/` whole cell · `/{lang}/{slug}/` structure ·
`/{lang}/{slug}/?view=closeup` close-up · `…&detail={view}` second close-up view
(e.g. `/en/mitochondria/?view=closeup&detail=atp-synthase`) · `/{lang}/about/`.
Slugs are stable English identifiers shared by all languages. Back and Forward
restore the selection, view and language without reloading.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server with hot reload (port 5173). |
| `npm run build` | Type check, production build, prerender static pages into `dist/`. |
| `npm run build:fast` | Build and prerender without the type check. |
| `npm run preview` | Serve `dist/` on port 4173. |
| `npm run typecheck` | TypeScript project check (`tsc -b`). |
| `npm run lint` | ESLint (TypeScript, React hooks, fast refresh). |
| `npm test` | Unit tests (Vitest): routing/selection, tour timing, playback, scale, quality, search, content integrity and locale completeness. |
| `npm run test:e2e` | Browser tests (Playwright) against the production build: demonstration journey, navigation and history, fallbacks, no-JavaScript pages, phone layout and axe accessibility scans. Run `npm run build` first. |
| `npm run check` | Type check, lint, unit tests and build in one go. |
| `npm run check:links` | Checks every source URL and DOI (needs normal internet access). |
| `npm run screenshots` | Regenerates `docs/screenshots/` from a running preview. |
| `npm run perf` | Measures start-up and frame times from a running preview (`-- --gpu` to use the GPU). |
| `npm run i18n -- check fr` | Translation helper: list sections, show English text, merge a translated section, check a locale. |

Playwright uses the Chromium build that matches `@playwright/test` 1.56.1. On a
new machine run `npx playwright install chromium` once.

## Deployment

The build output in `dist/` is a static site: one prerendered `index.html` per
route, hashed assets under `assets/`, `404.html` and `robots.txt`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_PATH` | `/` | Deploy below a sub-path, e.g. `BASE_PATH=/cell-atlas/ npm run build` (start and end with `/`). |
| `SITE_URL` | empty | Public origin, e.g. `https://atlas.example.org`: canonical and hreflang links become absolute and `sitemap.xml` is written. |

- **Netlify:** `netlify.toml` is included (build `npm run build`, publish `dist`,
  long-term caching for `assets/`). Set `SITE_URL` in the site's environment.
- **Vercel:** `vercel.json` is included (same build, trailing slashes, caching headers).
- **GitHub Pages / any static host:** build with `BASE_PATH=/<repository>/`
  (and `SITE_URL`), then publish `dist/`. Hosts that serve `404.html` for unknown
  paths show the whole cell with a "page does not exist" notice.

No server-side code, accounts or external AI services are needed; all content
ships with the site.

## Project structure

```
src/
  content/        language-neutral content: structures.ts (ids, slugs, groups, colours, parts,
                  relations, model scale, close-up views), science.ts (quantities + claim sources),
                  sources.ts (100 source records with verification status), registry/search/text helpers
  i18n/           languages, translator (plural rules, number formatting), lazy locale loading,
                  validator; locales/*.json hold all prose (English + six translations)
  app/            store (zustand), routing, actions (single selection action), tour state machine,
                  scale maths, quality presets/auto controller, settings, head metadata, hooks
  ui/             accessible React components: top bar, structure list + search, reading panel,
                  controls, tour bar, dialogs, text atlas, static (prerendered) page
  engine/         three.js renderer (React Three Fiber host):
    cell/         seeded layout + one module per group; every structure implements the same
                  interface (objects, focus, picking, framing, label anchors, update, quality, cleanup)
    closeups/     19 lazily loaded close-up scenes + kit.ts (shared molecular building blocks)
    camera/ picking/ labels/ export/ perf/ core/   camera rig, picking, label layout, PNG export,
                  frame-time monitor, materials/geometry/noise/seeded random
  entry-server.tsx  renders static pages for the prerender step
scripts/          prerender, translation helper, link checker, screenshots, performance measurement
tests/unit/       Vitest unit tests        tests/e2e/   Playwright browser tests
docs/             implementation notes, checklist, verification record, performance, screenshots
```

Adding or changing content: numbers and their sources live in `src/content/`;
wording lives in `src/i18n/locales/`. Translations share the same keys, so
language versions cannot drift; `npm test` fails if a locale is missing a key,
loses a `{placeholder}`, lacks a plural form or still contains English.

## Scientific model and simplifications

- **Model.** A generalized human cell in interphase (G1), not a specific cell
  type; rounded; diploid and female (XX), so one X chromosome is shown as an
  inactive X (Barr body); a vimentin intermediate-filament network
  (fibroblast-like). Numbers always name the cell type, species or experimental
  setting in which they were measured (e.g. HeLa cells, hepatocytes).
- **Three separate quantities** are kept apart in the content model and the
  interface: *typical size*, *typical quantity in the cited cell type*, and
  *objects drawn in this model* (which varies with the quality setting).
- **Scale.** Whole cell in µm; close-ups declare their own unit (1 or 10 nm per
  unit) and state magnification, slow-down and any molecule enlargement.
  Small repeated objects are drawn far fewer than in a real cell and enlarged
  where needed (each explanation states the factor, e.g. ribosomes ×2.5,
  microtubules ×2.4, actin and intermediate filaments ×4, the plasma membrane's
  thickness ×10).
- **Colours are illustrative**; most cell structures are colourless.
- **Animations are educational**: slowed (e.g. kinesin ×50, ATP synthase ×100,
  translation ×10), simplified and usually one event at a time.
- **Chromosomes** are shown as dispersed chromatin territories in the cell; the
  condensed (metaphase) chromosome appears only as a separate close-up with its
  cell-cycle context stated.
- Each structure lists its own simplifications (e.g. T-loops drawn much smaller
  than real, fewer proteins in the cytosol cube than a real cytosol holds).

## Languages

English, Serbian (Latin script), French, Italian, Spanish, Russian and
Simplified Chinese. The six translations were produced with AI assistance from
the English source, then checked automatically for completeness (every key,
placeholder and plural form; no leftover English) and proofread by rendering
every text with real values; **they have not yet been reviewed by
native-speaking subject experts**, and each language's About text says so.

Language changes keep the current structure and camera, are saved locally,
set `<html lang>`, localize numbers (`Intl`), titles, descriptions, canonical and
alternate-language links. Chinese fonts load only when Chinese is chosen. If a
language file cannot be loaded, the page says so and offers a retry; English is
never presented as a finished translation.

## Accessibility

Every structure and control is reachable by keyboard, with visible focus,
skip links, landmarks, real headings, `aria-pressed`/`aria-current`/`aria-expanded`
states and live regions for status messages. All 3D content has a text
equivalent (reading panel, text atlas, static pages). Reduced motion turns camera
travel into cuts, stops decorative motion and starts biological animation frozen;
each close-up then shows a representative, labelled moment of its animation. It
follows the system setting unless changed. Automated axe scans (WCAG 2.1 A/AA)
of the overview, a structure view and the Help dialog report no violations.

## Performance

Quality levels change pixel ratio, bloom/anti-aliasing, environment lighting,
geometric detail and the number of repeated objects, never removing a
structure. **Auto** starts conservatively (low on touch devices and software
renderers) and changes level with hysteresis (sustained slow windows to step
down, a long cooldown and a "two strikes" rule before stepping up again). Heavy
parts load lazily: the 3D engine (≈ 290 KB gzipped) after the interface,
close-ups and other languages on demand. Rendering pauses with the browser's
frame loop when the tab is hidden.

Measurements, the environment they were taken in and how to repeat them on real
hardware are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). **Only software
rendering (SwiftShader, no GPU) was available while building**, so the 60 fps
desktop / 30 fps phone targets are not yet confirmed on hardware.

## Testing and verification

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the commands that were run
and their results, and [docs/CHECKLIST.md](docs/CHECKLIST.md) for the
requirement-by-requirement status. Screenshots at desktop, tablet and phone
widths are in [docs/screenshots/](docs/screenshots/).

## Limitations

- **Reference not observed.** The build environment's network policy blocked
  `cellulahumana.com`, so its pages, controls and mobile layout could not be
  inspected. Features follow the documented experience described in the
  project's specification; everything else is a design decision (recorded in
  [docs/IMPLEMENTATION_NOTES.md](docs/IMPLEMENTATION_NOTES.md)).
- **Sources were verified through search records, not by opening the pages.**
  Scientific websites (NCBI, DOI, publishers, BioNumbers) were also blocked, so
  all 100 sources were checked against search-engine records of their abstracts,
  publisher and repository pages and database entries; each source's note says
  which record was used (two values were corrected as a result). Link
  reachability was not tested: run `npm run check:links` from a normal
  connection. Details in [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **Translations** are AI-assisted and not yet reviewed by native-speaking experts.
- **Performance** has only been measured with software rendering (see above).
- Close-up scenes are fixed at the quality level active when they open (changing
  quality applies on the next close-up).

## Licences

Third-party assets and libraries are listed in [ASSET_LICENSES.md](ASSET_LICENSES.md)
(fonts under the SIL Open Font License 1.1; libraries under MIT). No external
images, 3D models or texts are used. The repository has no licence file of its
own yet; add one before publishing.
