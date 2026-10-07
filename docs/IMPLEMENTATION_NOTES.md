# Implementation notes — Human Cell Atlas

This file records the Stage A inventory, the assumptions and design decisions,
the chosen stack, the implementation plan and the running checklist. It is
updated as the work proceeds.

## 1. Reference inspection (observed vs. described)

The brief asks for a review of <https://cellulahumana.com/>. **The reference
could not be observed from the build environment**: the sandbox's network
egress policy denied `cellulahumana.com` (HTTP 403 from the proxy, and the
WebFetch tool reported `EGRESS_BLOCKED`), and archived copies were also
unreachable. Nothing in this project is therefore based on direct observation
of the reference's pages, controls, mobile layout or code.

The feature inventory below is taken from the reference's **documented
experience as described in the brief**, and every other behaviour is marked as
a design decision made for this implementation.

| Area | Source | Notes |
| --- | --- | --- |
| 19 structures in 5 groups | Brief (documented reference experience) | Implemented exactly as listed. |
| Close-up navigation | Brief | Implemented as a two-level view: focused "In the cell" view plus a lazy-loaded "Close-up" detail scene. |
| Guided tour | Brief | 19 stops; timing rules from the brief. |
| Labels | Brief | Screen-space labels with leader lines (design decision on layout). |
| Biological-animation freeze | Brief | Separate from tour pause. |
| Camera shortcuts | Brief | Exact keys are our design decision (documented in Help). |
| Still-image export | Brief | PNG, clean and annotated. |
| Source citations | Brief | Claim-linked; verified via search-index results (see §5). |
| Seven languages | Brief | en, sr-Latn, fr, it, es, ru, zh-Hans. |
| Readable text pages | Brief | Prerendered semantic pages from the same registry. |
| Visual mood (dark, glowing, serif titles) | Brief | Our interpretation; no reference assets used. |
| Search, visible quality control, explicit reduced-motion setting | Brief: **required implementation improvements** | Labelled as improvements in the About panel and README. |

All code, geometry, explanatory text and illustrations in this repository are
original. No reference assets, text or code were copied (none were accessible).

## 2. Repository inspection

The repository contained a small Vite (vanilla JavaScript) "greeting card
generator" with no tests or lint configuration. It has been replaced by the
atlas application; the previous app remains in git history (commit `2a1db85`).
Vite was the only established convention and is kept.

## 3. Stack (versions checked against the npm registry on 2026-10-07)

| Package | Version | Why this version |
| --- | --- | --- |
| react / react-dom | 19.3.0 | Latest; within @react-three/fiber's peer range (`>=19 <19.4`). |
| three / @types/three | 0.186.1 / 0.186.0 | Latest. |
| @react-three/fiber | 9.8.1 | Latest; React 19 line. |
| camera-controls | 3.1.2 | Orbit/dolly/touch handling; MIT. |
| zustand | 5.0.15 | Small store usable from React and the renderer. |
| vite / @vitejs/plugin-react | 8.3.3 / 6.1.2 | Latest; plugin 6 requires Vite 8. |
| typescript | **6.0.3** | TypeScript 7.0 is the latest, but typescript-eslint 8.71 supports `<6.1.0`; 6.0.3 is the newest compatible release. |
| eslint / typescript-eslint | 10.12.0 / 8.71.1 | Latest, mutually compatible. |
| vitest | 5.0.3 | Latest; supports Vite 8. |
| @playwright/test | **1.56.1** | Matches the Chromium build (rev. 1194) pre-installed in this environment; elsewhere run `npx playwright install chromium`. |
| tsx | 4.23.15 | Runs the TypeScript prerender script. |
| @fontsource/alegreya, alegreya-sans, noto-sans-sc | 5.3.0 | Self-hosted OFL fonts (Latin, Latin-ext, Cyrillic; CJK loaded only for Chinese). |

Node.js ≥ 22.12 is required (Vite 8 / Vitest 5 engines).

## 4. Key design decisions

* **Units.** Whole-cell scene: 1 scene unit = 1 µm. Each close-up declares its
  own unit (usually 1 unit = 1 nm). The scale bar is computed from the camera's
  vertical field of view, the distance to the orbit target and the current
  scene's unit mapping.
