// Who gets a response: the session that asked; `bateson inbox` in its repository (a Who with a cwd) only once
// that session has ended; nobody in another repository; and never twice. The hooks ask only for their own
// session (test/hooks.test.ts).
import { REPO, OTHER, sessionOpen, sessionClosed, reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import store from '../lib/store.ts';
import { claim, collect, own, checkoutOf, reachOf, awaitDecision } from '../lib/delivery.ts';
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

test('once the session that asked has ended, bateson inbox in the repo may take it', () => {
  sessionOpen(A_PID, 'A');
  sessionOpen(B_PID, 'B');
  answered('A');
  sessionClosed(A_PID);
  assert.equal(collect({ sessionId: 'B', cwd: REPO }, 'test').length, 1);
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), [], 'and nobody gets it twice');
});

test('for bateson inbox, a /clear counts as the session ending: its process is on another session now', () => {
  sessionOpen(A_PID, 'A');
  answered('A');
  sessionOpen(A_PID, 'A-after-clear');
  assert.equal(collect({ sessionId: 'A-after-clear', cwd: REPO }, 'test').length, 1);
});

test('a session in another repository never gets it', () => {
  answered('A');
  assert.deepEqual(collect({ sessionId: 'B', cwd: OTHER }, 'test'), []);
});

test('an item no session claimed goes to bateson inbox in its repo', () => {
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

test('a wait hears a decision as it is made, not at its next look', async () => {
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Hello', source: { cwd: REPO } });
  const t0 = Date.now();
  const waiting = awaitDecision(res.id, { by: 'test', every: 60_000, until: Date.now() + 30_000 });
  setTimeout(() => store.decide(res.id, res.n, { decision: 'approve' }), 300);
  assert.equal((await waiting).kind, 'decision');
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms: it waited for its next look`);
});

test('the app is told where an undecided answer will go', () => {
  sessionOpen(A_PID, 'A');
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 't', note: 'n', body: 'b', source: { cwd: REPO, top: checkoutOf(REPO)!, repo: 'repo' } });
  const item = store.getItem(res.id)!;
  assert.equal(reachOf(item), 'ended', 'nobody claimed it');
  own(item, { sessionId: 'A' });
  assert.equal(reachOf(item), 'its-session');
  store.writeWaiter(item, { pid: process.pid, sessionId: 'A', n: 1 });
  assert.equal(reachOf(item), 'waiting');
  sessionClosed(A_PID);
  store.clearWaiter(item);
  assert.equal(reachOf(item), 'ended');
});

/** A wake-up delivered the answer to session `to` two minutes ago, with this transcript. */
function wokeUp(item: ReturnType<typeof answered>, to: string, transcript: string) {
  const vdir = path.join(item.dir, 'v1');
  // Taken as the hook takes it, which notes the delivery among the recent ones; then set two minutes back.
  assert.ok(store.claimDelivery(item, 1, `rewake:${to}`, { sessionId: to, transcript }));
  fs.writeFileSync(path.join(vdir, 'delivered.json'), JSON.stringify({ at: new Date(Date.now() - 120_000).toISOString(), by: `rewake:${to}`, sessionId: to, transcript }));
  store.fileAway(item);
  return store.getItem(item.id)!;
}

test('a lost wake-up in a queue from before deliveries were noted is still found, and noted from then on', () => {
  sessionOpen(A_PID, 'A');
  const item = answered('A');
  wokeUp(item, 'A', path.join(REPO, '..', 'gone-before.jsonl'));
  const recent = path.join(store.ROOT, 'recent');
  fs.rmSync(recent, { recursive: true, force: true });
  assert.equal(store.unconfirmed().length, 1, 'found by reading every item, once');
  assert.deepEqual(fs.readdirSync(recent), [`${item.id}.json`]);
  assert.equal(collect({ sessionId: 'A' }, 'test').length, 1);
});

test('only items delivered in the last day are looked at for a lost wake-up, and an older note goes', () => {
  sessionOpen(A_PID, 'A');
  const item = answered('A');
  wokeUp(item, 'A', path.join(REPO, '..', 'gone-old.jsonl'));
  const note = path.join(store.ROOT, 'recent', `${item.id}.json`);
  fs.writeFileSync(note, JSON.stringify({ at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }));
  assert.deepEqual(store.unconfirmed(), []);
  assert.ok(!fs.existsSync(note));
});

test('a new item takes the colour after the newest one\'s without the done items being read', () => {
  const hues = ['slate', 'terracotta', 'moss', 'plum', 'ochre'];
  const first = answered(null);
  claim(first.id, 1, 'test');
  // The done item is gone from disk: only hue.json says what colour came last.
  fs.rmSync(path.join(store.ROOT, 'done'), { recursive: true, force: true });
  const next = store.getItem(store.send({ kind: 'review', bodyType: 'markdown', title: 't', note: 'n', body: 'b', source: { cwd: REPO, repo: 'repo' } }).id)!;
  assert.equal(next.hue, hues[(hues.indexOf(first.hue!) + 1) % hues.length]);
});

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

test('a lost wake-up whose session has ended goes to bateson inbox in the repo', () => {
  sessionOpen(B_PID, 'B');
  const item = answered('A');
  wokeUp(item, 'A', path.join(REPO, '..', 'gone.jsonl'));
  assert.equal(collect({ sessionId: 'B', cwd: REPO }, 'test').length, 1);
});

// ---- A version replaced in place while the reviewer decides it.

test('a decision made while the agent replaced the version is not a decision on the new text', () => {
  const first = answered(null);
  // A send-back, so the agent's next send is a new version 2, and then a revision of it before it is read.
  const back = store.send({ itemId: first.id, kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'v2', body: 'Text the reviewer read', source: {} });
  const seen = store.currentVersion(store.getItem(back.id)!).createdAt;
  const shot = path.join(REPO, 'shot.png');
  fs.writeFileSync(shot, 'png');
  // The reviewer's decision lands while the replacement is being written (the server is another process: here it
  // runs in the middle of copying the attachment, after the version's folder is made and before item.json says so).
  // It is refused as stale, so the app says so instead of saying it went through.
  const copy = fs.copyFileSync;
  fs.copyFileSync = ((...args: Parameters<typeof copy>) => {
    fs.copyFileSync = copy;
    assert.throws(() => store.decide(back.id, back.n, { decision: 'approve' }, { at: seen }), { code: 'stale' });
    return copy(...args);
  }) as typeof copy;
  try {
    store.send({ itemId: back.id, kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'v2 again', body: 'Text nobody read', attachments: [shot], source: {} });
  } finally { fs.copyFileSync = copy; }
  const it = store.getItem(back.id)!;
  const v = store.currentVersion(it);
  assert.equal(store.readBody(it, v), 'Text nobody read');
  assert.equal(store.readDecision(it, v.n), null, 'the new text is waiting, not approved');
  assert.ok(store.pending().some((r) => r.item.id === back.id));
  store.decide(back.id, v.n, { decision: 'approve' }, { at: v.createdAt });
  assert.equal(store.readDecision(it, v.n)?.decision, 'approve');
});

test('a version replaced in the same millisecond still has its own createdAt, so the old one cannot decide it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Text the reviewer read', source: {} });
  const seen = store.currentVersion(store.getItem(res.id)!).createdAt;
  store.send({ itemId: res.id, kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Text nobody read', source: {} });
  const v = store.currentVersion(store.getItem(res.id)!);
  assert.equal(v.n, res.n);
  assert.ok(v.createdAt > seen, 'the replacement is dated after the text it replaced');
  assert.throws(() => store.decide(res.id, v.n, { decision: 'approve' }, { at: seen }), { code: 'stale' });
});

test('a decision left from an earlier body of the version is ignored, and the version can still be decided', () => {
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Hello', source: {} });
  let it = store.getItem(res.id)!;
  const file = path.join(store.ROOT, 'items', res.id, 'v1', 'decision.json');
  fs.writeFileSync(file, JSON.stringify({ decision: 'approve', decidedAt: new Date().toISOString(), versionAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(store.readDecision(it, 1), null);
  assert.deepEqual(collect({ sessionId: 'A' }, 'test'), []);
  store.decide(res.id, 1, { decision: 'drop' }, { at: store.currentVersion(it).createdAt });
  it = store.getItem(res.id)!;
  assert.equal(store.readDecision(it, 1)?.decision, 'drop');
});

test('a decision that cannot be told is left undelivered, not marked delivered and lost', () => {
  sessionOpen(A_PID, 'A');
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Hello', source: {} });
  own(store.getItem(res.id)!, { sessionId: 'A' });
  // Written by hand, not by the app, in a shape the agent's message cannot be made from.
  fs.writeFileSync(path.join(store.ROOT, 'items', res.id, 'v1', 'decision.json'), JSON.stringify({ decision: 'send-back', comments: 'x', decidedAt: new Date().toISOString() }));
  assert.throws(() => collect({ sessionId: 'A' }, 'test'));
  assert.equal(store.isDelivered(store.getItem(res.id)!, 1), false);
});

test('while a send is writing the next version, a decision waits and none is delivered', () => {
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy', note: 'n', body: 'Text', source: {} });
  const item = store.getItem(res.id)!;
  const at = store.currentVersion(item).createdAt;
  store.decide(res.id, res.n, { decision: 'approve' }, { at });
  const mark = path.join(item.dir, 'replacing.json');
  fs.writeFileSync(mark, '{}');
  assert.equal(claim(res.id, res.n, 'test'), null, 'not delivered while the version may change under it');
  fs.rmSync(mark);
  assert.match(claim(res.id, res.n, 'test') || '', /Approved/);
});

test('a hook finds its Claude Code process from the session it is told, when exactly one live process lists it', () => {
  sessionOpen(A_PID, 'A');
  assert.equal(store.claudeProcess('A'), A_PID);
  assert.equal(store.claudeProcess('B'), null, 'no process lists it');
  sessionOpen(B_PID, 'A');
  assert.equal(store.claudeProcess('A'), null, 'two do: no telling which');
});

test('the working tree is recorded in a repository without a commit yet, and with its HEAD once there is one', async () => {
  const { snapshot } = await import('../lib/worktree.ts');
  const { execFileSync } = await import('node:child_process');
  fs.writeFileSync(path.join(REPO, 'new.md'), 'x\n');
  const before = snapshot(REPO)!;
  assert.equal(path.resolve(before.top), checkoutOf(REPO)); // git says C:/x on Windows
  assert.equal(before.head, null);
  assert.ok(before.files['new.md']);
  execFileSync('git', ['add', '.'], { cwd: REPO });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'first'], { cwd: REPO });
  assert.match(snapshot(REPO)!.head!, /^[0-9a-f]{40,64}$/);
});
