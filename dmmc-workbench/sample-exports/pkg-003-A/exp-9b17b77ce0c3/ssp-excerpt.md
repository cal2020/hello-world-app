# Draft SSP excerpt — proj-mtel (REVIEWED_FOR_DEMO)

> SYNTHETIC DEMONSTRATION ARTIFACT. Partial excerpt prepared for expert review. Not an official System Security Plan or Security Assessment Report, not an assessment result, and not an authorization decision.

| Field | Value |
|---|---|
| export_id | `exp-9b17b77ce0c3` |
| package_id | `pkg-003-A` |
| package_digest | `3447109e8f32daef9d817cf2354d008ce14545fd39e6979ebf63642848bb0791` |
| created_at | `2026-09-23T15:00:00Z` |
| export_mode | `current` |
| status_at_export | `REVIEWED_FOR_DEMO` |
| drafter_mode | `fixture` |
| model snapshot | `snap-001-A-814dfa8c` revision A |
| evidence scope | ev-audit-api-a1@fef3f617c86c (active), ev-design-note-transport@2573cea4779d (active), ev-tls-portal-api-a1@0c94bf858333 (active) |

## Obligation matrix

| Row | Control stmt | Object (rev) | Evidence state | Check result | Gaps |
|---|---|---|---|---|---|
| OBL-AC3-API::cmp:api-service | ac-3_smt | cmp:api-service (a1) | CURRENT | **PASS** | 0 |
| OBL-AU12-API::cmp:api-service | au-12_smt.c | cmp:api-service (a1) | CURRENT | **PASS** | 2 |
| OBL-SC8-FLOW::flow:portal-api | sc-8_smt | flow:portal-api (f1) | CURRENT | **PASS** | 1 |
| OBL-SC8-INHERIT::cmp:telemetry-db | sc-8_smt | cmp:telemetry-db (d1) | NONE | **UNKNOWN** | 2 |

3 of 4 selected demo obligation rows have current applicable evidence. This is not a compliance percentage.

## Scope and provenance

- **[FACT]** This excerpt was drafted from synthetic model revision A (snapshot 814dfa8cfa46). [c1]
- **[FACT]** The source model is fictional and is not a Cameo/SysML export. [c2]
- **[LIMITATION]** Drafted in fixture mode: deterministic text used to exercise the workflow, not a measure of model quality. 

## System boundary and components (design assertions)

- **[FACT]** Boundary Operator workstation zone (bnd:operator-zone) is modelled as trust-zone. [c3]
- **[FACT]** Boundary Maintenance telemetry enclave (bnd:enclave) is modelled as authorization-boundary. [c4]
- **[FACT]** Operator Portal (cmp:operator-portal, revision p1) is placed in Operator workstation zone. Browser-based portal used by operators and maintainers to view and annotate telemetry. [c5]
- **[FACT]** Telemetry API Service (cmp:api-service, revision a1) is placed in Maintenance telemetry enclave. REST service that mediates all reads and writes of maintenance telemetry. [c6]
- **[FACT]** Telemetry Database (cmp:telemetry-db, revision d1) is placed in Maintenance telemetry enclave. Relational store for telemetry records. [c7]
- **[FACT]** Audit Collector (cmp:audit-collector, revision c1) is placed in Maintenance telemetry enclave. Receives structured audit records from the API service. [c8]

## Data flows (design assertions)

- **[FACT]** Flow flow:portal-api carries telemetry queries and annotations from Operator Portal to Telemetry API Service and crosses a boundary. [c9]
- **[FACT]** Flow flow:api-db carries telemetry records from Telemetry API Service to Telemetry Database within one boundary. [c10]
- **[FACT]** Flow flow:api-audit carries audit records from Telemetry API Service to Audit Collector within one boundary. [c11]

## AC-3 — cmp:api-service

- **[FACT]** Selected control statement ac-3_smt (AC-3) is referenced for cmp:api-service. Selection is part of the curated demo mapping, not a baseline decision. [c12]
- **[FACT]** Local demo obligation: The reviewed policy bundle for the API allows exactly the role/action/resource combinations declared in the model and denies the independently authored negative cases. [c13]
- **[FACT]** Independent policy tests: 15 passed, 0 failed, 0 errored against policy digest 8659ebba72b5. [c14]
- **[FACT]** Check result PASS applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c14]
- **[LIMITATION]** Limitation: Does not show that the policy is deployed, that every API route calls it, or that access enforcement is complete. [c13]

