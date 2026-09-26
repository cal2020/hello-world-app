# Source and reference register

| Ref | Source | Version / access | Used for | Design implication |
|---|---|---|---|---|
| Brief | `HEXIS_Software_Implementation_Brief.pdf` (user-supplied) | 26 Sep 2026, 26 pp., fully text-extracted | Requirements (all sections) | Implemented per [REQUIREMENTS.md](REQUIREMENTS.md) |
| Master | `Universal_Implementation_Master_Prompt.pdf` (user-supplied) | 26 Sep 2026, 9 pp., fully text-extracted | Delivery workflow, ledger and report format | Not product requirements; KBR handoff (§11) not activated |
| R1 | HEXIS paper, arXiv:2609.30123 | **Not accessed**: arxiv.org was denied by the environment's egress policy | Paper mechanisms (alignment stages, 1.5× loop heuristic, replay) | Taken from the brief's summary only. The paper's reported results (+16.1 pts, 38.4–88.9 % tokens) are **not** reproduced or claimed here |
| R2–R7 | github.com/Worldbuilder013/HEXIS | Commit `96be2719ee79fc5071dc7eb2aeed816dc03aaa6c` (HEAD at access; tag 0.1.0 = `c93e8e63`) | `efsm-v1` field names, guard grammar, runtime edge semantics | Compatible reader; guard subset conformance-tested; differences listed in ARCHITECTURE.md |
| R8 | Upstream `LICENSE` | Same commit | License | GNU GPL v3 text |
| R9 | Upstream `pyproject.toml` | Same commit | Metadata | Declares `license = "MIT"`, Alpha, Python ≥3.11. **Conflicts with R8; unresolved.** No upstream code is copied into this repository |
| R10 | JSON Schema Draft 2020-12 | via `jsonschema==4.25.1` | Tool, variable and response schemas; `schemas/` exports | `Draft202012Validator` everywhere |
| R11 | Pydantic strict validation | `pydantic==2.13.5` | Record models | `extra="forbid"`, explicit type checks at kernel boundary |
| R12 | PostgreSQL explicit locking | Not used | Multi-worker store | Not implemented |
| R13–14 | LangGraph persistence/interrupts | Not used | Optional hosting | Not implemented |
| Claude API | Anthropic Python SDK `anthropic==1.8.0`, `output_config.format` structured output | Bundled SDK docs, Sep 2026 | `models/anthropic_adapter.py` | Explicit model id; no live call executed |

## Upstream baseline (brief §18 phase 0)

Executed in an isolated venv outside this repository (Python 3.11.15, pydantic 2.13.5, PyYAML 6.0.3,
httpx 0.28.1, pytest 9.1.1):

```
git clone https://github.com/Worldbuilder013/HEXIS  &&  git rev-parse HEAD   # 96be2719ee79fc5071dc7eb2aeed816dc03aaa6c
pip install -e ".[dev]"  &&  python -m pytest
230 passed, 4 skipped in 1.18s      # skips: tests/test_45_opencode_tools.py (OpenCode binary required)
```

This is a local result at that commit, not the upstream README's claimed count. The upstream example
command (`hexis-agent`) was not run against a live model.

**Reuse decision.** Upstream is used as a read-only format and semantics reference and as an optional
conformance oracle (`tests/conformance/test_upstream_compat.py`, enabled with
`HEXIS_UPSTREAM_DIR=<checkout> PYTHONPATH=<checkout>/src`). It is not a dependency, and none of its
code is copied, until the license is clarified.
