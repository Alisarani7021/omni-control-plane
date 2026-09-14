/**
 * Service worker.
 *
 * Zeus's SW caches a list of five CDN URLs. If any CDN is unreachable the
 * `cache.addAll` promise rejects and *nothing* gets cached, so the "PWA" still
 * needs a live internet connection to all four third-party CDNs. Kaveh caches
 * only its own same-origin assets, individually, so the panel shell opens even
 * with the network down and shows a friendly offline state.
 */
const VERSION = "kaveh-v3";
const SHELL = ["/", "/panel", "/index.html", "/assets/app.css", "/assets/app.js", "/assets/api.js", "/assets/i18n.js", "/assets/charts.js", "/assets/views.js", "/assets/components.js", "/assets/fx.js", "/assets/nettest.js", "/assets/vendor/qrcode.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Individually, with catch — one 404 must not break the whole shell.
      Promise.allSettled(SHELL.map((u) => cache.add(u).catch(() => null))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Never cache dynamic data.
  if (/^\/(api|s|sub|status|feed)\//.test(url.pathname)) return;

  // Stale-while-revalidate for the shell: instant paint, updates in background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const clone = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached || offlinePage(url));
      return cached || network;
    }),
  );
});

function offlinePage(url) {
  if (url.pathname.startsWith("/assets/")) return new Response("", { status: 504 });
  return new Response(
    `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>آفلاین</title><body style="font-family:system-ui,Tahoma;background:#06070a;color:#e8ecf4;display:grid;place-items:center;min-height:100vh;text-align:center;padding:20px">
     <h2>📡 اتصال قطع است</h2><p style="opacity:.7">پوسته‌ی پنل از حافظه‌ی نهان باز شد، اما داده‌ها نیاز به شبکه دارند.</p>
     <button onclick="location.reload()" style="margin-top:14px;padding:10px 20px;border-radius:10px;border:none;background:#22d3ee;color:#04121a;font-weight:700;cursor:pointer">تلاش دوباره</button>
     </body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
