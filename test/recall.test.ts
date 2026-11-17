// `bateson recall`: past decisions, one line each, searched without an index.
import { REPO, OTHER, reset, childEnv } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from '../lib/store.ts';
import { recall } from '../lib/recall.ts';
import { checkoutOf } from '../lib/delivery.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
beforeEach(reset);

const src = (cwd: string) => ({ agent: 'claude-code', cwd, top: checkoutOf(cwd)!, repo: path.basename(cwd) });

/** An interview round on the sign-in, answered: Q1 over the recommendation, Q2 taking it, Q3 in their own words. */
function interview(cwd = REPO, choice = 0, at = new Date().toISOString()) {
  const { id } = store.send({
    kind: 'decision', bodyType: 'questions', title: 'Sign-in for the admin area', source: src(cwd),
    body: { questions: [
      { id: 'Q1', title: 'Who should be able to sign in?', body: 'Passwords or not.', options: [{ label: 'Email code' }, { label: 'Passkeys' }], recommended: 1 },
      { id: 'Q2', title: 'How long should a sign-in last?', options: [{ label: 'A day' }, { label: 'A month' }], recommended: 1 },
      { id: 'Q3', title: 'What should the button say?', options: [{ label: 'Sign in' }, { label: 'Log in' }] },
    ] },
  });
  store.decide(id, 1, { decision: 'answer', answers: [
    { id: 'Q1', choice }, { id: 'Q2', choice: 1, accepted: true }, { id: 'Q3', choice: null, other: 'Continue' },
  ] });
  // When it was decided, set here: two decisions in the same millisecond have no order.
  const file = path.join(store.getItem(id)!.dir, 'v1', 'decision.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), decidedAt: at }));
  return id;
}

test('an interview comes back one line per answer, saying how each relates to the recommendation', () => {
  interview();
  const lines = recall('').shown.map((r) => `${r.about} -> ${r.said}`);
  assert.ok(lines.includes('Who should be able to sign in? -> Email code (over the recommended "Passkeys")'));
  assert.ok(lines.includes('How long should a sign-in last? -> A month (the recommendation, taken as it was)'));
  assert.ok(lines.includes('What should the button say? -> wrote: "Continue"'));
});

test('words match the question first, then its body and options; short words are ignored', () => {
  interview();
  const { shown, words } = recall('the passkeys sign');
  assert.deepEqual(words, ['passkeys', 'sign']);
  assert.equal(shown[0].about, 'Who should be able to sign in?', 'best match first');
  assert.equal(recall('xyzzy').total, 0);
  assert.deepEqual(recall('a to of which should').words, []);
});

test('a question asked again shows once, at its latest answer, with what changed', () => {
  interview(REPO, 0, '2026-11-01T10:00:00.000Z');
  interview(REPO, 1, '2026-11-02T10:00:00.000Z');
  const q1 = recall('sign').shown.filter((r) => r.about === 'Who should be able to sign in?');
  assert.equal(q1.length, 1);
  assert.match(q1[0].said, /^Passkeys/);
  assert.match(q1[0].earlier, /changed: earlier "Email code/);
  const q2 = recall('long').shown.find((r) => r.about === 'How long should a sign-in last?')!;
  assert.match(q2.earlier, /same answer 2 times/);
});

test('the same question in another repository is its own decision; this checkout ranks first on a tie', () => {
  interview(OTHER, 1, '2026-11-02T10:00:00.000Z');
  interview(REPO, 0, '2026-11-01T10:00:00.000Z'); // older, but this checkout's
  const rows = recall('who should sign', { top: checkoutOf(REPO)!, repo: 'repo' }).shown.filter((r) => r.about.startsWith('Who'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].repo, 'repo');
});

test('reviews and findings: approvals, send-backs with their comments, dismissed findings with the reason', () => {
  const plan = store.send({ kind: 'review', bodyType: 'markdown', title: 'Plan: move billing to Stripe', note: 'Step 3.', body: 'Plan', source: src(REPO) });
  store.decide(plan.id, 1, { decision: 'send-back', comments: [{ id: 'c1', text: 'Do it after the migration.', anchor: { kind: 'text', quote: 'step 3' } }] });
  const copy = store.send({ kind: 'review', bodyType: 'markdown', title: 'Copy for the empty queue', note: 'Tone.', body: 'Nothing here.', source: src(REPO) });
  store.decide(copy.id, 1, { decision: 'approve' });
  const f = store.send({ kind: 'review', bodyType: 'findings', title: 'Review of sign-in', note: 'Two.', source: src(REPO),
    body: { findings: [{ id: 'F1', title: 'Tokens are logged', severity: 'high', body: '' }, { id: 'F2', title: 'Long function', severity: 'low', body: '' }] } });
  store.decide(f.id, 1, { decision: 'findings', marks: [{ id: 'F1', mark: 'keep' }, { id: 'F2', mark: 'dismiss', reason: 'fine as it is' }] });
  const said = recall('').shown.map((r) => `${r.about} -> ${r.said}`);
  assert.ok(said.includes('Plan: move billing to Stripe -> sent back: 1) on "step 3": Do it after the migration.'));
  assert.ok(said.includes('Copy for the empty queue -> approved'));
  assert.ok(said.includes('Long function -> dismissed the finding: fine as it is'));
  assert.ok(!said.some((s) => s.startsWith('Tokens are logged')), 'a finding kept without a comment says nothing new');
});

test('the command prints the lines and what to do with them, and refuses a search of only short words', () => {
  interview();
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bateson.ts'), 'recall', ...args], { cwd: REPO, env: childEnv(), encoding: 'utf8' });
  const out = run('passkeys');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /matching "passkeys"/);
  assert.match(out.stdout, /\d{4}-\d\d-\d\d {2}repo {2}Who should be able to sign in\? -> Email code \(over the recommended "Passkeys"\) {2}\(q_/);
  assert.match(out.stdout.trim().split('\n').at(-1)!, /is settled/);
  assert.match(run('nothing-like-it').stdout, /nothing .* matches/);
  assert.equal(run('of').status, 1);
  assert.equal(run('--limit', '0').status, 1);
});
