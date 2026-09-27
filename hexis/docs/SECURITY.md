# Security notes

| Failure surface (§13) | Control in this build | Test |
|---|---|---|
| Prompt injection in documents/tool results | document text is data; the model has no tools; kernel rejects extra/privileged output keys and engine-owned writes; approvals only via `ApprovalService`; broker re-checks tenant and business-unit scope | A26 (DOC-666), A06 |
| Malicious compiled artifact | strict loader (unknown keys, duplicate keys, NaN rejected), guard allowlist with size/depth limits, no code deserialization, trusted catalog lookup, hash verification, signed admission | A02, A03, tamper test |
| Trace poisoning | trace hash integrity, machine-independent eligibility, negative corpus, runtime cannot admit its own traces (admission is a separate call) | A15, A31, negative-corpus test |
| Tool-output spoofing | tool outputs validated against the trusted output schema; receipts bound to logical action id; ERP reads tenant-checked | schema checks in kernel |
| Cross-tenant access | tenant taken from the host principal for every lookup; other tenants' runs are "not found" | cross-tenant test |
| Shell/tool escape | no generic shell tool exists in the catalog | catalog review |
| Missing input / permissive coercion | strict selectors, strict template resolution, no coercion in schema validation | A05, A07 |
| Budget exhaustion | global monotonic step/tool/model/token counters in the checkpoint | A10 |
| Adaptive policy weakening | policy-diff gate; compiler/updater cannot modify policy, catalog, evidence or approvals | policy-diff test |
| Secrets | keys only from the environment; none in artifacts, fixtures or logs | review |

Not provided: production authentication, key management (admission HMAC falls back to a documented
development key), encryption at rest, redaction pipelines, rate limiting. A passing local suite is not a
security assessment.
