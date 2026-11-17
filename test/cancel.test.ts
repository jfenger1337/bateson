// Calling an item off from the terminal: you tell the agent to stop, it runs `bateson cancel`, and the item
// leaves the app's queue, the hook waiting on it lets go without waking anyone, and nothing answers it later.
import { REPO, TMP, sessionOpen, reset, childEnv } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from '../lib/store.ts';
import { own, checkoutOf, collect } from '../lib/delivery.ts';
import { stateView } from '../lib/view.ts';
import { createApp } from '../server/server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(reset);

/** An interview round sent from session `owner`. */
function interview(owner = 'S') {
  const body = { questions: [1, 2].map((i) => ({ id: `Q${i}`, title: `Question ${i}?`, options: [{ label: 'Yes' }, { label: 'No' }], recommended: 0 })) };
  const res = store.send({ kind: 'decision', bodyType: 'questions', title: 'Team accounts', body, source: { agent: 'claude-code', cwd: REPO, top: checkoutOf(REPO)!, repo: 'repo' } });
  const it = store.getItem(res.id)!;
  own(it, { sessionId: owner, cwd: REPO });
  return it;
}

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bateson.ts'), ...args], { env: childEnv(env), cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const answer = { decision: 'answer' as const, answers: [{ id: 'Q1', choice: 0 }, { id: 'Q2', choice: 1 }] };

test('a cancelled interview leaves the queue and the app says so', () => {
  const it = interview();
  assert.equal(stateView().current?.id, it.id);
  assert.match(cli(['cancel', it.id]), /Cancelled "Team accounts"/);
  const s = stateView();
  assert.equal(s.current, null);
  assert.deepEqual(s.queue, []);
  assert.deepEqual(s.cancelled.map((c) => c.id), [it.id]);
  assert.match(cli(['list']), /Nothing is waiting/);
  assert.match(cli(['status', it.id]), /was cancelled/);
});

test('an answer given after the cancel is refused, and one given before is never handed on', async () => {
  const it = interview();
  cli(['cancel', it.id]);
  const { app } = createApp({ dist: null });
  const res = await app.request(`/api/items/${it.id}/decide`, {
    method: 'POST', headers: { host: 'localhost:4848', 'content-type': 'application/json' }, body: JSON.stringify({ n: 1, ...answer }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'withdrawn');

  const other = interview();
  store.decide(other.id, 1, answer);
  assert.match(cli(['cancel', other.id]), /had already answered/);
  assert.deepEqual(collect({ sessionId: 'S', cwd: REPO }, 'test'), []);
});

test('the hook waiting on it lets go without waking the session', async () => {
  sessionOpen(process.pid, 'S');
  const it = interview();
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'rewake.ts')], { env: childEnv(), cwd: REPO });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.end(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'S', cwd: REPO, transcript_path: path.join(TMP, 's.jsonl'),
    tool_name: 'Bash', tool_input: { command: 'bateson send --title "Team accounts" --questions -' }, tool_response: { stdout: `queued ${it.id} v1` },
  }));
  const done = new Promise<number | null>((r) => child.on('exit', r));
  for (let i = 0; i < 100 && !store.waiter(store.getItem(it.id)!); i++) await sleep(100);
  assert.ok(store.waiter(store.getItem(it.id)!), 'the hook is waiting');
  cli(['cancel', it.id]);
  assert.equal(await done, 0);
  assert.equal(err, '');
  assert.match(cli(['rearm', it.id], { CLAUDE_CODE_SESSION_ID: 'S' }), /^bateson: .* was cancelled/, 'and rearm does not start a new wait');
});

test('without an id, it cancels only what this session has open', () => {
  const mine = interview('S');
  const theirs = interview('T');
  const out = cli(['cancel'], { CLAUDE_CODE_SESSION_ID: 'S' });
  assert.match(out, new RegExp(mine.id));
  assert.doesNotMatch(out, new RegExp(theirs.id));
  assert.deepEqual(store.pending().map((r) => r.item.id), [theirs.id]);
  assert.match(cli(['cancel'], { CLAUDE_CODE_SESSION_ID: 'S' }), /nothing to cancel/);
});

test('when you write in the terminal, the session hears what it still has waiting and how to cancel it', () => {
  const it = interview('S');
  const prompt = (sessionId: string) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'catchup.ts')], {
    env: childEnv(), cwd: REPO, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: REPO, prompt: 'stop the interview' }),
  }).stdout;
  assert.match(prompt('S'), new RegExp(`bateson cancel ${it.id}`));
  assert.doesNotMatch(prompt('T'), new RegExp(it.id), 'not another session');
  cli(['cancel', it.id]);
  assert.doesNotMatch(prompt('S'), /bateson cancel/, 'not once it is cancelled');
});

test('sending the next round of a cancelled interview puts it back in the queue', () => {
  const it = interview();
  cli(['cancel', it.id]);
  const body = { questions: [3, 4].map((i) => ({ id: `Q${i}`, title: `Question ${i}?`, options: [{ label: 'Yes' }], recommended: 0 })) };
  store.send({ itemId: it.id, kind: 'decision', bodyType: 'questions', body, source: { agent: 'claude-code', cwd: REPO } });
  assert.equal(store.readWithdrawn(store.getItem(it.id)!), null);
  assert.equal(stateView().current?.id, it.id);
});
