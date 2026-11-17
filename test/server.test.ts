// What the server tells `bateson send` about open pages, so a send opens a window only when none is open.
import { reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.ts';
import store from '../lib/store.ts';

beforeEach(reset);

const HOST = { headers: { host: 'localhost:4848' } };
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
  app.request(`/api/items/${id}/decide`, { method: 'POST', headers: { host: 'localhost:4848', 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
  const post = (body: unknown) => app.request(`/api/items/${id}/pasted`, { method: 'POST', headers: { host: 'localhost:4848', 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
  const own = { host: 'localhost:4848', origin: 'http://localhost:4848', 'sec-fetch-site': 'same-origin' };
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
    const res = await app.request(`/api/items/${id}/later`, { method: 'POST', headers: { ...own, 'content-type': type, 'content-length': '0' } });
    assert.equal(res.status, 415, type);
  }
  assert.equal((await app.request(`/api/items/${id}/later`, { method: 'POST', headers: own })).status, 415, 'no type at all');
  assert.equal((await app.request(`/api/items/${id}/later`, { method: 'POST', headers: { ...own, 'content-type': 'application/json' } })).status, 200);
});
