# Implementation checklist

Status of every requirement in the project specification. **Done** = implemented
and checked (how is given in the last column); **Partial** = implemented with a
stated gap; **Blocked** = could not be done in the build environment.
Verification details and results: [VERIFICATION.md](VERIFICATION.md).

## 1. Product and reference

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Immersive atlas of a ~14 µm representative human cell | Done | `src/engine/cell/`, model in µm (`layout.ts`); About and overview state the size and assumptions. |
| Review the reference's pages, mobile view, controls | **Blocked** | `cellulahumana.com` was blocked by the environment's network policy; features follow the documented experience in the specification. Observed vs. decided is recorded in IMPLEMENTATION_NOTES.md §1. |
| Original code, text and geometry; asset licences tracked | Done | No external assets; ASSET_LICENSES.md. |
| Client-side app, local preview, production build, deployment instructions | Done | README (Quick start, Commands, Deployment); `netlify.toml`, `vercel.json`. |
| Content available without accounts or external AI services | Done | All content ships in the bundle and the prerendered pages. |
| Search, visible quality control, explicit reduced-motion setting, labelled as improvements | Done | Top bar / list; About “Implementation improvements”; README. |

## 2. All 19 structures

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Five groups, 19 structures, each discoverable, selectable, explained | Done | `structures.ts`; list, labels, picking, search; unit test “content integrity”. |
| Distinctive anatomy (enclosing membranes, ER sheets + tubes, curved Golgi stacks, mitochondria with cristae, distinct filament networks) | Done | `engine/cell/structures/*.ts`; screenshots. |
| Seeded, reproducible arrangement in correct compartments | Done | `core/random.ts` (seeded), `cell/layout.ts`. |
| Rough and smooth ER connected and distinguished by ribosomes; centrosome organizes microtubules | Done | ER network continuous with the nuclear envelope; microtubules radiate from the centrosome. |
| Small structures get an enlarged close-up linked to their location | Done | 19 close-ups (21 views) with location inset and “Back to the cell view”. |

## 3. Scientific model and scale

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Illustrative model; cell type and assumptions explained | Done | Overview text, About “Assumptions”. |
| µm base unit; biological size, rendered size, enlargement, sampling stored separately | Done | `ModelScale` in `structures.ts`; shown under “Objects drawn in this model”. |
| Fewer repeated objects; colours and counts explained | Done | Per-structure “sampling”, overview, About. |
| Scale bar from camera projection and scene unit; µm ↔ nm; enlargement shown | Done | `app/scale.ts` (unit tests), engine `updateScale`; close-ups show magnification vs. whole cell. |
| Typical size / typical quantity in the cited cell type / objects drawn kept distinct, with context | Done | Reading panel “By the numbers”. |
| Interphase chromatin; condensed chromosome as separate close-up with cell-cycle context; chromatids, centromere, telomeres; XX assumption | Done | Chromosome territories + inactive X in the cell; metaphase close-up text states mitosis context. |
| Claims verified against publications | Done | All 100 sources verified through search records (abstracts, publisher and repository pages, BioNumbers); two values corrected. Pages could not be opened directly from the environment. See VERIFICATION.md §1. |
| Simplifications explained; time-scaling stated | Done | Per-structure simplifications; close-up notes “slowed about ×N”. |

## 4. Visual design and layout

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Dark scientific-atlas mood, soft lighting, restrained glow, serif titles, readable sans | Done | Alegreya / Alegreya Sans; bloom only at medium/high. |
| Desktop: scene dominates, list left, reading panel right, focused object beside panel, compact controls and scale | Done | View offsets keep the subject in the free area; screenshots. |
| Phones/tablets: collapsible list, expandable bottom sheet, reframing, safe areas, touch targets, orientation | Done | Compact and compact-landscape layouts; sheet with drag handle; e2e “phone layout”. |
| Independent panel scrolling without camera movement | Done | Panel is outside the canvas; wheel/touch on it never reach camera controls. |
| Screen-space labels with leader lines, overlap/occlusion handling, clamped, clickable; hover and touch feedback | Done | `labels/LabelLayer.ts`. |
| Purposeful easing; 1–3 s travel; immediate direct manipulation; reduced motion respected | Done | `camera/CameraRig.ts` (distance-based durations, cancellable). |

## 5. Interaction contract

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Entry: real progress, preview, “Enter the cell”, cutaway (instant with reduced motion); failure → text atlas | Done | EntryOverlay; e2e fallback tests. |
| Explore: orbit, wheel/pinch zoom, zoom/reset buttons, constrained ranges | Done | camera-controls with per-view limits. |
| Select: geometry/label/list/search → same action; camera, panel, state, URL together; drag ≠ click; generous pick targets | Done | `actions.selectStructure`; unit test “every selection source…”; Picker drag threshold. |
| Focus: highlight + reduced obstruction, consistent for visuals and picking; deep structures viewable | Done | Opacity context table, 0.3 pick threshold, unobstructed framing, foreground dissolve. |
| Return: persistent Whole cell, Escape order, previous overview pose restored | Done | Unit test “Escape goes up one level”; e2e. |
| Navigate: previous/next, arrow keys, wrap explained, search with synonyms and empty state | Done | Unit + e2e tests; Help explains wrapping. |
| Tour: 19 stops, start/pause/resume/next/previous/exit, progress, ~14 s reading, arrival starts timer, manual selection exits, pause preserves state | Done | `app/tour.ts` + unit tests; e2e journey. |
| Freeze: clearly labelled, separate from tour pause | Done | Unit test “independent”. |
| Controls: labels, quality, motion, help, export; toggle states; shortcuts documented and ignored in form fields | Done | Help dialog; `useShortcuts`. |
| Export: real PNG, clean and annotated (labels + physical scale), current camera, errors reported | Done | `export/exportImage.ts`; e2e download test. |
| URLs: stable routes, direct load, Back/Forward restore without reset | Done | Routing unit tests; e2e “deep links, Back/Forward”. |

