// CampSpace service worker.
// - App shell is precached so the site opens with no connection.
// - Static files: stale-while-revalidate. Pages: network first, fall back to the cached shell.
// - API responses are NEVER cached here (they can contain personal or medical data). Tickets that a corps member
//   downloads are stored by the app itself in IndexedDB and wiped on sign-out.
const VERSION = 'v1.0.0';
const SHELL = `campspace-shell-${VERSION}`;
const ASSETS = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/main.js', '/js/core.js', '/js/qr.js', '/js/shell.js', '/js/pages-public.js', '/js/pages-corps.js',
  '/js/pages-admin.js', '/js/pages-med.js', '/js/pages-super.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('campspace-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only, never cached

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/index.html')) || (await caches.match('/')) || new Response('Offline', { status: 503 })));
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await refresh) || new Response('', { status: 504 });
  })());
});

// Ask open pages to send their saved offline requests when the browser regains connectivity.
self.addEventListener('sync', (e) => {
  if (e.tag === 'campspace-sync') e.waitUntil(self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'sync' }))));
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