## AU-12 — cmp:api-service

- **[FACT]** Selected control statement au-12_smt.c (AU-12) is referenced for cmp:api-service. Selection is part of the curated demo mapping, not a baseline decision. [c15]
- **[FACT]** Local demo obligation: Synthetic audit records captured from the API include actor, action, target, time and outcome for every event type the model declares for the API. [c16]
- **[FACT]** Synthetic observation ev-audit-api-a1 is applicable to the current revisions and reports PASS. [c17] [c18]
- **[FACT]** Check result PASS applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c18]
- **[GAP]** Parameter au-12_odp.01 is organization-defined and unresolved; a qualified reviewer must set it. [c18]
- **[GAP]** Parameter au-12_odp.02 is organization-defined and unresolved; a qualified reviewer must set it. [c18]
- **[LIMITATION]** Limitation: Does not show production log completeness, retention, or protection of audit records. [c16]

## SC-8 — flow:portal-api

- **[FACT]** Selected control statement sc-8_smt (SC-8) is referenced for flow:portal-api. Selection is part of the curated demo mapping, not a baseline decision. [c19]
- **[FACT]** Local demo obligation: Each flow whose endpoints sit in different boundaries has (a) a design transport assertion and (b) a current, applicable transport test observation reporting pass. [c20]
- **[FACT]** The model asserts transport protection 'TLS' for flow:portal-api (design assertion only). [c9]
- **[FACT]** Design note ev-design-note-transport (an assertion, not an observation) states: "All interfaces that cross the maintenance telemetry enclave boundary are designed to use TLS 1.2 or later with certificates issued by the program demo CA." [c21]
- **[FACT]** Synthetic observation ev-tls-portal-api-a1 is applicable to the current revisions and reports PASS. [c22] [c23]
- **[FACT]** Check result PASS applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c23]
- **[GAP]** Parameter sc-08_odp is organization-defined and unresolved; a qualified reviewer must set it. [c23]
- **[LIMITATION]** Limitation: A model attribute alone cannot establish transport protection. A synthetic test report is not an observation of a real system. [c20]

## SC-8 — cmp:telemetry-db

- **[FACT]** Selected control statement sc-8_smt (SC-8) is referenced for cmp:telemetry-db. Selection is part of the curated demo mapping, not a baseline decision. [c19]
- **[FACT]** Local demo obligation: A claimed inherited SC-8 implementation is supported by provider/scope evidence that names the provider and the covered component. [c24]
- **[FACT]** Check result UNKNOWN applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c25]
- **[GAP]** inheritance claimed in the model; no provider/scope evidence. Left unresolved. [c25]
- **[GAP]** Parameter sc-08_odp is organization-defined and unresolved; a qualified reviewer must set it. [c25]
- **[LIMITATION]** Limitation: A provider statement is an assertion. Inheritance must not become satisfied because a vendor says so. [c24]

## Questions for a qualified reviewer

- Parameter au-12_odp.01 for OBL-AU12-API::cmp:api-service is unresolved. Who sets it, and to what value? [c15]
- Parameter au-12_odp.02 for OBL-AU12-API::cmp:api-service is unresolved. Who sets it, and to what value? [c15]
- Parameter sc-08_odp for OBL-SC8-FLOW::flow:portal-api is unresolved. Who sets it, and to what value? [c19]
- Which provider evidence establishes the inherited SC-8 claim for cmp:telemetry-db, and what scope does it cover? [c25] [c7]
- Parameter sc-08_odp for OBL-SC8-INHERIT::cmp:telemetry-db is unresolved. Who sets it, and to what value? [c19]

## Review record (document review only)

- `dec-001` ACCEPT by alice at 2026-09-23T15:00:00Z: Wording accepted for demo; inheritance and parameters remain open. (bound to package digest `3447109e8f32`; acknowledged gap rows: 3)

## Citations (immutable versions)

