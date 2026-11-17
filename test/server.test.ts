// What the server tells `bateson send` about open pages, so a send opens a window only when none is open.
import { reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.ts';

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
