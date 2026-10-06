# UI round 1: shell, design system, components and the state graph

Two agents, **shell** and **graph**, work in parallel in the shared tree. Engine-porting agents are also writing
`src/`, `golden/gen_<module>.py` and `test/NN_*.test.js` at the same time, so never touch those. Each agent
owns only the files listed for it. Read `specs/UI.md` completely first. It is the specification, and this
file only scopes the round.

## Building and testing without stepping on each other
* Build into your own output folder, include only the engine modules that already work, and (while the other UI
  agent is mid-edit) only your own app files:
  * shell: `python build.py --engine-prefixes 00,05,10,15 --app-prefixes 00,01,02,05,10,20,30,40,50,60,90 --out dist-shell`
  * graph: `python build.py --engine-prefixes 00,05,10,15 --app-prefixes 00,35 --out dist-graph`
* Run E2E against it: `HX_PAGE=dist-shell/hexis-lab.local.html node test/e2e/run.mjs 10_shell`. The runner tests
  1280px and 400px in light and dark. It fails on any console error, page error, network request or horizontal
  page scroll. Its `t.open()` waits for `#app[data-boot]` to leave `pending`, which only `app/90_boot.js` does.
  A graph test that builds without the boot script navigates with `page.goto` itself and waits for
  `HXUI.graph`.
* Once the Wave 1 engine modules (prefixes 20, 25, 26, 28, 34, 55) exist and `node test/run.mjs` passes, you may
  add them to `--engine-prefixes`. Wave 2 brings `HX.compile` (36), `HX.validate` (30) and `HX.kernel` (40).
  Until then, sections that need them show the unavailable state.
* At the end, build everything together (`python build.py --engine-prefixes 00,05,10,15 --out dist-all`) and
  run the whole E2E suite against it.

## shell owns
* `app/index.template.html`: the font links right after `<title>`. Keep the four placeholders and their order.
* `app/01_base.css`, `app/02_components.css`, `app/10_overview.css`
* `app/05_ui.js`: the HXUI core API, exactly as specified in UI.md. That covers the DOM builder, components,
  bus, lab state, section registry, router and theme toggle, plus `engine_missing`.
* `app/90_boot.js` (and delete `app/00_boot.js`). The page shell:
  - top bar: name, one-line purpose, Reset lab, theme toggle;
  - section rail (a scrollable tab strip at 400px);
  - main canvas;
  - a polite live region.

  Boot mounts the shell, routes to `location.hash` or `#overview`, then sets `#app[data-boot]` to `ready`. If
  boot throws, it shows a readable error panel and sets `failed`.
* `app/10_overview.js`: the Overview section from UI.md.
  - The thesis (2–3 sentences).
  - The live parity row: compile with `HX.compile.compile_procurement()` and compare to
    `HX.data.python_build.initial_artifact_hash`; the refined hash needs `HX.update` and comes in round 2.
    Each check shows its own unavailable state while its namespaces are missing.
  - A compact live graph of the compiled machine via `HXUI.graph.create`, when both `HX.compile` and
    `HXUI.graph` exist.
  - The guided demo step list (static text for now; round 2 drives it).
  - "What is simulated".
* Placeholders `app/20_compile.js`, `app/30_run.js`, `app/40_learn.js`, `app/50_break.js`, `app/60_selftest.js`:
  - each registers its section (`id`, `title`, `summary`, `needs`);
  - each renders a designed placeholder: a short statement of what the section lets you do (2–3 concrete
    bullets from UI.md), plus the unavailable state when its needs are missing;
  - Self-test also lists every `HX` namespace present or missing in this build. Round 2 replaces these files.
* `test/e2e/10_shell.e2e.mjs`:
  - boot reaches `ready`;
  - every section is reachable by clicking the rail and by `#hash` deep link, and the active item has
    `aria-current="page"`;
  - keyboard: Tab reaches the rail, Enter activates, and focus is visibly outlined (check the computed
    `outline` or `box-shadow`);
  - the theme toggle cycles system → light → dark, sets or removes `data-theme`, and the body background
    differs between light and dark;
  - Reset lab works;
  - every unavailable state renders with no errors when only engine modules 00–15 are present;
  - `prefers-reduced-motion: reduce` disables transitions.

