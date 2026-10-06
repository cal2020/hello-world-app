/* Placeholder boot (replaced by the lab UI): marks the page ready once the engine has loaded. */
(function () {
  "use strict";
  const el = document.getElementById("app");
  el.textContent = "HEXIS engine " + (globalThis.HX ? HX.VERSION : "missing") + " loaded.";
  el.dataset.boot = globalThis.HX ? "ready" : "failed";
})();
