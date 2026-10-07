# UI run API notes

Fixes for each review item:
- **NEEDS:** jsonschema, guards, efsm, pkg, clauses, validate, diff and fixture are now listed, in both 30_run.js and the E2E.
- **Ledger:** Tool and Status come first. State, rev, attempts and logical action fold under Tool. Receipts show "Dispatch · certainty" as two chips that wrap; ref and receipt fold.
- **Evidence:** Claim (wrapping mono text, with break points after "_") comes first, then Validity. Result, verifier and receipt fold.
- **Interactions:** the first column is "Approval ix_…", then Status. Answer and scope fold.
- **Variables:** the Last step column is gone. Changed rows show a "changed" chip next to the name. The 16rem minimum is dropped. Values print with a space after "," and ":", and short string literals never break (so "BU-EMEA" stays whole).
- **Success colors:** `run_chip` and `run_tone` take a COMPLETED run's tone and label from its outcome category ("Completed · fallback" is crit, "Completed · unverified" is warn). This applies to the drive result, the summary and the runs list. The runs list has an Outcome column that folds at narrow widths.
- **Waiting states:** while waiting, Step and Run until blocked are disabled with a reason, plus a visible line under them. Step is primary only when it can move the run. Once the approval has expired, Step is enabled again so the expiry can be recorded.
- **Crash and cancel:** the summary shows a crit "Worker crashed at <point>" chip and a warn "Cancel requested" chip. Cancel is disabled with "Cancellation already requested: press Step to finish it."
- **Crash state:** Approve, Reject and Send documents are disabled with the crash reason. `S.crash` remembers its env and clears when `lab:changed` brings a different env. The model-switch restart lists armed crash points that were dropped. There is only one primary restart button now, "Restart worker to recover" in the notice; the drive-row Restart stays secondary.
- **Panel order:** summary, Start, Workbench, Inspector, Make trouble, Runs. After a successful Start, focus moves to #rn-step and scrolls it into view (block nearest, smooth unless reduced motion is set). Once a run exists, the scenario cards shrink to their titles at 40rem and below; the selected card keeps its text.
- **A25 outcome:** for TERMINAL_ADMISSION_DENIED the card is titled "Verified outcome refused" and opens with the reason. The drive result title says so too. Other FAILED runs show the code and message from their RUN_STOPPED event.
- **Outcome rows:** "Fallback path" says "not entered: the machine routed to END_REVIEW by its own edge (see Why)". A Why row shows the last transition, its guard or "by the default edge", and the values that decided it (e.g. lookup_status = "conflict").
- **Wording:** the summary item is now "Transitions". The Metrics tab says "Timed steps". The timeline header reads "N of M events shown (timing hidden)".
- **No-break text:** short ids use a no-break `code`, "A → B" is one no-break unit, and long ids, claims and the policy version use a wrapping mono span. The outcome lists wrap.
- **Approver labels:** the tenant comes first when it differs from the run's ("user:mallory · globex · procurement_approver"). The hint names the eligible approvers.
- **Summary strip:** the breakpoint is now 52rem, so the strip is one sticky row at 1280. Status chips wrap instead of being cut off.
- **Scenario cards:** tags always sit on their own row. A disabled card's tag uses the neutral tone. The reason is a <span>. Each radio is labelled by the card title and described by its summary (and by the reason when disabled). Start run lines up with the control row, and the gap above it is removed at narrow widths.
- **Custom JSON:** errors give the line and column. Schema errors are summarized as "Missing fields: …" with other errors after, and a "Reset to example" button (#rn-custom-reset) is added.
- **Revoke:** the copy says the change stays until Reset lab. "Revoked in this lab: …" lists the revoked capabilities against HX.data.policy.
- **Missing documents:** when HX.update, HX.reference, HX.registry, HX.fixture and HX.env are present, an "Admit refined machine" button (#rn-admit-refined) runs propose_update with the reference trace, then registry.admit as user:dana.
- **Focus keeping:** refresh() refocuses a rebuilt control that has the same id. The inspector re-renders keep focus by id and keep the Budget used <details> open state in st.open.
- **Stale drive result:** a successful human answer clears the old drive result.
- **Error hints:** hints depend on context. NOT_FOUND names the principal's tenant. NOT_AUTHORIZED for an input request names the requester. For an approval it explains self-approval or the missing role and names approvers taken from policy.doc (required role, same tenant, not the initiator).
- **ERP actions:** disabled on finished runs. The notes explain A25 (modify at END_VERIFIED_DRAFT) versus A28.
- **Copy:** the ERP tab says "call log of this ERP connection". The clock notice reads approval_expiry_s from the package and lease_ttl from env.service. The document prefill comes from the documents on file for the supplier in env.docs. The summary counts drafts for the initiator's tenant. The approval chip shows "Expired" (warn) once the clock passes expires_at.
- **Private calls removed:** custom validation uses HX.catalog.validate_against. Metrics use Object.keys(by_state).sort(). FakeERP rows are read only through `erp_drafts()` in 32_inspector.js, which prefers a public `list_drafts()` if one is added.
- **Smaller fixes:** the business-ref copy button has a stable id (rn-scope-ref-copy). Precondition errors no longer show "reload the page".
