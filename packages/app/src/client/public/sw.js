/**
 * drishti service worker — makes the app installable and lets the shell
 * launch offline. drishti is a *live* monitor: the useful data arrives over
 * a WebSocket the SW never sees, so there is nothing to cache there. The SW
 * only owns the static shell (HTML / JS / CSS / icons / manifest).
 *
 * Strategy is network-first for every same-origin GET: when online the user
 * always gets the freshly-built bundle (the parent rebuilds it on start, and
 * filenames are unhashed, so a cache-first SW would pin a stale `main.js`);
 * the cache is only a fallback for when the network is gone. `/rpc/*` (the
 * oRPC transport) is left entirely to the network. Precaching the shell at
 * install means even a never-visited asset is available on the first
 * offline launch.
 */

const CACHE = "drishti-shell-v1";
const SHELL = [
  "/",
  "/main.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Per-asset puts: one missing file shouldn't abort the whole install
      // (addAll is all-or-nothing).
      .then((cache) =>
        Promise.all(
          SHELL.map((url) =>
            fetch(url, { cache: "no-cache" })
              .then((resp) => (resp.ok ? cache.put(url, resp) : undefined))
              .catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/rpc")) return; // the live transport is the network's

  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return resp;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Offline navigation to an uncached route (e.g. /?host=…) → shell.
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
