// What the page shows when the server does not answer, instead of the browser's "localhost refused to connect":
// at login before the server is up, while an update restarts it, while keepalive waits to start it again. The page
// is waiting.html, the same one the Mac app shows. Nothing of bateson is cached: a page always comes from the
// server, and only when that fails does this answer, with its copy of waiting.html, which waits for the server and
// goes back to bateson once it is back. Registered from web/src/main.tsx, served by server/server.ts. When the
// server cannot start at all (a Node too old for it), the login item answers in its place with why
// (lib/node-check.mjs), and that page is shown as it comes.

const PAGE = '/waiting.html';
const FONT = '/fonts/schibstedgrotesk-normal.woff2';
const CACHE = 'bateson-waiting';

self.addEventListener('install', (event) => {
  // The page and the one font it uses, kept for when the server that serves them is down. A worker that could not
  // keep them is not installed, and the next load tries again.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([PAGE, FONT])).then(() => self.skipWaiting()));
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
    event.respondWith(fetch(req).then((res) => {
      // The server is up (not the stand-in that says why it cannot start): the copy of the page is brought up to
      // date, so a new version of it is the one shown.
      if (res.ok) event.waitUntil(caches.open(CACHE).then((c) => c.add(PAGE)).catch(() => {}));
      return res;
    }, () => caches.match(PAGE).then((r) => r || Response.error())));
  } else if (new URL(req.url).pathname === FONT) {
    // From the cache too when what answers is not the server (lib/node-check.mjs's page, which uses this font).
    const cached = (r) => caches.match(FONT).then((c) => c || r || Response.error());
    event.respondWith(fetch(req).then((r) => (r.ok ? r : cached(r)), () => cached()));
  }
});
