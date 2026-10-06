/* HEXIS Runtime Lab: boot. Builds the page shell (top bar, section rail, main canvas, live region),
   routes to location.hash or #overview, then sets #app[data-boot] to "ready". If anything here throws,
   it shows a readable error panel and sets "failed". */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const app = document.getElementById("app");

  function fail(err) {
    if (!app) return;
    /* plain DOM on purpose: this must work even when app/05_ui.js is missing */
    const box = document.createElement("div");
    box.className = "hx-boot-error";
    box.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "The lab could not start";
    const lead = document.createElement("p");
    lead.textContent = "Something in this build failed while the page was starting. Reload the page to try again. " +
      "If it fails again, the build itself is broken, and the message below says where.";
    const pre = document.createElement("pre");
    pre.textContent = String((err && (err.stack || err.message)) || err);
    box.append(title, lead, pre);
    app.replaceChildren(box);
    app.dataset.boot = "failed";
  }

  function stub_missing_sections() {
    for (const id of HXUI.SECTION_ORDER) {
      if (HXUI.has_section(id)) continue;
      HXUI.register_section({
        id, title: HXUI.DEFAULT_TITLES[id], summary: "This section did not load", needs: [],
        mount(el) {
          el.appendChild(HXUI.notice("crit", "This section did not load",
            "Its script is missing from this build or stopped while loading. The other sections still work, and Self-test lists what this build contains."));
        },
      });
    }
  }

  /* ---------------------------------------------------------------- top bar */
  function reset_control() {
    const h = HXUI.h;
    const label = h("span", { class: "hx-btn-label" }, "Reset lab");
    const trigger = h("button", {
      type: "button", id: "hx-reset", class: "hx-btn hx-btn--secondary hx-btn--sm hx-reset",
      "aria-expanded": "false", "aria-controls": "hx-reset-pop", "aria-haspopup": "dialog",
    }, HXUI.icon("reset"), label);
    const cancel = HXUI.button("Cancel", { id: "hx-reset-cancel", variant: "ghost", size: "sm" });
    const confirm = HXUI.button("Reset lab", { id: "hx-reset-confirm", variant: "danger", size: "sm" });
    const pop = h("div", {
      id: "hx-reset-pop", class: "hx-pop", role: "dialog", "aria-modal": "false",
      "aria-labelledby": "hx-reset-pop-title", "aria-describedby": "hx-reset-pop-desc", hidden: true,
    },
    h("p", { class: "hx-pop-title", id: "hx-reset-pop-title" }, "Reset the lab?"),
    h("p", { class: "hx-pop-body", id: "hx-reset-pop-desc" },
      "This clears every run, package, archive entry and log line in this page. The engine and the example data stay loaded."),
    h("div", { class: "hx-pop-actions" }, cancel, confirm));
    const wrap = h("div", { class: "hx-reset-wrap" }, trigger, pop);
    let done_timer = 0;

    function open() {
      pop.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      cancel.focus();
    }
    function close(return_focus) {
      if (pop.hidden) return;
      pop.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (return_focus) trigger.focus();
    }
    trigger.addEventListener("click", () => { if (pop.hidden) open(); else close(true); });
    cancel.addEventListener("click", () => close(true));
    confirm.addEventListener("click", () => {
      HXUI.lab_reset();
      close(true);
      clearTimeout(done_timer);
      trigger.classList.add("is-done");
      trigger.replaceChildren(HXUI.icon("check"), h("span", { class: "hx-btn-label" }, "Lab reset"));
      HXUI.announce("Lab reset. Runs, packages, the archive and the log are empty again.");
      done_timer = setTimeout(() => {
        trigger.classList.remove("is-done");
        trigger.replaceChildren(HXUI.icon("reset"), label);
      }, 2400);
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) { e.preventDefault(); close(true); }
    });
    wrap.addEventListener("focusout", (e) => {
      if (!pop.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false);
    });
    document.addEventListener("pointerdown", (e) => {
      if (!pop.hidden && e.target instanceof Node && !wrap.contains(e.target)) close(false);
    });
    return wrap;
  }

  function top_bar() {
    const h = HXUI.h;
    return h("header", { class: "hx-top" },
      h("div", { class: "hx-brand" },
        h("h1", { class: "hx-brand-name" }, h("span", { class: "hx-brand-mark" }, HXUI.icon("hex")), "HEXIS Runtime Lab"),
        h("p", { class: "hx-purpose" }, "The HEXIS engine, running in your browser. No server.")),
      h("div", { class: "hx-top-actions" }, reset_control(), HXUI.theme_toggle({ id: "hx-theme-toggle" })));
  }

  /* ---------------------------------------------------------------- rail */
  function meter(inventory, label) {
    const h = HXUI.h;
    return h("div", { class: "hx-meter", role: "img", "aria-label": label },
      inventory.map((m) => h("span", { class: "hx-meter-cell", dataset: { status: m.status }, title: "HX." + m.ns[0] + ": " + m.status })));
  }

  function rail_foot() {
    const h = HXUI.h;
    const inv = HXUI.engine_inventory();
    const loaded = inv.filter((m) => m.status === "loaded").length;
    const failed = inv.filter((m) => m.status === "failed").length;
    const version = globalThis.HX && HX.VERSION ? String(HX.VERSION) : "not loaded";
    const summary = loaded + " of " + inv.length + " modules loaded" + (failed ? ", " + failed + " failed" : "");
    return h("div", { class: "hx-rail-foot" },
      h("div", { class: "hx-rail-fact" },
        h("p", { class: "hx-label" }, "Engine"),
        h("p", null, h("code", { class: "hx-rail-version" }, version)),
        meter(inv, summary),
        h("p", { class: "hx-rail-note" }, h("a", { class: "hx-link", href: "#selftest", "data-section-link": "selftest" }, summary))),
      h("div", { class: "hx-rail-fact" },
        h("p", { class: "hx-label" }, "Mode"),
        h("p", { class: "hx-rail-note" }, HXUI.chip("Fixture", "info"), " ERP, documents, registry, identities and models are simulated.")));
  }

  function rail(links) {
    const h = HXUI.h;
    const list = h("ul", { class: "hx-rail-list", role: "list" });
    for (const s of HXUI.sections()) {
      const a = h("a", { class: "hx-rail-link", href: "#" + s.id, dataset: { section: s.id } },
        h("span", { class: "hx-rail-title" }, s.title),
        h("span", { class: "hx-rail-short" }, s.nav),
        s.summary ? h("span", { class: "hx-rail-sum" }, s.summary) : null);
      a.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        HXUI.go(s.id);
      });
      links.set(s.id, a);
      list.appendChild(h("li", null, a));
    }
    const nav = h("nav", { class: "hx-rail", "aria-label": "Sections" }, list, rail_foot());
    nav.addEventListener("click", (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[data-section-link]") : null;
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      HXUI.go(a.getAttribute("data-section-link"), { focus: true });
    });
    /* tab-strip affordance on narrow screens: fade the edge that has more items behind it */
    const sync_edges = () => {
      const max = list.scrollWidth - list.clientWidth;
      list.dataset.scrollStart = list.scrollLeft > 2 ? "more" : "edge";
      list.dataset.scrollEnd = list.scrollLeft < max - 2 ? "more" : "edge";
    };
    list.addEventListener("scroll", sync_edges, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(sync_edges).observe(list);
    return { nav, list, sync_edges };
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    if (!app || app.dataset.boot !== "pending") return;
    if (typeof HXUI.h !== "function" || typeof HXUI.register_section !== "function") {
      throw new Error("The UI core (app/05_ui.js) is missing from this build or failed to load.");
    }
    const h = HXUI.h;
    stub_missing_sections();
    const links = new Map();
    const r = rail(links);
    const main = h("main", { class: "hx-main", id: "hx-main", tabindex: "-1" });
    const skip = h("a", { class: "hx-skip", href: "#hx-main" }, "Skip to the section content");
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      const head = main.querySelector(".hx-section:not([hidden]) .hx-section-title");
      (head || main).focus();
    });
    const live = h("div", { id: "hx-live", class: "hx-visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    app.replaceChildren(skip, top_bar(), h("div", { class: "hx-frame" }, r.nav, main), live);

    HXUI.attach_shell({
      main,
      set_active(id) {
        for (const [sid, a] of links) {
          if (sid === id) a.setAttribute("aria-current", "page");
          else a.removeAttribute("aria-current");
        }
        const a = links.get(id);
        const list = r.list;
        if (a && list.scrollWidth > list.clientWidth + 1) {
          const pad = 24;
          const left = a.offsetLeft;
          const right = left + a.offsetWidth;
          if (left - pad < list.scrollLeft) list.scrollLeft = Math.max(0, left - pad);
          else if (right + pad > list.scrollLeft + list.clientWidth) list.scrollLeft = right + pad - list.clientWidth;
        }
        r.sync_edges();
      },
      on_register(rec) {
        if (links.has(rec.id)) {
          const a = links.get(rec.id);
          a.querySelector(".hx-rail-title").textContent = rec.title;
          a.querySelector(".hx-rail-short").textContent = rec.nav;
        }
      },
    });
    HXUI.route_initial();
    app.dataset.boot = "ready";
    HXUI.bus.emit("shell:ready", { section: HXUI.current() });
  }

  try {
    boot();
  } catch (err) {
    fail(err);
  }
})();
