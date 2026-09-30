// Apply the last theme before first paint; app.js confirms it from the saved config.
try {
  const t = localStorage.getItem('echo:theme') || 'system'
  document.documentElement.dataset.theme = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'echo-paper' : 'echo-ink') : t
} catch {}
