/* HEXIS Runtime Lab: Compile section (round 1 placeholder; round 2 replaces this file). */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);

  /* plain data: HXUI.rich() sets {code} in mono and {strong} in bold when the list renders */
  const ABOUT = [
    ["Read ", { code: "SKILL.md" }, " with every clause tagged by its id (", { code: "S1.1" }, ", ", { code: "S1.2" }, ", …) and the ", { strong: "MUST" }, " clauses marked."],
    "Compile the skill and inspect each attempt: its status, its findings, and the counterexample path of any ordering violation.",
    ["Check clause coverage and compare the artifact hash with the Python build, then admit the package as ", { code: "user:dana" }, "."],
  ];

  HXUI.register_section({
    id: "compile",
    title: "Compile",
    nav: "Compile",
    summary: "From the written skill to an admitted state machine",
    needs: ["clauses", "compile", "validate", "registry", "env"],
    about: ABOUT,
    mount(el) {
      el.appendChild(h("div", { class: "hx-placeholder" },
        HXUI.notice("neutral", "The compile workbench is not in this build yet",
          "The engine modules it needs are loaded. The controls for this section arrive with the next build of the lab."),
        HXUI.about_list(ABOUT)));
    },
  });
})();
