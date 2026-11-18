// What the page shows when the server does not answer, instead of the browser's "localhost refused to connect":
// at login before the server is up, while an update restarts it, while keepalive waits to start it again. The
// Mac app does the same in its own window (mac/Sources/App.swift). Nothing of bateson is cached: a page always
// comes from the server, and only when that fails does this answer, with a page that waits for the server and
// reloads into bateson once it is back. Registered from web/src/main.tsx, served by server/server.ts.

const FONT = '/fonts/schibstedgrotesk-normal.woff2';
const CACHE = 'bateson-waiting-1';

self.addEventListener('install', (event) => {
  // The one font the waiting page uses, kept for when the server that serves it is down.
  event.waitUntil(caches.open(CACHE).then((c) => c.add(FONT)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => waiting()));
  } else if (new URL(req.url).pathname === FONT) {
    event.respondWith(fetch(req).catch(() => caches.match(FONT).then((r) => r || Response.error())));
  }
});

function waiting() {
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#FCFCFB">
<title>bateson</title>
<script>
  (function () {
    var t = 'system';
    try { t = localStorage.getItem('bateson:theme') || t; } catch (e) {}
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    if (t === 'dark') document.querySelector('meta[name="theme-color"]').content = '#141414';
  })();
</script>
<style>
  @font-face { font-family: 'Schibsted Grotesk'; font-weight: 400 900; font-display: swap; src: url('${FONT}') format('woff2'); }
  :root { --work: #FCFCFB; --muted: #5F5B54; }
  [data-theme='dark'] { color-scheme: dark; --work: #141414; --muted: #99948C; }
  html, body { margin: 0; height: 100%; background: var(--work); color: var(--muted); }
  body { display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 16px;
    font: 14px/1.5 'Schibsted Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  /* Installed as an app with no title bar of its own: this strip is where the window is dragged from. */
  .drag { position: fixed; top: 0; left: 0; right: 0; height: env(titlebar-area-height, 0px); -webkit-app-region: drag; app-region: drag; }
</style>
</head>
<body>
<div class="drag"></div>
<p>Waiting for the bateson server on ${self.location.host}</p>
<script>
  setInterval(function () {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) { if (r.ok) location.reload(); }, function () {});
  }, 2000);
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
