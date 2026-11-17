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
import store, { PORT } from '../lib/store.ts';
import { kindOf, checkDecision } from '../lib/kinds.ts';
import { missingHooks, writeHooks } from '../lib/claude-settings.ts';
import { stateView, summaryView } from '../lib/view.ts';
import { openUpdater, due } from '../lib/update.ts';

/** What the app posts to decide: the version it saw (its number and createdAt) and the decision on it. */
type DecideBody = { n?: unknown; at?: unknown };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'web', 'dist');
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PAGE_SEEN_MS = 20_000;

/** The app without a socket. `changed` and `rebuilt` are how pages hear about the queue and a new build. */
export function createApp({ dist = DIST, updater: given }: { dist?: string | null; updater?: ReturnType<typeof openUpdater> } = {}) {
  store.ensureDirs();
  const app = new Hono();
  const listeners = new Set<() => void>();
  const reloaders = new Set<() => void>();
  const updater = given ?? openUpdater({ onChange: () => { for (const fn of listeners) fn(); } });
  // When a page last asked for the queue or its live updates. A page whose live updates were cut (a proxy or an
  // antivirus that ends long responses) holds no /api/events, but still reconnects every 2 seconds.
  let pageSeen = 0;

  // Who may ask. The Host header must be this machine (a rebinding page arrives with its own name), and anything
  // that changes the queue must come from the app's own pages: same origin, JSON bodies.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') || '';
    if (!LOCAL.test(host)) return c.json({ error: 'Not this host' }, 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && origin !== `http://${host}`) return c.json({ error: 'Not from bateson' }, 403);
      if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Not from bateson' }, 403);
      const type = c.req.header('content-type') || '';
      if (c.req.header('content-length') !== '0' && c.req.raw.body && !type.startsWith('application/json')) return c.json({ error: 'JSON only' }, 415);
    }
    await next();
  });

  const json = async (c: Context): Promise<unknown> => { try { return await c.req.json(); } catch { return null; } };

  // pages: how many bateson pages are open now (each holds /api/events), so a send knows whether to open one.
  // One that asked in the last 20 seconds counts too, even without a live connection.
  app.get('/api/health', (c) => c.json({ ok: true, pages: Math.max(listeners.size, Date.now() - pageSeen < PAGE_SEEN_MS ? 1 : 0) }));

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

  app.get('/api/state', (c) => {
    pageSeen = Date.now();
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
    try { decision = checkDecision(kindOf(item, store.currentVersion(item)), body); }
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

  app.post('/api/items/:id/later', (c) => { store.later(c.req.param('id')); return c.json({ ok: true }); });

  const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aif: 'audio/aiff', aiff: 'audio/aiff' };
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
      ...(type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
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
    await stream.writeSSE({ data: 'hello' });
    while (alive) await stream.sleep(25000).then(() => { if (alive) return stream.writeSSE({ event: 'ping', data: '' }); });
  }));

  // The built UI. Hashed assets cache forever; the page itself never does.
  if (dist && fs.existsSync(dist)) {
    app.use('/assets/*', async (c, next) => { await next(); c.header('cache-control', 'public, max-age=31536000, immutable'); });
    const root = path.relative(process.cwd(), dist) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('/fonts/*', serveStatic({ root }));
    // What makes the page installable as an app: the manifest and its icons (web/public).
    app.use('/icons/*', serveStatic({ root }));
    app.get('/manifest.webmanifest', serveStatic({ root }));
    app.get('*', (c) => {
      c.header('cache-control', 'no-store');
      return c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
    });
  }

  return {
    app,
    updater,
    changed: () => { for (const fn of listeners) fn(); },
    rebuilt: () => { for (const fn of reloaders) fn(); },
  };
}

/** Run it: watch the queue and the build, and listen on localhost. */
export function start() {
  const { app, changed, rebuilt, updater } = createApp();
  // Once a day, if Settings allows, ask GitHub whether there is a newer version. The first look waits a minute,
  // so a server that keeps restarting does not ask each time.
  updater.recover();
  const look = () => { if (store.readConfig().updates && due(updater.read())) updater.check().catch(() => {}); };
  setTimeout(look, 60_000);
  setInterval(look, 3600_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  fs.watch(store.ROOT, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(changed, 120); });
  // A waiting hook that dies leaves no file event, so nudge the pages now and then.
  setInterval(changed, 15000);
  if (fs.existsSync(DIST)) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    fs.watch(DIST, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(rebuilt, 300); });
  }
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
    console.log(`bateson on http://localhost:${PORT}${fs.existsSync(DIST) ? '' : ' (API only: run npm run build for the UI)'}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) start();
