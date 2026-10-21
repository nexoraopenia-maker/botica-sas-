/*
 * Service worker de AIMA ERP.
 *  - Estáticos (JS/CSS con hash, íconos, logo, fuentes): cache-first → la app abre al instante.
 *  - Navegación (páginas): siempre red; NO se guardan en caché porque contienen datos del negocio.
 *    Sin conexión se muestra /offline.html.
 *  - Server Actions, RSC, API y cualquier método distinto de GET: no se interceptan.
 * Cambiar VERSION invalida la caché anterior.
 */
const VERSION = "aima-v1";
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/brand/aima-logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname.startsWith("/icons/") ||
  url.pathname.startsWith("/brand/") ||
  url.pathname.startsWith("/_next/image");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isStatic(url)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Navegación de página completa: red primero; sin red, página offline (las páginas no se cachean)
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
  }
});
