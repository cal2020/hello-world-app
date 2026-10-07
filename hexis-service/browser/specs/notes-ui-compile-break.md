# UI compile-break API notes

Compile (20_compile.js)
- Ids changed. Admissions are now an <ol id="cp-admissions" data-latest=STATUS>, newest first. Each item is an article#cp-admission-N with data-status. Inside it: #cp-admit-N-version, #cp-admit-N-key, #cp-admit-N-sig(-copy) and #cp-admit-N-digest(-copy). The old #cp-admission, #cp-admit-version and #cp-admit-key are gone. No other group referenced them (checked with grep).
- New stable ids on clause buttons: #cp-a{attempt}-f{i}-clause and #cp-a{attempt}-diff-{S3-2}. Draft hashes are #cp-attempt-{n}-hash(-copy). The back button is #cp-skill-back. Clause spans keep #cp-clause-{id} and now have tabindex=-1.
- Coverage rows carry data-classification and data-critical.
- Layout: the DOM order is now summary, work column, skill column, then coverage. Coverage sits at full width below the two-column grid. A grid area puts the skill text on the left on wide screens; at one column the results come before SKILL.md.
- A clause-id click lights the clause and scrolls the pane. If the clause is still off screen, the page scrolls to the SKILL.md panel (offset by any sticky top bar), the clause stays lit and takes focus, and "Back to ..." returns focus to the button.
- A failed admit no longer counts as an admission. The button label comes from the history.
- In the error state, the timing line reads "The compiler stopped after N ms", the button reads "Try compiling again", and the artifact, admission and coverage areas each explain why they are empty.

Break it (50_break.js)
- There is no aria-live any more. HXUI.announce fires once when the sweep finishes, and after a user-triggered analyze() (now debounced to 250 ms).
- #br-g-out data-status can now also be TYPES_INVALID, GUARDS_REJECTED or EMPTY.
- Findings carry data-state, data-edge and data-variable. #br-findings carries data-digest (the report digest).
- The picker uses a roving tabindex (Arrow keys, Home, End) and has data-more-above/below for the fade.
- A base compile failure is cached until lab:reset (BASE_ERROR).

Catalog (52_mutations.js)
- Now 42 mutations. Added a03-open, a03-comprehension, a03-deep-not, c24-counter-fraction, c24-counter-string, c20-caps, c23-fallback-subgraph, c22-missing and c27-unknown-kind.
- at() accepts a null state, so a02-duplicate-variable asserts the (None, None) location.
