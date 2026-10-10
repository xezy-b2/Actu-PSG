// Service worker PSG Live : fonctionnement hors ligne et notifications.
const CACHE = "psg-live-v1";
const BASE = new URL(self.registration.scope).pathname; // "/" sur Railway, "/actu-psg/" sur GitHub Pages
const SHELL = ["", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png"].map((p) => BASE + p);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Réseau d'abord (pour toujours avoir l'actu fraîche), cache en secours hors ligne.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith(BASE + "api/")) return;
  const key = url.pathname === BASE + "index.html" ? BASE : url.pathname;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || caches.match(BASE)))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "PSG Live", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "PSG Live", {
      body: d.body || "",
      tag: d.tag,
      renotify: !!d.tag,
      icon: BASE + "icons/icon-192.png",
      badge: BASE + "icons/badge-96.png",
      data: { url: d.url || "" },
      lang: "fr",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data?.url || "").replace(/^\//, ""), self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === location.origin) { c.navigate(target).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});
