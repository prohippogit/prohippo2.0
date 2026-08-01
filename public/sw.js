/* ProHippo service worker — app-shell caching for PWA/offline support.
   Bump CACHE_VERSION to invalidate old caches on deploy.

   v4: static assets are served stale-while-revalidate, so a returning user runs
   whatever JS is already cached and only picks up a new build on the RELOAD
   after the one that fetched it. That is fine for a cosmetic change and not fine
   for a behavioural one — it meant the download fix appeared not to work. Bump
   this on any release whose behaviour users must get immediately. */
const CACHE_VERSION = "prohippo-v4";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/prohippo-logo.png",
  "/prohippo-mark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Firebase/API calls go straight to network

  // Navigations: network first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
