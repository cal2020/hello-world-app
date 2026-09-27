# Sources, provenance and baseline

## Inputs to this work

| File | Date | Classification | Use |
|---|---|---|---|
| `HEXIS_Software_Implementation_Brief.pdf` (26 pages) | 26 Sep 2026 | implementation requirements | build specification; read completely |
| `Universal_Implementation_Master_Prompt.pdf` (9 pages) | 26 Sep 2026 | workflow instructions | process (scope contract, ledger, verification, handoff); the optional KBR interview handoff was **not** activated because no KBR context was supplied |
| Research-shortlist excerpt in the request ("2. HEXIS …") | 24 Sep 2026 item | research summary | target selection only; its benchmark figures are author-reported, not results of this build |

## Reference register

| Ref | Title / location | Version | Used for | Design implication |
|---|---|---|---|---|
| R1 | HEXIS: Compiling Skills into Extended Finite State Machines, arXiv:2609.30123 | v1, 24 Sep 2026 | mechanisms as summarized by the brief | local state instructions, typed variables, ordered guards, staged alignment, ≤2 update attempts, all-protected-trace replay, ~1.5× loop heuristic. **The paper itself was not fetched or read here**; mechanisms are taken from the brief's description. |
| R2–R7 | github.com/Worldbuilder013/HEXIS | commit `96be2719ee79fc5071dc7eb2aeed816dc03aaa6c` (cloned, checked out) | efsm-v1 field names and semantics; verified differences (see ARCHITECTURE) | read `machine/schema.py`, `execution/runtime.py` (`fill_template`), `pyproject.toml`, `LICENSE` |
| R8 | `LICENSE` at that commit | — | licensing | GNU GPL v3 text |
| R9 | `pyproject.toml` at that commit | — | licensing, baseline | declares `license = "MIT"`, `Development Status :: 3 - Alpha`, `requires-python >=3.11`, deps pydantic ≥2.5, pyyaml ≥6, httpx ≥0.27 |
| R10 | JSON Schema Draft 2020-12 | — | schemas | a strict subset is implemented in `jsonschema_lite.py` |
| R11 | Pydantic strict mode | — | not used | stdlib validation chosen so the demo needs no installs |
| R12 | PostgreSQL explicit locking | — | not used | SQLite adapter only |
| R13–R14 | LangGraph persistence / interrupts | — | not used | no LangGraph adapter |

## License discrepancy and reuse decision

The pinned upstream `LICENSE` file contains the GPL v3 text while `pyproject.toml` declares MIT. The
brief does not resolve this and neither does this work. **Decision:** no upstream code was copied,
vendored, imported or relabelled. This package is an independent implementation of the `efsm-v1`
interchange format and of the mechanisms as described in the brief. It is **not** a clean-room
implementation: upstream source files were read (listed above) to match field names and to verify
specific behaviours. Resolve the intended upstream license before adopting or distributing any
derived work, and before adding an upstream adapter.

## Phase 0 baseline (upstream, in an isolated scratch checkout)

Environment: Python 3.11.15, venv with pydantic 2.13.5, pydantic_core 2.46.5, PyYAML 6.0.3, httpx 0.28.1,
pytest 9.1.1; upstream installed editable at `96be271`.

Command: `python -m pytest -q` (hermetic suite, no API keys).

Result actually observed: the progress output showed **234 test markers, 4 of them skipped (`s`) and
no failures or errors (`F`/`E`)**. The final summary line was cut off by the output filter on that single
run; a second run to capture it was not permitted by the sandbox policy for executing downloaded code,
so this baseline is recorded as *partial*. The upstream example (`hexis-agent` CLI) was **not** run.
The upstream README's own test count was not used as a local result.
