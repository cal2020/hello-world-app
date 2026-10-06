/* HEXIS Runtime Lab: Run workbench section (round 1 placeholder; round 2 replaces this file). */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);

  const ABOUT = [
    "Pick a scenario (clean intake, missing documents, registry conflict, repairs exhausted, prompt injection, or your own task JSON) and step through it on the live state graph.",
    "Approve or reject as any identity, tamper with the approval scope, revoke a capability, restart the worker, and inject ERP faults such as a timeout after commit.",
    "Inspect the timeline, variables, ledger, evidence and latency metrics, then read the outcome with its assurance.",
  ];

  HXUI.register_section({
    id: "run",
    title: "Run workbench",
    nav: "Run",
    summary: "Drive runs through approvals, faults and recovery",
    needs: ["env", "service", "kernel", "broker", "store", "policy", "approvals", "evidence", "fakes", "metrics"],
    about: ABOUT,
    mount(el) {
      el.appendChild(h("div", { class: "hx-placeholder" },
        HXUI.notice("neutral", "The run workbench is not in this build yet",
          "The engine modules it needs are loaded. The controls for this section arrive with the next build of the lab."),
        HXUI.about_list(ABOUT)));
    },
  });
})();
