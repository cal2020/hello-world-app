# HEXIS Runtime Lab — UI specification

One self-contained page (`dist/hexis-lab.html`) that runs the real JavaScript port of the engine in the
viewer's browser. Audience: an engineering lead or interviewer who should, in five minutes, see the
control boundary working and break it themselves. Every number and status shown is **computed live** by
the engine, never hard-coded, except the reference facts in `HX.data.python_build`, which are shown as the
Python build's values that the page compares against.

## Platform contract (Artifact viewer; enforced by build.py and the E2E tests)
* The page is a fragment: it starts with `<title>HEXIS Runtime Lab</title>` and has no
  doctype/html/head/body tags. All CSS and JS are inline. The only external resource allowed is Google
  Fonts (`IBM Plex Sans`, `IBM Plex Mono`, `Literata`), always with fallback stacks.
* No network calls, no `alert`/`confirm`/`prompt`, no `window.print`, no download links, no iframes.
  Lab state lives in memory, with a "Reset lab" control. `localStorage` holds only per-viewer conveniences
  (the theme choice, the last section). Every access is wrapped in try/catch, and the page works the same
  when storage is empty or blocked.
* The host skeleton's reset has `[hidden]{display:none!important}`. Toggle visibility with `el.hidden`, never
  `style.display`. The host pads `:root` by the safe-area insets. Keep that padding, and give a sticky
  header `top: env(safe-area-inset-top, 0px)`.
* Every form control has a stable `id` and a `<label>`. Forms handle `submit` with `preventDefault()`. Copy
  buttons call `navigator.clipboard.writeText` inside the click handler, catch the rejection, and fall back
  to selecting the text.
* Theme: every color is a token on `:root` (light) and is redefined under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` and again under
  `:root[data-theme="dark"]`, with `color-scheme: dark`. `body` gets an explicit background.
* Responsive down to 400px wide with no horizontal page scroll. Wide tables, code and the graph scroll
  inside their own `overflow-x: auto` containers. Gutters are at least 16px. Grids collapse to one column.
* Accessible:
  - semantic landmarks and buttons;
  - a visible `:focus-visible` outline;
  - `aria-live="polite"` for run status changes;
  - keyboard operability of every control;
  - `prefers-reduced-motion` respected;
  - color is never the only signal (chips carry text).
* The page is complete at rest. On load it shows the Overview with the live parity check already run (hash
  equal to the Python build) and a ready-to-run workbench with an example scenario preselected.

## Design tokens
`app/00_tokens.css` defines every color, font, size, space and radius, with both themes and contrast-checked
pairs. Components use only these tokens. Derived shades use `color-mix(in srgb, var(--token) N%, transparent)`,
which works in both themes. No literal colors outside `00_tokens.css`. UI agents do not edit the tokens: if one
seems missing, derive it locally with `color-mix` and mention it in the report.

Fonts: `<link rel="preconnect" href="https://fonts.googleapis.com">`,
`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, and
`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap">`,
placed right after the `<title>` in the template. The E2E runner serves fonts as empty responses, so the
fallback stacks are what the tests see. The page must look right with them.

## Visual direction
A precise instrument panel for control flow: technical, calm and legible, without decoration.
* **Palette.**
  - Light: cool off-white ground (around `#f3f5f8`), white surfaces, ink `#18212d`, muted `#5b6576`,
    rule `#dbe0e7`, accent cobalt `#2a46c0`.
  - Dark: ground `#10141b`, surface `#181d26`, ink `#e5e9f0`, accent `#93a8ff`.
  - Semantic tokens: ok (green), warn (amber), crit (red) and info (violet, for "simulated"/"fixture").
    Each has a text color and a tint background, defined for both themes.
* **Type.**
  - Literata for page and section titles only.
  - IBM Plex Sans for UI text.
  - IBM Plex Mono for ids, digests, guards and JSON.
  - A fixed scale, roughly 13 / 14 / 16 / 20 / 28.
  - Tabular numerals in tables and counters.