## graph owns
* `app/35_graph.js`, `app/35_graph.css`. They must not depend on other app files: use your own small SVG helper
  and attach to `globalThis.HXUI = globalThis.HXUI || {}`. The API is exactly the one in UI.md ("State graph API").
* `golden/gen_ui_fixtures.py` → `golden/ui_fixtures.json`. Run it with `../.venv/bin/python` from `golden/`,
  using `_common.py`'s `write`, `ints` and `deterministic_uuids`, and `ManualClock(1790000000.25)` from the
  Python demo env. It contains:
  - the Python-built `initial` and `refined` package dumps (`demo/env.py`; the refined one comes from
    `propose_update` with the fixture aligner, as in `golden/gen_data.py`);
  - step-by-step snapshots of three runs, using the Python `RunService` API as in
    `demo/procurement_demo.py` and the integration tests:
    1. the happy path with approval by `user:bob`;
    2. a registry conflict that ends in review/fallback;
    3. missing documents on the refined package (WAITING_FOR_INPUT, then input, then completion).

    Each snapshot holds the operation, the run status, the current state, the terminal (if any) and the
    ordered list of TRANSITION events (`{from, to, edge}`) so far.

  These fixtures are for UI development and tests only. The page never embeds them.
* `test/e2e/35_graph.e2e.mjs` (`export const matrix` stays the default full matrix). It injects the fixtures
  into a container appended to the page and checks, for both machines:
  - no two node boxes overlap;
  - no edge path passes through a node box other than its endpoints (sample points along each path);
  - every node, edge and label lies inside the SVG viewBox, and no label overlaps a node box;
  - layout is deterministic (two `layout()` calls deep-equal);
  - `update()` marks the current state, draws visited edges solid and numbers them in order (a loop edge
    traversed twice shows both numbers), and colors the terminal by category;
  - `highlight()` works;
  - with `on_select`, nodes are focusable with descriptive `aria-label`s, Enter or Space selects, and there is a
    text alternative (a visually hidden list of states and transitions);
  - at 400px the graph scrolls inside its own container and the page does not scroll sideways.
* Visual check: screenshot both machines (at rest, and mid-run from each fixture run) in both themes at 1280 and
  400 into `dist-graph/*.png`, look at every image with the Read tool, and iterate until it looks right.

### Graph design notes
* Lay the machine out top to bottom. The main success path (initial → … → verified terminal) runs down one
  straight column. Repair or retry loops (REPAIR_DRAFT → VALIDATE_DRAFT, READ_BACK → READ_BACK) curve out to the
  side, and terminal pills sit in a lane where their many incoming "else" edges stay readable.
  - END_UNVERIFIED receives six edges. You may draw a terminal more than once as a small stub next to each
    source, as long as the text alternative and the selection model still treat it as one state.
  - Avoid spaghetti: prefer few crossings and clear channels over compactness.
* Node: the state id (mono, medium weight) plus a sublabel with the action, such as "tool · documents.read",
  "model · extract", "approval" or "input". `end` states are pills labelled with their terminal category
  (verified / unverified / fallback), colored ok / warn / crit with text.
* Edge labels: the guard in mono at `--fs-1`, truncated to about 30 characters with the full text in a `<title>`.
  An empty guard shows as `else`, and `inc` shows as `+1 repair_count`.
* States:
  - current: accent stroke 2px, accent-tint fill, and a small "current" tag;
  - visited: normal stroke;
  - not yet visited: faint.

  Visited edges are solid accent with numbered step badges; others are faint. Transitions are at most
  150ms and are off under reduced motion.
* Marker arrowheads take their fill from tokens through CSS classes (one marker per edge style). There are no
  literal colors anywhere (see UI.md "Design tokens").
* Compact mode (`{compact: true}`, used on the Overview) hides edge labels except on hover or focus, and
  tightens the spacing.

## Done when
* `node test/e2e/run.mjs` passes against the combined build (all app files, engine 00–15) at both widths and
  both themes, and the existing `00_engine_loads` test still passes.
* You looked at your screenshots and fixed what looked wrong.
* No literal colors outside `app/00_tokens.css`, no `innerHTML` with data, no network, no
  alert/confirm/prompt, and storage access only inside try/catch.
