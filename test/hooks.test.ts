// The wake-up hook and the CLI, run as Claude Code runs them: a child process with the hook's JSON on stdin.
// This test process stands in for Claude Code: its pid is in the scratch list of running sessions.
import { REPO, TMP, sessionOpen, reset, childEnv } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from '../lib/store.ts';
import { own, checkoutOf, collect } from '../lib/delivery.ts';
import { stableNode, missingHooks, writeHooks } from '../lib/claude-settings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(reset);

function item(owner?: string) {
  const res = store.send({ kind: 'review', bodyType: 'markdown', title: 'Plan for billing', note: 'Step 3.', body: 'Plan', source: { agent: 'claude-code', cwd: REPO, top: checkoutOf(REPO)!, repo: 'repo' } });
  const it = store.getItem(res.id)!;
  if (owner) own(it, { sessionId: owner, cwd: REPO });
  return it;
}

/** Run hooks/rewake.mjs (which runs rewake.ts) after a Bash call; resolves with how it exited and what it said. */
function rewake(stdout: string, command = 'bateson send --title "Plan" --file plan.md', env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'rewake.mjs')], { env: childEnv(env), cwd: REPO });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.end(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'S', cwd: REPO, transcript_path: path.join(TMP, 's.jsonl'),
    tool_name: 'Bash', tool_input: { command }, tool_response: { stdout },
  }));
  const done = new Promise<{ code: number | null; err: string }>((r) => child.on('exit', (code) => r({ code, err })));
  return { child, done };
}

async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(100); }
}

test('the wake-up hook waits, then wakes its session with the answer', async () => {
  sessionOpen(process.pid, 'S');
  const it = item();
  const { done } = rewake(`queued ${it.id} v1\nThe user will see it in bateson.`);
  await until(() => !!store.waiter(store.getItem(it.id)!));
  assert.equal(store.readSession(store.getItem(it.id)!)?.sessionId, 'S', 'the item is tied to the session');
  store.decide(it.id, 1, { decision: 'approve' });
  const { code, err } = await done;
  assert.equal(code, 2);
  assert.match(err, new RegExp(`\\(${it.id}, v1\\)`));
});

test('with the output piped away, the hook finds what its session just sent', async () => {
  sessionOpen(process.pid, 'S');
  const it = item('S');
  const { done } = rewake('', 'bateson send --title "Plan" --file plan.md | tail -1');
  await until(() => !!store.waiter(store.getItem(it.id)!));
  store.decide(it.id, 1, { decision: 'approve' });
  assert.equal((await done).code, 2);
});

test('when its session moves on, the hook lets go and leaves the answer for whoever may take it', async () => {
  sessionOpen(process.pid, 'S');
  const it = item();
  const { done } = rewake(`queued ${it.id} v1`);
  await until(() => !!store.waiter(store.getItem(it.id)!));
  sessionOpen(process.pid, 'S-after-clear'); // a /clear: same process, another conversation
  assert.equal((await done).code, 0);
  assert.equal(store.readWaiter(store.getItem(it.id)!), null, 'no waiter left behind');
  store.decide(it.id, 1, { decision: 'approve' });
  assert.equal(collect({ sessionId: 'S-after-clear', cwd: REPO }, 'test').length, 1);
});

test('before its time runs out, the hook wakes its session to renew the wait', async () => {
  sessionOpen(process.pid, 'S');
  const it = item();
  const { code, err } = await rewake(`queued ${it.id} v1`, undefined, { BATESON_REARM_AFTER: '2' }).done;
  assert.equal(code, 2);
  assert.match(err, new RegExp(`bateson rearm ${it.id}`));
  assert.equal(store.readWaiter(store.getItem(it.id)!), null, 'it let go before waking the session');

  // The session does as it is told; the hook starts again on that command and is woken by the answer.
  const out = cli(['rearm', it.id], { CLAUDE_CODE_SESSION_ID: 'S' });
  assert.equal(out[0], `waiting ${it.id} v1`);
  const again = rewake(out.join('\n'), `bateson rearm ${it.id}`);
  await until(() => !!store.waiter(store.getItem(it.id)!));
  store.decide(it.id, 1, { decision: 'approve' });
  const woken = await again.done;
  assert.equal(woken.code, 2);
  assert.match(woken.err, new RegExp(`\\(${it.id}, v1\\)`));
});

test('a question more than a day old is not renewed: the hook lets go quietly', async () => {
  sessionOpen(process.pid, 'S');
  const it = item();
  const file = path.join(it.dir, 'item.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.versions[0].createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(json));
  const { code, err } = await rewake(`queued ${it.id} v1`, undefined, { BATESON_REARM_AFTER: '1' }).done;
  assert.equal(code, 0);
  assert.equal(err, '');
});

function cli(args: string[], env: Record<string, string>, input = '') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bateson.ts'), ...args], { env: childEnv(env), cwd: REPO, input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n');
}

test('bateson send ties the item to its session, from CLAUDE_CODE_SESSION_ID', () => {
  const out = cli(['send', '--title', 'Plan', '--note', 'n', '--stdin'], { CLAUDE_CODE_SESSION_ID: 'S1' }, 'body');
  const id = /queued (q_[a-z0-9]+)/.exec(out[0])![1];
  assert.equal(store.readSession(store.getItem(id)!)?.sessionId, 'S1');
  assert.match(out.at(-1)!, /bateson wait|End your turn/, 'what to do next is the last line');
});

