
const CACHE = 'vocabcycle-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './words.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const req = event.request;
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      // cache same-origin GET
      if (req.method === 'GET' && new URL(req.url).origin === location.origin) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // fallback to app shell
      const fallback = await cache.match('./index.html');
      return fallback;
    }
  })());
});
