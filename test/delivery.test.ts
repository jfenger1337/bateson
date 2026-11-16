// Who gets a response: the session that asked while it is open, another session in its repository only once
// it has ended, nobody in another repository, and never twice.
import { REPO, OTHER, sessionOpen, sessionClosed, reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import store from '../lib/store.ts';
import { collect, own, checkoutOf, reachOf } from '../lib/delivery.ts';
import { deliveryMark } from '../lib/kinds.ts';

// Two Claude Code processes that are really alive, so the session list counts them as running.
const A_PID = process.pid;
const B_PID = process.ppid;

beforeEach(reset);

/** An item sent from session `owner` in `repo`, already approved. */
function answered(owner: string | null, repo = REPO) {
  const res = store.send({
    kind: 'review', bodyType: 'markdown', title: 'Copy for the empty queue', note: 'Read it.', body: 'Hello',
    source: { agent: 'claude-code', cwd: repo, top: checkoutOf(repo)!, repo: path.basename(repo) },
  });
  const item = store.getItem(res.id)!;
  if (owner) own(item, { sessionId: owner, cwd: repo });
  store.decide(res.id, res.n, { decision: 'approve' });
  return store.getItem(res.id)!;
}

test('another session in the repo does not get an answer while the session that asked is open', () => {
  sessionOpen(A_PID, 'A');
  sessionOpen(B_PID, 'B');
  answered('A');
  assert.deepEqual(collect({ sessionId: 'B', cwd: REPO }, 'test'), []);
});

test('the session that asked gets its answer on its next prompt, once', () => {
  sessionOpen(A_PID, 'A');
  const item = answered('A');
  const msgs = collect({ sessionId: 'A' }, 'test');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], new RegExp(deliveryMark(item.id, 1).replace(/[()]/g, '\\$&')));
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), []);
});

test('once the session that asked has ended, the next session in the repo gets it', () => {
  sessionOpen(A_PID, 'A');
  sessionOpen(B_PID, 'B');
  answered('A');
  sessionClosed(A_PID);
  assert.equal(collect({ sessionId: 'B', cwd: REPO }, 'test').length, 1);
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), [], 'and nobody gets it twice');
});

test('a /clear counts as the session ending: its process is on another session now', () => {
  sessionOpen(A_PID, 'A');
  answered('A');
  sessionOpen(A_PID, 'A-after-clear');
  assert.equal(collect({ sessionId: 'A-after-clear', cwd: REPO }, 'test').length, 1);
});

test('a session in another repository never gets it', () => {
  answered('A');
  assert.deepEqual(collect({ sessionId: 'B', cwd: OTHER }, 'test'), []);
});

test('an item no session claimed goes to the next session in its repo', () => {
  sessionOpen(B_PID, 'B');
  answered(null);
  assert.equal(collect({ sessionId: 'B', cwd: REPO }, 'test').length, 1);
});

test('a hook still waiting keeps the answer; a waiter that stopped touching its file does not', () => {
  sessionOpen(A_PID, 'A');
  const item = answered('A');
  store.writeWaiter(item, { pid: process.pid, sessionId: 'A', n: 1 });
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), [], 'left to the hook');
  // A process id that is alive but belongs to something else now: the waiter's file has gone quiet.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(item.dir, 'waiter.json'), old, old);
  assert.equal(collect({ sessionId: 'A' }, 'test').length, 1);
});

test('the app is told where an undecided answer will go', () => {
  sessionOpen(A_PID, 'A');
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 't', note: 'n', body: 'b', source: { cwd: REPO, top: checkoutOf(REPO)!, repo: 'repo' } });
  const item = store.getItem(res.id)!;
  assert.equal(reachOf(item), 'next-session', 'nobody claimed it');
  own(item, { sessionId: 'A' });
  assert.equal(reachOf(item), 'its-session');
  store.writeWaiter(item, { pid: process.pid, sessionId: 'A', n: 1 });
  assert.equal(reachOf(item), 'waiting');
  sessionClosed(A_PID);
  store.clearWaiter(item);
  assert.equal(reachOf(item), 'next-session');
});

/** A wake-up delivered the answer to session `to` two minutes ago, with this transcript. */
function wokeUp(item: ReturnType<typeof answered>, to: string, transcript: string) {
  const vdir = path.join(item.dir, 'v1');
  fs.writeFileSync(path.join(vdir, 'delivered.json'), JSON.stringify({ at: new Date(Date.now() - 120_000).toISOString(), by: `rewake:${to}`, sessionId: to, transcript }));
  store.fileAway(item);
  return store.getItem(item.id)!;
}

test('a wake-up found in its transcript is confirmed and not handed over again', () => {
  sessionOpen(A_PID, 'A');
  const item = answered('A');
  const transcript = path.join(REPO, '..', 'a.jsonl');
  fs.writeFileSync(transcript, `{"message":"From bateson: bateson: the user responded to \\"x\\" ${deliveryMark(item.id, 1)}."}\n`);
  const done = wokeUp(item, 'A', transcript);
  assert.deepEqual(collect({ sessionId: 'A', cwd: REPO }, 'test'), []);
  assert.ok(store.isConfirmed(done, 1));
});

test('a wake-up that never reached its conversation is handed over again, once, to that session', () => {
  sessionOpen(A_PID, 'A');
  sessionOpen(B_PID, 'B');
  const item = answered('A');
  const transcript = path.join(REPO, '..', 'a2.jsonl');
  fs.writeFileSync(transcript, '{"message":"something else"}\n');
  wokeUp(item, 'A', transcript);
  assert.deepEqual(collect({ sessionId: 'B', cwd: REPO }, 'test'), [], 'not to another open session');
  const msgs = collect({ sessionId: 'A' }, 'test');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /may not have reached it/);
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), [], 'only once');
});

test('a lost wake-up whose session has ended goes to the next session in the repo', () => {
  sessionOpen(B_PID, 'B');
  const item = answered('A');
  wokeUp(item, 'A', path.join(REPO, '..', 'gone.jsonl'));
  assert.equal(collect({ sessionId: 'B', cwd: REPO }, 'test').length, 1);
});
