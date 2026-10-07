/* HEXIS Runtime Lab: HXUI core, shared by every section.
   DOM builder, components (chip, digest, button, field, select, table, tabs, json_view, code, notice),
   polite announcements, event bus, lab state, section registry, router, theme and engine inventory.
   No innerHTML with data anywhere: everything is built from DOM nodes. Storage only in try/catch. */
(function () {
  "use strict";
  globalThis.HXUI = globalThis.HXUI || {};
  const HXUI = globalThis.HXUI;
  const doc = document;
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* ------------------------------------------------------------------ storage (conveniences only) */
  const storage = {
    get(key) {
      try { return globalThis.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) globalThis.localStorage.removeItem(key);
        else globalThis.localStorage.setItem(key, String(value));
      } catch (e) { /* storage blocked or full: the page works the same without it */ }
    },
  };
  HXUI.storage = storage;

  /* ------------------------------------------------------------------ DOM builder */
  function is_attrs(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Node);
  }

  function append_children(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false || c === true) continue;
      if (Array.isArray(c)) { append_children(el, c); continue; }
      if (c instanceof Node) { el.appendChild(c); continue; }
      el.appendChild(doc.createTextNode(String(c)));
    }
  }

  /* Keys and values h() refuses: markup strings, inline handlers and script URLs never reach the DOM. */
  const MARKUP_KEYS = /^(html|innerhtml|outerhtml|srcdoc)$/i;
  const HANDLER_KEY = /^on[a-z]/i;
  const URL_KEYS = /^(href|src|xlink:href|action|formaction|data|poster|background)$/i;
  function is_script_url(v) {
    /* the URL parser ignores ASCII whitespace and control characters, so "java\tscript:" counts too */
    return /^(javascript|vbscript):/i.test(String(v).replace(/[\u0000- \u007f]/g, ""));
  }

  function apply_attrs(el, attrs, svg) {
    let value;
    let has_value = false;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (v === undefined || v === null) continue;
      if (MARKUP_KEYS.test(key)) {
        throw new Error("HXUI.h: the " + key + " attribute is not supported. Build DOM nodes instead.");
      }
      if (key !== "on" && HANDLER_KEY.test(key)) {
        throw new Error("HXUI.h: inline handler attributes such as " + key + " are not allowed. Pass on: {" +
          key.slice(2).toLowerCase() + ": fn} instead.");
      }
      if (URL_KEYS.test(key) && is_script_url(v)) {
        throw new Error("HXUI.h: " + key + " must not be a javascript: or vbscript: URL.");
      }
      switch (key) {
        case "class":
        case "className": {
          const cls = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
          if (cls) el.setAttribute("class", cls);
          break;
        }
        case "text":
          el.textContent = String(v);
          break;
        case "on":
          for (const ev of Object.keys(v)) if (typeof v[ev] === "function") el.addEventListener(ev, v[ev]);
          break;
        case "style":
          if (typeof v !== "object" || Array.isArray(v)) {
            throw new TypeError("HXUI.h: style takes an object of properties, such as {marginTop: \"4px\"}, not a " + typeof v + ".");
          }
          for (const p of Object.keys(v)) {
            const sv = v[p];
            if (sv === null || sv === undefined || sv === false) continue;
            if (p.indexOf("-") >= 0) el.style.setProperty(p, String(sv));
            else el.style[p] = String(sv);
          }
          break;
        case "dataset":
          for (const d of Object.keys(v)) if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]);
          break;
        case "hidden":
          if (svg) { if (v) el.setAttribute("hidden", ""); } else el.hidden = !!v;
          break;
        case "disabled":
          if (svg) break;
          el.disabled = !!v;
          break;
        case "checked":
          el.checked = !!v;
          break;
        case "selected":
          el.selected = !!v;
          break;
        case "value":
          value = v;
          has_value = true;
          break;
        default:
          if (v === false) {
            if (key.startsWith("aria-")) el.setAttribute(key, "false");
            break;
          }
          if (v === true) { el.setAttribute(key, key.startsWith("aria-") ? "true" : ""); break; }
          el.setAttribute(key, String(v));
      }
    }
    return has_value ? { value } : null;
  }

  /** h(tag, attrs?, ...children): build an HTML element. */
  function h(tag, attrs, ...children) {
    const el = doc.createElement(tag);
    if (!is_attrs(attrs)) { children.unshift(attrs); attrs = null; }
    const deferred = attrs ? apply_attrs(el, attrs, false) : null;
    append_children(el, children);
    if (deferred) el.value = deferred.value; /* after <option> children exist */
    return el;
  }

  /** s(tag, attrs?, ...children): build an SVG element (same attrs as h). */
  function s(tag, attrs, ...children) {
    const el = doc.createElementNS(SVG_NS, tag);
    if (!is_attrs(attrs)) { children.unshift(attrs); attrs = null; }
    if (attrs) apply_attrs(el, attrs, true);
    append_children(el, children);
    return el;
  }
  HXUI.h = h;
  HXUI.s = s;

  /* ------------------------------------------------------------------ icons (16px grid, stroked) */
  const ICONS = {
    check: [["path", { d: "M3.5 8.5 6.6 11.5 12.5 4.5" }]],
    cross: [["path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" }]],
    alert: [["path", { d: "M8 2.3 14.3 13.4H1.7Z" }], ["path", { d: "M8 6.4v3.1M8 11.5v.05" }]],
    stop: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["path", { d: "M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" }]],
    info: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["path", { d: "M8 7.3v3.9M8 4.9v.05" }]],
    unavailable: [["circle", { cx: 8, cy: 8, r: 6.2, "stroke-dasharray": "2.4 1.9" }], ["path", { d: "M5.4 8h5.2" }]],
    copy: [["rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.2 }],
      ["path", { d: "M10.5 5.5V3.7c0-.7-.5-1.2-1.2-1.2H3.7c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h1.8" }]],
    sun: [["circle", { cx: 8, cy: 8, r: 2.7 }],
      ["path", { d: "M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" }]],
    moon: [["path", { d: "M13.3 9.7A5.7 5.7 0 0 1 6.3 2.7a5.7 5.7 0 1 0 7 7Z" }]],
    system: [["circle", { cx: 8, cy: 8, r: 5.9 }], ["path", { d: "M8 2.1a5.9 5.9 0 0 1 0 11.8Z", fill: "currentColor", stroke: "none" }]],
    reset: [["path", { d: "M2.9 8.1A5.1 5.1 0 1 0 4.5 4.4" }], ["path", { d: "M4.6 1.9v2.6H2" }]],
    arrow: [["path", { d: "M3 8h9.6M8.8 4.2 12.6 8l-3.8 3.8" }]],
    chevron: [["path", { d: "M6 3.5 10.5 8 6 12.5" }]],
    play: [["path", { d: "M5 3.4 12.4 8 5 12.6Z", fill: "currentColor" }]],
    hex: [["path", { d: "M8 1.4 13.7 4.7v6.6L8 14.6 2.3 11.3V4.7Z" }], ["circle", { cx: 8, cy: 8, r: 1.7, fill: "currentColor", stroke: "none" }]],
    list: [["path", { d: "M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5v.05M2.5 8v.05M2.5 11.5v.05" }]],
  };

  /** icon(name, {label}) -> SVG. Decorative unless a label is given. */
  HXUI.icon = function (name, opts) {
    const o = opts || {};
    const parts = ICONS[name] || ICONS.info;
    const svg = s("svg", {
      class: ["hx-icon", "hx-icon-" + name, o.class], viewBox: "0 0 16 16", width: 16, height: 16,
      fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round",
      focusable: "false", "aria-hidden": o.label ? null : "true", role: o.label ? "img" : null, "aria-label": o.label || null,
    });
    for (const [tag, attrs] of parts) svg.appendChild(s(tag, attrs));
    return svg;
  };

  /* ------------------------------------------------------------------ chips and digests */
  const TONES = ["ok", "warn", "crit", "info", "accent", "neutral"];
  function tone_of(t) { return TONES.indexOf(t) >= 0 ? t : "neutral"; }

  /** chip(text, tone?, {icon, mono, title, class}) -> span */
  HXUI.chip = function (text, tone, opts) {
    const o = opts || {};
    return h("span", { class: ["hx-chip", "hx-tone-" + tone_of(tone), o.mono ? "is-mono" : null, o.class], title: o.title || null },
      o.icon ? HXUI.icon(o.icon) : null, h("span", { class: "hx-chip-text" }, text === null || text === undefined ? "" : text));
  };

  /** plain_lists(text): Python list reprs in an engine message read as plain words in the UI ("['draft']" ->
      "draft", "['a', 'b']" -> "a, b"). The engine text itself stays as Python writes it. */
  HXUI.plain_lists = function (msg) {
    return String(msg === null || msg === undefined ? "" : msg).replace(/\[((?:'[^'\]]*'(?:,\s*)?)+)\]/g,
      (m, inner) => inner.split(/,\s*/).map((x) => x.replace(/^'|'$/g, "")).filter(Boolean).join(", "));
  };

  /** Status chips follow one rule everywhere: an engine status value (WAITING_FOR_APPROVAL, CANDIDATE, ADMITTED,
      NO_CHANGE) reads as words in sentence case ("Waiting for approval", "No change"), with the engine's own value in
      the tooltip and in data-value. Codes and identifiers (NOT_AUTHORIZED, state ids) stay mono. */
  /** wrap_id(text, {tag, class}) -> a mono identifier that may wrap only after "_", ".", "/", "-", "[" or "::" (a
      <wbr> there), never mid-word: test names, paths, claims. */
  HXUI.wrap_id = function (text, opts) {
    const o = opts || {};
    const parts = String(text === null || text === undefined ? "" : text).split(/(?<=::|[_./\-[])/);
    const kids = [];
    parts.forEach((p, i) => { if (i) kids.push(h("wbr")); kids.push(p); });
    return h(o.tag || "code", { class: ["hx-wrap-id", o.class] }, kids);
  };

  /** summary_strip(id, label) -> dl.hx-sumstrip, the bordered strip that opens a section (as Compile, Run and Learn
      do). el.hx.set([{id, label, value, note}]) fills it; each item is dt label, then dd value with its note under. */
  HXUI.summary_strip = function (id, label) {
    const el = h("dl", { class: "hx-sumstrip", id, "aria-label": label || null });
    el.hx = {
      set(items) {
        el.replaceChildren(...(items || []).filter(Boolean).map((it) => h("div", { class: "hx-sum-item", id: it.id || null },
          h("dt", { class: "hx-label" }, it.label),
          h("dd", { class: "hx-sum-value" }, it.value, it.note ? h("span", { class: "hx-sum-note" }, it.note) : null))));
      },
    };
    return el;
  };

  HXUI.status_words = function (value) {
    const s = String(value === null || value === undefined ? "" : value).replace(/_/g, " ").toLowerCase().trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  };
  HXUI.status_chip = function (value, tone, opts) {
    const o = opts || {};
    const c = HXUI.chip(o.text || HXUI.status_words(value), tone, Object.assign({}, o, { title: o.title || "Engine status " + value, mono: false }));
    c.dataset.value = String(value);
    return c;
  };

  function select_contents(el) {
    try {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = globalThis.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection unsupported: the text is still visible */ }
  }

  function selection_covers(el) {
    try {
      const sel = globalThis.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      return el.contains(sel.anchorNode) && el.contains(sel.focusNode);
    } catch (e) { return false; }
  }

  /* what to do instead depends on the input: a touch screen has no keyboard shortcut, it has the long-press menu */
  function copy_blocked() {
    let touch = false;
    try { touch = !!(globalThis.matchMedia && globalThis.matchMedia("(pointer: coarse)").matches); } catch (e) { touch = false; }
    return touch
      ? "Copy is blocked here. Long-press the selected value and choose Copy."
      : "Copy is blocked here. Press Ctrl+C or Cmd+C to copy the selected value.";
  }

  /** copy_button(text, {label, target, id}) -> button that copies text. When the clipboard is blocked (the
      normal case in a sandboxed viewer) it expands and selects `target` and shows a visible one-line note
      after the digest that says what to do; the note goes away after 6 s or once the selection moves. */
  HXUI.copy_button = function (text, opts) {
    const o = opts || {};
    const full = String(text);
    const name = o.label ? "Copy " + o.label : "Copy the full value";
    const btn = h("button", { type: "button", id: o.id || HXUI.uid("hx-copy"), class: "hx-icon-btn hx-copy", "aria-label": name, title: name }, HXUI.icon("copy"));
    let timer = 0;
    let note = null;
    let watch = null;
    function drop_note() {
      if (watch) { doc.removeEventListener("selectionchange", watch); watch = null; }
      if (note) { note.remove(); note = null; btn.removeAttribute("aria-describedby"); }
    }
    function rest() {
      clearTimeout(timer);
      drop_note();
      delete btn.dataset.state;
      btn.replaceChildren(HXUI.icon("copy"));
      btn.setAttribute("aria-label", name);
      btn.title = name;
    }
    function show_note(target) {
      drop_note();
      note = h("span", { class: "hx-copy-note", id: btn.id + "-note" }, HXUI.icon("info"), h("span", null, copy_blocked()));
      const anchor = btn.closest(".hx-digest") || btn;
      anchor.insertAdjacentElement("afterend", note);
      btn.setAttribute("aria-describedby", note.id);
      if (target) {
        watch = () => { if (!selection_covers(target)) rest(); };
        doc.addEventListener("selectionchange", watch);
      }
    }
    function settle(state, target) {
      clearTimeout(timer);
      btn.dataset.state = state;
      btn.replaceChildren(HXUI.icon(state === "copied" ? "check" : "copy"));
      const msg = state === "copied" ? "Copied" : copy_blocked();
      /* blocked: the button keeps its name and the visible note becomes its description (read once) */
      btn.setAttribute("aria-label", state === "copied" ? msg : name);
      btn.title = msg;
      if (state === "selected") show_note(target); else drop_note();
      HXUI.announce(state === "copied" ? "Copied to the clipboard." : msg);
      timer = setTimeout(rest, state === "copied" ? 1600 : 6000);
    }
    function fallback() {
      const target = o.target || null;
      if (target) {
        target.textContent = full;
        target.classList.add("is-expanded");
        select_contents(target);
      }
      settle("selected", target);
    }
    btn.addEventListener("click", () => {
      let p = null;
      try {
        if (globalThis.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          p = navigator.clipboard.writeText(full);
        }
      } catch (e) { p = null; }
      if (!p || typeof p.then !== "function") { fallback(); return; }
      p.then(() => settle("copied"), () => fallback());
    });
    return btn;
  };

  /** digest(text, {short=14, copy=true, label, id}) -> mono, truncated, full value in title, copy button.
      With an id, the digest text gets that id and its copy button gets id + "-copy". */
  HXUI.digest = function (text, opts) {
    const o = Object.assign({ short: 14, copy: true }, opts || {});
    const full = text === null || text === undefined ? "" : String(text);
    if (!full) return h("span", { class: "hx-digest is-empty" }, h("code", { class: "hx-digest-text", id: o.id || null }, "none"));
    const shown = full.length > o.short ? full.slice(0, o.short) + "…" : full;
    const code = h("code", { class: "hx-digest-text", title: full, id: o.id || null }, shown);
    const wrap = h("span", { class: "hx-digest", dataset: { full } }, code);
    if (o.copy) wrap.appendChild(HXUI.copy_button(full, { label: o.label || "full digest", target: code, id: o.id ? o.id + "-copy" : null }));
    return wrap;
  };

  /* ------------------------------------------------------------------ buttons and form controls */
  /** set_disabled(el, disabled, reason): buttons stay focusable (aria-disabled) so the reason is reachable. */
  HXUI.set_disabled = function (el, disabled, reason) {
    if (!el) return el;
    if (el.dataset.hxTitle === undefined) el.dataset.hxTitle = el.getAttribute("title") || "";
    const is_button = el.tagName === "BUTTON" || el.getAttribute("role") === "button";
    if (disabled) {
      if (is_button) el.setAttribute("aria-disabled", "true"); else el.disabled = true;
      if (reason) {
        el.setAttribute("title", reason);
        el.setAttribute("aria-description", reason);
      }
    } else {
      if (is_button) el.removeAttribute("aria-disabled"); else el.disabled = false;
      el.removeAttribute("aria-description");
      if (el.dataset.hxTitle) el.setAttribute("title", el.dataset.hxTitle); else el.removeAttribute("title");
    }
    return el;
  };

  HXUI.is_disabled = function (el) {
    return !!el && (el.getAttribute("aria-disabled") === "true" || el.disabled === true);
  };

  /** button(label, {id, variant, on_click, disabled, disabled_reason, icon, type, size, title, class}) */
  HXUI.button = function (label, opts) {
    const o = opts || {};
    const variant = ["primary", "secondary", "ghost", "danger"].indexOf(o.variant) >= 0 ? o.variant : "secondary";
    const btn = h("button", {
      type: o.type || "button", id: o.id || null, title: o.title || null,
      class: ["hx-btn", "hx-btn--" + variant, o.size === "sm" ? "hx-btn--sm" : null, o.class],
    }, o.icon ? HXUI.icon(o.icon) : null, h("span", { class: "hx-btn-label" }, label));
    btn.addEventListener("click", (e) => {
      if (btn.getAttribute("aria-disabled") === "true") {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (typeof o.on_click === "function") o.on_click(e);
    });
    if (o.disabled) HXUI.set_disabled(btn, true, o.disabled_reason);
    return btn;
  };

  let auto_id = 0;
  HXUI.uid = function (prefix) { auto_id += 1; return (prefix || "hx") + "-" + auto_id; };

  function find_control(control) {
    if (!control || !(control instanceof Element)) return null;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) return control;
    return control.querySelector("input, select, textarea");
  }

  /** field(label, control, {hint, error, id}): label + control + hint/error wired with aria-describedby. */
  HXUI.field = function (label, control, opts) {
    const o = opts || {};
    const input = find_control(control);
    const id = (input && input.id) || o.id || HXUI.uid("hx-field");
    if (input && !input.id) input.id = id;
    const hint = h("p", { class: "hx-field-hint", id: id + "-hint", hidden: !o.hint }, o.hint || "");
    const error_text = h("span", null, o.error || "");
    const error = h("p", { class: "hx-field-error", id: id + "-error", hidden: !o.error }, HXUI.icon("alert"), error_text);
    const wrap = h("div", { class: "hx-field" }, h("label", { class: "hx-field-label", for: id }, label), control, hint, error);
    function sync() {
      const ids = [];
      if (!hint.hidden) ids.push(hint.id);
      if (!error.hidden) ids.push(error.id);
      if (input) {
        if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
        else input.removeAttribute("aria-describedby");
        if (!error.hidden) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
      wrap.classList.toggle("has-error", !error.hidden);
    }
    wrap.hx = {
      control: input,
      set_error(msg) { error_text.textContent = msg || ""; error.hidden = !msg; sync(); },
      set_hint(msg) { hint.textContent = msg || ""; hint.hidden = !msg; sync(); },
    };
    sync();
    return wrap;
  };

  /** select(id, [{value, label, disabled}], {value, on_change(value, event)}) -> <select> */
  HXUI.select = function (id, options, opts) {
    const o = opts || {};
    const sel = h("select", { id, class: "hx-select" }, (options || []).map((op) =>
      h("option", { value: String(op.value), disabled: !!op.disabled }, op.label === undefined || op.label === null ? String(op.value) : op.label)));
    if (o.value !== undefined && o.value !== null) sel.value = String(o.value);
    if (typeof o.on_change === "function") sel.addEventListener("change", (e) => o.on_change(sel.value, e));
    return sel;
  };

  /* ------------------------------------------------------------------ scroll containers */
  /* A wrapper that scrolls sideways becomes a focusable, labelled region only while it overflows. Table
     scrollers also fold their foldable columns into the first column when the table does not fit, and fade
     the side that has more content behind it (the fade is a mask on the table, so the scroller's own focus
     ring is never faded). */
  let overflow_observer = null;
  function sync_fold(el) {
    const wrap = el.parentElement;
    if (!wrap || !wrap.classList.contains("has-fold")) return;
    if (!wrap.classList.contains("is-folded")) {
      if (el.scrollWidth > el.clientWidth + 1) {
        wrap.dataset.hxNatural = String(el.scrollWidth);
        wrap.classList.add("is-folded");
      }
    } else if (el.clientWidth >= Number(wrap.dataset.hxNatural || Infinity)) {
      wrap.classList.remove("is-folded");
      if (el.scrollWidth > el.clientWidth + 1) wrap.classList.add("is-folded");
    }
  }
  function sync_fade(el) {
    const max = el.scrollWidth - el.clientWidth;
    const over = max > 1;
    const start = over && el.scrollLeft > 2;
    const end = over && el.scrollLeft < max - 2;
    el.dataset.scrollStart = start ? "more" : "edge";
    el.dataset.scrollEnd = end ? "more" : "edge";
    el.style.setProperty("--hx-sl", Math.round(el.scrollLeft) + "px");
    el.style.setProperty("--hx-cw", el.clientWidth + "px");
    el.style.setProperty("--hx-fl", start ? "2.5rem" : "0px");
    el.style.setProperty("--hx-fr", end ? "2.5rem" : "0px");
  }
  function sync_overflow(el) {
    sync_fold(el);
    const over = el.scrollWidth > el.clientWidth + 1;
    if (over) {
      if (el.getAttribute("tabindex") !== "0") el.setAttribute("tabindex", "0");
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", el.dataset.hxLabel || "Scrollable content");
      el.classList.add("is-overflowing");
    } else if (el.classList.contains("is-overflowing")) {
      el.removeAttribute("tabindex");
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
      el.classList.remove("is-overflowing");
    }
    if (el.dataset.hxFade === "1") sync_fade(el);
  }
  /* observed element -> the scroller it measures (a table observes a zero-height sizer, so folding the table,
     which changes its height, never re-triggers the observer inside its own callback) */
  const observed = new WeakMap();

  /** The one ResizeObserver for scrollers and tab bars; null where ResizeObserver does not exist. */
  function ensure_observer() {
    if (typeof ResizeObserver !== "function") return null;
    if (!overflow_observer) {
      overflow_observer = new ResizeObserver((entries) => {
        for (const en of entries) {
          /* a removed element reports a last resize: stop observing it, or the observer keeps its whole
             detached tree (a section's old render) alive; sweep_overflow catches the ones removed while hidden */
          if (!en.target.isConnected) { forget(en.target); continue; }
          const bar = tab_bars.get(en.target);
          if (bar) { bar(); continue; }
          const target = observed.get(en.target);
          if (target) sync_overflow(target);
        }
      });
    }
    return overflow_observer;
  }

  /** watch_overflow(el, label, {fade, sizer}) -> el, a labelled, focusable region while it scrolls sideways */
  HXUI.watch_overflow = function (el, label, opts) {
    const o = opts || {};
    el.dataset.hxLabel = label || "";
    if (o.fade) {
      el.dataset.hxFade = "1";
      el.addEventListener("scroll", () => sync_fade(el), { passive: true });
    }
    if (!ensure_observer()) return el;
    const probe = o.sizer || el;
    observed.set(probe, el);
    watched.add(probe);
    overflow_observer.observe(probe);
    return el;
  };
  /* every probe observed now, so a sweep can release the ones whose element left the page */
  const watched = new Set();
  const tab_bars = new WeakMap(); /* tablist -> its reveal function (HXUI.tabs) */
  function forget(probe) {
    if (overflow_observer) overflow_observer.unobserve(probe);
    watched.delete(probe);
    observed.delete(probe);
    tab_bars.delete(probe);
  }
  /** sweep_overflow(): stop observing scrollers that are no longer in the document (run on lab:reset and when a
      section is shown, after sections have re-rendered). */
  HXUI.sweep_overflow = function () {
    for (const p of Array.from(watched)) if (!p.isConnected) forget(p);
    return watched.size;
  };

  /* ------------------------------------------------------------------ table */
  function cell_value(col, row, i) {
    const v = typeof col.render === "function" ? col.render(row, i) : row ? row[col.key] : "";
    return v === null || v === undefined ? "" : v;
  }

  /* A copy of a rendered cell for the folded line: same text and styling, no ids, no listeners. */
  function fold_copy(v) {
    if (Array.isArray(v)) return v.map(fold_copy);
    if (!(v instanceof Node)) return v;
    const c = v.cloneNode(true);
    if (c instanceof Element) {
      c.removeAttribute("id");
      for (const x of c.querySelectorAll("[id]")) x.removeAttribute("id");
    }
    return c;
  }

  function fold_line(cols, row, i) {
    const parts = [];
    for (const c of cols) {
      const v = typeof c.fold === "function" ? c.fold(row, i) : fold_copy(cell_value(c, row, i));
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      /* a no-break space before the dot: a wrapped line never starts with the separator */
      if (parts.length) parts.push(h("span", { class: "hx-fold-sep", "aria-hidden": "true" }, " · "));
      parts.push(h("span", { class: ["hx-fold-item", c.mono ? "is-mono" : null] },
        c.fold_label ? h("span", { class: "hx-fold-label" }, c.fold_label + " ") : null, v));
    }
    return parts.length ? h("span", { class: "hx-fold" }, parts) : null;
  }

  /** table({columns:[{key, label, align, mono, nowrap, render(row), fold, fold_label}], rows, caption,
             caption_hidden, empty, row_attrs(row,i), class})
      fold: true (or a function (row, i) -> content) marks a column that, while the table is too wide for its
      container, is hidden and shown as a second line in the first column instead. The table scrolls sideways
      inside its own wrapper when it still does not fit, with a fade on the side that has more. */
  HXUI.table = function (spec) {
    const cols = spec.columns || [];
    const rows = spec.rows || [];
    const folded = cols.filter((c, i) => i > 0 && c.fold);
    const cls = (c) => ["hx-al-" + (c.align || "left"), c.mono ? "is-mono" : null, c.nowrap ? "is-nowrap" : null, c.fold ? "hx-col-fold" : null, c.class || null];
    const head = h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: cls(c) }, c.label === undefined ? c.key : c.label))));
    const body = h("tbody", null, rows.length
      ? rows.map((row, i) => h("tr", typeof spec.row_attrs === "function" ? spec.row_attrs(row, i) : null,
        cols.map((c, ci) => h("td", { class: cls(c) }, cell_value(c, row, i), ci === 0 && folded.length ? fold_line(folded, row, i) : null))))
      : h("tr", { class: "hx-table-empty" }, h("td", { colspan: Math.max(1, cols.length) }, spec.empty || "Nothing to show yet.")));
    const caption = spec.caption ? h("caption", { class: spec.caption_hidden ? "hx-visually-hidden" : null }, spec.caption) : null;
    const table = h("table", { class: ["hx-table", spec.class] }, caption, head, body);
    const scroller = h("div", { class: "hx-table-scroll" }, table);
    const sizer = h("div", { class: "hx-table-sizer", "aria-hidden": "true" });
    const wrap = h("div", { class: ["hx-table-wrap", folded.length ? "has-fold" : null] }, sizer, scroller);
    HXUI.watch_overflow(scroller, typeof spec.caption === "string" ? spec.caption : "Table", { fade: true, sizer });
    return wrap;
  };

  /* ------------------------------------------------------------------ tabs */
  /** tabs(id, [{id, label, render() -> Element}], {selected, on_change(tab_id), label, orientation}) -> Element
      Horizontal by default: ArrowLeft / ArrowRight / Home / End move between tabs, and ArrowUp / ArrowDown keep
      scrolling the page. orientation: "vertical" uses ArrowUp / ArrowDown instead.
      The returned element carries el.hx = {select(id), refresh(), selected(), tab(id), panel(id)}. */
  HXUI.tabs = function (id, items, opts) {
    const o = opts || {};
    const list = items || [];
    const tabs = {};
    const panels = {};
    let selected = null;
    const vertical = o.orientation === "vertical";
    const prev_key = vertical ? "ArrowUp" : "ArrowLeft";
    const next_key = vertical ? "ArrowDown" : "ArrowRight";
    const tablist = h("div", {
      role: "tablist", class: ["hx-tablist", vertical ? "is-vertical" : null], "aria-label": o.label || null,
      "aria-orientation": vertical ? "vertical" : "horizontal",
    });
    for (const it of list) {
      const tab = h("button", {
        type: "button", role: "tab", id: id + "-tab-" + it.id, class: "hx-tab", "aria-selected": "false",
        "aria-controls": id + "-panel-" + it.id, tabindex: "-1", dataset: { tab: it.id },
      }, it.label);
      tab.addEventListener("click", () => select(it.id, true));
      tabs[it.id] = tab;
      tablist.appendChild(tab);
      panels[it.id] = h("div", { role: "tabpanel", id: id + "-panel-" + it.id, class: "hx-tabpanel", "aria-labelledby": tab.id, tabindex: "0", hidden: true });
    }
    tablist.addEventListener("keydown", (e) => {
      const ids = list.map((t) => t.id);
      const at = ids.indexOf(selected);
      let next = null;
      if (e.key === next_key) next = ids[(at + 1) % ids.length];
      else if (e.key === prev_key) next = ids[(at - 1 + ids.length) % ids.length];
      else if (e.key === "Home") next = ids[0];
      else if (e.key === "End") next = ids[ids.length - 1];
      if (next === null || next === undefined) return;
      e.preventDefault();
      select(next, true);
      tabs[next].focus();
    });
    function render(tid) {
      const it = list.find((x) => x.id === tid);
      const panel = panels[tid];
      if (!it || !panel) return;
      panel.replaceChildren();
      try {
        const out = typeof it.render === "function" ? it.render() : null;
        append_children(panel, [out]);
      } catch (err) {
        panel.appendChild(HXUI.notice("crit", "This tab could not be shown", String((err && err.message) || err)));
      }
    }
    function select(tid, user) {
      if (!tabs[tid]) return;
      const changed = tid !== selected;
      selected = tid;
      for (const k of Object.keys(tabs)) {
        const on = k === tid;
        tabs[k].setAttribute("aria-selected", on ? "true" : "false");
        tabs[k].tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
      }
      render(tid);
      if (tablist.isConnected) reveal_selected();
      if (user && changed && typeof o.on_change === "function") o.on_change(tid);
    }
    /* a bar wider than its box fades the edge with more tabs behind it, and keeps the selected tab in view */
    function sync_edges() {
      const max = tablist.scrollWidth - tablist.clientWidth;
      tablist.dataset.scrollStart = max > 1 && tablist.scrollLeft > 2 ? "more" : "edge";
      tablist.dataset.scrollEnd = max > 1 && tablist.scrollLeft < max - 2 ? "more" : "edge";
    }
    function reveal_selected() {
      const tab = selected !== null ? tabs[selected] : null;
      if (tab && tablist.scrollWidth > tablist.clientWidth + 1) {
        const pad = 40;
        const left = tab.offsetLeft - tablist.offsetLeft, right = left + tab.offsetWidth;
        if (left - pad < tablist.scrollLeft) tablist.scrollLeft = Math.max(0, left - pad);
        else if (right + pad > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right + pad - tablist.clientWidth;
      }
      sync_edges();
    }
    tablist.addEventListener("scroll", sync_edges, { passive: true });
    /* one shared observer for every tab bar (released by sweep_overflow with the rest) */
    if (ensure_observer()) {
      tab_bars.set(tablist, reveal_selected);
      watched.add(tablist);
      overflow_observer.observe(tablist);
    }
    const root = h("div", { class: "hx-tabs", id }, tablist, list.map((t) => panels[t.id]));
    const first = o.selected && tabs[o.selected] ? o.selected : list.length ? list[0].id : null;
    if (first !== null) select(first, false);
    root.hx = {
      select: (tid) => select(tid, false),
      refresh: () => { if (selected !== null) render(selected); },
      selected: () => selected,
      tab: (tid) => tabs[tid] || null,
      panel: (tid) => panels[tid] || null,
    };
    return root;
  };

  /* ------------------------------------------------------------------ JSON view and code */
  function json_leaf(v) {
    if (v === null) return h("span", { class: "hx-json-null" }, "null");
    if (typeof v === "string") return h("span", { class: "hx-json-str" }, JSON.stringify(v));
    if (typeof v === "number") return h("span", { class: "hx-json-num" }, String(v));
    if (typeof v === "boolean") return h("span", { class: "hx-json-bool" }, String(v));
    if (v === undefined) return h("span", { class: "hx-json-null" }, "undefined");
    return h("span", { class: "hx-json-str" }, String(v));
  }

  function json_node(key, v, depth, o) {
    const key_el = key === null ? null
      : [h("span", { class: typeof key === "number" ? "hx-json-idx" : "hx-json-key" }, typeof key === "number" ? String(key) : JSON.stringify(key)),
        h("span", { class: "hx-json-punct" }, ": ")];
    if (v !== null && typeof v === "object") {
      const arr = Array.isArray(v);
      const keys = arr ? null : Object.keys(v);
      const n = arr ? v.length : keys.length;
      if (n === 0) return h("div", { class: "hx-json-row" }, key_el, h("span", { class: "hx-json-punct" }, arr ? "[]" : "{}"));
      const count = arr ? n + (n === 1 ? " item" : " items") : n + (n === 1 ? " key" : " keys");
      const summary = h("summary", { class: "hx-json-row" }, key_el,
        h("span", { class: "hx-json-punct" }, arr ? "[" : "{"), h("span", { class: "hx-json-count" }, count), h("span", { class: "hx-json-punct" }, arr ? "]" : "}"));
      const body = h("div", { class: "hx-json-body" });
      const limit = Math.min(n, o.max_items);
      for (let i = 0; i < limit; i++) body.appendChild(arr ? json_node(i, v[i], depth + 1, o) : json_node(keys[i], v[keys[i]], depth + 1, o));
      if (n > limit) body.appendChild(h("div", { class: "hx-json-more" }, (n - limit) + " more not shown"));
      return h("details", { class: "hx-json-node", open: depth < o.open_depth }, summary, body);
    }
    return h("div", { class: "hx-json-row" }, key_el, json_leaf(v));
  }

  /** json_view(value, {open_depth=1, max_items=200, label}) -> collapsible tree, keys in given order */
  HXUI.json_view = function (value, opts) {
    const o = Object.assign({ open_depth: 1, max_items: 200 }, opts || {});
    const root = h("div", { class: "hx-json" }, json_node(null, value, 0, o));
    HXUI.watch_overflow(root, o.label || "JSON");
    return root;
  };

  /** code(text, {label}) -> mono block that scrolls sideways inside itself */
  HXUI.code = function (text, opts) {
    const pre = h("pre", { class: "hx-code" }, h("code", null, text === null || text === undefined ? "" : String(text)));
    HXUI.watch_overflow(pre, (opts && opts.label) || "Code");
    return pre;
  };

  /* ------------------------------------------------------------------ notices */
  const NOTICE_ICONS = { ok: "check", warn: "alert", crit: "stop", info: "info", accent: "info", neutral: "info" };

  /** notice(tone, title, body?) -> inline message block (not a toast) */
  HXUI.notice = function (tone, title, body) {
    const t = tone_of(tone);
    const has_body = body !== undefined && body !== null && body !== false && body !== "";
    return h("div", { class: ["hx-notice", "hx-tone-" + t] },
      h("span", { class: "hx-notice-icon" }, HXUI.icon(NOTICE_ICONS[t])),
      h("div", { class: "hx-notice-main" },
        h("p", { class: "hx-notice-title" }, title),
        has_body ? h("div", { class: "hx-notice-body" }, typeof body === "string" ? h("p", null, body) : body) : null));
  };

  /* ------------------------------------------------------------------ announcements */
  let live_timer = 0;
  function live_region() {
    let el = doc.getElementById("hx-live");
    if (!el) {
      el = h("div", { id: "hx-live", class: "hx-visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
      (doc.getElementById("app") || doc.body).appendChild(el);
    }
    return el;
  }
  HXUI.live_region = live_region;

  /** announce(text): polite aria-live announcement (repeats are announced again). */
  HXUI.announce = function (text) {
    const el = live_region();
    el.textContent = "";
    clearTimeout(live_timer);
    live_timer = setTimeout(() => { el.textContent = String(text); }, 40);
  };

  /* ------------------------------------------------------------------ event bus */
  const listeners = new Map();
  HXUI.bus = {
    on(event, fn) {
      if (typeof fn !== "function") return fn;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return fn;
    },
    off(event, fn) {
      const set = listeners.get(event);
      if (set) set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (err) {
          /* one broken listener must not stop the others; surface it as an uncaught error */
          if (typeof globalThis.reportError === "function") globalThis.reportError(err);
          else setTimeout(() => { throw err; }, 0);
        }
      }
    },
  };

  /* ------------------------------------------------------------------ lab state */
  function fresh_lab() {
    return { env: null, packages: { initial: null, refined: null }, compile: null, runs: [], selected_run: null, archive: [], log: [] };
  }
  if (!HXUI.lab) HXUI.lab = fresh_lab();

  /** lab_reset(): rebuild HXUI.lab in place (same object) and emit lab:reset. */
  HXUI.lab_reset = function () {
    const lab = HXUI.lab;
    for (const k of Object.keys(lab)) delete lab[k];
    Object.assign(lab, fresh_lab());
    HXUI.bus.emit("lab:reset", {});
    /* the sections re-rendered: release the scrollers of their old trees */
    if (typeof HXUI.sweep_overflow === "function") HXUI.sweep_overflow();
    return lab;
  };

  /** lab_changed(what): tell other sections that HXUI.lab.<what> changed. */
  HXUI.lab_changed = function (what) {
    HXUI.bus.emit("lab:changed", { what });
  };

  /* ------------------------------------------------------------------ engine inventory */
  /* Every engine module of browser/README.md, keyed by its file prefix. */
  const ENGINE_MODULES = [
    { prefix: "00", ns: ["util", "HXError"], ref: "", label: "core" },
    { prefix: "05", ns: ["data"], ref: "examples/", label: "data" },
    { prefix: "10", ns: ["canonical"], ref: "canonical.py", label: "canonical" },
    { prefix: "15", ns: ["jsonschema"], ref: "jsonschema (tools/catalog.py)", label: "jsonschema" },
    { prefix: "20", ns: ["guards"], ref: "guards.py", label: "guards" },
    { prefix: "25", ns: ["efsm"], ref: "artifacts/efsm.py", label: "efsm" },
    { prefix: "26", ns: ["pkg", "catalog"], ref: "artifacts/package.py, tools/catalog.py", label: "pkg" },
    { prefix: "28", ns: ["clauses"], ref: "compiler/clauses.py", label: "clauses" },
    { prefix: "30", ns: ["validate"], ref: "artifacts/validate.py", label: "validate" },
    { prefix: "32", ns: ["diff"], ref: "artifacts/diff.py", label: "diff" },
    { prefix: "34", ns: ["fixture"], ref: "demo/procurement_fixture.py", label: "fixture" },
    { prefix: "36", ns: ["compile"], ref: "compiler/compile.py", label: "compile" },
    { prefix: "40", ns: ["kernel"], ref: "runtime/kernel.py", label: "kernel" },
    { prefix: "45", ns: ["store"], ref: "storage/sqlite.py", label: "store" },
    { prefix: "47", ns: ["policy"], ref: "tools/policy.py", label: "policy" },
    { prefix: "48", ns: ["approvals", "evidence"], ref: "approvals/scope.py, evidence/receipts.py", label: "approvals" },
    { prefix: "50", ns: ["broker"], ref: "tools/broker.py", label: "broker" },
    { prefix: "55", ns: ["fakes"], ref: "demo/fakes.py, tools/errors.py", label: "fakes" },
    { prefix: "58", ns: ["service"], ref: "runtime/service.py", label: "service" },
    { prefix: "59", ns: ["metrics"], ref: "metrics.py", label: "metrics" },
    { prefix: "60", ns: ["traces"], ref: "traces/model.py", label: "traces" },
    { prefix: "62", ns: ["normalize"], ref: "traces/normalize.py", label: "normalize" },
    { prefix: "64", ns: ["replay"], ref: "replay/replay.py", label: "replay" },
    { prefix: "66", ns: ["update"], ref: "traces/update.py", label: "update" },
    { prefix: "68", ns: ["registry"], ref: "artifacts/registry.py", label: "registry" },
    { prefix: "70", ns: ["reference"], ref: "demo/reference.py", label: "reference" },
    { prefix: "75", ns: ["env"], ref: "demo/env.py", label: "env" },
    { prefix: "80", ns: ["demo"], ref: "demo/procurement_demo.py", label: "demo" },
    { prefix: "90", ns: ["eval"], ref: "evals/run_eval.py", label: "eval" },
  ];
  HXUI.ENGINE_MODULES = ENGINE_MODULES;

  function hx() { return globalThis.HX || {}; }
  function has_ns(name) { const v = hx()[name]; return v !== undefined && v !== null; }

  function build_scripts(folder) {
    const out = new Map();
    for (const el of doc.querySelectorAll("script[data-hx-module]")) {
      const path = el.getAttribute("data-hx-module") || "";
      if (path.indexOf(folder + "/") !== 0) continue;
      const file = path.slice(folder.length + 1);
      out.set(file.slice(0, 2), path);
    }
    return out;
  }

  /** engine_inventory() -> [{prefix, label, ns, ref, file, in_build, present, status}], status loaded|failed|absent */
  HXUI.engine_inventory = function () {
    const scripts = build_scripts("src");
    return ENGINE_MODULES.map((m) => {
      const present = m.ns.every(has_ns);
      const file = scripts.get(m.prefix) || null;
      return {
        prefix: m.prefix, label: m.label, ns: m.ns.slice(), ref: m.ref, file, in_build: !!file, present,
        status: present ? "loaded" : file ? "failed" : "absent",
      };
    });
  };

  /** Namespaces on HX that the inventory does not list (for example HX.errors). */
  HXUI.engine_extras = function () {
    const known = new Set(["VERSION"]);
    for (const m of ENGINE_MODULES) for (const n of m.ns) known.add(n);
    return Object.keys(hx()).filter((k) => !known.has(k)).sort();
  };

  function strip_hx(name) { return String(name).replace(/^HX\./, ""); }

  /** engine_missing(names) -> ["HX.compile", ...] for every listed namespace absent from this page. */
  HXUI.engine_missing = function (names) {
    return (names || []).map(strip_hx).filter((n) => !has_ns(n)).map((n) => "HX." + n);
  };

  /** namespace_status("HX.compile" | "HXUI.graph") -> "loaded" | "failed" | "absent" */
  HXUI.namespace_status = function (name) {
    const full = String(name);
    if (full.indexOf("HXUI.") === 0) {
      const key = full.slice(5);
      if (HXUI[key] !== undefined && HXUI[key] !== null) return "loaded";
      const app_prefix = { graph: "35", tour: "65" }[key];
      return app_prefix && build_scripts("app").has(app_prefix) ? "failed" : "absent";
    }
    const n = strip_hx(full);
    if (has_ns(n)) return "loaded";
    const mod = ENGINE_MODULES.find((m) => m.ns.indexOf(n) >= 0);
    return mod && build_scripts("src").has(mod.prefix) ? "failed" : "absent";
  };

  /** unavailable(missing_names, {title, lead, hint, compact}) -> the designed "not in this build" state */
  HXUI.unavailable = function (missing, opts) {
    const o = opts || {};
    const names = (missing || []).map(String);
    const failed = names.filter((n) => HXUI.namespace_status(n) === "failed");
    const absent = names.filter((n) => failed.indexOf(n) < 0);
    const chips = (list, tone) => h("ul", { class: "hx-ns-list", role: "list" },
      list.map((n) => h("li", null, HXUI.chip(n, tone, { mono: true }))));
    const parts = [];
    if (absent.length) {
      parts.push(h("p", null, o.lead || "This part needs engine modules that are not in this build:"), chips(absent, "neutral"));
    }
    if (failed.length) {
      parts.push(h("p", null, failed.length === 1 ? "This module is in the build but failed to load:" : "These modules are in the build but failed to load:"),
        chips(failed, "crit"));
    }
    const hint = o.hint === false ? null
      : h("p", { class: "hx-unavailable-hint" }, o.hint || ["Self-test lists every engine module in this build. ",
        h("a", { class: "hx-link", href: "#selftest" }, "Open Self-test")]);
    return h("div", { class: ["hx-unavailable", o.compact ? "is-compact" : null], dataset: { missing: names.join(" ") } },
      h("span", { class: "hx-unavailable-icon" }, HXUI.icon("unavailable")),
      h("div", { class: "hx-unavailable-main" },
        h("p", { class: "hx-unavailable-title" }, o.title || (failed.length && !absent.length ? "Failed to load in this build" : "Not in this build")),
        parts, hint));
  };

  /** about_list(items, {title, level=3}) -> "What you can do here" list. level is the heading level of its
      label (2 to 6): 3 under a section title, 4 inside a panel whose title is an h3. */
  HXUI.about_list = function (items, opts) {
    const o = opts || {};
    const title_id = HXUI.uid("hx-about");
    const level = Math.min(6, Math.max(2, Math.round(Number(o.level) || 3)));
    return h("div", { class: "hx-about" },
      h("h" + level, { class: "hx-label", id: title_id }, o.title || "What you can do here"),
      h("ul", { class: "hx-about-list", "aria-labelledby": title_id }, (items || []).map((t) => h("li", null, HXUI.rich(t)))));
  };

  function rich_part(p) {
    if (Array.isArray(p)) return p.map(rich_part);
    if (p && typeof p === "object" && !(p instanceof Node)) {
      if (typeof p.code === "string") return h("code", { class: "hx-inline" }, p.code);
      if (typeof p.strong === "string") return h("strong", null, p.strong);
      return String(p);
    }
    return p;
  }

  /** rich(parts) -> children for h(): strings stay text, {code: "x"} becomes an inline mono identifier and
      {strong: "x"} bold text. Section copy can then keep ids such as user:dana or SKILL.md in mono while staying
      plain data at load time. */
  HXUI.rich = function (parts) {
    return Array.isArray(parts) ? parts.map(rich_part) : [rich_part(parts)];
  };

  /* ------------------------------------------------------------------ sections and router */
  const SECTION_ORDER = ["overview", "compile", "run", "learn", "break", "selftest"];
  const DEFAULT_TITLES = { overview: "Overview", compile: "Compile", run: "Run workbench", learn: "Learn from traces", break: "Break it", selftest: "Self-test" };
  /* A few words under each title in the wide rail. The section header shows the full summary. */
  const DEFAULT_BLURBS = {
    overview: "Parity check and demo", compile: "Skill to state machine", run: "Approvals, faults, recovery",
    learn: "Gated machine updates", break: "Mutations and guards", selftest: "Checks run in this page",
  };
  HXUI.SECTION_ORDER = SECTION_ORDER.slice();
  HXUI.DEFAULT_TITLES = Object.assign({}, DEFAULT_TITLES);
  HXUI.DEFAULT_BLURBS = Object.assign({}, DEFAULT_BLURBS);

  const registry = new Map();
  let registered = 0;
  let shell = null;
  let current = null;

  /** register_section({id, title, summary, nav, blurb, needs, about, mount(el), on_show()})
      summary: one sentence under the section title. nav: the short tab label on phones. blurb: a few words
      under the title in the wide rail (defaults per section id; "" for none). */
  HXUI.register_section = function (spec) {
    if (!spec || typeof spec.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(spec.id)) {
      throw new Error("register_section: id must be a bare lowercase token such as \"compile\"");
    }
    const old = registry.get(spec.id);
    if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    registered += 1;
    const rec = {
      id: spec.id,
      title: spec.title || DEFAULT_TITLES[spec.id] || spec.id,
      summary: spec.summary || "",
      blurb: typeof spec.blurb === "string" ? spec.blurb : DEFAULT_BLURBS[spec.id] || "",
      nav: spec.nav || spec.title || DEFAULT_TITLES[spec.id] || spec.id,
      needs: Array.isArray(spec.needs) ? spec.needs.slice() : [],
      about: Array.isArray(spec.about) ? spec.about.slice() : [],
      mount: spec.mount,
      on_show: spec.on_show,
      seq: old ? old.seq : registered,
      el: null,
      body: null,
      state: "idle",
    };
    registry.set(spec.id, rec);
    if (shell && typeof shell.on_register === "function") shell.on_register(rec);
    if (shell && current === spec.id) { current = null; show(spec.id, {}); }
    return rec.id;
  };

  function ordered() {
    const rank = (r) => { const i = SECTION_ORDER.indexOf(r.id); return i >= 0 ? i : SECTION_ORDER.length + r.seq; };
    return Array.from(registry.values()).sort((a, b) => rank(a) - rank(b));
  }

  /** sections() -> [{id, title, summary, blurb, nav, needs, state}] in navigation order */
  HXUI.sections = function () {
    return ordered().map((r) => ({ id: r.id, title: r.title, summary: r.summary, blurb: r.blurb, nav: r.nav, needs: r.needs.slice(), state: r.state }));
  };
  HXUI.has_section = function (id) { return registry.has(id); };
  HXUI.current = function () { return current; };

  function set_state(rec, state) {
    rec.state = state;
    if (rec.el) rec.el.dataset.state = state;
  }

  function section_error(err) {
    const msg = String((err && err.message) || err || "Unknown error");
    return HXUI.notice("crit", "This section failed to start", h("div", { class: "hx-stack-tight" },
      h("p", null, "The page itself still works. Reload the page to try again, and use Self-test to see which engine modules loaded."),
      HXUI.code(msg, { label: "Error message" })));
  }

  function mount(rec) {
    if (rec.el) return;
    const title_id = "sec-" + rec.id + "-title";
    const body = h("div", { class: "hx-section-body" });
    const el = h("section", { class: "hx-section", id: "sec-" + rec.id, "aria-labelledby": title_id, dataset: { section: rec.id, state: "idle" }, hidden: true },
      h("header", { class: "hx-section-head" },
        h("h2", { class: "hx-section-title", id: title_id, tabindex: "-1" }, rec.title),
        rec.summary ? h("p", { class: "hx-section-summary" }, rec.summary) : null),
      body);
    rec.el = el;
    rec.body = body;
    shell.main.appendChild(el);
    const missing = HXUI.engine_missing(rec.needs);
    if (missing.length) {
      body.appendChild(h("div", { class: "hx-placeholder" },
        HXUI.unavailable(missing),
        rec.about.length ? HXUI.about_list(rec.about) : null));
      set_state(rec, "unavailable");
      return;
    }
    try {
      if (typeof rec.mount === "function") rec.mount(body);
      set_state(rec, "ready");
    } catch (err) {
      body.replaceChildren(section_error(err));
      set_state(rec, "error");
    }
  }

  function focus_heading(rec) {
    const head = rec.el && rec.el.querySelector(".hx-section-title");
    if (head) {
      try { head.focus({ preventScroll: true }); } catch (e) { head.focus(); }
    }
  }

  function show(id, opts) {
    const o = opts || {};
    const rec = registry.get(id);
    if (!rec || !shell) return false;
    const prev = current ? registry.get(current) : null;
    const active = doc.activeElement;
    const focus_was_inside = !!(prev && prev.el && active && prev.el.contains(active));
    current = id;
    mount(rec);
    for (const r of registry.values()) if (r.el) r.el.hidden = r.id !== id;
    if (typeof shell.set_active === "function") shell.set_active(id);
    if (prev && prev.id !== id) {
      if (!o.keep_scroll) {
        try { globalThis.scrollTo(0, 0); } catch (e) { /* ignore */ }
      }
      if (o.focus || focus_was_inside) focus_heading(rec);
      else HXUI.announce(rec.title); /* focus stays on the rail link, so say where we are */
    }
    if (rec.state === "ready" && typeof rec.on_show === "function") {
      try { rec.on_show(); } catch (err) { rec.body.replaceChildren(section_error(err)); set_state(rec, "error"); }
    }
    HXUI.bus.emit("section:shown", { id, previous: prev ? prev.id : null });
    if (typeof HXUI.sweep_overflow === "function") HXUI.sweep_overflow();
    return true;
  }

  function hash_id() {
    const raw = (globalThis.location && location.hash ? location.hash : "").replace(/^#/, "");
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  /* The URL always names the section on screen: a hash that names no section is replaced (no new history
     entry) by the current one. */
  function correct_hash() {
    if (!current || hash_id() === current) return;
    try { history.replaceState(history.state, "", "#" + current); } catch (e) { /* sandboxed: the view is still right */ }
  }

  /** go(section_id, {focus}) -> true if routed. Updates location.hash with the bare token. */
  HXUI.go = function (section_id, opts) {
    const id = String(section_id || "").replace(/^#/, "");
    if (!registry.has(id)) return false;
    if (hash_id() !== id) {
      try { location.hash = id; } catch (e) { /* sandboxed: routing still works without the hash */ }
    }
    if (current === id) return true;
    return show(id, opts || {});
  };

  /** Called once by app/90_boot.js with the shell: {main, set_active(id), on_register(rec)}. */
  HXUI.attach_shell = function (s) {
    shell = s;
    globalThis.addEventListener("hashchange", () => {
      const id = hash_id();
      if (!registry.has(id)) correct_hash();
      else if (id !== current) show(id, {});
    });
    /* in-page links to a section (href="#compile") route without leaving focus on a hidden element */
    shell.main.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href^='#']") : null;
      if (!a) return;
      const id = a.getAttribute("href").slice(1);
      if (!registry.has(id)) return;
      e.preventDefault();
      HXUI.go(id, { focus: true });
    });
  };

  /** route_initial(): show the section named by location.hash, or the Overview. */
  HXUI.route_initial = function () {
    const id = hash_id();
    const target = registry.has(id) ? id : registry.has("overview") ? "overview" : (ordered()[0] || {}).id;
    if (target) {
      show(target, {});
      correct_hash();
    }
    return target;
  };

  /* ------------------------------------------------------------------ theme */
  const THEME_KEY = "hexis-lab.theme";
  const THEME_MODES = ["system", "light", "dark"];
  const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
  const THEME_ICONS = { system: "system", light: "sun", dark: "moon" };
  let theme_mode = "system";
  const toggles = new Set();

  function apply_theme(mode) {
    const root = doc.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
  }

  function next_mode(mode) { return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]; }

  function sync_toggle(btn) {
    const mode = theme_mode;
    const next = next_mode(mode);
    btn.dataset.mode = mode;
    /* the visible label says what the control sets ("Theme: System"); phones show the icon only */
    btn.replaceChildren(HXUI.icon(THEME_ICONS[mode]), h("span", { class: "hx-theme-label" }, "Theme: " + THEME_LABELS[mode]));
    btn.setAttribute("aria-label", "Theme: " + THEME_LABELS[mode] + ". Switch to " + THEME_LABELS[next] + ".");
    btn.title = (mode === "system" ? "Theme follows your device." : "Theme: " + THEME_LABELS[mode] + ".") + " Click for " + THEME_LABELS[next].toLowerCase() + ".";
  }

  HXUI.theme = {
    modes: THEME_MODES.slice(),
    get() { return theme_mode; },
    effective() {
      if (theme_mode !== "system") return theme_mode;
      try { return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e) { return "light"; }
    },
    set(mode) {
      theme_mode = THEME_MODES.indexOf(mode) >= 0 ? mode : "system";
      apply_theme(theme_mode);
      storage.set(THEME_KEY, theme_mode === "system" ? null : theme_mode);
      for (const b of toggles) sync_toggle(b);
      HXUI.bus.emit("theme:changed", { mode: theme_mode, effective: HXUI.theme.effective() });
      return theme_mode;
    },
    cycle() { return HXUI.theme.set(next_mode(theme_mode)); },
  };

  /** theme_toggle({id}) -> button that cycles system -> light -> dark -> system */
  HXUI.theme_toggle = function (opts) {
    const o = opts || {};
    const btn = h("button", { type: "button", id: o.id || "hx-theme-toggle", class: "hx-btn hx-btn--secondary hx-btn--sm hx-theme-toggle" });
    btn.addEventListener("click", () => {
      const mode = HXUI.theme.cycle();
      HXUI.announce(mode === "system" ? "Theme follows your device." : THEME_LABELS[mode] + " theme.");
    });
    toggles.add(btn);
    sync_toggle(btn);
    return btn;
  };

  /* Apply the stored choice as early as possible (this script runs before the shell renders). */
  (function init_theme() {
    const stored = storage.get(THEME_KEY);
    theme_mode = stored === "light" || stored === "dark" ? stored : "system";
    apply_theme(theme_mode);
  })();
})();
