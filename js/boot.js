// Applique le thème avant le premier rendu pour éviter tout flash (fichier séparé : la CSP interdit les scripts inline).
try { var t = (JSON.parse(localStorage.getItem('carnet.ui')) || {}).theme || 'auto';
  document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; } catch (e) {}