* **Two inspection levels.** "In the cell" (organelle scale, the structure's
  representative instance is framed and everything else fades) and "Close-up"
  (separate molecular or anatomical scene, lazy-loaded, with a breadcrumb and a
  location inset that links back to the whole-cell location).
* **Routes.** `/{lang}/` (whole cell), `/{lang}/{slug}/` (structure),
  `/{lang}/{slug}/?view=closeup`, `…&detail={viewId}` for a structure's second
  close-up view, `/{lang}/about/`. Slugs are stable English identifiers shared
  by every language; titles, descriptions and alternate links are localised.
  `/` redirects to the saved or browser language. Every route is also
  prerendered as a static page (`scripts/prerender.ts`).
* **Navigation wraps.** Previous/next and arrow keys wrap from the last
  structure to the first and vice versa (stated in Help and on the controls).
* **Tour.** Uses `history.replaceState` for its steps so that a tour does not
  flood browser history; manual selection ends automatic advancement.
* **Reduced motion.** Camera travel becomes an immediate cut, panels do not
  slide, decorative ambient motion stops, and biological animation starts
  frozen (one click to play). Setting: System / Reduce / Allow.
* **Picking.** A structure is pickable only while its effective opacity is at
  least 0.3, so faded ("ghosted") structures never intercept clicks — the same
  rule drives visuals and picking.
* **Cutaway.** The plasma membrane and nuclear envelope open a cap centred on
  the line of sight, so the interior stays visible from any orbit angle. Its
  glowing edge dims while an interior structure is in focus.
* **Unobstructed focus.** When a structure is selected, the camera keeps its
  preferred viewing direction unless other copies of the structure (or strongly
  visible context) would block the line of sight; then it picks the nearest
  clear direction within ~50°. Anything closer to the camera than ~45 % of the
  focus distance dissolves (dithered), and dissolved objects cannot be clicked.
* **Close-up toolkit.** Close-ups share `src/engine/closeups/kit.ts`: lipid
  bilayers with individual lipids, banded cut membranes, DNA/RNA helices,
  coiled coils, actin and microtubule lattices, tRNA and ribosome shapes, glowing
  ion particles and GPU-side thermal motion. Close-up animations are pure
  functions of biological time, so freezing stops them exactly. Each close-up
  runs on its own clock, which starts at the view's `posterTime`: a moment
  with its key parts labelled, chosen by probing which phase-limited labels
  are visible over the loop (`__HCA_DEBUG__.closeupLabels` with `?perf=1`) and
  checking the frames. With motion frozen (reduced motion) that moment is the
  still image readers see; otherwise playback continues from it.
* **Translations.** A language-neutral registry (`src/content/`) holds numbers,
  sources and structure metadata; locale files hold all prose. Six translations
  were produced with AI assistance and are checked automatically (keys,
  placeholders, plural categories, no leftover English); unit strings may be
  plural objects for languages such as French (“1 milliard *de* molécules”).

## 5. Scientific sourcing method

Direct access to scientific websites (NCBI, DOI resolver, publishers, PubMed,
BioNumbers, Wikipedia) was blocked by the sandbox's egress policy. Citations
were therefore verified through web-search index results: a source is
accepted only if a search result showed the exact URL, a matching title and
supporting text. The verification note for each source is kept in
`src/content/sources.ts`. Links were not fetched live from this environment;
`npm run check:links` re-checks them from a machine with normal internet
access.

## 6. Plan

* **A.** Inventory, assumptions, stack, plan (this file).
* **B.** Interface shell, content registry, English locale, routing, store, text atlas, prerender.
* **C.** Whole-cell scene: seeded procedural geometry for all 19 structures; picking.
* **D.** Camera rig and transitions, view offsets for panels, labels, scale bar, entry cutaway.
* **E.** Close-up scenes and teaching animations.
* **F.** Tour, freeze, export, quality, reduced motion, six translations, resilience.
* **G.** Checks, browser tests, screenshots, performance notes, README, handoff.

## 7. Running checklist

Status is kept current in `docs/CHECKLIST.md`; verification results are in
`docs/VERIFICATION.md` and performance notes in `docs/PERFORMANCE.md`.
