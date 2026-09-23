# Remaining gaps and backlog

## Simulated or unexercised

| Item | Status | What closing it takes |
|---|---|---|
| Live model generation (`providers/anthropic.js`) | Implemented, **not exercised** (no credentials in the build environment). Request shape follows current SDK documentation but has not run against the API. | Run with a key; add the live configuration to the evaluation; record tokens and latency; compare with the baseline on held-out cases |
| Model draft quality | **Unmeasured.** The fixture is deterministic code. | Live runs plus human-adjudicated unsupported-claim rates |
| System-model data | Hand-written JSON labeled as simulated | Real export adapter (see ARCHITECTURE.md). No Cameo or Teamwork Cloud interface has been verified. |
| Authentication | Fixed demo tokens | Real identity provider; the role-to-permission mapping already exists in `ops.js` |
| Human review measures (review time, seeded-error catch rate, reviewer disagreement) | Unmeasured | Sessions with qualified reviewers; collect independent judgments before any discussion |

## Known limitations (by design or deferred)

- **Semantic support is not machine-checked.** A real quote attached to a claim it does not support passes the citation checks (evaluation case H08). Only the reviewer judgment catches it.
- **Invalidation is conservative.** Any source import marks every open version stale, even when the new source is irrelevant. The impact view gives the precise list, but staleness itself is not filtered.
- **Single reviewer per judgment.** The latest judgment on a claim digest wins. There is no independent multi-reviewer capture and no separation of duties: the reviewer who edits a version may also accept it.
- **Bulk judgment** exists to save demo time. It records a per-claim judgment under the reviewer's name, but it can encourage rubber-stamping.
- **The fixture repeats its seeded error** on every regeneration. A reviewer's correction does not carry over into the next generation. This is realistic, but the corrective loop (prompt change, re-evaluation) is not built.
- **Scenario-specific checks.** Calibration, serial and inspection-point checks are written for this scenario's record types. They are not a general rules engine.
- **Retrieval sends all permitted passages.** That works for this tiny corpus but would not scale.
- **Audit immutability** is enforced by the application (triggers and a hash chain), not against a database administrator.
- **No SCALE decision and no statistical gate.** The evaluation gate is "zero unsafe outcomes on this suite", which is prototype demo readiness only.

## Needs domain expertise or validation

- Whether any of these states, checks or roles correspond to an actual Air Force tactics-development workflow. DAFMAN 11-260 could not be retrieved from this environment.
- What counts as authoritative source material, and who may approve at each stage in a real program.
- Whether requirement-level change impact is the right granularity for real procedures, or whether element- and parameter-level dependencies are needed.

## Suggested next increments (in order)

1. Run the live provider on the held-out suite and record actual unsupported-claim and gap-disclosure rates against the baseline.
2. Independent dual review with disagreement capture before reconciliation.
3. Relevance-filtered staleness: mark a version stale only when a new source falls inside its dependency scope, while keeping the conservative mode as an option.
4. A real model-export adapter behind the existing snapshot interface.
5. Optional OSCAL-shaped export for security-evidence use cases, if a customer asks for it.
