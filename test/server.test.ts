// What the server tells `bateson send` about open pages, so a send opens a window only when none is open.
import { reset, TMP, HOME } from './setup.ts';
import fs from 'node:fs';
import path from 'node:path';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, watchQueue } from '../server/server.ts';
import store, { openStore } from '../lib/store.ts';
import { accessKey } from '../lib/key.ts';

beforeEach(reset);

// As the command and the Mac app ask: with the key (lib/key.ts).
const KEY = { authorization: `Bearer ${accessKey()}` };
const HOST = { headers: { host: 'localhost:4848', ...KEY } };
const pages = async (app: ReturnType<typeof createApp>['app']) =>
  ((await (await app.request('/api/health', HOST)).json()) as { pages: number }).pages;

test('a page that just loaded the queue counts as open, even without live updates', async () => {
  const { app } = createApp({ dist: null });
  assert.equal(await pages(app), 0, 'no page yet');
  assert.equal((await app.request('/api/state', HOST)).status, 200);
  assert.equal(await pages(app), 1);
});

// ---- What a decision may be: decision.json is written once, so one the agent cannot be told would be stuck for good.

const decide = (app: ReturnType<typeof createApp>['app'], id: string, body: unknown) =>
  app.request(`/api/items/${id}/decide`, { method: 'POST', headers: { host: 'localhost:4848', ...KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function sent() {
  return store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Hello', source: {} });
}

test('only the kind\'s own decisions are taken, not a name every object has', async () => {
  const { app } = createApp({ dist: null });
  for (const decision of ['constructor', 'toString', '__proto__', 'answer']) {
    const { id } = sent();
    assert.equal((await decide(app, id, { n: 1, decision })).status, 400, decision);
    assert.equal(store.readDecision(store.getItem(id)!, 1), null, decision);
  }
  const { id } = sent();
  assert.equal((await decide(app, id, { n: 1, decision: 'approve' })).status, 200);
});

test('comments, answers and marks of the wrong shape are refused before anything is written', async () => {
  const { app } = createApp({ dist: null });
  const bad = [
    { decision: 'send-back', comments: 'x' },
    { decision: 'send-back', comments: [] },
    { decision: 'send-back', comments: [{ id: 'c', text: 'Why?', anchor: { kind: 'text', quote: 7 } }] },
    { decision: 'approve', answers: { id: 'Q1' } },
    { decision: 'approve', marks: [{ id: 'F1', mark: 'maybe' }] },
  ];
  for (const body of bad) {
    const { id } = sent();
    assert.equal((await decide(app, id, { n: 1, ...body })).status, 400, JSON.stringify(body));
    assert.equal(store.readDecision(store.getItem(id)!, 1), null);
  }
  const { id } = sent();
  const comment = { id: 'c1', text: 'Shorter.', anchor: { kind: 'text', quote: 'Hello', start: 0, end: 5, file: null, line: null } };
  assert.equal((await decide(app, id, { n: 1, decision: 'send-back', comments: [comment] })).status, 200);
  assert.deepEqual(store.readDecision(store.getItem(id)!, 1)?.comments, [comment]);
});

test('a pasted screenshot is saved, served back, and named in the answer; a name that is not one is refused', async () => {
  const { app } = createApp({ dist: null });
  const { id } = store.send({ kind: 'decision', bodyType: 'questions', title: 'Q', body: { questions: [{ id: 'Q1', title: 'Which?', options: [{ label: 'A' }] }] }, source: {} });
  const post = (body: unknown) => app.request(`/api/items/${id}/pasted`, { method: 'POST', headers: { host: 'localhost:4848', ...KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const res = await post({ n: 1, type: 'image/png', data: Buffer.from('png bytes').toString('base64') });
  assert.equal(res.status, 200);
  const { name } = (await res.json()) as { name: string };
  const got = await app.request(`/api/items/${id}/pasted/1/${name}`, HOST);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(await got.text(), 'png bytes');
  assert.equal((await post({ n: 1, type: 'text/html', data: 'eA==' })).status, 409);
  assert.equal((await decide(app, id, { n: 1, decision: 'answer', answers: [{ id: 'Q1', choice: null, images: ['../../config.json'] }] })).status, 400);
  assert.equal((await decide(app, id, { n: 1, decision: 'answer', answers: [{ id: 'Q1', choice: null, other: '', images: [name] }] })).status, 200);
});

// ---- Framing: another website must not put bateson in a frame and steer clicks into it.

test('no other website may frame the app, and a file keeps its own sandboxing policy', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bateson-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>bateson</title>');
  const { app } = createApp({ dist });
  for (const url of ['/', '/api/state']) {
    const res = await app.request(url, HOST);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', url);
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'", url);
  }
  const { id } = sent();
  const item = store.getItem(id)!;
  fs.mkdirSync(path.join(item.dir, 'v1', 'files'), { recursive: true });
  fs.writeFileSync(path.join(item.dir, 'v1', 'files', 'notes.html'), '<script>alert(1)</script>');
  const file = await app.request(`/api/items/${id}/files/1/notes.html`, HOST);
  assert.match(file.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal(file.headers.get('cross-origin-resource-policy'), 'same-origin');
  // A PDF keeps out of the sandbox (a browser's viewer may not show it there), and still loads nothing.
  fs.writeFileSync(path.join(item.dir, 'v1', 'files', 'spec.pdf'), '%PDF-1.1');
  const pdf = await app.request(`/api/items/${id}/files/1/spec.pdf`, HOST);
  assert.match(pdf.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.doesNotMatch(pdf.headers.get('content-security-policy') || '', /sandbox/);
  // Settings keeps only the keys it knows, not ones every object has.
  await app.request('/api/config', { ...HOST, method: 'PUT', headers: { ...HOST.headers, 'content-type': 'application/json' }, body: JSON.stringify({ bring: { toString: true } }) });
  assert.ok(!Object.hasOwn(store.readConfig().bring, 'toString'));
  // The queue's folder is the user's alone.
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.ROOT).mode & 0o077, 0);
  fs.rmSync(dist, { recursive: true, force: true });
});

test('a folder given as an attachment is refused before the unread version it would replace is touched', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { id } = sent();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bateson-attach-'));
  assert.throws(() => store.send({ itemId: id, kind: 'review', bodyType: 'markdown', title: 'Copy', body: 'Again', attachments: [folder], source: {} }), /not a file/);
  const item = store.getItem(id)!;
  assert.equal(item.versions.length, 1);
  assert.equal(store.readBody(item, store.currentVersion(item)), 'Hello', 'the version is still there, body and all');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a form cannot post, even empty and from bateson\'s own page: only JSON changes anything', async () => {
  const { app } = createApp({ dist: null });
  const { id } = sent();
  const own = { host: 'localhost:4848', ...KEY, origin: 'http://localhost:4848', 'sec-fetch-site': 'same-origin' };
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
    const res = await app.request(`/api/items/${id}/later`, { method: 'POST', headers: { ...own, 'content-type': type, 'content-length': '0' } });
    assert.equal(res.status, 415, type);
  }
  assert.equal((await app.request(`/api/items/${id}/later`, { method: 'POST', headers: own })).status, 415, 'no type at all');
  assert.equal((await app.request(`/api/items/${id}/later`, { method: 'POST', headers: { ...own, 'content-type': 'application/json' } })).status, 200);
});

// ---- The service worker that answers a load while the server is down (web/public/sw.js).

test('the service worker and its waiting page are served as themselves and never cached, so new ones are picked up at once', async () => {
  const dist = fs.mkdtempSync(path.join(TMP, 'dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>app');
  fs.writeFileSync(path.join(dist, 'sw.js'), '// sw');
  fs.writeFileSync(path.join(dist, 'waiting.html'), '<!doctype html><p>waiting');
  const { app } = createApp({ dist });
  for (const [file, type, body] of [['/sw.js', /javascript/, '// sw'], ['/waiting.html', /html/, '<!doctype html><p>waiting']] as const) {
    const res = await app.request(file, HOST);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type') || '', type, file);
    assert.equal(res.headers.get('cache-control'), 'no-cache', file);
    assert.equal(await res.text(), body, file);
  }
});

// ---- What the server watches and keeps. A waiting agent touches its waiter.json every few seconds; that used to
// have every page read the whole queue again each time.

const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a waiter coming and going, and a decision, reach the pages; its heartbeat and the logs do not', async () => {
  const { id } = sent();
  const item = store.getItem(id)!;
  let calls = 0;
  const settled = async () => { await quiet(600); const c = calls; calls = 0; return c; };
  const watch = watchQueue(HOME, () => calls++, { settle: 50 });
  try {
    await settled();
    store.writeWaiter(item, { pid: process.pid, n: 1 });
    assert.equal(await settled(), 1, 'a waiter arrives');
    for (let i = 0; i < 3; i++) { store.beat(item, process.pid); await quiet(150); }
    assert.equal(await settled(), 0, 'its heartbeat');
    fs.appendFileSync(path.join(HOME, 'hooks.log'), 'x\n');
    fs.appendFileSync(path.join(HOME, 'server.log'), 'x\n');
    assert.equal(await settled(), 0, 'the logs');
    store.decide(id, 1, { decision: 'approve' });
    assert.equal(await settled(), 1, 'a decision');
    store.clearWaiter(item);
    assert.equal(await settled(), 1, 'the waiter goes');
  } finally { watch.close(); }
});

test('a done item the server kept is read again once it is told the item changed', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'kept-'));
  const s = openStore(root, { claudeDir: null });
  s.keepDone();
  const send = (itemId?: string) => s.send({ itemId, kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Hello', source: {} });
  const { id } = send();
  s.decide(id, 1, { decision: 'approve' });
  s.fileAway(s.getItem(id)!);
  const done = s.getItem(id)!;
  assert.equal(s.isQueued(done), false);
  assert.equal(s.readWithdrawn(done), null);
  // Another process (an agent's `bateson cancel`) writes to it: kept as it was until the watcher says so.
  const file = path.join(done.dir, 'withdrawn.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), n: 1 }));
  assert.equal(s.readWithdrawn(done), null);
  s.forget(file);
  assert.equal(s.readWithdrawn(s.getItem(id)!)?.n, 1);
  // What it does itself needs no telling: another round takes it back into the queue, and it is filed again.
  fs.rmSync(file);
  s.forget(null);
  send(id);
  s.decide(id, 2, { decision: 'approve' });
  s.fileAway(s.getItem(id)!);
  const again = s.getItem(id)!;
  assert.equal(again.versions.length, 2);
  assert.equal(s.readDecision(again, 2)?.decision, 'approve');
  assert.deepEqual(s.allDone().map((it) => it.versions.length), [2]);
});

test('a settings change naming something every object has ("constructor") is ignored, like any unknown key', async () => {
  const { app } = createApp({ dist: null });
  const res = await app.request('/api/config', { method: 'PUT', headers: { host: 'localhost:4848', ...KEY, 'content-type': 'application/json' }, body: '{"constructor":{"a":1},"__proto__":{"b":2},"toString":"x","sound":false}' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { sound: boolean }).sound, false);
});

test('an address under /api that is not one is said so as JSON, not answered with the page', async () => {
  const { app } = createApp();
  const res = await app.request('/api/nope', HOST);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('answers that do not fit the round are refused: another question, the same one twice, an option it has not', async () => {
  const { app } = createApp({ dist: null });
  const opt = (label: string) => ({ label });
  const { id, n } = store.send({ kind: 'decision', bodyType: 'questions', title: 'Round', source: {}, body: { questions: [
    { id: 'Q1', title: 'One?', options: [opt('A'), opt('B')] }, { id: 'Q2', title: 'Two?', options: [opt('A'), opt('B')] },
  ] } });
  for (const answers of [[{ id: 'Q9', choice: 0 }], [{ id: 'Q1', choice: 0 }, { id: 'Q1', choice: 1 }], [{ id: 'Q1', choice: 2 }], [{ id: 'Q1', choice: -1 }]]) {
    assert.equal((await decide(app, id, { n, decision: 'answer', answers })).status, 400, JSON.stringify(answers));
  }
  assert.equal(store.readDecision(store.getItem(id)!, n), null, 'nothing was written');
  assert.equal((await decide(app, id, { n, decision: 'answer', answers: [{ id: 'Q1', choice: 1 }, { id: 'Q2', choice: null, other: 'Neither' }] })).status, 200);
});

test('the live updates say how many changes were told when they connect, and the queue says the same, so a page asks once', async () => {
  const { app, changed } = createApp({ dist: null });
  const told = async () => Number((await app.request('/api/state', HOST)).headers.get('x-bateson-told'));
  const hello = async () => {
    const res = await app.request('/api/events', HOST);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
  };
  assert.equal(await told(), 0);
  assert.match(await hello(), /^data: hello 0\n/);
  changed();
  assert.equal(await told(), 1, 'a look after the change says so');
  assert.match(await hello(), /^data: hello 1\n/, 'and updates connecting after an older look say there is something newer');
});

test('the server keeps done items as read, finds the cancelled and the next round being written among those noted lately, and sees a new one', () => {
  const kept = openStore(HOME, { claudeDir: null });
  const round = () => kept.send({ kind: 'decision', bodyType: 'questions', title: 'Round', source: {}, body: { questions: [
    { id: 'Q1', title: 'One?', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'Q2', title: 'Two?', options: [{ label: 'A' }, { label: 'B' }] } ] } });
  const answered = round();
  kept.decide(answered.id, 1, { decision: 'answer', answers: [{ id: 'Q1', choice: 0 }, { id: 'Q2', choice: 1 }] });
  kept.claimDelivery(kept.getItem(answered.id)!, 1, 'test');
  kept.fileAway(kept.getItem(answered.id)!);
  kept.keepDone();
  const first = kept.doneKept();
  assert.deepEqual(first.map((it) => it.id), [answered.id]);
  assert.equal(kept.doneKept()[0], first[0], 'the same object, not read and parsed again');
  assert.deepEqual(kept.writing(kept.lately(kept.doneKept()), null).map((w) => w.id), [answered.id], 'its next round is being written');
  // Cancelled before any answer: nothing was handed over, and it is still found without looking at every done item.
  const called = round();
  assert.equal(kept.withdraw(kept.getItem(called.id)!, 'test'), 'waiting');
  const done = kept.doneKept();
  assert.deepEqual(done.map((it) => it.id).sort(), [answered.id, called.id].sort(), 'the folder is listed again once an item is filed');
  assert.deepEqual(kept.withdrawnSince(Date.now() - 60_000, kept.lately(done)).map((x) => x.item.id), [called.id]);
  // A note gone (a day old): the item is no longer among the recent ones, once the store is told.
  fs.rmSync(path.join(HOME, 'recent', `${called.id}.json`));
  kept.forget(path.join(HOME, 'recent', `${called.id}.json`));
  assert.deepEqual(kept.lately(kept.doneKept()).map((it) => it.id), [answered.id]);
});

test('the queue is answered only to who has the key: the command, the Mac app, a page opened with a ticket', async () => {
  const dist = fs.mkdtempSync(path.join(TMP, 'dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>bateson</title>');
  const { app } = createApp({ dist });
  const bare = { headers: { host: 'localhost:4848' } };
  const json = { 'content-type': 'application/json' };
  // Another account on this machine: the page and whether the server is up, nothing of the queue.
  assert.equal((await app.request('/', bare)).status, 200);
  assert.equal((await app.request('/api/health', bare)).status, 200);
  for (const url of ['/api/state', '/api/summary', '/api/config', '/api/events', '/api/update', '/api/items/q_x/files/1/a.png']) assert.equal((await app.request(url, bare)).status, 401, url);
  for (const url of ['/api/update', '/api/restart', '/api/ticket', '/api/hooks']) assert.equal((await app.request(url, { method: 'POST', headers: { ...bare.headers, ...json } })).status, 401, url);
  assert.equal((await app.request('/api/config', { method: 'PUT', headers: { ...bare.headers, ...json }, body: '{"name":"x"}' })).status, 401);
  assert.equal((await app.request('/api/state', { headers: { ...bare.headers, authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await app.request('/api/state', { headers: { ...bare.headers, cookie: 'bateson-4848=nope' } })).status, 401);
  // A ticket, from who has the key, signs a page in: once.
  const { ticket } = await (await app.request('/api/ticket', { method: 'POST', headers: { ...HOST.headers, ...json } })).json() as { ticket: string };
  const opened = await app.request(`/?ticket=${ticket}`, bare);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/');
  const cookie = (opened.headers.get('set-cookie') || '').split(';')[0];
  assert.match(opened.headers.get('set-cookie') || '', /^bateson-4848=\w+;.*HttpOnly/);
  assert.equal((await app.request('/api/state', { headers: { ...bare.headers, cookie } })).status, 200);
  const again = await app.request(`/?ticket=${ticket}`, bare);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('set-cookie'), null, 'a ticket works once');
  assert.equal((await app.request('/?ticket=made-up', bare)).headers.get('set-cookie'), null);
  // The Mac app's window asks with the key, and its page keeps the cookie.
  assert.match((await app.request('/', HOST)).headers.get('set-cookie') || '', /^bateson-4848=/);
  // The key is the user's alone to read.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(HOME, 'key')).mode & 0o077, 0);
  fs.rmSync(dist, { recursive: true, force: true });
});

test('a ticket sends the browser back to this server only, never to a path that names another site', async () => {
  const { app } = createApp({ dist: null });
  const bare = { headers: { host: 'localhost:4848' } };
  for (const url of ['//evil.example/?ticket=x', '/\\evil.example/?ticket=x', '///evil.example?ticket=x']) {
    const to = (await app.request(url, bare)).headers.get('location') || '';
    assert.ok(to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\'), `${url} -> ${to}`);
  }
});

test('an item.json without versions is left out of the queue, and the queue still reads', async () => {
  const { app } = createApp({ dist: null });
  const { id } = sent();
  const bad = path.join(HOME, 'items', 'q_broken');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'item.json'), JSON.stringify({ id: 'q_broken', kind: 'review', title: 'x', versions: [] }));
  assert.equal(store.getItem('q_broken'), null);
  const res = await app.request('/api/state', HOST);
  assert.equal(res.status, 200);
  assert.ok(JSON.stringify(await res.json()).includes(id));
});

test('a setting of the wrong type in config.json reads as its default', () => {
  fs.mkdirSync(HOME, { recursive: true });
  const file = path.join(HOME, 'config.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ name: 5, sound: 'yes' }));
    const c = store.readConfig();
    assert.equal(c.name, '');
    assert.equal(c.sound, true);
  } finally { if (before == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); }
});

test('a delivery that lands while a send is writing the next version leaves the item whole, in the queue', () => {
  const { id } = sent();
  store.decide(id, 1, { decision: 'approve' } as never);
  const item = store.getItem(id)!;
  fs.writeFileSync(path.join(item.dir, 'replacing.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  store.fileAway(item);
  assert.ok(fs.existsSync(path.join(HOME, 'items', id, 'item.json')), 'not moved while a send is writing');
  fs.rmSync(path.join(item.dir, 'replacing.json'));
  store.fileAway(store.getItem(id)!);
  assert.ok(fs.existsSync(path.join(HOME, 'done', id, 'item.json')), 'moved once the send is done');
});

test('a recording is sent in the ranges asked for, read from disk as it goes', async () => {
  const { app } = createApp({ dist: null });
  const { id } = sent();
  const item = store.getItem(id)!;
  fs.mkdirSync(path.join(item.dir, 'v1', 'files'), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(item.dir, 'v1', 'files', 'clip.mp4'), bytes);
  const url = `/api/items/${id}/files/1/clip.mp4`;
  const part = await app.request(url, { headers: { ...HOST.headers, range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  const end = await app.request(url, { headers: { ...HOST.headers, range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await end.arrayBuffer()), bytes.subarray(995));
  const whole = await app.request(url, HOST);
  assert.equal(whole.status, 200);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  assert.equal((await app.request(url, { headers: { ...HOST.headers, range: 'bytes=2000-' } })).status, 416);
  fs.writeFileSync(path.join(item.dir, 'v1', 'files', 'empty.txt'), '');
  assert.equal(await (await app.request(`/api/items/${id}/files/1/empty.txt`, HOST)).text(), '');
});

test('a key file left empty (a crash while it was written) is replaced, not a lock-out', () => {
  const file = path.join(store.ROOT, 'key');
  const before = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const key = accessKey();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(accessKey(), key, 'the same key the next time');
  } finally { fs.writeFileSync(file, before); }
});
