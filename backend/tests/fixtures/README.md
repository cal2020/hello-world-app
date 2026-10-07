# Test fixtures

Upstream fixtures (unmodified, with their licenses) live in `kora-doctor/` and
`audr/`. The files below are synthetic and written for this project.

| File | Purpose | Expected result |
| --- | --- | --- |
| `known_costs.jsonl` | 4 calls costing `0.1`, `0.2`, `1e-7` and `12.345678901234567891` USD | Total exactly `12.645679001234567891` USD (binary floats give `12.645679001234568`) |
| `mixed_currency_missing.jsonl` | USD `0.01`, EUR `0.02`, one call without `cost`, one USD `0` | USD `0.01` and EUR `0.02` reported separately; 1 unknown-cost call; the `0` call is a known zero |
| `zero_cost_run.jsonl` | Two calls with a reported cost of `0` | Total USD `0`, complete; percentage change from it is undefined |