test('bateson send finds its session from the Claude Code process above it', () => {
  sessionOpen(process.pid, 'P');
  const out = cli(['send', '--title', 'Plan', '--note', 'n', '--stdin'], {}, 'body');
  const id = /queued (q_[a-z0-9]+)/.exec(out[0])![1];
  assert.equal(store.readSession(store.getItem(id)!)?.sessionId, 'P');
});

test('bateson inbox does not hand over another open session\'s answer', () => {
  sessionOpen(process.pid, 'P');
  const it = item('P');
  store.decide(it.id, 1, { decision: 'approve' });
  assert.match(cli(['inbox'], { CLAUDE_CODE_SESSION_ID: 'Q' }).join('\n'), /no responses/);
  assert.match(cli(['inbox'], { CLAUDE_CODE_SESSION_ID: 'P' }).join('\n'), new RegExp(it.id));
});

/** Run hooks/catchup.mjs (which runs catchup.ts) for session `sessionId` in REPO; what it tells the session ('' for nothing). */
function catchup(event: 'SessionStart' | 'UserPromptSubmit', sessionId: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'catchup.mjs')], {
    env: childEnv(), cwd: REPO, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: REPO, transcript_path: path.join(TMP, `${sessionId}.jsonl`), ...extra }),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('a session starting in the repo never gets the answer of another session, even one that has ended', () => {
  const it = item('A'); // A is not in Claude Code's list of running sessions: it has ended
  store.decide(it.id, 1, { decision: 'approve' });
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.doesNotMatch(catchup('SessionStart', 'B', { source }), new RegExp(it.id), `not on ${source}`);
  }
  assert.doesNotMatch(catchup('UserPromptSubmit', 'B', { prompt: 'carry on' }), new RegExp(it.id));
  assert.match(catchup('SessionStart', 'A', { source: 'resume' }), new RegExp(`\\(${it.id}, v1\\)`), 'resuming the session that asked gets it');
});

test('the session that asked gets its answer on its next prompt', () => {
  sessionOpen(process.pid, 'A');
  const it = item('A');
  store.decide(it.id, 1, { decision: 'approve' });
  assert.doesNotMatch(catchup('UserPromptSubmit', 'B', { prompt: 'hi' }), new RegExp(it.id));
  assert.match(catchup('UserPromptSubmit', 'A', { prompt: 'hi' }), new RegExp(`\\(${it.id}, v1\\)`));
  assert.doesNotMatch(catchup('UserPromptSubmit', 'A', { prompt: 'hi' }), new RegExp(it.id), 'once');
});

test('bateson rearm hands over an answer that arrived meanwhile, but only to the session that asked', () => {
  sessionOpen(process.pid, 'P');
  const it = item('P');
  store.decide(it.id, 1, { decision: 'approve' });
  assert.match(cli(['rearm', it.id], { CLAUDE_CODE_SESSION_ID: 'Q' }).join('\n'), /not this session's to take/);
  assert.match(cli(['rearm', it.id], { CLAUDE_CODE_SESSION_ID: 'P' }).join('\n'), new RegExp(`\\(${it.id}, v1\\)`));
});

test('a hook whose Node is gone counts as missing', () => {
  const file = path.join(TMP, 'settings.json');
  writeHooks({ file });
  assert.deepEqual(missingHooks(file), []);
  const text = fs.readFileSync(file, 'utf8').replace(/"command": "\\"[^"\\]+\\"/g, '"command": "\\"/no/such/node\\"');
  fs.writeFileSync(file, text);
  assert.ok(missingHooks(file).includes('PostToolUse'));
});

test('hooks an install wrote before the launchers, pointing at the .ts files, still count as there', () => {
  const file = path.join(TMP, 'settings-legacy.json');
  writeHooks({ file });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('.mjs\\"', '.ts\\"'));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\.mjs/);
  assert.deepEqual(missingHooks(file), []);
  writeHooks({ file });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /rewake\.mjs/, 'an install puts the launchers in their place');
  assert.doesNotMatch(text, /hooks\/\w+\.ts/, 'and leaves none of the old entries');
});

test('the hooks use a link to Node that survives an upgrade, where there is one', { skip: process.platform === 'win32' && 'a symlink needs Developer Mode on Windows' }, () => {
  const bin = path.join(TMP, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, [bin]), path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, [path.join(TMP, 'nothing')]), process.execPath);
});

test('a hook that fails lets the session carry on, and writes it down', () => {
  // A queue where the sessions folder cannot be made (a file is in its way): the hook throws on the first write.
  const queue = path.join(TMP, 'broken-queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'sessions'), '');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'catchup.mjs')], {
    env: childEnv({ BATESON_HOME: queue }), input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x', cwd: REPO }), encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'the session carries on');
  assert.equal(r.stdout, '', 'and is told nothing');
  assert.match(fs.readFileSync(path.join(queue, 'hooks.log'), 'utf8'), /catchup\.ts .*EEXIST|catchup\.ts .*ENOTDIR/);
});
