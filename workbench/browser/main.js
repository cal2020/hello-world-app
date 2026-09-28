// Page side of the browser build. Starts the Python worker and routes the real UI's fetch() calls for
// /api, /manage, /consumer and /web/fixtures to it. Everything else (none, in practice) goes to the network.
"use strict";
(function () {
  const worker = new Worker(new URL("worker.js", document.currentScript.src), { type: "module" });
  const pending = new Map();
  let nextId = 1;
  const nativeFetch = window.fetch.bind(window);
  const LOCAL = /^\/(api|manage|consumer|web\/fixtures)(\/|$)/;
  const $ = (id) => document.getElementById(id);

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "progress") { $("lb-status").textContent = m.text; return; }
    if (m.kind === "ready") {
      $("lb-overlay").hidden = true;
      $("lb-state").textContent = `Running in this tab · started in ${m.seconds}s`;
      refreshConsumer();
      return;
    }
    if (m.kind === "failed") {
      $("lb-status").textContent = "The workbench could not start in this browser: " + m.text;
      $("lb-overlay").classList.add("failed");
      return;
    }
    if (m.kind === "response") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p(new Response(m.status === 204 ? null : m.body, { status: m.status, headers: m.headers }));
    }
  };
  worker.onerror = (e) => { $("lb-status").textContent = "The workbench could not start: " + (e.message || "worker error"); };

  window.fetch = async function (input, init) {
    init = init || {};
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const path = url.pathname + url.search;
    if (url.origin !== location.origin || !LOCAL.test(url.pathname)) return nativeFetch(input, init);
    let body = null;
    if (init.body != null) body = typeof init.body === "string" ? new TextEncoder().encode(init.body).buffer
      : init.body instanceof ArrayBuffer ? init.body : await new Response(init.body).arrayBuffer();
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k.replace(/(^|-)([a-z])/g, (s) => s.toUpperCase())] = v; });
    const id = nextId++;
    const res = new Promise((resolve) => pending.set(id, resolve));
    worker.postMessage({ kind: "request", id, method: (init.method || "GET").toUpperCase(), path, headers, body },
      body ? [body] : []);
    const r = await res;
    if ((init.method || "GET").toUpperCase() !== "GET" && !path.startsWith("/consumer")) setTimeout(refreshConsumer, 50);
    return r;
  };

  // The server's background outbox thread, in-process: deliver whatever is due (respects pause and backoff).
  setInterval(() => worker.postMessage({ kind: "tick" }), 1000);
  setInterval(() => { if ($("lb-overlay").hidden) refreshConsumer(); }, 2000);

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) (k === "class" ? (n.className = v) : n.setAttribute(k, v));
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
    return n;
  }
  let consumerBusy = false;
  async function refreshConsumer() {
    if (consumerBusy) return;
    consumerBusy = true;
    try {
      const r = await window.fetch("/consumer/state");
      if (r.ok) renderConsumer(await r.json());
    } finally { consumerBusy = false; }
  }
  function renderConsumer(c) {
    const s = c.stream || {};
    const effects = c.effect_count_by_event || {};
    const kv = el("dl", { class: "lb-kv" },
      el("dt", null, "Pinned release"), el("dd", null, s.pinned_release || "none yet"),
      el("dt", null, "Pinned model revision"), el("dd", null, s.pinned_revision || "—"),
      el("dt", null, "Latest model head it knows"), el("dd", null, s.latest_known_head || "—"),
      el("dt", null, "Last event sequence"), el("dd", null, String(s.last_seq ?? 0)),
      el("dt", null, "Sensors shown"), el("dd", null, String((c.sensors || []).length)));
    const rows = (c.received_events || []).slice(-8).map((e) => {
      const n = effects[e.event_id] || 0;
      return el("tr", null, el("td", null, String(e.seq)), el("td", null, e.type), el("td", null, e.handling),
        el("td", { class: e.deliveries > 1 ? "dup" : null }, String(e.deliveries)),
        el("td", { class: n > 1 ? "bad" : null }, String(n)));
    });
    $("lb-cons").replaceChildren(kv, rows.length ? el("div", { class: "lb-tbl" }, el("table", null,
      el("thead", null, el("tr", null, ...["seq", "event", "handling", "deliveries", "effects"].map((h) => el("th", null, h)))),
      el("tbody", null, rows))) : el("p", { class: "lb-hint" }, "No events received yet."));
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("lb-reset").addEventListener("click", () => location.reload());
  });
})();
