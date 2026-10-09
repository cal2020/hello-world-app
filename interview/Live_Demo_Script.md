# Live demo script: Model-to-Evidence Workbench (about 7 minutes)

Uses the live browser build: https://cal2020.github.io/hello-world-app/dmmc-workbench/app/
(the local-server version of the same flow is in `dmmc-workbench/docs/DEMO_SCRIPT.md`).

**Before the call**
- Open the app in advance so the first load (about 15 MB) is cached.
- Click **Reset demo state**, set the identity menu to **Bob**, and close any other tabs of the app.
- Keep the recorded walkthrough https://cal2020.github.io/hello-world-app/dmmc-workbench/ open in a second window
  as a fallback.

---

### 0. Framing (30 s)
> "I'd like to show a small prototype I built to think through one problem: security plans are written from system
> models, and they go stale the moment the model changes. I wanted to see what it takes to keep every statement
> traceable to its source, and to have the system *tell* you when a review no longer holds. It's synthetic: a
> fictional telemetry system and three NIST 800-53 controls. It runs entirely in the browser, so nothing leaves this
> machine."

### 1. Baseline (1 min 30)
**Click:** **Import model A**, then **Import evidence set A**, then **Build package (fixture drafter)**.
> "The model is the kind of export a modelling tool would produce: components, boundaries, flows and permissions.
> Evidence items each have a validity window. When I build, deterministic checks run first. The AC-3 check compares
> the model's permissions with the enforced OPA policy, and that policy also has 15 independent tests. The drafter
> then writes SSP-style statements from those results."

**Point at** AC-3 PASS and the inherited SC-8 row showing UNKNOWN.
> "SC-8 here is inherited, and I don't have evidence from the provider, so it says UNKNOWN rather than guessing PASS.
> That was a deliberate choice: a wrong 'pass' is the expensive failure."

**Click** a `check:` link.
> "Every sentence points to exactly what it's based on: this check, this model element, this evidence version."

### 2. Human review and authorization (1 min 30)
**Click** into the package, type a reason, then **Record decision as current identity** (still as Bob).
> "Bob is an engineer, and the server-side rules refuse to let him review."

**Switch to Alice**, enter a reason, record **ACCEPT**, then **Export as currently reviewed**.
> "A reviewer accepts with a reason. The decision is bound to the exact digest of what she saw. Export includes an
> OSCAL component definition, validated against the NIST schema."

### 3. The model changes (1 min 30)
**Switch to Bob**, go to the Dashboard, click **Import model B**. **Switch to Alice**, open the package, try
**Export as currently reviewed** again.
> "Someone added a data flow. The approval is now stale, and export is refused. The system doesn't let yesterday's
> review cover today's design."

**Click Impact.**
> "It lists what changed and which evidence no longer applies. That guides the re-review, but it never keeps an
> approval alive by itself. Invalidation is conservative on purpose."

### 4. The policy catches a real mismatch (1 min)
**As Bob:** click **Import evidence set B**, then **Build package (fixture drafter)**.
> "With the new model, AC-3 fails and names the two permission mismatches: the model grants write access that the
> enforced policy doesn't. That's computed live by the policy, not asserted by the drafter."

### 5. Where the AI sits (1 min)
**Click:** **Build package (seeded drafter errors)**, then **Evaluate generated candidate**, then
**Evaluate candidate using http.send**.
> "The drafter only proposes text from pinned sources. It has no tools and can't touch evidence, policy or review
> state. Here I seeded six bad statements, and the validator flags them. The same boundary applies to AI-suggested
> policy: this generated candidate fails 5 of the 15 independent tests, so it's quarantined. The one that tries a
> network call is rejected at compile. So the value comes from the checks, and the AI stays behind them."

### 6. Close (30 s)
**Click Audit.**
> "Every action is in a hash-chained, append-only log. What I'd want to learn is how this maps onto your real model
> exports and review process: where the models come from, who signs off, and what 'stale' should mean for you."

---

### If asked…
- **"Is this production?"** "No. It's a synthetic prototype to test the design. I'd expect the real integration
  points (model export format, evidence sources, identity) to be where most of the work is."
- **"Did you use AI to build it?"** Answer truthfully, in your own words.
- **"Does it integrate with Cameo?"** "No. It reads a JSON model contract I defined. An adapter from a real tool's
  export would be the next step."
- **"How do you know it works?"** "22 acceptance scenarios, unit tests, and a browser test suite. Those are
  engineering checks I wrote myself, not independent measurements."
- **"Why UNKNOWN instead of FAIL?"** "Missing evidence isn't evidence of failure. Keeping them separate tells the
  reviewer what to go and get."

**If the live page misbehaves:** reload once. If it's still wrong, switch to the walkthrough window: "Here's the
recorded run of the same flow."

**Before using this:** rehearse the clicks once with a timer, change any line that doesn't sound like you, and add
claims about your own experience only where you can stand behind them.