* **Signature element:** the live state-machine graph (SVG). States are rounded rectangles labelled with
  their id and action kind (tool name in mono). Edges are curved paths with guard labels in mono. The
  current state is outlined in the accent color, visited edges are drawn solid with an order number, and
  unvisited edges are faint. Terminal states are drawn as pills colored by category (verified = ok,
  unverified = warn, fallback = crit). It updates on every step without a full redraw flash.
* Cards only where an element is a separate object (scenario card, approval request, attempt card).
  Panels are separated by rules and spacing, not shadows. No emoji. No gradient heroes.

## Information architecture
A top bar holds the title, a one-line purpose ("The HEXIS engine, running in your browser. No server.")
and a theme toggle (light / dark / system). The nav has the sections below: a left rail on wide screens,
a horizontal scrollable tab bar on narrow ones. A bare `#anchor` deep-links each section (`#overview`,
`#compile`, `#run`, `#learn`, `#break`, `#selftest`).

### 1. Overview (`#overview`)
* Two or three sentences on what HEXIS does: it compiles a skill into a state machine, admits it through
  gates, runs it with a deterministic kernel, and puts a broker in front of every external write.
* A "Parity with the Python reference" row. It computes live: compile the skill and compare the artifact
  hash to `python_build.initial_artifact_hash`; apply the refinement and compare to `refined_artifact_hash`;
  compare the catalog digest. Each shows its digest prefix and a ✓ chip, with the label "computed in this
  page".
* A "Guided demo" panel with a step list (the six steps of the CLI demo). It has a "Start" button that
  drives the other sections and narrates each step in plain language: what happened and why it matters.
  The user can also step through manually.
* A "What is simulated" note: fake ERP, documents, registry and identities; scripted extraction model.

### 2. Compile (`#compile`)
* Left: the SKILL.md text, with each clause wrapped in a span that shows its clause id chip (S1.1, …). Critical
  (**MUST**) clauses are marked.
* Right: a "Compile skill" button. Each attempt then appears as a card with its status chip and findings
  (code, message). ORDERING_VIOLATION findings show their counterexample path as a state chain
  (`READ_INTAKE → … → PERSIST_DRAFT`).
* The final artifact hash in mono, with a parity chip.
* The clause coverage table: clause, critical, classification chip, states, justification. Hovering or
  focusing a row highlights the clause text.
* "Admit as user:dana (artifact_admin)" shows the AdmissionResult (status, archive version, signature
  key id).

### 3. Run workbench (`#run`)
* **Scenario picker** (cards or a select): clean intake, missing documents (refined machine required),
  registry conflict, repairs exhausted, prompt-injection document (gullible model), custom task JSON. The
  custom option is an editor validated with `HX.canonical.strict_loads` and the task schema; errors are
  shown inline.
* **Machine:** a toggle between initial and refined (when admitted). The graph is shown above.
* **Controls:**
  - Start run (as the selected initiator), Step (`advance_run` once), Run until blocked, Restart worker,
    Cancel run, and Advance clock (+1 h, +25 h).
  - A **fault injector** select (`FaultInjector` points plus the ERP faults `timeout_after_commit`,
    `timeout_before_commit`, `read_unavailable`) with Arm.
  - **Policy:** revoke a capability from a principal.
  - **ERP:** "modify draft out of band" and "tamper payload".

  Disable each control when not applicable, and give the reason in a tooltip and aria-description.
* **Approval panel:** appears when the run is WAITING_FOR_APPROVAL. It shows:
  - the exact scope (tool, args digest, business reference, evidence receipts, policy version, expiry);
  - an approver select (bob, alice, carol, mallory, dana);
  - Approve and Reject buttons, plus a "tamper scope digest" checkbox for the negative demo.

  It shows the result or error code inline (NOT_AUTHORIZED, SCOPE_MISMATCH, …). For WAITING_FOR_INPUT, it
  shows an input form for `document_ids`.
