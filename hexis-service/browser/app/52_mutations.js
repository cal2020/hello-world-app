/* HEXIS Runtime Lab: the mutation catalog for "Break it" (HXUI.mutations).

   Each entry re-expresses one mutation of the Python conformance tests
   (tests/conformance/test_static_admission.py and test_review_admission_validator.py) in JS:
     {id, group, title, test, why, focus: [path, ...], skill_focus, mode, apply(d), skill(text),
      asserts: [{text, test(r)}], python: {codes, hash}}
   apply(d) edits a deep copy of the compiled package dump in place (the Python test's `mutate` / `reseal`
   callback). HXUI.mutations.build(m, base) then reseals it ("reseal": the package is re-hashed, as the tests'
   mutate() does) or keeps the stale hash ("keep": a tampered package). skill(text) edits the skill source the
   validator compares the clause quotes against.
   asserts are what the Python test asserts, evaluated on the live report r = {codes: Set, errors: [finding
   dumps]}. python.case names the golden case; python.codes / python.hash are the Python reference's full error codes and resealed artifact hash
   for the same mutation (golden/validate_conformance.json, production profile, with skill text and deployment
   policy). They are shown as the Python build's values next to the ones computed in the page.
   Plain data and pure functions: nothing here touches the DOM or runs at load time beyond defining data. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;

  const st = (d, id) => d.machine.states[id];
  const has = (r, code) => r.codes.has(code);
  const errs = (r, code) => r.errors.filter((f) => f.code === code);
  const code_assert = (code) => ({ text: [{ code }, " is reported"], test: (r) => has(r, code) });
  const at = (code, state, edge) => ({
    text: [{ code }, " is reported at ", { code: state }, edge === null ? "" : " edge " + edge],
    test: (r) => { const f = errs(r, code)[0]; return !!f && f.state === state && (f.edge === undefined ? null : f.edge) === edge; },
  });
  const fails = { text: "The package fails validation", test: (r) => !r.passed };

  const GROUPS = [
    { id: "structure", title: "Structure" },
    { id: "guards", title: "Guards" },
    { id: "dataflow", title: "Data flow" },
    { id: "loops", title: "Loops" },
    { id: "ordering", title: "Ordering and evidence" },
    { id: "policy", title: "Execution policy" },
    { id: "integrity", title: "Integrity and provenance" },
  ];

  const T_STATIC = "test_static_admission.py";
  const T_REVIEW = "test_review_admission_validator.py";

  const MUTATIONS = [
    /* ---------------------------------------------------------------- structure (A02) */
    {
      id: "a02-unknown-target", group: "structure", title: "Edge to a state that does not exist",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "The supplier lookup's second edge now points at NOPE. A run that took it would have nowhere to go.",
      focus: [["machine", "states", "LOOKUP_SUPPLIER", "transitions", 1]],
      apply: (d) => { st(d, "LOOKUP_SUPPLIER").transitions[1].to = "NOPE"; },
      asserts: [at("UNKNOWN_TARGET", "LOOKUP_SUPPLIER", 1)],
      python: { case: "A02-unknown-target", codes: ["UNKNOWN_TARGET"], hash: "sha256:4cfa5ca6d0cee2153b887c79a8ccb33fce012626e6cc3cbe369ff63de901f23e" },
    },
    {
      id: "a02-unknown-tool", group: "structure", title: "Tool missing from the trusted catalog",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "READ_INTAKE now calls shell.exec. Only tools in the trusted catalog can be called, so this one has no contract.",
      focus: [["machine", "states", "READ_INTAKE", "action", "name"]],
      apply: (d) => { st(d, "READ_INTAKE").action.name = "shell.exec"; },
      asserts: [at("UNKNOWN_TOOL", "READ_INTAKE", null)],
      python: { case: "A02-unknown-tool", codes: ["UNKNOWN_TOOL"], hash: "sha256:c840917d8a31419c1317147a931a89d2ed2a9aeb15929145fa3579029393e662" },
    },
    {
      id: "a02-unknown-variable", group: "structure", title: "Read of an undeclared variable",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "The extraction step now reads ghost, which the machine never declares.",
      focus: [["machine", "states", "EXTRACT_DRAFT", "action", "reads"]],
      apply: (d) => { st(d, "EXTRACT_DRAFT").action.reads.push("ghost"); },
      asserts: [at("UNKNOWN_VARIABLE", "EXTRACT_DRAFT", null)],
      python: { case: "A02-unknown-variable", codes: ["UNKNOWN_VARIABLE"], hash: "sha256:1aaac913d45b3941fe19838e0c2a833cea069850438ba002eb4ae82b8b6f6aed" },
    },
    {
      id: "a02-unknown-terminal", group: "structure", title: "End state with an undeclared outcome",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "END_UNVERIFIED now ends in END_MYSTERY, an outcome with no category and no evidence contract.",
      focus: [["machine", "states", "END_UNVERIFIED", "action"]],
      apply: (d) => { st(d, "END_UNVERIFIED").action.terminal = "END_MYSTERY"; },
      asserts: [at("UNKNOWN_TERMINAL", "END_UNVERIFIED", null)],
      python: { case: "A02-unknown-terminal", codes: ["UNKNOWN_TERMINAL"], hash: "sha256:8616fe90cde015b0d567d3601a1dd7cfccc597c2167fabf3f39a6c69e9d3685d" },
    },
    {
      id: "a02-duplicate-variable", group: "structure", title: "Variable declared twice",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "A second declaration of the first variable makes its type and owner ambiguous.",
      focus: [["machine", "variables"]],
      apply: (d) => { d.machine.variables.push(JSON.parse(JSON.stringify(d.machine.variables[0]))); },
      asserts: [code_assert("DUPLICATE_VARIABLE")],
      python: { case: "A02-duplicate-variable", codes: ["DUPLICATE_VARIABLE"], hash: "sha256:2dc1ebfc24b00039f9b9ed8095243b3fbe4680e662663d1932f26124768b4c9b" },
    },
    {
      id: "a02-unknown-initial", group: "structure", title: "Initial state that does not exist",
      test: T_STATIC + "::test_A02_structural_errors_rejected_with_location",
      why: "The machine now starts in NOWHERE, so no run could begin.",
      focus: [["machine", "initial"]],
      apply: (d) => { d.machine.initial = "NOWHERE"; },
      asserts: [at("UNKNOWN_INITIAL", "NOWHERE", null)],
      python: { case: "A02-unknown-initial", codes: ["UNKNOWN_INITIAL"], hash: "sha256:c827d998af7f977adcfe15bc993eb62c5b1cba96677c29268c08908f39b6049d" },
    },

    /* ---------------------------------------------------------------- guards (A03, A08, approval) */
    {
      id: "a03-import", group: "guards", title: "Malicious guard: import and run a shell command",
      test: T_STATIC + "::test_A03_malicious_guards_rejected_without_execution",
      why: "A guard is an expression in a small allowlisted grammar. This one tries to call __import__ and run a command. It is parsed and rejected, never executed.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 0]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[0].if = "__import__('os').system('touch /tmp/hexis-golden/pwned') == 0"; },
      asserts: [code_assert("GUARD_INVALID")],
      python: { case: "A03-malicious-guard-0", codes: ["GUARD_INVALID"], hash: "sha256:e862c2bc0681a3096b6422fc96076cd84dafa127d813399ae07a643b27cabdba" },
    },
    {
      id: "a03-dunder", group: "guards", title: "Malicious guard: attribute access",
      test: T_STATIC + "::test_A03_malicious_guards_rejected_without_execution",
      why: "Attribute access such as draft.__class__ is the usual first step out of an expression sandbox. The grammar has no attributes at all.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 0]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[0].if = "draft.__class__ == 'x'"; },
      asserts: [code_assert("GUARD_INVALID")],
      python: { case: "A03-malicious-guard-1", codes: ["GUARD_INVALID"], hash: "sha256:e704abf0d01e869b97534cc8595f8837a98feac6b19619cba5fd8d5888ed30ed" },
    },
    {
      id: "a03-lambda", group: "guards", title: "Malicious guard: lambda",
      test: T_STATIC + "::test_A03_malicious_guards_rejected_without_execution",
      why: "A guard must be a comparison over typed variables. A lambda is code, not a condition.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 0]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[0].if = "lambda: 1"; },
      asserts: [code_assert("GUARD_INVALID")],
      python: { case: "A03-malicious-guard-4", codes: ["GUARD_INVALID"], hash: "sha256:450e449e5801427e8406f0a755282ffb9bf6b4ac4bc802b7270d79e36e99de28" },
    },
    {
      id: "a08-overlap", group: "guards", title: "Overlapping guards",
      test: T_STATIC + "::test_A08_overlapping_guards_counterexample_and_unknown",
      why: "The repair edge now also fires when validation passes, so two edges out of VALIDATE_DRAFT can be true at once. The analysis finds a concrete assignment that proves it.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 1]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[1].if = "validation_status in ['pass', 'repairable'] and repair_count < 2"; },
      asserts: [code_assert("GUARDS_OVERLAP"), {
        text: ["The counterexample sets ", { code: "validation_status" }, " to ", { code: "'pass'" }],
        test: (r) => { const f = errs(r, "GUARDS_OVERLAP")[0]; return !!f && !!f.detail && !!f.detail.counterexample && f.detail.counterexample.validation_status === "pass"; },
      }],
      python: { case: "A08-overlap", codes: ["GUARDS_OVERLAP"], hash: "sha256:14bab0d27e9c396ff5e64483e93eae3ce72e2bceaea7d777d24e507719983aa7" },
    },
    {
      id: "a08-unknown", group: "guards", title: "Guards the analysis cannot decide",
      test: T_STATIC + "::test_A08_overlapping_guards_counterexample_and_unknown",
      why: "Comparing two variables (repair_count < readback_count) is outside what the disjointness analysis can decide, so admission fails closed instead of guessing.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 1]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[1].if = "validation_status == 'repairable' and repair_count < readback_count"; },
      asserts: [code_assert("GUARDS_DISJOINTNESS_UNKNOWN")],
      python: { case: "A08-unknown", codes: ["GUARDS_DISJOINTNESS_UNKNOWN", "LOOP_UNBOUNDED"], hash: "sha256:c5be917ee13ab39ebff52fc2cd1d2d361a381d8f8c6fab9070c5f0bea1952fa3" },
    },
    {
      id: "widen-approval", group: "guards", title: "Approval guard widened to any decision",
      test: T_STATIC + "::test_mutation_widen_approval_guard",
      why: "The edge to the ERP write now also fires when the approver rejects. Only 'approved' may lead to a write.",
      focus: [["machine", "states", "REQUEST_APPROVAL", "transitions", 0]],
      apply: (d) => { st(d, "REQUEST_APPROVAL").transitions[0].if = "approval_decision in ['approved', 'rejected']"; },
      asserts: [code_assert("APPROVAL_GUARD_WEAK")],
      python: { case: "mutation-widen-approval", codes: ["APPROVAL_GUARD_WEAK"], hash: "sha256:cf30d0959c9543d5c883def03aeb4d1252f6e67d958f9d0fbb008aa7aab8133a" },
    },
    {
      id: "x02-disjunctive", group: "guards", title: "Approval guard with an escape clause",
      test: T_REVIEW + "::test_X02_disjunctive_approval_guard_rejected",
      why: "\"approved or repair_count >= 1\" lets a repaired draft reach the write without approval.",
      focus: [["machine", "states", "REQUEST_APPROVAL", "transitions", 0]],
      apply: (d) => { st(d, "REQUEST_APPROVAL").transitions[0].if = "approval_decision == 'approved' or repair_count >= 1"; },
      asserts: [code_assert("APPROVAL_GUARD_WEAK")],
      python: { case: "X02-disjunctive", codes: ["APPROVAL_GUARD_WEAK"], hash: "sha256:544e8e8707e1371c87e479b47745f41e306f887966c2b79c715c524519b22160" },
    },

    /* ---------------------------------------------------------------- data flow */
    {
      id: "a04-definite-assignment", group: "dataflow", title: "Path that skips an assignment",
      test: T_STATIC + "::test_A04_definite_assignment_rejects_unsafe_path",
      why: "A new edge lets EXTRACT_DRAFT run straight after READ_INTAKE, before LOOKUP_SUPPLIER has assigned existing_supplier.",
      focus: [["machine", "states", "READ_INTAKE", "transitions"]],
      apply: (d) => { st(d, "READ_INTAKE").transitions.splice(1, 0, { if: "docs_status == 'missing'", to: "EXTRACT_DRAFT" }); },
      asserts: [{
        text: [{ code: "READ_BEFORE_WRITE" }, " of ", { code: "existing_supplier" }, " at ", { code: "EXTRACT_DRAFT" }],
        test: (r) => errs(r, "READ_BEFORE_WRITE").some((f) => f.state === "EXTRACT_DRAFT" && f.variable === "existing_supplier"),
      }],
      python: { case: "A04-definite-assignment", codes: ["READ_BEFORE_WRITE"], hash: "sha256:80fb5ea7ddf664712488f952f8e52089b371357a1e3eebb30ade253c87c41b26" },
    },
    {
      id: "counter-reset", group: "dataflow", title: "Model resets the repair counter",
      test: T_STATIC + "::test_mutation_counter_reset_by_model",
      why: "REPAIR_DRAFT is a model step. If it could write repair_count it could reset the bound and repair forever.",
      focus: [["machine", "states", "REPAIR_DRAFT", "action", "writes"]],
      apply: (d) => { st(d, "REPAIR_DRAFT").action.writes.push("repair_count"); },
      asserts: [code_assert("WRITE_OWNERSHIP")],
      python: { case: "mutation-counter-reset", codes: ["WRITE_OWNERSHIP"], hash: "sha256:aedc7597db46acd7515a9a957142d7a902db3c14327b4674a2a0540e3cad1b48" },
    },
    {
      id: "c24-counter-init", group: "dataflow", title: "Loop counter that starts below zero",
      test: T_REVIEW + "::test_C24_negative_counter_init_rejected",
      why: "Starting repair_count at -1000 turns \"at most two repairs\" into 1002.",
      focus: [["machine", "variables", { name: "repair_count" }]],
      apply: (d) => { for (const v of d.machine.variables) if (v.name === "repair_count") v.init = -1000; },
      asserts: [code_assert("COUNTER_INIT")],
      python: { case: "C24-counter-init--1000", codes: ["COUNTER_INIT"], hash: "sha256:d6f3db01dd78cebbfe033a25d0d7646ae2eeb002b62df9805fccf8088bb0baae" },
    },

    /* ---------------------------------------------------------------- loops (A11) */
    {
      id: "a11-cycle", group: "loops", title: "Cycle that avoids the bounded edge",
      test: T_STATIC + "::test_A11_cycle_avoiding_bounded_edge_rejected",
      why: "VERIFY_PERSISTED's default edge now loops back to READ_BACK without passing the counted retry edge, so the loop has no bound.",
      focus: [["machine", "states", "VERIFY_PERSISTED", "transitions", 1]],
      apply: (d) => { st(d, "VERIFY_PERSISTED").transitions[1].to = "READ_BACK"; },
      asserts: [code_assert("LOOP_UNBOUNDED")],
      python: { case: "A11-cycle", codes: ["LOOP_UNBOUNDED"], hash: "sha256:11a8a20557a6a6335f57d87f9d86506475b4e9fdc48a73fc26ce73c1b756a5ec" },
    },
    {
      id: "a11-unbounded-repair", group: "loops", title: "Repair loop without its counter",
      test: T_STATIC + "::test_A11_cycle_avoiding_bounded_edge_rejected",
      why: "The repair edge no longer increments repair_count, so the guard's bound never moves.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 1]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[1].inc = null; },
      asserts: [code_assert("LOOP_UNBOUNDED")],
      python: { case: "A11-unbounded-repair", codes: ["LOOP_UNBOUNDED"], hash: "sha256:7a14599be00ccb0a1ce7aae0d062e44e8452b6e501d90227197f4bc7fe03f719" },
    },
    {
      id: "loop-ceiling", group: "loops", title: "Loop bound above the operator's ceiling",
      test: T_STATIC + "::test_learned_loop_bound_clamped_to_operator_ceiling",
      why: "The skill says at most two repairs, and the execution policy caps every loop. A bound of 5 exceeds that cap.",
      focus: [["machine", "states", "VALIDATE_DRAFT", "transitions", 1]],
      apply: (d) => { st(d, "VALIDATE_DRAFT").transitions[1].if = "validation_status == 'repairable' and repair_count < 5"; },
      asserts: [code_assert("LOOP_BOUND_EXCEEDS_CEILING")],
      python: { case: "loop-bound-ceiling", codes: ["LOOP_BOUND_EXCEEDS_CEILING"], hash: "sha256:6fa0dfdc4f0aeda73cc99904f09a3ee348fdfca959805a72e768f481253cc6db" },
    },

    /* ---------------------------------------------------------------- ordering and evidence */
    {
      id: "a17-shortcut", group: "ordering", title: "Shortcut from extraction to approval",
      test: T_STATIC + "::test_A17_static_shortcut_rejected_with_path",
      why: "The extracted draft now goes straight to approval and the ERP write, skipping validation. The ordering check returns the offending path.",
      focus: [["machine", "states", "EXTRACT_DRAFT", "transitions", 0]],
      apply: (d) => { st(d, "EXTRACT_DRAFT").transitions[0].to = "REQUEST_APPROVAL"; },
      asserts: [code_assert("ORDERING_VIOLATION"), {
        text: ["The counterexample path ends at ", { code: "PERSIST_DRAFT" }, " or ", { code: "REQUEST_APPROVAL" }],
        test: (r) => { const f = errs(r, "ORDERING_VIOLATION")[0]; const p = f && f.detail && f.detail.path; return Array.isArray(p) && ["PERSIST_DRAFT", "REQUEST_APPROVAL"].indexOf(p[p.length - 1]) >= 0; },
      }],
      python: { case: "A17-shortcut", codes: ["DEAD_STATE", "ORDERING_VIOLATION", "READ_BEFORE_WRITE", "TERMINAL_OUTPUT_UNASSIGNED"], hash: "sha256:a8db07a2ca3e574f1b5b0c5fc71ff2426fbaaf0275c9dee1a7df951156fb88a3" },
    },
    {
      id: "remove-verifier", group: "ordering", title: "Verifier removed before the verified outcome",
      test: T_STATIC + "::test_mutation_remove_verifier",
      why: "READ_BACK now jumps to END_VERIFIED_DRAFT, so the run could claim success without the verifier's receipt.",
      focus: [["machine", "states", "READ_BACK", "transitions", 0]],
      apply: (d) => { st(d, "READ_BACK").transitions[0].to = "END_VERIFIED_DRAFT"; },
      asserts: [{
        text: [{ code: "ORDERING_VIOLATION" }, " of a ", { code: "derived:evidence" }, " requirement"],
        test: (r) => errs(r, "ORDERING_VIOLATION").some((f) => f.detail && String(f.detail.requirement || "").indexOf("derived:evidence") >= 0),
      }],
      python: { case: "mutation-remove-verifier", codes: ["DEAD_STATE", "ORDERING_VIOLATION", "TERMINAL_OUTPUT_UNASSIGNED"], hash: "sha256:4a6cee2f855ae62409e8f9ae9972ef83e1625b61a20e7f0214d2bbc613265109" },
    },
    {
      id: "verified-no-evidence", group: "ordering", title: "Verified outcome without evidence",
      test: T_STATIC + "::test_mutation_verified_terminal_without_evidence",
      why: "END_VERIFIED_DRAFT no longer lists the evidence it needs, so \"verified\" would mean nothing.",
      focus: [["contracts", "terminals", "END_VERIFIED_DRAFT", "evidence"]],
      apply: (d) => { d.contracts.terminals.END_VERIFIED_DRAFT.evidence = []; },
      asserts: [code_assert("VERIFIED_WITHOUT_EVIDENCE")],
      python: { case: "mutation-verified-no-evidence", codes: ["VERIFIED_WITHOUT_EVIDENCE"], hash: "sha256:8e061f4c66525c0f24f8a0894acc161626dc348e3aa2b47088b2dfef65f2c3dd" },
    },
    {
      id: "unsafe-default", group: "ordering", title: "Default edge into the ERP write",
      test: T_STATIC + "::test_unsafe_default_into_write_rejected",
      why: "The approval step's \"otherwise\" edge now leads to PERSIST_DRAFT, so any decision but 'approved' also writes.",
      focus: [["machine", "states", "REQUEST_APPROVAL", "transitions", 1]],
      apply: (d) => { st(d, "REQUEST_APPROVAL").transitions[1].to = "PERSIST_DRAFT"; },
      asserts: [code_assert("UNSAFE_DEFAULT")],
      python: { case: "unsafe-default", codes: ["APPROVAL_GUARD_WEAK", "UNSAFE_DEFAULT"], hash: "sha256:757eceb926503e017285338748fcd44db11eb52748ffe77ee825aa93d1e13858" },
    },
    {
      id: "x02-bypass", group: "ordering", title: "Approval bypassed through a no-op state",
      test: T_REVIEW + "::test_X02_approval_default_through_noop_state_rejected",
      why: "The default edge goes to a harmless-looking NOOP state that then writes. The check follows the path, not just the next hop.",
      focus: [["machine", "states", "REQUEST_APPROVAL", "transitions"], ["machine", "states", "NOOP"]],
      apply: (d) => {
        d.machine.states.NOOP = { id: "NOOP", action: { kind: "model", prompt: "noop", reads: [], writes: [] }, transitions: [{ if: "", to: "PERSIST_DRAFT" }] };
        const t = st(d, "REQUEST_APPROVAL").transitions;
        t[t.length - 1].to = "NOOP";
      },
      asserts: [code_assert("APPROVAL_BYPASS")],
      python: { case: "X02-bypass", codes: ["APPROVAL_BYPASS"], hash: "sha256:2bdcee16d46760fd33e8aa133458e1b265304d23820378ef5e7e42482d3bd2b2" },
    },

    /* ---------------------------------------------------------------- execution policy */
    {
      id: "capability-ceiling", group: "policy", title: "Capability outside the declared ceiling",
      test: T_STATIC + "::test_capability_outside_ceiling_rejected",
      why: "The package's ceiling now allows only documents:read, but its states still call the registry, the validator and the ERP.",
      focus: [["execution_policy", "capability_ceiling"]],
      apply: (d) => { d.execution_policy.capability_ceiling = ["documents:read"]; },
      asserts: [code_assert("CAPABILITY_EXCEEDS_CEILING")],
      python: { case: "capability-ceiling", codes: ["CAPABILITY_EXCEEDS_CEILING"], hash: "sha256:5f18d29f1a71c3b30c43af7069ca6870a547b19f1b25bf6ed58dd6cc754a3f26" },
    },
    {
      id: "c20-widen", group: "policy", title: "Execution policy wider than the operator's",
      test: T_REVIEW + "::test_C20_widened_execution_policy_rejected_at_admission",
      why: "The package raises its own loop bound to 1000 and its step budget to 100000. It is consistent with itself, but the operator's deployment policy is narrower.",
      focus: [["execution_policy"], ["machine", "max_steps"], ["machine", "states", "VALIDATE_DRAFT", "transitions", 1, "if"]],
      apply: (d) => {
        d.execution_policy.max_loop_bound = 1000;
        d.execution_policy.budgets.max_steps = 100000;
        d.machine.max_steps = 100000;
        st(d, "VALIDATE_DRAFT").transitions[1].if = "validation_status == 'repairable' and repair_count < 1000";
      },
      asserts: [code_assert("POLICY_EXCEEDS_DEPLOYMENT")],
      python: { case: "C20-widen", codes: ["POLICY_EXCEEDS_DEPLOYMENT"], hash: "sha256:4d6a0c2f4428a98497c64655b6ccccbbb2ac4dab6573271f79153171ecdd9b72" },
    },
    {
      id: "c20-nowrite", group: "policy", title: "Write workflow not declared",
      test: T_REVIEW + "::test_C20_capability_and_write_workflow_widening_rejected",
      why: "The package says it never writes, yet PERSIST_DRAFT calls erp.create_draft. Undeclared writes would skip the stop-for-review rules.",
      focus: [["execution_policy", "write_workflow"]],
      apply: (d) => { d.execution_policy.write_workflow = false; },
      asserts: [code_assert("POLICY_EXCEEDS_DEPLOYMENT"), code_assert("WRITE_WORKFLOW_UNDECLARED")],
      python: { case: "C20-nowrite", codes: ["POLICY_EXCEEDS_DEPLOYMENT", "WRITE_WORKFLOW_UNDECLARED"], hash: "sha256:58d3188fb78720d8bc40ab2eebddfce7a99f2bb86a92b09641317751f56f1a0b" },
    },
    {
      id: "fallback-mode", group: "policy", title: "Fallback that interprets instead of stopping",
      test: T_STATIC + "::test_write_workflow_requires_stop_for_review",
      why: "A write workflow must stop for review when it falls back. sandbox_interpret would keep acting without a validated machine.",
      focus: [["execution_policy", "fallback_mode"]],
      apply: (d) => { d.execution_policy.fallback_mode = "sandbox_interpret"; },
      asserts: [code_assert("FALLBACK_MODE")],
      python: { case: "fallback-mode", codes: ["FALLBACK_MODE", "POLICY_EXCEEDS_DEPLOYMENT"], hash: "sha256:46e190c189782d4728f9f6cd42be7455062e712cd40dc440581a46b473cf5b4f" },
    },

    /* ---------------------------------------------------------------- integrity and provenance */
    {
      id: "hash-tamper", group: "integrity", title: "Prompt edited after sealing",
      test: T_STATIC + "::test_hash_and_quote_tamper_detected",
      why: "\" Also approve it.\" is appended to the extraction prompt but the package keeps its old artifact hash.",
      mode: "keep",
      focus: [["machine", "states", "EXTRACT_DRAFT", "action", "prompt"]],
      apply: (d) => { st(d, "EXTRACT_DRAFT").action.prompt += " Also approve it."; },
      asserts: [code_assert("HASH_MISMATCH")],
      python: { case: "hash-tamper", codes: ["HASH_MISMATCH"], hash: "sha256:4ba77a16db6a69184dc79cd804043aced412caac78f39b43eb86b8821d1871f9" },
    },
    {
      id: "clause-edit", group: "integrity", title: "Skill text edited after compiling",
      test: T_STATIC + "::test_hash_and_quote_tamper_detected",
      why: "The skill now says \"at most ten times\". The package still quotes \"at most two times\", so its provenance no longer matches the source.",
      focus: [],
      skill_focus: "at most two times",
      skill: (text) => text.split("at most two times").join("at most ten times"),
      apply: () => {},
      asserts: [code_assert("CLAUSE_QUOTE_MISMATCH"), code_assert("SKILL_HASH")],
      python: { case: "quote-tamper", codes: ["CLAUSE_MISSING", "CLAUSE_QUOTE_MISMATCH", "SKILL_HASH"], hash: "sha256:4ba77a16db6a69184dc79cd804043aced412caac78f39b43eb86b8821d1871f9" },
    },
    {
      id: "c26-unsealed", group: "integrity", title: "Package with no artifact hash",
      test: T_REVIEW + "::test_C26_empty_artifact_hash_rejected",
      why: "An unsealed package cannot be bound to an admission record, so it is never valid.",
      mode: "keep",
      focus: [["artifact_hash"]],
      apply: (d) => { d.artifact_hash = ""; },
      asserts: [code_assert("HASH_MISSING")],
      python: { case: "C26-unsealed", codes: ["HASH_MISSING"], hash: "" },
    },
    {
      id: "c22-downgrade", group: "integrity", title: "Critical clause declared unsupported",
      test: T_REVIEW + "::test_C22_critical_clause_cannot_self_declare_noncritical",
      why: "S3.1 is a MUST clause. The package claims it is neither critical nor supported. Criticality comes from the clause text, not from the package.",
      focus: [["contracts", "clause_coverage", "S3.1"]],
      apply: (d) => { d.contracts.clause_coverage["S3.1"] = { classification: "unsupported", justification: "x", states: [], critical: false }; },
      asserts: [code_assert("CRITICAL_CLAUSE_UNSUPPORTED"), code_assert("CRITICAL_FLAG_MISMATCH")],
      python: { case: "C22-downgrade", codes: ["CRITICAL_CLAUSE_UNSUPPORTED", "CRITICAL_FLAG_MISMATCH"], hash: "sha256:f974645c8d78a19b77ee287a8d1970171f78409285303e3cba1fbb9d1486f8dc" },
    },
    {
      id: "c27-selector", group: "integrity", title: "Ordering rules that match nothing",
      test: T_REVIEW + "::test_C27_unmatched_ordering_selectors_rejected",
      why: "\"tool: erp.create_draft\" (with a space) names no tool, so every ordering rule would silently pass.",
      focus: [["contracts", "ordering", 0]],
      apply: (d) => { for (const o of d.contracts.ordering) o.before = o.before.split("tool:").join("tool: "); },
      asserts: [code_assert("ORDERING_SELECTOR_UNKNOWN")],
      python: { case: "C27-space-selector", codes: ["ORDERING_SELECTOR_UNKNOWN"], hash: "sha256:bba6af8e001376544bac889dfcdb0953c6f60198921504a323b9e6b46e982c3c" },
    },
  ];

  /* ---------------------------------------------------------------- helpers */
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** get(obj, path): a path step is a key, an index (negative counts from the end) or {name} (array item by name) */
  function get(obj, path) {
    let cur = obj;
    for (const step of path) {
      if (cur === null || cur === undefined) return undefined;
      if (step && typeof step === "object") {
        cur = Array.isArray(cur) ? cur.find((x) => x && x.name === step.name) : undefined;
      } else if (typeof step === "number" && Array.isArray(cur)) {
        cur = cur[step < 0 ? cur.length + step : step];
      } else {
        cur = Object.prototype.hasOwnProperty.call(cur, step) ? cur[step] : undefined;
      }
    }
    return cur;
  }

  function path_text(path) {
    return path.map((s) => (s && typeof s === "object" ? "[name=" + s.name + "]" : typeof s === "number" ? "[" + s + "]" : "." + s))
      .join("").replace(/^\./, "");
  }

  /** build(m, base_dump) -> {pkg, before, after}: the mutated package as the Python test builds it */
  function build(m, base) {
    const d = clone(base);
    m.apply(d);
    let pkg;
    if (m.mode === "keep") pkg = HX.pkg.normalize_package(d);
    else { d.artifact_hash = ""; pkg = HX.pkg.sealed(d); }
    return pkg;
  }

  HXUI.mutations = {
    groups: GROUPS,
    list: MUTATIONS,
    find: (id) => MUTATIONS.find((m) => m.id === id) || null,
    build,
    get,
    path_text,
  };
})();
