# Synthetic model export contract 0.1

A deliberately small JSON shape used by the demo. **It is not a Cameo/SysML/XMI format.** A future adapter
could map a real export into it after the tool version, element semantics, stereotypes and data-release
permissions are confirmed with the program.

```json
{
  "contract": "dmmc-workbench/model-export",
  "contract_version": "0.1",
  "synthetic": true,
  "project": "proj-mtel",
  "source_id": "synthetic-model:maint-telemetry",
  "revision": "A",
  "boundaries": [{"id": "bnd:enclave", "name": "...", "kind": "authorization-boundary"}],
  "elements": [{"id": "cmp:api-service", "type": "component", "name": "...", "revision": "a1",
                "boundary": "bnd:enclave", "description": "...", "attributes": {"...": "..."}}],
  "flows": [{"id": "flow:portal-api", "source": "cmp:operator-portal", "target": "cmp:api-service",
             "data": "...", "revision": "f1", "attributes": {"transport": {"protection": "TLS"}}}]
}
```

Rules enforced by `importer.validate_model`:

- `synthetic` must be an explicit boolean.
- Ids are namespaced (`bnd:`, `cmp:`, `flow:`) and unique; elements and flows carry a `revision`.
- Element boundaries and flow endpoints must reference defined ids.
- `null` means **UNKNOWN** and is preserved; a missing key means **ABSENT**. Neither is ever treated as false.
- The raw bytes are stored and hashed (SHA-256); citations use `model:<digest>#<JSON Pointer>`.

Recognised attributes (others are preserved and displayed):

| Attribute | On | Used by |
|---|---|---|
| `permissions[] {role, action, resource}` | API element | AC-3 check (model vs policy decision table) |
| `audit_events[]` | API element | AU-12 check (required event types) |
| `transport.protection` | flow | SC-8 check (design assertion only) |
| `inherited_controls[] {control, provider, claim, evidence}` | element | inheritance row (stays UNKNOWN without provider evidence) |

## Evidence envelope

Each artifact is `<name>.meta.json` + payload. The artifact digest covers the envelope and the payload hash.

| Field | Meaning |
|---|---|
| `evidence_id` | Unique; replacement evidence needs a new id |
| `kind` | `assertion` (design notes, provider statements) or `observation` (test output, captured records) |
| `type` | `transport-test`, `audit-sample`, `design-note`, `provider-attestation` |
| `environment` | Must equal `demo-synthetic` to be applicable |
| `collected_at`, `expires_at` | Expired evidence is inapplicable |
| `target.element_revisions` | Every listed element must exist at that revision in the current model |
| `target.flow_id` / `target.about_flows` | Flow the observation / assertion is about |
| `synthetic`, `producer`, `collection_method` | Shown in exports; fixture evidence says it is a fixture |
