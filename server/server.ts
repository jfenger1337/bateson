// The app's server: the queue as JSON, decisions in, live updates out, and the built UI. Only this machine's
// own pages may talk to it: other websites, and DNS-rebinding tricks that pose as localhost, are refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import store, { PORT } from '../lib/store.ts';
import { kindOf, checkDecision } from '../lib/kinds.ts';
import { missingHooks, writeHooks } from '../lib/claude-settings.ts';
import { stateView, summaryView } from '../lib/view.ts';
import { reachOf } from '../lib/delivery.ts';
import { openUpdater, due } from '../lib/update.ts';
import { accessKey, sameKey } from '../lib/key.ts';

/** What the app posts to decide: the version it saw (its number and createdAt) and the decision on it. */
type DecideBody = { n?: unknown; at?: unknown };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'web', 'dist');
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PAGE_SEEN_MS = 20_000;
const TICKET_MS = 30_000;
const YEAR_S = 365 * 24 * 3600;

/** The app without a socket. `changed` and `rebuilt` are how pages hear about the queue and a new build. */
export function createApp({ dist = DIST, updater: given, key = accessKey() }: { dist?: string | null; updater?: ReturnType<typeof openUpdater>; key?: string } = {}) {
  store.ensureDirs();
  // Tickets not yet used, and when each stops being good (lib/key.ts).
  const tickets = new Map<string, number>();
  const app = new Hono();
  const listeners = new Set<() => void>();
  const reloaders = new Set<() => void>();
  // How many times the pages have been told of a change. A page's first look at the queue and its live updates
  // are two requests; each carries this number, so the page can tell whether anything was said between the two and
  // need not ask for the queue a second time just because the updates connected.
  let told = 0;
  const tell = () => { told++; for (const fn of listeners) fn(); };
  const updater = given ?? openUpdater({ onChange: tell });
  // When a page last asked for the queue or its live updates. A page whose live updates were cut (a proxy or an
  // antivirus that ends long responses) holds no /api/events, but still reconnects every 2 seconds.
  let pageSeen = 0;

  // Who may ask. The Host header must be this machine (a rebinding page arrives with its own name), and anything
  // that changes the queue must come from the app's own pages: same origin, sent as JSON.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') || '';
    if (!LOCAL.test(host)) return c.json({ error: 'Not this host' }, 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && origin !== `http://${host}`) return c.json({ error: 'Not from bateson' }, 403);
      if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Not from bateson' }, 403);
      // Always JSON, body or not: a form can only post form data or plain text, so one slipped into an agent's
      // markdown cannot post here from bateson's own page, even an empty one.
      const type = c.req.header('content-type') || '';
      if (!type.startsWith('application/json')) return c.json({ error: 'JSON only' }, 415);
    }
    // And whose page it is (lib/key.ts): another account on this machine reaches this port too. The key comes from
    // the command and the Mac app as a header, from a page as the cookie it was given. A ticket is traded for that
    // cookie, once. Without either, only the page itself and whether the server is up are answered: neither says
    // anything of yours, and the page says how to get in.
    const name = `bateson-${host.split(':').pop()}`; // by port: a browser keeps one jar of cookies for all of localhost
    const sign = () => setCookie(c, name, key, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: YEAR_S });
    const ticket = c.req.method === 'GET' ? c.req.query('ticket') : undefined;
    if (ticket !== undefined) {
      const until = tickets.get(ticket);
      tickets.delete(ticket);
      if (until && until > Date.now()) sign();
      const to = new URL(c.req.url);
      to.searchParams.delete('ticket');
      // Back to this server's own page: a path starting "//" would send the browser to another site.
      return c.redirect('/' + to.pathname.replace(/^[/\\]+/, '') + to.search, 302);
    }
    const bearer = /^Bearer (.+)$/.exec(c.req.header('authorization') || '')?.[1];
    const cookie = getCookie(c, name);
    if (sameKey(bearer, key)) { if (c.req.method === 'GET' && cookie !== key) sign(); } // the Mac app's window keeps it for its page
    else if (!sameKey(cookie, key) && c.req.path.startsWith('/api/') && c.req.path !== '/api/health') return c.json({ error: 'Not signed in', code: 'key' }, 401);
    await next();
    // No other website may frame bateson: a page that put it in a hidden frame could steer your clicks and keys into
    // answering a question or starting an update, with every request coming from bateson's own origin.
    c.header('x-frame-options', 'SAMEORIGIN');
    // Nor may one load what bateson serves as its own picture, script or sound, to learn from how it loads.
    c.header('cross-origin-resource-policy', 'same-origin');
    if (!c.res.headers.has('content-security-policy')) c.header('content-security-policy', "frame-ancestors 'self'");
  });

  // The types bateson serves files as; anything else is plain text.
  const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aif: 'audio/aiff', aiff: 'audio/aiff' };

  const json = async (c: Context): Promise<unknown> => { try { return await c.req.json(); } catch { return null; } };

  // pages: how many bateson pages are open now (each holds /api/events), so a send knows whether to open one.
  // One that asked in the last 20 seconds counts too, even without a live connection.
  app.get('/api/health', (c) => c.json({ ok: true, pages: Math.max(listeners.size, Date.now() - pageSeen < PAGE_SEEN_MS ? 1 : 0) }));

  // A ticket: an address that signs a page in, for whoever already has the key (`bateson open`, a send that opens the window).
  app.post('/api/ticket', (c) => {
    const now = Date.now();
    for (const [t, until] of tickets) if (until <= now) tickets.delete(t);
    const ticket = crypto.randomBytes(24).toString('hex');
    tickets.set(ticket, now + TICKET_MS);
    return c.json({ ticket });
  });

  app.get('/api/config', (c) => c.json(store.readConfig()));
  app.put('/api/config', async (c) => c.json(store.writeConfig(await json(c))));

  // Without its hooks in Claude Code's settings, no answer reaches an agent. Settings asks each time it opens,
  // and can put them back the way the installer does. `errors`: what the hooks wrote to hooks.log in the last day.
  app.get('/api/hooks', (c) => c.json({ missing: missingHooks(), errors: store.hookErrors() }));
  app.post('/api/hooks', (c) => {
    try { writeHooks(); } catch (e) { const { message, code } = e as NodeJS.ErrnoException; return c.json({ error: message, code }, 409); }
    return c.json({ missing: missingHooks(), errors: store.hookErrors() });
  });

  app.get('/api/summary', (c) => c.json(summaryView()));

  // Updating bateson (lib/update.ts). Installing takes minutes (npm, the build), longer than a request may stay
  // open, so it answers at once: pages hear each step as a change and read it from /api/state.
  app.get('/api/update', (c) => c.json(updater.read()));
  app.post('/api/update/check', async (c) => c.json(await updater.check()));
  app.post('/api/update', (c) => { updater.apply().catch(() => {}); return c.json({ started: true }); });
  // After an update a server nothing restarts is still the old one: this quits it for the new one.
  app.post('/api/restart', (c) => (updater.restart() ? c.json({ restarting: true }) : c.json({ error: 'An update is under way.' }, 409)));

  app.get('/api/state', (c) => {
    pageSeen = Date.now();
    c.header('x-bateson-told', String(told));
    return c.json(stateView({
      skip: (c.req.query('skip') || '').split(',').filter(Boolean),
      prefer: c.req.query('prefer') || undefined,
    }));
  });

  app.post('/api/items/:id/decide', async (c) => {
    const body = await json(c);
    if (!body) return c.json({ error: 'Bad request' }, 400);
    const { n, at } = body as DecideBody;
    const item = store.getItem(c.req.param('id'));
    if (!item) return c.json({ error: 'No such item' }, 404);
    let decision;
    try { decision = checkDecision(kindOf(item, store.currentVersion(item)), body, store.readQuestions(item, store.currentVersion(item))); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
    try { store.decide(item.id, typeof n === 'number' ? n : NaN, decision, { at: typeof at === 'string' ? at : undefined }); }
    catch (e) { const { message, code } = e as NodeJS.ErrnoException; return c.json({ error: message, code }, 409); }
    return c.json({ ok: true });
  });

  // An answer to a question marked `opens`, given before the rest of the round: the waiting agent drafts its follow-ups.
  app.post('/api/items/:id/early', async (c) => {
    const { n, answer } = ((await json(c)) || {}) as { n?: unknown; answer?: unknown };
    try { return c.json({ ok: store.saveEarly(c.req.param('id'), typeof n === 'number' ? n : NaN, answer) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });

  // A screenshot pasted or dropped into your own answer, saved as it arrives so the answer only names it. JSON like
  // everything else that changes the queue: { n, type, data } with the picture in base64.
  app.post('/api/items/:id/pasted', async (c) => {
    const { n, type, data } = ((await json(c)) || {}) as { n?: unknown; type?: unknown; data?: unknown };
    if (typeof type !== 'string' || typeof data !== 'string') return c.json({ error: 'Bad request' }, 400);
    try { return c.json({ name: store.savePasted(c.req.param('id'), typeof n === 'number' ? n : NaN, type, Buffer.from(data, 'base64')) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });
  app.get('/api/items/:id/pasted/:n/:name', (c) => {
    const item = store.getItem(c.req.param('id'));
    const name = c.req.param('name');
    const file = item && store.pastedPath(item, Number(c.req.param('n')), name);
    if (!file) return c.notFound();
    return c.body(fs.readFileSync(file), 200, {
      'content-type': TYPES[name.split('.').pop()!], 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
  });

  app.post('/api/items/:id/later', (c) => { store.later(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/api/items/:id/files/:n/:name', (c) => {
    const item = store.getItem(c.req.param('id'));
    const name = c.req.param('name');
    const bytes = item && store.readAttachment(item, Number(c.req.param('n')), name);
    if (!bytes) return c.notFound();
    // An agent's file never runs as a page on this origin: unknown types are plain text, and everything is sandboxed.
    const type = TYPES[name.split('.').pop()!.toLowerCase()] || 'text/plain; charset=utf-8';
    // A recording or a sound is asked for in ranges (the Mac app's web view plays nothing without them).
    const media = /^(video|audio)\//.test(type);
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') || '');
    if (media && range && (range[1] || range[2])) {
      const size = bytes.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) return c.body(null, 416, { 'content-range': `bytes */${size}` });
      return c.body(bytes.subarray(start, end + 1), 206, {
        'content-type': type, 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1),
      });
    }
    return c.body(bytes, 200, {
      'content-type': type,
      ...(media ? { 'accept-ranges': 'bytes' } : {}),
      'x-content-type-options': 'nosniff',
      // A PDF is left out of the sandbox, which can stop a browser's own viewer from showing it, but loads nothing either.
      'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'${type === 'application/pdf' ? '' : '; sandbox'}`,
    });
  });

  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    pageSeen = Date.now();
    let alive = true;
    const fn = () => { stream.writeSSE({ data: 'change' }).catch(() => {}); };
    const reload = () => { stream.writeSSE({ event: 'reload', data: '' }).catch(() => {}); };
    listeners.add(fn);
    reloaders.add(reload);
    stream.onAbort(() => { alive = false; listeners.delete(fn); reloaders.delete(reload); });
    await stream.writeSSE({ data: `hello ${told}` });
    while (alive) await stream.sleep(25000).then(() => { if (alive) return stream.writeSSE({ event: 'ping', data: '' }); });
  }));

  // Nothing else is the API's: said as JSON, not answered with the page below as if it were there.
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built UI. Hashed assets cache forever; the page itself never does.
  if (dist && fs.existsSync(dist)) {
    app.use('/assets/*', async (c, next) => { await next(); c.header('cache-control', 'public, max-age=31536000, immutable'); });
    const root = path.relative(process.cwd(), dist) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('/fonts/*', serveStatic({ root }));
    // What makes the page installable as an app: the manifest and its icons (web/public).
    app.use('/icons/*', serveStatic({ root }));
    app.get('/manifest.webmanifest', serveStatic({ root }));
    // The favicon, in the formats browsers ask for (web/public).
    for (const file of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) app.get(file, serveStatic({ root }));
    // The service worker that answers a load while this server is down (web/public/sw.js). Never cached, so a new
    // one is picked up on the next load.
    app.use('/sw.js', async (c, next) => { await next(); c.header('cache-control', 'no-cache'); });
    app.get('/sw.js', serveStatic({ root }));
    // The page it, and the Mac app, show while this server is down (web/public/waiting.html).
    app.use('/waiting.html', async (c, next) => { await next(); c.header('cache-control', 'no-cache'); });
    app.get('/waiting.html', serveStatic({ root }));
    app.get('*', (c) => {
      c.header('cache-control', 'no-store');
      return c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
    });
  }

  return {
    app,
    updater,
    /** Whether any page is open: one holding live updates, or one that asked lately. */
    pages: () => listeners.size > 0 || Date.now() - pageSeen < PAGE_SEEN_MS,
    changed: tell,
    rebuilt: () => { for (const fn of reloaders) fn(); },
  };
}

// Files in the queue's folder that no page shows: the logs and the server's own marks, the last colour given, a session's working-tree
// record (lib/worktree.ts), and a file still being written (it is renamed into place, and that is seen).
const UNSHOWN = /^(server\.(log|pid|stop|error)|hooks\.log(\.old)?|hue\.json|key)$/;
const UNSHOWN_ANYWHERE = /\.(tmp|tree)$/;
// What bateson worked out from the queue and kept (store.writeCache): it says nothing the queue's own files do not.
const UNSHOWN_UNDER = /^cache([\\/]|$)/;

/**
 * Watch the queue's folder. Every change is told to the store, which drops what it kept of a done item that
 * changed (store.keepDone); one the pages may show calls `changed`, once things have been quiet for `settle` ms.
 * A waiting agent touches its waiter.json every few seconds to say it is still there; only its coming and going
 * reaches the pages (one that stops touching it is caught by the pulse in start()). Before this, each touch had
 * every page read the whole queue again, every second for as long as an agent waited.
 */
export function watchQueue(root: string, changed: () => void, { settle = 250 } = {}) {
  const waiters = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(changed, settle); };
  const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
    // A change the system could not name (its list of changes overflowed): anything may have changed.
    if (name == null) { store.forget(null); soon(); return; }
    const rel = String(name);
    if (UNSHOWN.test(rel) || UNSHOWN_ANYWHERE.test(rel) || UNSHOWN_UNDER.test(rel)) return;
    const file = path.join(root, rel);
    if (path.basename(rel) === 'waiter.json') {
      // A heartbeat only changes the file's time. A new waiter writes it whole (renamed into place), even over
      // one left by a waiter that died, and that is told. Which of the two it was is read from the file itself,
      // which file it is and what it says, and not from the kind of event: macOS goes on calling a touch of a
      // file that was just renamed into place a rename, and every heartbeat then had the pages read the queue.
      let now: string | undefined;
      try { now = `${fs.statSync(file).ino}:${fs.readFileSync(file, 'utf8')}`; }
      catch { if (fs.existsSync(file)) return; } // there, and being replaced this moment: its next event says
      if (waiters.get(file) === now) return;
      if (now === undefined) waiters.delete(file); else waiters.set(file, now);
      soon();
      return;
    }
    store.forget(file);
    soon();
  });
  // A watch the system ends (the folder gone, too many changes at once): start over from the files.
  watcher.on('error', () => { store.forget(null); soon(); });
  return { close: () => { clearTimeout(timer); watcher.close(); } };
}

/** Waits, up to 20 seconds, for the server this one replaces (lib/update.ts relaunch) to quit and free the port. */
async function replaced(pid: number) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Run it: watch the queue and the build, and listen on localhost. */
export async function start() {
  const old = Number(process.env.BATESON_REPLACES);
  delete process.env.BATESON_REPLACES;
  if (old) await replaced(old);
  const { app, changed, rebuilt, updater, pages } = createApp();
  // Once a day, if Settings allows, ask GitHub whether there is a newer version. The first look waits a minute,
  // so a server that keeps restarting does not ask each time.
  updater.recover();
  const look = () => { if (store.readConfig().updates && due(updater.read())) updater.check().catch(() => {}); };
  setTimeout(look, 60_000);
  setInterval(look, 3600_000);
  // Done items are read once and kept, which needs the watcher to say what changed.
  store.keepDone();
  watchQueue(store.ROOT, changed);
  // Some changes leave no file event: a waiting hook that dies, a Claude Code session that ends, an answer older
  // than a window the page counts in. So every 15 seconds, while a page is open, the state is worked out here, and
  // the pages hear of it only if it reads differently, with each waiting item's reach (lib/delivery.ts) too. Each
  // time, a twentieth of what was kept of done items is read again, for a change the watcher missed: all of it
  // within 5 minutes, and never all at once, which stopped the server for as long as the reading took. With no page
  // open nothing is dropped, so the window a question opens is not kept waiting for the whole history to be read.
  let pulse = '';
  setInterval(() => {
    if (!pages()) return;
    // An error here would end the server (nothing catches it in a timer): it is logged, and the next pulse tries again.
    try {
      store.forgetOldest(1 / 20);
      const live = store.liveSessions();
      const now = JSON.stringify([stateView(), store.pending().map((r) => [r.item.id, reachOf(r.item, live)])]);
      if (now !== pulse) { pulse = now; changed(); }
    } catch (e) { console.error('bateson: the 15-second check failed:', e); }
  }, 15000);
  if (fs.existsSync(DIST)) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    fs.watch(DIST, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(rebuilt, 300); });
  }
  // On ::1 as well, where there is one. The page is opened as http://localhost, which Windows looks up as ::1
  // first: with nothing listening there, each new connection waited for that to fail before it tried 127.0.0.1.
  // A machine without IPv6 has no ::1 to listen on, and goes without.
  serve({ fetch: app.fetch, port: PORT, hostname: '::1' }).on('error', () => {});
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
    console.log(`bateson on http://localhost:${PORT}${fs.existsSync(DIST) ? '' : ' (API only: run npm run build for the UI)'}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) start();
