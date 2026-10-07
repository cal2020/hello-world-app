// Apply the saved theme before first paint (external file: the CSP forbids inline scripts).
try {
  var t = localStorage.getItem('switchyard.theme') || 'system';
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
