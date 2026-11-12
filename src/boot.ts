// Applique le thème avant le premier rendu pour éviter tout flash (fichier séparé : la CSP interdit les scripts inline).
try {
  const t = (JSON.parse(localStorage.getItem('carnet.ui') || '{}') as { theme?: string }).theme || 'auto';
  document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch { /* préférences illisibles : thème par défaut */ }
