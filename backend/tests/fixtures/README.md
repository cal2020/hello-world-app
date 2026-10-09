# Test fixtures

Upstream fixtures (unmodified, with their licenses) live in `kora-doctor/` and
`audr/`. The files below are synthetic and written for this project.

| File | Purpose | Expected result |
| --- | --- | --- |
| `known_costs.jsonl` | 4 calls costing `0.1`, `0.2`, `1e-7` and `12.345678901234567891` USD | Total exactly `12.645679001234567891` USD (binary floats give `12.645679001234568`) |
| `mixed_currency_missing.jsonl` | USD `0.01`, EUR `0.02`, one call without `cost`, one USD `0` | USD `0.01` and EUR `0.02` reported separately; 1 unknown-cost call; the `0` call is a known zero |
| `zero_cost_run.jsonl` | Two calls with a reported cost of `0` | Total USD `0`, complete; percentage change from it is undefined |
| `claude-code/session.jsonl` | A synthetic Claude Code transcript: 2 sessions, a request logged twice, an error message, a subagent, a Bedrock model ID, fast mode, web searches, a long Haiku 5.5 prompt, a saved cost figure and a cut-off last line | 7 API calls priced at list prices, USD `0.10235` in all; 1 call with unknown cost; Claude Code's figure `$0.07` against `$0.08` for the same calls |
