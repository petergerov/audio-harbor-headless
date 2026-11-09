/*
 * Audio Harbor offline shell. The page itself is network-first (a host update must never leave the
 * remote on an old index.html whose scripts are gone); the hashed files under /assets/ never change,
 * so they are cache-first. The API is never touched.
 */
const CACHE = 'harbor-shell-v2';
const PAGE = '/';
const SHELL = [PAGE, '/manifest.webmanifest', '/icon-180.png'];
/** A host that does not answer this fast: the cached page shows (the network keeps going). */
const PAGE_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/** The /assets/ files a page links to. */
function assetsOf(html) {
  return new Set(Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (m) => m[1]));
}

/** Keeps the new page, and drops the assets only older pages linked to. */
async function rememberPage(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  await cache.put(PAGE, response);
  const keep = assetsOf(html);
  if (!keep.size) return;
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const path = new URL(req.url).pathname;
        return path.startsWith('/assets/') && !keep.has(path);
      })
      .map((req) => cache.delete(req))
  );
}

/** Network first; the cached page when offline or when the host is too slow to answer. */
function page(request) {
  const network = fetch(request).then((res) => {
    if (res.ok) rememberPage(res.clone()).catch(() => undefined);
    return res;
  });
  const fallback = new Promise((resolve) => {
    setTimeout(() => caches.match(PAGE).then((cached) => cached && resolve(cached)), PAGE_TIMEOUT_MS);
    network.catch(() => caches.match(PAGE).then((cached) => resolve(cached || Response.error())));
  });
  return Promise.race([network.catch(() => fallback), fallback]);
}

/** Hashed and immutable: the cache when it has it, else the network (kept for next time). */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

/** Icon and manifest: the cache at once, refreshed behind it. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(page(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(asset(request));
  } else if (url.pathname === '/manifest.webmanifest' || url.pathname === '/icon-180.png') {
    event.respondWith(staleWhileRevalidate(request));
  }
});
