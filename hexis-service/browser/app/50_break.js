/* HEXIS Runtime Lab: Break it section (round 1 placeholder; round 2 replaces this file). */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const h = (...a) => HXUI.h(...a);

  const ABOUT = [
    "Apply a named mutation, such as removing the verifier, widening the approval guard or tampering with the hash, and compare the JSON before and after.",
    ["Run ", h("code", { class: "hx-inline" }, "validate_package"), " on the mutated package and read each finding with its code, location and message."],
    "Edit guards and variable types to see parse errors, type errors and overlap counterexamples live, then evaluate a guard against your own JSON environment.",
  ];

  HXUI.register_section({
    id: "break",
    title: "Break it",
    nav: "Break it",
    summary: "Mutate the machine and watch validation catch it",
    needs: ["validate", "guards", "efsm", "pkg", "catalog", "fixture", "compile"],
    about: ABOUT,
    mount(el) {
      el.appendChild(h("div", { class: "hx-placeholder" },
        HXUI.notice("neutral", "The mutation lab is not in this build yet",
          "The engine modules it needs are loaded. The controls for this section arrive with the next build of the lab."),
        HXUI.about_list(ABOUT)));
    },
  });
})();
