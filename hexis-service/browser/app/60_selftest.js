/* HEXIS Runtime Lab: Self-test section (round 1 placeholder; round 2 replaces this file).
   Lists every engine namespace and whether this build loaded it. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  if (typeof HXUI.register_section !== "function") return; /* the UI core is missing: boot reports it */
  const h = (...a) => HXUI.h(...a);

  const ABOUT = [
    ["Run every check in this page: the parity anchors, golden vectors from the Python reference, and the ", { code: "A01" }, " to ", { code: "A32" }, " acceptance scenarios."],
    "Read pass, fail and skip counts with durations, and the assertion message of any failure.",
  ];

  const STATUS = {
    loaded: ["Loaded", "ok", "check"],
    failed: ["Failed to load", "crit", "stop"],
    absent: ["Not in this build", "neutral", null],
  };

  function summary(inv) {
    const n = (st) => inv.filter((m) => m.status === st).length;
    const loaded = n("loaded");
    const failed = n("failed");
    const absent = n("absent");
    const label = loaded + " of " + inv.length + " engine modules loaded";
    /* the counter says how many loaded; the chips beside it say what is wrong or missing */
    return h("div", { class: "st-summary" },
      h("p", { class: "st-count" },
        h("span", { class: "st-count-num" }, String(loaded)),
        h("span", { class: "st-count-of" }, " of " + inv.length),
        h("span", { class: "st-count-label" }, "engine modules loaded")),
      h("div", { class: "hx-meter st-meter", role: "img", "aria-label": label },
        inv.map((m) => h("span", { class: "hx-meter-cell", dataset: { status: m.status }, title: "HX." + m.ns[0] + ": " + STATUS[m.status][0] }))),
      h("div", { class: "hx-panel-meta" },
        HXUI.chip(failed + " failed", failed ? "crit" : "neutral", { icon: failed ? "stop" : undefined }),
        HXUI.chip(absent + " not in this build", "neutral")));
  }

  function inventory_table(inv) {
    const namespaces = (m) => m.ns.map((x) => "HX." + x).join(", ");
    return HXUI.table({
      /* the panel heading labels the table; the caption stays for assistive technology */
      caption: "Engine modules in this build",
      caption_hidden: true,
      class: "st-modules",
      columns: [
        { key: "prefix", label: "Module", nowrap: true, render: (m) => h("span", { class: "st-module", title: m.file || "No script for this module in this build" }, h("code", null, m.prefix), " " + m.label) },
        { key: "status", label: "Status", nowrap: true, render: (m) => HXUI.chip(STATUS[m.status][0], STATUS[m.status][1], { icon: STATUS[m.status][2] || undefined }) },
        /* on a narrow screen the namespace and the Python file move under the module name */
        { key: "ns", label: "Namespace", mono: true, nowrap: true, render: namespaces, fold: namespaces },
        { key: "ref", label: "Python reference", mono: true, nowrap: true, render: (m) => m.ref || h("span", { class: "hx-faint" }, "none"), fold: (m) => m.ref || null },
      ],
      rows: inv,
      row_attrs: (m) => ({ dataset: { module: m.prefix, status: m.status } }),
    });
  }

  HXUI.register_section({
    id: "selftest",
    title: "Self-test",
    nav: "Self-test",
    summary: "Golden vectors and acceptance checks, run in this page",
    needs: [],
    about: ABOUT,
    mount(el) {
      const inv = HXUI.engine_inventory();
      const extras = HXUI.engine_extras();
      const run = HXUI.button("Run all checks", {
        id: "st-run", variant: "primary", icon: "play", disabled: true,
        disabled_reason: "The check runner is not in this build yet.",
      });
      el.appendChild(h("div", { class: "st hx-ruled" },
        h("section", { class: "hx-panel", "aria-labelledby": "st-checks-title" },
          h("div", { class: "hx-panel-head" }, h("h3", { class: "hx-panel-title", id: "st-checks-title" }, "Checks")),
          h("div", { class: "hx-action-row" }, run,
            h("p", { class: "hx-reason" }, HXUI.icon("info"), h("span", null, "The check runner is not in this build yet."))),
          HXUI.about_list(ABOUT, { title: "What the runner does", level: 4 })),
        h("section", { class: "hx-panel", "aria-labelledby": "st-engine-title" },
          h("div", { class: "hx-panel-head" },
            h("h3", { class: "hx-panel-title", id: "st-engine-title" }, "Engine in this build"),
            h("div", { class: "hx-panel-meta" }, HXUI.chip(globalThis.HX && HX.VERSION ? String(HX.VERSION) : "engine not loaded", "neutral", { mono: true }))),
          summary(inv),
          inventory_table(inv),
          extras.length ? h("p", { class: "st-extras" }, "Also present: ", extras.map((x, i) => [i ? ", " : "", h("code", { class: "hx-inline" }, "HX." + x)]), ".") : null)));
    },
  });
})();
