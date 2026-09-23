# Five-minute demonstration script

Setup (before the call): `export DMMC_NOW=2026-09-23T15:00:00Z; .venv/bin/python -m workbench serve`,
browser at 125% zoom, identity `bob`, dashboard open, **Reset demo state** clicked. Fallback: the recorded
transcript `sample-exports/demo-cli-transcript.txt` and `docs/screenshots/` (say that they are recordings).

| Time | Say | Do | Expect |
|---|---|---|---|
| 0:00–0:40 | "Everything here is synthetic. The question is whether we can show *why* a statement in a security plan is true, and notice when it stops being true." | Import model A, evidence A, Build | 3 of 4 rows with current evidence |
| 0:40–1:40 | "Each row is element × control statement × local obligation. The SC-8 row keeps the model's design assertion separate from the transport test." | Open package; click a model citation and an evidence citation | Citation resolves to the digest-pinned bytes |
| 1:40–2:20 | "Remove the test. The design still says TLS, but the workbench won't treat that as proof." | Evidence → Withdraw `ev-tls-portal-api-a1`; Build | SC-8 portal→API UNKNOWN, gap text; old package STALE |
| 2:20–3:00 | "Restore it, and a reviewer accepts the wording. The decision is bound to this exact digest, and the open gaps stay recorded." | Restore; Build; switch to `alice`; ACCEPT with reason; Export current | REVIEWED_FOR_DEMO; export files |
| 3:00–4:10 | "Now the model changes: an external provider connection and a different write role." | as `bob` Import model B; as `alice` try Export current; open Impact | Export refused (STALE); new SC-8 row; two evidence items no longer applicable |
| 4:10–5:00 | "New evidence for B, rebuild. AC-3 now fails: the model and the reviewed policy disagree about who may write. That's a finding for a person, not something the tool should fix itself." | Import evidence B; Build; show AC-3 mismatch + provider UNKNOWN | FAIL + UNKNOWN rows, hypotheses labelled as proposals |
