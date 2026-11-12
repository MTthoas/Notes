// Hors ligne. Stratégie « réseau d'abord » : en ligne, on sert toujours la version à jour
// (contrôlée auprès du serveur, sans le cache HTTP) ; le cache ne sert que hors ligne.
// Une stratégie « cache d'abord » mélangeait anciens et nouveaux modules après une mise à jour,
// ce qui pouvait empêcher l'application de démarrer.
const CACHE = 'carnet-v12';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'fonts/inter.woff2',
  'js/app.js', 'js/boot.js', 'js/core/crypto.js', 'js/core/db.js', 'js/core/store.js',
  'js/core/vault.js', 'js/features/home.js', 'js/features/hub.js', 'js/features/tasks.js', 'js/features/voice.js',
  'js/integrations/ai.js', 'js/integrations/github/api.js', 'js/integrations/github/page.js', 'js/integrations/linear/api.js', 'js/integrations/linear/notifications.js', 'js/integrations/linear/page.js',
  'js/integrations/link.js', 'js/lib/calc.js', 'js/lib/diff.js', 'js/lib/fuzzy.js', 'js/lib/graph.js',
  'js/lib/markdown.js', 'js/lib/qr.js', 'js/lib/schema.js', 'js/lib/zip.js', 'js/ui/kit.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE)
  .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
