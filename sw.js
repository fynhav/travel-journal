// Travel Journal service worker: keeps the whole app on the phone so it opens with no signal.
// The page registers it as sw.js?v=<app version>; a new version means a new URL, so a new cache.
const V = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'tj-' + V;
const SCOPE = self.registration.scope;
const FILES = ['index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'vendor/jszip.min.js', 'vendor/plus-jakarta-sans-latin-wght-normal.woff2', 'vendor/fraunces-latin-wght-normal.woff2', 'vendor/world-50m.json'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // a unique query string skips any stale copy held by the CDN or the browser
    await Promise.all(FILES.map(async f => {
      const u = new URL(f, SCOPE).href, r = await fetch(u + '?sw=' + encodeURIComponent(V), { cache: 'reload' });
      if (!r.ok) throw new Error('Could not cache ' + f);
      await c.put(u, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tj-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch the transcription and Claude calls
  if (url.searchParams.has('cb')) return; // update checks must reach the network
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(new URL('index.html', SCOPE).href).then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
