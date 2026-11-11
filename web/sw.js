/* Slide: service worker
   Makes the app installable and usable offline.
   Strategy: serve from cache immediately, refresh the cache in the background
   (stale-while-revalidate), so updates show up on the following visit.
   Bump CACHE only when the file list changes. */

const CACHE = "slide-v6";

const FILES = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json",
  "favicon.ico",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;

  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    // "no-cache" asks the server whether the file changed, skipping stale browser copies
    const fresh = fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached ?? Response.error());

    if (cached) {
      event.waitUntil(fresh);
      return cached;
    }
    return fresh;
  }));
});
