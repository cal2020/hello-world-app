/* HEXIS Runtime Lab: Learn from traces section (round 1 placeholder; round 2 replaces this file). */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);

  const ABOUT = [
    "Enroll completed runs into the protected archive, or see why a run is not eligible.",
    "Propose an update from the missing-documents trace and read every gate, the diff and the admission against the expected parent.",
    "Race two updates for the same parent, and watch a shortcut trace get rejected while the active version stays the same.",
  ];

  HXUI.register_section({
    id: "learn",
    title: "Learn from traces",
    nav: "Learn",
    summary: "Refine the machine from a trace and let the gates decide",
    needs: ["traces", "normalize", "replay", "update", "registry", "reference", "env"],
    about: ABOUT,
    mount(el) {
      el.appendChild(h("div", { class: "hx-placeholder" },
        HXUI.notice("neutral", "Learning from traces is not in this build yet",
          "The engine modules it needs are loaded. The controls for this section arrive with the next build of the lab."),
        HXUI.about_list(ABOUT)));
    },
  });
})();
