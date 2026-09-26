# Draft SSP excerpt — proj-mtel (REVIEWED_FOR_DEMO)

> SYNTHETIC DEMONSTRATION ARTIFACT. Partial excerpt prepared for expert review. Not an official System Security Plan or Security Assessment Report, not an assessment result, and not an authorization decision.

| Field | Value |
|---|---|
| export_id | `exp-d02f17ad138e` |
| package_id | `pkg-004-B` |
| package_digest | `236c91b5f6211044671e9d88708b667df2df89e559932c3d38982bdf3b60a22d` |
| created_at | `2026-09-23T15:00:00Z` |
| export_mode | `current` |
| status_at_export | `REVIEWED_FOR_DEMO` |
| drafter_mode | `fixture` |
| model snapshot | `snap-002-B-37a981cb` revision B |
| evidence scope | ev-audit-api-a1@fef3f617c86c (active), ev-audit-api-a2@b2095cc94839 (active), ev-design-note-transport@2573cea4779d (active), ev-provider-interface-note@4a1126c40820 (active), ev-tls-portal-api-a1@0c94bf858333 (active), ev-tls-portal-api-a2@4b7eb6d1fdc0 (active) |

## Obligation matrix

| Row | Control stmt | Object (rev) | Evidence state | Check result | Gaps |
|---|---|---|---|---|---|
| OBL-AC3-API::cmp:api-service | ac-3_smt | cmp:api-service (a2) | CURRENT | **FAIL** | 2 |
| OBL-AU12-API::cmp:api-service | au-12_smt.c | cmp:api-service (a2) | CURRENT | **PASS** | 2 |
| OBL-SC8-FLOW::flow:portal-api | sc-8_smt | flow:portal-api (f1) | CURRENT | **PASS** | 1 |
| OBL-SC8-FLOW::flow:provider-api | sc-8_smt | flow:provider-api (f1) | NONE | **UNKNOWN** | 2 |
| OBL-SC8-INHERIT::cmp:telemetry-db | sc-8_smt | cmp:telemetry-db (d1) | NONE | **UNKNOWN** | 2 |

3 of 5 selected demo obligation rows have current applicable evidence. This is not a compliance percentage.

## Scope and provenance

- **[FACT]** This excerpt was drafted from synthetic model revision B (snapshot 37a981cbdfcb). [c1]
- **[FACT]** The source model is fictional and is not a Cameo/SysML export. [c2]
- **[LIMITATION]** Drafted in fixture mode: deterministic text used to exercise the workflow, not a measure of model quality. 

## System boundary and components (design assertions)

- **[FACT]** Boundary Operator workstation zone (bnd:operator-zone) is modelled as trust-zone. [c3]
- **[FACT]** Boundary Maintenance telemetry enclave (bnd:enclave) is modelled as authorization-boundary. [c4]
- **[FACT]** Boundary External maintenance provider network (bnd:provider-net) is modelled as external. [c5]
- **[FACT]** Operator Portal (cmp:operator-portal, revision p1) is placed in Operator workstation zone. Browser-based portal used by operators and maintainers to view and annotate telemetry. [c6]
- **[FACT]** Telemetry API Service (cmp:api-service, revision a2) is placed in Maintenance telemetry enclave. REST service that mediates all reads and writes of maintenance telemetry. [c7]
- **[FACT]** Telemetry Database (cmp:telemetry-db, revision d1) is placed in Maintenance telemetry enclave. Relational store for telemetry records. [c8]
- **[FACT]** Audit Collector (cmp:audit-collector, revision c1) is placed in Maintenance telemetry enclave. Receives structured audit records from the API service. [c9]
- **[FACT]** Maintenance Provider Gateway (cmp:provider-gateway, revision g1) is placed in External maintenance provider network. External provider system that submits maintenance findings to the API. [c10]

## Data flows (design assertions)

- **[FACT]** Flow flow:portal-api carries telemetry queries and annotations from Operator Portal to Telemetry API Service and crosses a boundary. [c11]
- **[FACT]** Flow flow:api-db carries telemetry records from Telemetry API Service to Telemetry Database within one boundary. [c12]
- **[FACT]** Flow flow:api-audit carries audit records from Telemetry API Service to Audit Collector within one boundary. [c13]
- **[FACT]** Flow flow:provider-api carries maintenance findings from Maintenance Provider Gateway to Telemetry API Service and crosses a boundary. [c14]

