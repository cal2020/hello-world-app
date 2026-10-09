// Applies the saved or system color theme before first paint (no flash).
// External file because the app's Content-Security-Policy forbids inline scripts.
;(function () {
  var choice = 'system'
  try {
    choice = localStorage.getItem('aci.theme') || 'system'
  } catch (e) {
    /* storage unavailable: follow the system */
  }
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})()