- [c1] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/revision` → A
- [c2] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/synthetic_notice` → Fictional system. Not a Cameo/SysML export and not derived from any real program.
- [c3] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/boundaries/0` → {"id": "bnd:operator-zone", "name": "Operator workstation zone", "kind": "trust-zone"}
- [c4] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/boundaries/1` → {"id": "bnd:enclave", "name": "Maintenance telemetry enclave", "kind": "authorization-boundary"}
- [c5] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/elements/0` → {"id": "cmp:operator-portal", "type": "component", "name": "Operator Portal", "revision": "p1", "boundary": "bnd:operator-zone", "descriptio
- [c6] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/elements/1` → {"id": "cmp:api-service", "type": "component", "name": "Telemetry API Service", "revision": "a1", "boundary": "bnd:enclave", "description": 
- [c7] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/elements/2` → {"id": "cmp:telemetry-db", "type": "component", "name": "Telemetry Database", "revision": "d1", "boundary": "bnd:enclave", "description": "R
- [c8] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/elements/3` → {"id": "cmp:audit-collector", "type": "component", "name": "Audit Collector", "revision": "c1", "boundary": "bnd:enclave", "description": "R
- [c9] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/flows/0` → {"id": "flow:portal-api", "source": "cmp:operator-portal", "target": "cmp:api-service", "data": "telemetry queries and annotations", "revisi
- [c10] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/flows/1` → {"id": "flow:api-db", "source": "cmp:api-service", "target": "cmp:telemetry-db", "data": "telemetry records", "revision": "f1", "attributes"
- [c11] `model:814dfa8cfa46fc4612ee107198006665e5b6e57a24e43be1e9c94aaf41110134#/flows/2` → {"id": "flow:api-audit", "source": "cmp:api-service", "target": "cmp:audit-collector", "data": "audit records", "revision": "f1", "attribute
- [c12] `control:ac-3_smt@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Enforce approved authorizations for logical access to information and system resources in accordance with applicable access control policies
- [c13] `mapping:OBL-AC3-API@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → The reviewed policy bundle for the API allows exactly the role/action/resource combinations declared in the model and denies the independent
- [c14] `check:chk-2f2ddada9350` → {"row_id": "OBL-AC3-API::cmp:api-service", "result": "PASS"}
- [c15] `control:au-12_smt.c@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Generate audit records for the event types defined in [AU-2c](#au-2_smt.c) that include the audit record content defined in [AU-3](#au-3).
- [c16] `mapping:OBL-AU12-API@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → Synthetic audit records captured from the API include actor, action, target, time and outcome for every event type the model declares for th
- [c17] `evidence:ev-audit-api-a1@fef3f617c86c71f72f8fd5c540d5cdc52625c867c3c8ca15b4dd2c59c0548006` → {   "records": [     {       "actor": "user:op-17",       "action": "telemetry.read",       "target": "telemetry/unit-4",       "time": "202
- [c18] `check:chk-2d95ec371804` → {"row_id": "OBL-AU12-API::cmp:api-service", "result": "PASS"}
- [c19] `control:sc-8_smt@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Protect the {{ insert: param, sc-08_odp }} of transmitted information.
- [c20] `mapping:OBL-SC8-FLOW@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → Each flow whose endpoints sit in different boundaries has (a) a design transport assertion and (b) a current, applicable transport test obse
- [c21] `evidence:ev-design-note-transport@2573cea4779d10d657ae934052905e6d1b3aa641d3944337df542bf8e2533440#char=36,190` → All interfaces that cross the maintenance telemetry enclave boundary are designed to use TLS 1.2 or later with certificates issued by the pr
- [c22] `evidence:ev-tls-portal-api-a1@0c94bf8583334cecd7e9547afc6d9161035f1d46f3772734781e487538623e17` → {   "report": "transport-test",   "flow_id": "flow:portal-api",   "result": "pass",   "protocol": "TLSv1.3",   "observations": [     "handsh
- [c23] `check:chk-09508e8143b1` → {"row_id": "OBL-SC8-FLOW::flow:portal-api", "result": "PASS"}
- [c24] `mapping:OBL-SC8-INHERIT@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → A claimed inherited SC-8 implementation is supported by provider/scope evidence that names the provider and the covered component.
- [c25] `check:chk-fe9ffd4c5da4` → {"row_id": "OBL-SC8-INHERIT::cmp:telemetry-db", "result": "UNKNOWN"}
