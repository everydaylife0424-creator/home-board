/* HOME offline cache: app files are network-first (so updates arrive on next open), wallpapers and libraries cache-first. */
const CACHE = "home-v5";
const SHELL = ["./", "index.html", "fb.js", "manifest.webmanifest", "icons/192.png", "icons/180.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  const sameOrigin = u.origin === location.origin;
  const lib = u.hostname === "www.gstatic.com" || u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com";
  if (sameOrigin && u.pathname.includes("/bg/") || lib) {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok || res.type === "opaque") { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })));
  } else if (sameOrigin) {
    // no-cache: always ask GitHub whether there is a newer version (its CDN otherwise lets browsers keep a copy for 10 minutes)
    // A page navigation can't be re-fetched with extra options, so fetch its URL instead.
    const fresh = r.mode === "navigate" ? fetch(u.href, { cache: "no-cache", credentials: "same-origin" }) : fetch(r, { cache: "no-cache" });
    e.respondWith(fresh.then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })
      .catch(() => caches.match(r).then(hit => hit || caches.match("index.html"))));
  }
});