## AC-3 — cmp:api-service

- **[FACT]** Selected control statement ac-3_smt (AC-3) is referenced for cmp:api-service. Selection is part of the curated demo mapping, not a baseline decision. [c15]
- **[FACT]** Local demo obligation: The reviewed policy bundle for the API allows exactly the role/action/resource combinations declared in the model and denies the independently authored negative cases. [c16]
- **[FACT]** Independent policy tests: 15 passed, 0 failed, 0 errored against policy digest 8659ebba72b5. [c17]
- **[GAP]** Model does not declare maintainer write on telemetry, but the reviewed policy allows it. [c17] [c7]
- **[GAP]** Model declares provider-integration write on telemetry, but the reviewed policy denies it. [c17] [c7]
- **[FACT]** Check result FAIL applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c17]
- **[LIMITATION]** Limitation: Does not show that the policy is deployed, that every API route calls it, or that access enforcement is complete. [c16]

## AU-12 — cmp:api-service

- **[FACT]** Selected control statement au-12_smt.c (AU-12) is referenced for cmp:api-service. Selection is part of the curated demo mapping, not a baseline decision. [c18]
- **[FACT]** Local demo obligation: Synthetic audit records captured from the API include actor, action, target, time and outcome for every event type the model declares for the API. [c19]
- **[GAP]** Evidence ev-audit-api-a1 was not used: collected against cmp:api-service revision a1; current revision is a2. [c20] [c21]
- **[FACT]** Synthetic observation ev-audit-api-a2 is applicable to the current revisions and reports PASS. [c22] [c21]
- **[FACT]** Check result PASS applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c21]
- **[GAP]** Parameter au-12_odp.01 is organization-defined and unresolved; a qualified reviewer must set it. [c21]
- **[GAP]** Parameter au-12_odp.02 is organization-defined and unresolved; a qualified reviewer must set it. [c21]
- **[LIMITATION]** Limitation: Does not show production log completeness, retention, or protection of audit records. [c19]

## SC-8 — flow:portal-api

- **[FACT]** Selected control statement sc-8_smt (SC-8) is referenced for flow:portal-api. Selection is part of the curated demo mapping, not a baseline decision. [c23]
- **[FACT]** Local demo obligation: Each flow whose endpoints sit in different boundaries has (a) a design transport assertion and (b) a current, applicable transport test observation reporting pass. [c24]
- **[FACT]** The model asserts transport protection 'TLS' for flow:portal-api (design assertion only). [c11]
- **[FACT]** Design note ev-design-note-transport (an assertion, not an observation) states: "All interfaces that cross the maintenance telemetry enclave boundary are designed to use TLS 1.2 or later with certificates issued by the program demo CA." [c25]
- **[GAP]** Evidence ev-tls-portal-api-a1 was not used: collected against cmp:api-service revision a1; current revision is a2. [c26] [c27]
- **[FACT]** Synthetic observation ev-tls-portal-api-a2 is applicable to the current revisions and reports PASS. [c28] [c27]
- **[FACT]** Check result PASS applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c27]
- **[GAP]** Parameter sc-08_odp is organization-defined and unresolved; a qualified reviewer must set it. [c27]
- **[LIMITATION]** Limitation: A model attribute alone cannot establish transport protection. A synthetic test report is not an observation of a real system. [c24]

## SC-8 — flow:provider-api

- **[FACT]** Selected control statement sc-8_smt (SC-8) is referenced for flow:provider-api. Selection is part of the curated demo mapping, not a baseline decision. [c23]
- **[FACT]** Local demo obligation: Each flow whose endpoints sit in different boundaries has (a) a design transport assertion and (b) a current, applicable transport test observation reporting pass. [c24]
- **[FACT]** The model asserts transport protection 'TLS' for flow:provider-api (design assertion only). [c14]
- **[FACT]** Design note ev-provider-interface-note (an assertion, not an observation) states: "The provider states that its gateway supports TLS." [c29]
- **[FACT]** Check result UNKNOWN applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c30]
- **[GAP]** No current applicable observation. [c30]
- **[GAP]** Parameter sc-08_odp is organization-defined and unresolved; a qualified reviewer must set it. [c30]
- **[LIMITATION]** Limitation: A model attribute alone cannot establish transport protection. A synthetic test report is not an observation of a real system. [c24]

## SC-8 — cmp:telemetry-db

