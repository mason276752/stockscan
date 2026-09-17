// Service worker of the pure-frontend build (registered by main.js only when
// VITE_STATIC=1). What it adds on top of the app's own Cache Storage use
// (staticData.js keeps every filing, score, dictionary, finished-year bar
// file and content-named index it has fetched):
//   - the app shell (index.html, the hashed files under assets/) is served
//     from the cache, so the app opens instantly and works offline with the
//     data it has seen; index.html itself is network-first so a new deploy
//     is picked up on the next load and old assets are pruned to the ones
//     that page references
//   - the few small files that change with every deploy (index/meta.json,
//     this year's bars head.zst and their meta.json) are network-first with
//     the cached copy as the offline fallback
// Everything under data/store, data/zdict and the finished-year bars is left
// to the app so it is not stored twice.
const SHELL = 'stockscan-shell-v1';
const FALLBACK = 'stockscan-fallback-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stockscan-') && k !== SHELL && k !== FALLBACK && !k.startsWith('stockscan-store')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isNavigation = (req) => req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
const isAsset = (url) => /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(url.pathname); // vite's hashed file names
const isVolatile = (url) => /\/index\/meta\.json$/.test(url.pathname) || /\/data\/bars\/.*\/(head\.zst|meta\.json)$/.test(url.pathname);

// index.html from the network (a deploy shows up on the next load), the
// cached page when offline; the shell cache is then pruned to what the
// page references
async function navigate(req) {
  const cache = await caches.open(SHELL);
  const key = new URL('./', req.url).href; // one entry per directory, whatever the query string
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(key, res.clone());
      prune(cache, await res.clone().text(), new URL(req.url)).catch(() => {});
    }
    return res;
  } catch {
    return (await cache.match(key)) || Response.error();
  }
}
// the assets of the current page: what index.html references, plus what
// those scripts load themselves (the dynamically imported data layer, the
// worker it starts, the chunk of a page) - found by reading the cached
// scripts for hashed file names, one level after another
async function prune(cache, html, pageUrl) {
  const keep = new Set();
  const queue = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)) {
    const u = new URL(m[1], pageUrl).href;
    keep.add(u);
    queue.push(u);
  }
  if (!keep.size) return;
  while (queue.length) {
    const u = queue.shift();
    if (!/\.js$/.test(u)) continue;
    const res = await cache.match(u);
    if (!res) continue;
    for (const m of (await res.text()).matchAll(/["'`]((?:\.\/)?[\w.-]+-[\w-]{8}\.(?:js|css|wasm))["'`]/g)) {
      const ref = new URL(m[1], u).href;
      if (keep.has(ref)) continue;
      keep.add(ref);
      queue.push(ref);
    }
  }
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    if (isAsset(u) && !keep.has(u.href)) await cache.delete(req);
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
async function networkFirst(req) {
  const cache = await caches.open(FALLBACK);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNavigation(req)) e.respondWith(navigate(req));
  else if (isAsset(url)) e.respondWith(cacheFirst(req));
  else if (isVolatile(url)) e.respondWith(networkFirst(req));
  // anything else (data/store, data/zdict, data/bars/<year>.zst, index/*.zst): the app caches it itself
});
