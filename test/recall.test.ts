// `bateson recall`: past decisions, one line each, searched without an index.
import { REPO, OTHER, reset, childEnv } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from '../lib/store.ts';
import { recall, overrides, overridesNote } from '../lib/recall.ts';
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

const here = () => { const top = checkoutOf(REPO)!; return { top, repo: path.basename(top) }; };

test('overrides: their own answers and options other than the recommended, in this checkout only, newest first', () => {
  interview(OTHER, 0, '2026-11-03T10:00:00.000Z');
  interview(REPO, 0, '2026-11-01T10:00:00.000Z');
  const list = overrides(here());
  assert.deepEqual(list.map((r) => r.about).sort(), ['What should the button say?', 'Who should be able to sign in?'], 'taking the recommendation is not one');
  assert.ok(list.every((r) => r.repo === 'repo'));
  assert.deepEqual(list.find((r) => r.about.startsWith('Who'))!.override, { chose: '"Email code"', over: 'Passkeys' });
  assert.deepEqual(list.find((r) => r.about.startsWith('What'))!.override, { chose: 'their own answer, "Continue"', over: undefined });
});

test('an override they later took back no longer counts', () => {
  interview(REPO, 0, '2026-11-01T10:00:00.000Z');
  interview(REPO, 1, '2026-11-02T10:00:00.000Z'); // Q1 now the recommended Passkeys
  assert.ok(!overrides(here()).some((r) => r.about.startsWith('Who')));
});

test('the note: one line each, at most five, and nothing at all when there are none', () => {
  assert.equal(overridesNote(here(), 'Sam'), '');
  for (let d = 1; d <= 4; d++) {
    const { id } = store.send({ kind: 'decision', bodyType: 'questions', title: `Round ${d}`, source: src(REPO), body: { questions: [
      { id: 'Q1', title: `Question ${d}?`, options: [{ label: 'Left' }, { label: 'Right' }], recommended: 0 },
      { id: 'Q2', title: `Other ${d}?`, options: [{ label: 'Up' }, { label: 'Down' }], recommended: 0 } ] } });
    store.decide(id, 1, { decision: 'answer', answers: [{ id: 'Q1', choice: 1 }, { id: 'Q2', choice: 1 }] });
  }
  const note = overridesNote(here(), 'Sam');
  assert.match(note, /^Where Sam went against an agent's recommendation in this repository lately/);
  const lines = note.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^- \d{4}-\d\d-\d\d .+\? They chose "Right" over the recommended "Left"\.$|^- \d{4}-\d\d-\d\d .+\? They chose "Down" over the recommended "Up"\.$/);
});

test('a new session hears the overrides with how they work; a session elsewhere does not', () => {
  interview(REPO, 0);
  const start = (cwd: string) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'catchup.mjs')], {
      env: childEnv(), input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x', cwd }), encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  };
  const told = start(REPO);
  assert.match(told, /^How the user works with bateson/);
  assert.match(told, /Who should be able to sign in\? They chose "Email code" over the recommended "Passkeys"\./);
  assert.doesNotMatch(start(OTHER), /went against/);
});

test('the note is kept until a decision joins the record: asked again it reads no item, and a new override shows at once', () => {
  interview(REPO, 0, '2026-11-01T10:00:00.000Z');
  const first = overridesNote(here(), 'Sam');
  assert.match(first, /Who should be able to sign in\?/);
  const kept = path.join(store.ROOT, 'cache', 'overrides.json');
  assert.ok(fs.existsSync(kept), 'kept in cache/overrides.json');
  // What is kept is what is told: changed by hand, the change shows, so nothing was read again.
  fs.writeFileSync(kept, fs.readFileSync(kept, 'utf8').replace('Who should be able to sign in?', 'Who may sign in?'));
  assert.match(overridesNote(here(), 'Sam'), /Who may sign in\?/);
  // A decision on an item still in the queue, where nothing moves: the note is worked out again.
  const { id } = store.send({ kind: 'decision', bodyType: 'questions', title: 'Colours', source: src(REPO), body: { questions: [
    { id: 'Q1', title: 'Which blue?', options: [{ label: 'Navy' }, { label: 'Sky' }], recommended: 0 },
    { id: 'Q2', title: 'Which red?', options: [{ label: 'Brick' }, { label: 'Rose' }], recommended: 0 } ] } });
  store.decide(id, 1, { decision: 'answer', answers: [{ id: 'Q1', choice: 1 }, { id: 'Q2', choice: 0 }] });
  const next = overridesNote(here(), 'Sam');
  assert.match(next, /Which blue\? They chose "Sky" over the recommended "Navy"\./);
  assert.match(next, /Who should be able to sign in\?/, 'and the earlier one as it is on record');
  // Filed under done, and a file that is not the cache: both still told.
  store.claimDelivery(store.getItem(id)!, 1, 'test');
  store.fileAway(store.getItem(id)!);
  fs.writeFileSync(kept, 'not json');
  assert.match(overridesNote(here(), 'Sam'), /Which blue\?/);
});
