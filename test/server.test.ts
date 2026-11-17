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
