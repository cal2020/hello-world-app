# Evidence Link Bench

A working demonstrator of AI-assisted linking between requirements (e.g. a Cameo model) and external test evidence. It keeps each responsibility in one place:

1. **Integration code retrieves** authoritative records, preserving IDs, revisions, relationship types and access markings.
2. **Jev judges meaning**: does the evidence describe the requirement's fault and expected behavior? Choices include `ambiguous` and `insufficient_evidence`.
3. **Deterministic code checks exact facts**: revision match, unit-normalized limits, reviewer access, release status, and instruction-like text.
4. **An engineer approves**, with a required rationale. Decisions are fingerprinted against the exact source revisions, and any source change makes them stale.

## What is and isn't real

- All requirements, test reports, IDs and markings are **synthetic**.
- **No model is called.** Jev outputs are hand-written fixtures (`src/cases.js`, `JUDGE_FIXTURES`) behind the adapter in `src/judge.js`, pinned to `jev-1.13.0`. A live adapter is intentionally absent, because API details and deployment approval are unestablished.
- The evaluation plan (50 labeled cases, rules vs. conventional LLM vs. Jev) is **proposed, not run**.

## Develop

```sh
npm install
npm run dev           # local dev server
npm test              # deterministic checks, staleness, fixtures
npm run build         # static site in dist/
npm run build:single  # one self-contained HTML file in dist-artifact/
```

## Layout

| File | Role |
|------|------|
| `src/cases.js` | Synthetic records, the six review cases, illustrative judge fixtures |
| `src/checks.js` | Deterministic checks and which decisions they allow |
| `src/judge.js` | Judge adapter interface, pinned model version, narrow request payload |
| `src/audit.js` | Decision records, fingerprints, staleness on revision change |
| `src/content.js` | Evaluation plan and interview notes tabs |
| `src/main.js` | UI |
