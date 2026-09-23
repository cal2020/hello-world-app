# Simulated and absent integrations

| Integration | Status in this prototype | What a real integration would need |
|---|---|---|
| Cameo Systems Modeler / Enterprise Architecture | **Absent.** Hand-authored JSON fixtures stand in for an export | Program's tool version; which interface is installed and permitted (file export, Teamwork Cloud REST, OSLC, plug-in API); stereotype/profile semantics for components, flows, boundaries; element identity across versions; data-release approval |
| Teamwork Cloud / OSLC | **Absent.** Nothing here claims either is deployed at KBR | Vendor docs describe a TWC REST API and a read-only OSLC API (search-result excerpts only; docs.nomagic.com was not reachable from this environment, so verify before relying on it) |
| Evidence producers (scanners, test harnesses, log pipelines) | **Simulated** by fixture JSON envelopes | Signed or otherwise attributable outputs, target identity that matches model identity, environment tags |
| Identity provider | **Simulated** (dropdown) | IdP/SSO, role source of truth, revocation events |
| NIST SP 800-53 catalog | **Real content, pinned excerpt** of NIST's OSCAL catalog (Rev 5.2.0; upstream SHA-256 recorded) | Full catalog import, baseline/profile resolution, parameter values from the responsible organization |
| OSCAL | **Real schema** (NIST OSCAL 1.2.3 component-definition JSON Schema). Export is a bounded component definition only | SSP / assessment-plan / assessment-results models, profile resolution, organization-specific metadata |
| OPA | **Real** (1.20.0 CLI, pinned SHA-256) | Deployed decision point, bundle distribution, decision logging |
| Language model | **Optional adapter, not exercised** (no credentials in this environment). Fixture drafter used instead | Approved provider for the data classification, prompt/eval governance, cost and latency budget |
| DMMC ("Run DMMC"), Digital Forge, "Lucid dream" | **Not integrated and not characterised.** Names are from the candidate's notes on conversations with the hiring manager | Everything; ask first |
