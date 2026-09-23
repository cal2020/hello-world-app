# Five-minute demonstration script

**Setup (before the call):**

1. Run `.venv/bin/python scripts/run.py --reset` and then `.venv/bin/python scripts/seed.py`.
2. Open <http://127.0.0.1:8780/> and <http://127.0.0.1:8781/> in two browser tabs. Zoom to 125% for Teams.
3. Keep a terminal ready with `.venv/bin/python scripts/demo.py --pause` as the scripted path. Do not run it against the same stack after the UI steps have been clicked.

**Fallback:**

* `examples/demo_transcript.txt` is a *recording* of `scripts/demo.py --self-host`. Present it as a recording.
* The `examples/screenshots/` folder has stills of each panel.

The values under "Observed" below come from that recorded run. IDs change between runs.

| Time | What I say | What I show / do | Observed (recorded run) | Claim it supports | If it fails |
|---|---|---|---|---|---|
| 0:00–0:30 | "The problem I'm exploring: when a system model changes, which APIs, links and consuming apps are affected, and how do you promote a fix without breaking whoever depends on it? This is synthetic data and a local prototype. It isn't a Cameo integration." | Workbench header: synthetic banner, simulated identity | — | Framing and honesty | — |
| 0:30–1:30 | "Import model A. Identity is source + project + source ID. Unknown content is kept and flagged, not dropped. I build a contract from a reviewed projection, the consumer tests it against real HTTP responses, and only then does a pointer move." | Import A → Build (1.0.0) → Consumer checks → Activate. Consumer tab | `accepted_head`, 12 entities; candidate `tested_pass` (dashboard ✓, archive-export ✓, schema ✓); consumer pinned to revision `7c1e9a` | Automated API definition/deployment, locally; consumer-tested promotion | Use the transcript step 1 |
| 1:30–1:50 | "Same export again, maybe a retried pipeline." | Import A again; show receipts table | `duplicate_no_change`, `duplicate_of` = first import, counts identical, no new outbox event | Idempotent ingestion | — |
| 1:50–2:50 | "Now link maintenance records to model elements. The deterministic baseline finds exact serials. The model path can find aliases, but it only proposes. Every quote must resolve to the retained source bytes. Two sensors on P-101 have near-identical names, so MR-1003 is ambiguous. Note N-2 resolves it and I accept the NDE sensor. The review is bound to model `7c1e9a` and records `m-20260901`." | Run deterministic, then fixture-model. Point to FIXTURE MODE label, invalid citation (struck through), forged N-3 note (`reference_outside_permitted_set`, `approved` field ignored). Reject DE, accept NDE | deterministic: 3 candidates; fixture: 10 proposals, 6 valid; MR-1003 two competing candidates; link `reviewer_accepted` | AI proposes, code validates, people decide; ambiguity is visible | Transcript step 3 |
| 2:50–3:50 | "Model B renames the gateway. Same entity. Then C removes `serialNumber`, which the dashboard needs. An approval made against A is now stale and is rejected. The C candidate is blocked, and the dashboard keeps being served from A, two heads behind, and says so." | Import B, try Accept MR-1004 (still showing old view) → 409. Import C → Build 1.0.0 → checks → Activate → refused | B: same `entity_uid`, 12 entities; accept → `409 stale_dependency` (`model_revision_changed`, `target_version_changed`); C: `definition_missing Sensor.serialNumber` (structural), 8 consumer check failures, activate `409 activation_blocked`; current = A, `headsBehind=2` | Change impact, optimistic concurrency, failed promotion is safe | Transcript step 4 |
| 3:50–4:40 | "The fix is an explicit projection change: map `serialNumber` to the renamed `assetSerial`. The contract digest doesn't change, so consumers see the same API. I retest and activate, and I drop the consumer's acknowledgment after it commits. The worker retries, the consumer deduplicates, and there's one effect." | Approve 1.1.0 → Build → checks → Inject lost-ack fault → Activate → Deliver now ×2 → consumer tab | contract digest unchanged, diff `[]`; `tested_pass`; delivery attempt 1 `no_acknowledgment`, attempt 2 `acknowledged`; consumer deliveries=2, effects=1; retry of activate with same key → `Idempotent-Replay: true` | Retry ≠ duplicate effect; history retained | Transcript step 5 |
| 4:40–5:00 | "What I'd want to learn from you: when a model changes, where is reconciliation hardest today? Preserving element identity, adapting generated contracts, or knowing which consuming applications need to change? I'd test this pattern against one of those, using your real conventions." | Architecture note, decisions table | — | Collaboration; bounded next experiment | — |

## Spoken notes

* **Where the design comes from.** This design draws on distributed pipelines with recovery, packaged and governed delivery, data integration, and a customer beta built around provenance and controlled actions. That is Evren's reported background. Attribute each claim precisely in the interview and keep the beta distinct from production work.
* **What the prototype does not show.** It shows none of these:
  * Cameo, SysML API or LOKI implementation experience
  * compatibility with KBR's environment
  * real-model link quality
  * any deployment beyond the local machine
* **If asked "is AI doing anything here?":** "In this demo the model path is scripted. It's there to show the validation and review boundary. A live adapter exists but hasn't been run here. The deterministic baseline found 3 of 5 dev links and 1 of 4 held-out links on this tiny set. The question a real pilot would answer is whether a model raises recall without letting incorrect links through review."

## Rehearsal checklist

- [ ] `--reset` and seed run in under 10 seconds, and the UI shows no leftover state
- [ ] The whole flow runs in under 5:00 with clicks, twice in a row
- [ ] Text is readable when sharing a 1280px window over Teams
- [ ] The recorded fallback is ready and labeled as a recording
- [ ] `.venv/bin/python -m unittest discover -s tests -t .` is green on the machine used for the call