- **[FACT]** Selected control statement sc-8_smt (SC-8) is referenced for cmp:telemetry-db. Selection is part of the curated demo mapping, not a baseline decision. [c23]
- **[FACT]** Local demo obligation: A claimed inherited SC-8 implementation is supported by provider/scope evidence that names the provider and the covered component. [c31]
- **[FACT]** Check result UNKNOWN applies only to the stated predicate and inputs. It is not a statement about control effectiveness. [c32]
- **[GAP]** inheritance claimed in the model; no provider/scope evidence. Left unresolved. [c32]
- **[GAP]** Parameter sc-08_odp is organization-defined and unresolved; a qualified reviewer must set it. [c32]
- **[LIMITATION]** Limitation: A provider statement is an assertion. Inheritance must not become satisfied because a vendor says so. [c31]

## Proposed risks and mitigations (hypotheses, not findings)

- **Hypothesis:** Design intent and the reviewed access policy disagree about who may write telemetry; either the model or the policy is out of date. [c17] [c7]
  - Assumptions: The model reflects current design intent.; The reviewed bundle is the one intended for deployment.
  - Proposed mitigation: Reconcile with the policy owner; change the policy only through normal review and re-run the independent tests.
- **Hypothesis:** Information on flow:provider-api may be transmitted without verified protection. [c30] [c14]
  - Assumptions: The design assertion may not match deployed configuration.
  - Proposed mitigation: Obtain a current transport test for flow:provider-api against current revisions and confirm the counterpart's TLS configuration.

## Questions for a qualified reviewer

- Parameter au-12_odp.01 for OBL-AU12-API::cmp:api-service is unresolved. Who sets it, and to what value? [c18]
- Parameter au-12_odp.02 for OBL-AU12-API::cmp:api-service is unresolved. Who sets it, and to what value? [c18]
- Parameter sc-08_odp for OBL-SC8-FLOW::flow:portal-api is unresolved. Who sets it, and to what value? [c23]
- Parameter sc-08_odp for OBL-SC8-FLOW::flow:provider-api is unresolved. Who sets it, and to what value? [c23]
- Which provider evidence establishes the inherited SC-8 claim for cmp:telemetry-db, and what scope does it cover? [c32] [c8]
- Parameter sc-08_odp for OBL-SC8-INHERIT::cmp:telemetry-db is unresolved. Who sets it, and to what value? [c23]

## Review record (document review only)

- `dec-002` ACCEPT by alice at 2026-09-23T15:00:00Z: Accepted for demo with open gaps: provider transport test missing; provider write role not in reviewed policy. (bound to package digest `236c91b5f621`; acknowledged gap rows: 5)

## Citations (immutable versions)

