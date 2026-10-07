/* HEXIS Runtime Lab: Run workbench scenarios, as data (HXUI.run_scenarios).
   Each scenario is the task the Python tests and the CLI demo use, built from HX.data.task (examples/task.json):
     {id, title, summary, refs, machine: "initial" | "refined", model: {gullible?} | null, expect, task() -> task input}
   machine "refined" needs the refined package to be admitted in the lab environment (Learn from traces does that).
   model: the extraction model the worker runs with; the workbench restarts the worker (env.restart(model)) when a
   scenario needs a different one, and says so. The custom scenario's task comes from the JSON editor. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;

  function base_task() {
    const t = globalThis.HX && HX.data && HX.data.task ? HX.data.task : null;
    return t ? JSON.parse(JSON.stringify(t)) : {};
  }
  function with_task(over) { return () => Object.assign(base_task(), over || {}); }

  const SCENARIOS = [
    {
      id: "clean", title: "Clean intake", refs: "happy path",
      summary: ["Supplier ", { code: "SUP-10042" }, " with both intake documents. One bounded repair, then approval of the exact ERP write, then a verified read-back."],
      machine: "initial", model: null,
      expect: "Waits for approval, then ends END_VERIFIED_DRAFT once user:bob approves.",
      task: with_task(),
    },
    {
      id: "missing-docs", title: "Missing documents", refs: "refined machine",
      summary: ["Intake lists ", { code: "DOC-LATE-MISSING" }, ". The refined machine asks the requester for documents once, then continues."],
      machine: "refined", model: null,
      expect: "Waits for input; answer with DOC-LATE-40002, then approve.",
      task: with_task({ supplier_ref: "SUP-40002", document_ids: ["DOC-LATE-MISSING"] }),
    },
    {
      id: "registry-conflict", title: "Registry conflict", refs: "review path",
      summary: ["Supplier ", { code: "SUP-55555" }, " is already registered to BU-NA, which conflicts with the requested BU-EMEA."],
      machine: "initial", model: null,
      expect: "Stops for human review: END_REVIEW, nothing written.",
      task: with_task({ supplier_ref: "SUP-55555" }),
    },
    {
      id: "repairs-exhausted", title: "Repairs exhausted", refs: "Python test A10", refs_title: "Mirrors the Python acceptance test A10: repairs are bounded",
      summary: ["Only ", { code: "DOC-W9-10042" }, " is provided, so no contact email exists. Two repairs cannot fix the draft."],
      machine: "initial", model: null,
      expect: "Ends END_UNVERIFIED after exactly two repairs, nothing written.",
      task: with_task({ document_ids: ["DOC-W9-10042"] }),
    },
    {
      id: "injection", title: "Prompt-injection document", refs: "Python test A26", refs_title: "Mirrors the Python acceptance test A26: an injected document cannot widen the output",
      summary: ["A document says approval is already granted and asks for ", { code: "tenant_id=globex" }, ". The gullible model obeys it."],
      machine: "initial", model: { gullible: true },
      expect: "The output contract rejects the extra keys and the run falls back to review.",
      task: with_task({ supplier_ref: "SUP-30001", document_ids: ["DOC-INJECT-30001"] }),
    },
    {
      id: "custom", title: "Custom task JSON", refs: "your input",
      summary: ["Edit the task yourself. The page parses it strictly and checks it against the package's task schema before the run starts."],
      machine: "initial", model: null, custom: true,
      expect: "Whatever the engine decides for your input.",
      task: with_task(),
    },
  ];

  HXUI.run_scenarios = SCENARIOS;
  HXUI.run_scenario = (id) => SCENARIOS.find((s) => s.id === id) || null;
})();
