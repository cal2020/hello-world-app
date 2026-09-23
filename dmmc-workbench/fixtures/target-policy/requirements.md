# Access requirements for the simulated telemetry API (synthetic)

These requirements were written first. `authz_test.rego` was written from this file,
not from `authz.rego`. They describe the fictional target application being analysed,
not the workbench's own authorization.

Decision contract: `data.mtel.authz.decision` returns `{"allow": bool, "reasons": [string]}`.

- R1. An `operator` may `read` `telemetry` in their own project.
- R2. A `maintainer` may `read` and `write` `telemetry` in their own project.
- R3. No role has access to resources in a different project.
- R4. A subject whose authority is revoked (`subject.revoked == true`) is denied everything.
- R5. Explicit deny takes precedence: `write` to a resource with `locked == true` is denied for every role (maintenance freeze).
- R6. A request missing any of subject id, role, project, revoked flag, action, resource type or resource project is denied.
- R7. Any role, action or resource type not granted above is denied (default deny). This includes `provider-integration`.