* **Inspector tabs:**
  - Timeline: events with type chips; TRANSITION events show from → to with the guard.
  - Variables: checkpoint variables, changed ones highlighted after each step.
  - Ledger: intents and receipts (dispatch state and certainty chips).
  - Evidence: receipts, valid or invalidated with reason.
  - Interactions.
  - ERP: drafts table and call log.
  - Metrics: the engine / model / tool / human-wait latency split from `HX.metrics.collect`.
* **Outcome card:** terminal, category chip, verification scope text, assurance (fallback, missing evidence,
  policy violations, unresolved effects), and diagnostics.
* **Runs list:** all runs in this session, with status chips. Click one to inspect it.
* Status changes are announced via an `aria-live` region.

### 4. Learn from traces (`#learn`)
* **Protected archive:** the list of enrolled traces. "Enroll completed runs" calls `export_run_trace` then
  `enroll_protected` as dana, and shows a rejection reason for ineligible runs.
* **Propose update:** pick a development trace (the missing-documents reference trace by default; shortcut
  and forbidden-write are also available). Run `propose_update` with the matching fixture aligner. The result
  shows status, a gates table (policy non-widening, static validation, new-trace replay, protected replay
  with count, negative corpus), the diff (states and edges added, contracts changed, newly reachable
  effects), and diagnostics.
* **Admit:** with the expected parent (CAS). Shows ADMITTED / CONFLICT / REJECTED and the active pointer
  before and after. A "Race two updates" demo reproduces A18 (one ADMITTED, one CONFLICT).
* **Shortcut:** shows trace eligibility EXCLUDED; the hand-built shortcut candidate's gate failures with the
  counterexample path; and "active version unchanged" with the hash.

### 5. Break it (`#break`)
* **Mutation lab:** a list of named mutations (the conformance tests' mutations: remove verifier, widen
  approval guard, model resets counter, verified terminal without evidence, unsafe default into write,
  capability outside ceiling, shortcut edge, unbounded loop, overlapping guards, malicious guard,
  definite-assignment break, hash tamper, clause text edit, widened execution policy). Selecting one shows
  the mutated element (before/after JSON diff) and runs `validate_package` live. Findings are listed with
  code, location and message. Pass or fail is shown as a chip.
