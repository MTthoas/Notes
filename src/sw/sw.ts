// Hors ligne. Stratégie « réseau d'abord » : en ligne, on sert toujours la version à jour
// (contrôlée auprès du serveur, sans le cache HTTP) ; le cache ne sert que hors ligne.
// La liste des fichiers et la version du cache sont injectées au build (scripts/build.ts) :
// la version est l'empreinte du contenu, elle change donc d'elle-même à chaque modification.
declare const __VERSION__: string;
declare const __SHELL__: string[];

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `studio-${__VERSION__}`;

sw.addEventListener('install', e => e.waitUntil(caches.open(CACHE)
  .then(c => c.addAll(__SHELL__.map(u => new Request(u, { cache: 'reload' }))))
  .then(() => sw.skipWaiting())));

sw.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  .then(() => sw.clients.claim())));

sw.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) await cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
