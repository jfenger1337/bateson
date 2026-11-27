// A revision answers each comment on the version before: changed it (--done), kept it (--not), or, for a comment
// that asked a question, answered it (--answered). The app shows which, and the agent is told it can.
import { REPO, reset, childEnv } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from '../lib/store.ts';
import { formatDecision } from '../lib/kinds.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
beforeEach(reset);

function cli(args: string[]) {
  return spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bateson.ts'), ...args], { env: childEnv({ BATESON_NO_OPEN: '1' }), cwd: REPO, encoding: 'utf8' });
}

function sentBack(bodyType: 'markdown' | 'findings' = 'markdown') {
  const body = bodyType === 'markdown' ? 'One. Two. Three.' : { findings: [{ id: 'F1', title: 'A', severity: 'high' as const, body: '' }] };
  const res = store.send({ kind: 'review', bodyType, title: 'Plan', note: 'n', body, source: { cwd: REPO } });
  if (bodyType === 'markdown') {
    const q = (quote: string) => ({ kind: 'text' as const, quote });
    store.decide(res.id, 1, { decision: 'send-back', comments: [
      { id: 'a', anchor: q('One.'), text: 'shorter' }, { id: 'b', anchor: q('Two.'), text: 'drop it' }, { id: 'c', anchor: q('Three.'), text: 'is this legal?' },
    ] });
  } else store.decide(res.id, 1, { decision: 'findings', marks: [{ id: 'F1', mark: 'keep' }] });
  return res.id;
}

test('a question comment is answered: stored as answered, nothing changed, and the agent is told it may', () => {
  const id = sentBack();
  assert.match(formatDecision(store.getItem(id)!, 1)!, /--answered "3: the answer"/);
  fs.writeFileSync(path.join(REPO, 'v2.md'), 'One. Two. Three.');
  const r = cli(['send', '--item', id, '--note', 'n', '--file', 'v2.md', '--done', '1: Shorter.', '--not', '2: Kept, it is needed.', '--answered', '3: Yes, FAQ 3.8.']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(store.readReplies(store.getItem(id)!, 2), [
    { comment: 1, addressed: true, text: 'Shorter.' },
    { comment: 2, addressed: false, text: 'Kept, it is needed.' },
    { comment: 3, addressed: false, answered: true, text: 'Yes, FAQ 3.8.' },
  ]);
});

test('a missing answer names --answered, and a finding cannot be answered', () => {
  const id = sentBack();
  fs.writeFileSync(path.join(REPO, 'v2.md'), 'One.');
  const r = cli(['send', '--item', id, '--note', 'n', '--file', 'v2.md', '--done', '1: x', '--done', '2: y']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--answered "<n>: the answer" for a question\) for 3/);
  const f = sentBack('findings');
  const r2 = cli(['send', '--item', f, '--note', 'n', '--file', 'v2.md', '--answered', 'F1: it is fine']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /fixed or not: answer it with --done or --not/);
});