## 6. Animations that teach

| Structure | Status | Close-up |
| --- | --- | --- |
| Nucleus | Done | Nuclear pore cross-section with import and export traffic. |
| Nucleolus | Done | rDNA “Christmas tree”, subunit assembly and exit. |
| Ribosomes | Done | Translation: mRNA codons, tRNA cycle, growing chain. |
| Rough ER and Golgi | Done | Translocation, signal cleavage, glycosylation, folding, COPII export; cisternal maturation through the Golgi. |
| Vesicles and motors | Done | Kinesin hand-over-hand stepping toward the plus end; dynein the other way. |
| Mitochondria | Done | Cut-open organelle; proton pumping and ATP synthase rotation. |
| Endosomes and lysosomes | Done | Uptake → recycling → degradation; lysosome digestion. |
| Peroxisomes | Done | Oxidase/catalase chemistry, fatty-acid shortening, protein import. |
| Cytoskeleton | Done | Microtubule dynamic instability, actin treadmilling and branching, intermediate-filament assembly and stretch, centrioles. |
| Every structure has an inspection view; priority close-ups (membrane, chromosomes/telomeres, ribosomes, mitochondria, motors) | Done | See screenshots. |
| Subtle living-cell motion in the whole cell | Done | Microtubule dynamic instability, vesicle transport, wobbling organelles, drifting cytosol specks. |

## 7. Content and languages

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Structured registry: id, name, group, slug, short text, function, “what you are seeing”, 3–5 facts with context, interesting fact, parts, citations, relations, simplifications | Done | `content/` + locales; content tests check completeness. |
| Citations with title, author/organisation, year, working URL; beside explanations; searchable list in Help/About | Done / **Partial** | Numbered citations in each article; filterable list. Link reachability could not be tested from the environment (`npm run check:links`). |
| Seven languages, everything translated, common content model | Done | Locale tests: same keys, placeholders, plural forms, no leftover English. AI-assisted; not yet reviewed by native experts. |
| Same structure on language change, camera kept, preference saved, html lang, number formatting, font coverage, localized metadata, canonical and alternate links | Done | e2e journey; prerendered pages carry hreflang/canonical. |
| Never present English as a finished translation | Done | Stand-in banner (e2e “failed language load”). |
| About page: model, assumptions, credits, sources, licences | Done | `/{lang}/about/`. |

## 8. Architecture

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| React, TypeScript, Vite, Three.js, React Three Fiber; stable checked versions; static hosting | Done | IMPLEMENTATION_NOTES.md §3. |
| Separation: content / scene construction / animation / camera & picking / state & routing / UI & fallback | Done | Folder structure (README). |
| Consistent per-structure interface | Done | `engine/cell/types.ts` `StructureInstance`; `closeups/types.ts`. |
| Explicit states (loading, overview, transition, focused, failure); tour and playback independent; single selection action | Done | Store `phase`, `viewState`, `tour`, `bioFrozen`. |
| Renderer-side fast state, frame-time-independent animation with clamped steps, cancellable transitions | Done | Engine frame loop (0.25 s cap; tab-resume frame skipped). |
| Instancing, detail levels, economical materials, procedural geometry, dedicated detail scenes | Done | Instanced meshes throughout; quality presets. |
| Prerendered semantic pages from the same registry; deliberate static-host routing | Done | `scripts/prerender.ts` (147 pages + root + 404); e2e no-JS test. |

## 9. Performance, accessibility, resilience

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| ~60 fps desktop / ~30 fps midrange phone, measured and documented | **Partial** | Only software rendering available; measurements and the procedure for hardware runs in PERFORMANCE.md. |
| Auto/low/medium/high; no oscillation; settings saved | Done | `app/quality.ts` + unit tests. |
| Useful first view, lazy heavy parts, real progress, background pause, resources released | Done | Lazy 3D engine, close-ups and locales; rAF stops when hidden; disposal paths; object URLs revoked. |
| Keyboard access, focus indicators, contrast, screen-reader semantics, motion setting, text equivalents | Done | axe scans: no WCAG A/AA violations; skip links; e2e keyboard test. |
| Recovery from WebGL failure, context loss, locale failure, export failure | Done | e2e fallback tests; export errors shown as toasts. |
| Text atlas with navigation and original illustrations when 3D is unavailable | Done | Text atlas with contents; each structure has an original illustration rendered from its close-up (`public/illustrations/`). |

## 10–11. Process, acceptance and handoff

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Staged implementation with a running checklist | Done | This file; IMPLEMENTATION_NOTES.md. |
| Type check, lint, build, focused unit tests, browser journeys and fallbacks | Done | VERIFICATION.md §2. |
| Screenshots at desktop, tablet, narrow phone | Done | `docs/screenshots/`. |
| Demonstration flow | Done | e2e `journey.spec.ts` runs it end to end. |
| README, lockfile, content and sources, licences, verification results, screenshots, limitations | Done | This repository. |