* **Guard playground:** a variable-types editor (pre-filled from the machine) and a list of guards (pre-filled
  with VALIDATE_DRAFT's). Live it shows: parse or typecheck errors per guard; `analyze_disjoint` status with
  the counterexample assignment (and which guards it makes true); and an "evaluate with" panel that takes a
  JSON environment.

### 6. Self-test (`#selftest`)
* "Run all checks" executes, in this page:
  - the parity anchors;
  - an embedded sample of golden vectors from the Python reference (guards, canonical, kernel transitions,
    runtime transcripts; sized to keep the page under 3 MB);
  - an acceptance suite of scenario checks mirroring A01–A32 against the engine.

  It shows pass, fail and skip counts, durations and each check's name and ID. A failure shows its
  assertion message. It runs in chunks so the UI stays responsive (yielding via `setTimeout` from the
  `app/` layer only).

## Engine availability
Each engine module is its own `<script>` element (see README "Build"), and UI development builds may include
only part of the engine (`--engine-prefixes`). Every section declares the `HX` namespaces it needs. While any
are missing, it renders a designed unavailable state ("This part needs engine modules that are not in this
build: HX.compile, HX.kernel."). It never throws. Boot lists missing namespaces in the Self-test section.

## HXUI core API (app/05_ui.js), shared by every section
```
HXUI.h(tag, attrs?, ...children) -> Element
    attrs: {class, id, text, html: never (no innerHTML with data), on: {click: fn, ...}, hidden, disabled,
            style: {prop: value}, dataset: {...}, "aria-*", role, title, for, type, value, ...}
    children: Element | string | number | null/false (skipped) | arrays (flattened)
HXUI.chip(text, tone?)            tone: "ok" | "warn" | "crit" | "info" | "accent" | "neutral" (default)
HXUI.digest(text, {short=14, copy=true})   mono, truncated with the full value in title + copy button
HXUI.button(label, {id, variant: "primary"|"secondary"|"ghost"|"danger", on_click, disabled, disabled_reason})
HXUI.field(label, control, {hint, error, id})      label + control + hint/error, wired with aria-describedby
HXUI.select(id, options [{value, label}], {value, on_change})
HXUI.table({columns: [{key, label, align, mono, render(row)}], rows, caption, empty})   in an overflow-x wrapper
HXUI.tabs(id, [{id, label, render() -> Element}], {selected, on_change})   ARIA tablist, arrow-key navigation
HXUI.json_view(value, {open_depth=1})   collapsible <details> tree, mono, keys sorted as given
HXUI.code(text)                    mono block in an overflow-x wrapper
HXUI.notice(tone, title, body?)    inline message block (not a toast)
HXUI.announce(text)                polite aria-live announcement
HXUI.bus.on(event, fn) / HXUI.bus.off(event, fn) / HXUI.bus.emit(event, payload)
HXUI.lab                           shared lab state (see below); mutate through HXUI.lab_reset() and section helpers
HXUI.register_section({id, title, summary, needs: ["compile", ...], mount(el), on_show()})
HXUI.go(section_id)                route (updates location.hash with a bare token)
HXUI.engine_missing(names) -> ["HX.compile", ...]
HXUI.graph                         see below (app/35_graph.js)
```
`HXUI.lab` starts as `{env: null, packages: {initial: null, refined: null}, compile: null, runs: [],
selected_run: null, archive: [], log: []}`. Sections fill it and emit `lab:changed` with `{what}`.
`HXUI.lab_reset()` rebuilds it and emits `lab:reset`.

## State graph API (app/35_graph.js)
```
HXUI.graph.layout(machine) -> {width, height, nodes: [{id, x, y, w, h, kind, terminal_kind, label, sublabel}],
                                edges: [{key: "FROM#i", from, to, index, cond, inc, path, label: {x, y, w, h, text}}]}
    pure and deterministic (same machine -> same layout); machine = package.machine (efsm-v1 dump)
const view = HXUI.graph.create(container, machine, {title, on_select(state_id), compact})
view.update({current: state_id | null, visited: [{from, to, edge}], status, terminal: state_id | null})
    visited = the TRANSITION events of the run in order (edge = transition index), drawn solid and numbered
view.highlight(state_ids)          e.g. states covering a hovered clause; [] clears
view.destroy()
```
Edges are identified as `FROM#index`, matching the kernel's TRANSITION event `{from, to, edge}`. The `end` states
are the terminals; their category comes from `machine.terminals`.

## Code organization (app/)
* `app/index.template.html`: the skeleton with the `{{HX:...}}` placeholders and the fonts `<link>`.
* `app/00_tokens.css` holds the design tokens, `app/01_base.css` the reset, typography and layout, and
  `app/02_components.css` the shared components. Each section owns its own `NN_<section>.css`.
* `app/05_ui.js` (`HXUI`) provides:
  - a tiny DOM builder (`h(tag, attrs, ...children)`);
  - chip, table, tabs, code-block and json-view helpers;
  - an event bus;
  - the lab state, a single `HXUI.lab` object holding the env, packages, runs and archive;
  - `HXUI.register_section({id, title, mount(el), on_show()})`;
  - the router and theme toggle.
* Each section is one file (`10_overview.js`, `20_compile.js`, `30_run.js`, `35_graph.js`, `40_learn.js`, `50_break.js`,
  `60_selftest.js`, `65_tour.js`), and `90_boot.js` boots the page. Every app file starts with
  `globalThis.HXUI = globalThis.HXUI || {};` inside its IIFE and never replaces the object. Sections talk only
  through `HXUI.lab` and the bus.
* `app/embed.json` lists the golden subsets to embed for the self-test. A generator
  `golden/gen_selftest.py` builds `golden/selftest.json`, and the page reads it from `#hx-embed`.
* The boot script sets `#app[data-boot]` to `ready` after the first render, or to `failed` with a visible
  error panel if boot throws.
