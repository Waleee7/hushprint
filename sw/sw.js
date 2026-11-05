// Hushprint service worker: offline cache of the app shell only. It never sees your files (they stay in the page).
// The two placeholders below are filled in at build time by the hushprint-pwa plugin in vite.config.ts.
const VERSION = '__VERSION__';
const CACHE = `hushprint-${VERSION}`;
const FILES = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('hushprint-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // never touch cross-origin traffic
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : undefined) || fetch(req)));
});