- [c1] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/revision` → B
- [c2] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/synthetic_notice` → Fictional system. Not a Cameo/SysML export and not derived from any real program.
- [c3] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/boundaries/0` → {"id": "bnd:operator-zone", "name": "Operator workstation zone", "kind": "trust-zone"}
- [c4] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/boundaries/1` → {"id": "bnd:enclave", "name": "Maintenance telemetry enclave", "kind": "authorization-boundary"}
- [c5] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/boundaries/2` → {"id": "bnd:provider-net", "name": "External maintenance provider network", "kind": "external"}
- [c6] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/elements/0` → {"id": "cmp:operator-portal", "type": "component", "name": "Operator Portal", "revision": "p1", "boundary": "bnd:operator-zone", "descriptio
- [c7] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/elements/1` → {"id": "cmp:api-service", "type": "component", "name": "Telemetry API Service", "revision": "a2", "boundary": "bnd:enclave", "description": 
- [c8] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/elements/2` → {"id": "cmp:telemetry-db", "type": "component", "name": "Telemetry Database", "revision": "d1", "boundary": "bnd:enclave", "description": "R
- [c9] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/elements/3` → {"id": "cmp:audit-collector", "type": "component", "name": "Audit Collector", "revision": "c1", "boundary": "bnd:enclave", "description": "R
- [c10] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/elements/4` → {"id": "cmp:provider-gateway", "type": "component", "name": "Maintenance Provider Gateway", "revision": "g1", "boundary": "bnd:provider-net"
- [c11] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/flows/0` → {"id": "flow:portal-api", "source": "cmp:operator-portal", "target": "cmp:api-service", "data": "telemetry queries and annotations", "revisi
- [c12] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/flows/1` → {"id": "flow:api-db", "source": "cmp:api-service", "target": "cmp:telemetry-db", "data": "telemetry records", "revision": "f1", "attributes"
- [c13] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/flows/2` → {"id": "flow:api-audit", "source": "cmp:api-service", "target": "cmp:audit-collector", "data": "audit records", "revision": "f1", "attribute
- [c14] `model:37a981cbdfcbc503e57ae0e780fb747f92ce3c1368028c017dda9bfbc2501938#/flows/3` → {"id": "flow:provider-api", "source": "cmp:provider-gateway", "target": "cmp:api-service", "data": "maintenance findings", "revision": "f1",
- [c15] `control:ac-3_smt@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Enforce approved authorizations for logical access to information and system resources in accordance with applicable access control policies
- [c16] `mapping:OBL-AC3-API@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → The reviewed policy bundle for the API allows exactly the role/action/resource combinations declared in the model and denies the independent
- [c17] `check:chk-9e55bac04bc5` → {"row_id": "OBL-AC3-API::cmp:api-service", "result": "FAIL"}
- [c18] `control:au-12_smt.c@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Generate audit records for the event types defined in [AU-2c](#au-2_smt.c) that include the audit record content defined in [AU-3](#au-3).
- [c19] `mapping:OBL-AU12-API@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → Synthetic audit records captured from the API include actor, action, target, time and outcome for every event type the model declares for th
- [c20] `evidence:ev-audit-api-a1@fef3f617c86c71f72f8fd5c540d5cdc52625c867c3c8ca15b4dd2c59c0548006` → {   "records": [     {       "actor": "user:op-17",       "action": "telemetry.read",       "target": "telemetry/unit-4",       "time": "202
- [c21] `check:chk-2d78551229f4` → {"row_id": "OBL-AU12-API::cmp:api-service", "result": "PASS"}
- [c22] `evidence:ev-audit-api-a2@b2095cc94839e70376dd296ea0020aaec9eda2bb95a850e6eb016a2fa7a461b3` → {   "records": [     {       "actor": "user:op-17",       "action": "telemetry.read",       "target": "telemetry/unit-4",       "time": "202
- [c23] `control:sc-8_smt@abb4d5e45b773685bda70ea0583be298ffaf4b74009845df6e875510d6bbbe26` → Protect the {{ insert: param, sc-08_odp }} of transmitted information.
- [c24] `mapping:OBL-SC8-FLOW@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → Each flow whose endpoints sit in different boundaries has (a) a design transport assertion and (b) a current, applicable transport test obse
- [c25] `evidence:ev-design-note-transport@2573cea4779d10d657ae934052905e6d1b3aa641d3944337df542bf8e2533440#char=36,190` → All interfaces that cross the maintenance telemetry enclave boundary are designed to use TLS 1.2 or later with certificates issued by the pr
- [c26] `evidence:ev-tls-portal-api-a1@0c94bf8583334cecd7e9547afc6d9161035f1d46f3772734781e487538623e17` → {   "report": "transport-test",   "flow_id": "flow:portal-api",   "result": "pass",   "protocol": "TLSv1.3",   "observations": [     "handsh
- [c27] `check:chk-3a98b4a3498e` → {"row_id": "OBL-SC8-FLOW::flow:portal-api", "result": "PASS"}
- [c28] `evidence:ev-tls-portal-api-a2@4b7eb6d1fdc06b11c1394b0cb3439b058b09ce75d4f85d7f99ffd5cbbaf35fc6` → {   "report": "transport-test",   "flow_id": "flow:portal-api",   "result": "pass",   "protocol": "TLSv1.3",   "observations": [     "handsh
- [c29] `evidence:ev-provider-interface-note@4a1126c40820660354b845c4b548098eb8cea4116568c3fab95f1a56e0eab4ef#char=158,` → The provider states that its gateway supports TLS.
- [c30] `check:chk-ee9674547497` → {"row_id": "OBL-SC8-FLOW::flow:provider-api", "result": "UNKNOWN"}
- [c31] `mapping:OBL-SC8-INHERIT@857dd5aa4e764d0909a989f8c712b0922c1761b9453021e4883e455cdd1549e8` → A claimed inherited SC-8 implementation is supported by provider/scope evidence that names the provider and the covered component.
- [c32] `check:chk-9790a6297528` → {"row_id": "OBL-SC8-INHERIT::cmp:telemetry-db", "result": "UNKNOWN"}
