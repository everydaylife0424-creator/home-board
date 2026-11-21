/* 股市模擬的離線快取：網頁檔案先抓網路（有更新就用新的），沒網路時用快取。報價不快取。 */
const CACHE = "stocksim-v1";
const SHELL = ["./", "index.html", "app.js", "app.css", "stocks.js", "sync.js", "manifest.webmanifest", "icons/192.png", "icons/180.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("stocksim-") && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  const fresh = r.mode === "navigate" ? fetch(u.href, { cache: "no-cache", credentials: "same-origin" }) : fetch(r, { cache: "no-cache" });
  e.respondWith(fresh.then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))));
});
