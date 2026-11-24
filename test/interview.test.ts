// What the agent is told about a round: every answer, and, when the round was sent early with Send now, which
// questions are still open so it asks them again instead of taking its own recommendation.
import { REPO, reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import store from '../lib/store.ts';
import { formatDecision, formatEarly } from '../lib/kinds.ts';

beforeEach(reset);

function round() {
  const opt = (label: string) => ({ label });
  const res = store.send({
    kind: 'decision', bodyType: 'questions', title: 'Team accounts',
    body: { questions: [
      { id: 'Q1', title: 'Who owns a team', options: [opt('The creator'), opt('Billing contact')], recommended: 0 },
      { id: 'Q2', title: 'Invite by link', options: [opt('Yes'), opt('No')], recommended: 0 },
      { id: 'Q3', title: 'Seat limit', options: [opt('None'), opt('Ten')], recommended: 1 },
    ] },
    source: { agent: 'claude-code', cwd: REPO, repo: path.basename(REPO) },
  });
  return res;
}

test('a full round lists every answer and lets the agent finish', () => {
  const { id, n } = round();
  store.decide(id, n, { decision: 'answer', answers: [
    { id: 'Q1', choice: 1 }, { id: 'Q2', choice: 0, accepted: true }, { id: 'Q3', choice: null, other: 'Twenty' },
  ] });
  const msg = formatDecision(store.getItem(id)!, n)!;
  assert.match(msg, /Q1 Who owns a team: Billing contact/);
  assert.match(msg, /Q3 Seat limit: wrote their own answer: Twenty/);
  assert.doesNotMatch(msg, /sent this round early/);
  assert.match(msg, /If the interview is complete/);
});

test('a round sent early names the open questions and keeps the interview going', () => {
  const { id, n } = round();
  store.decide(id, n, { decision: 'answer', answers: [{ id: 'Q1', choice: 1 }] });
  const msg = formatDecision(store.getItem(id)!, n)!;
  assert.match(msg, /Q1 Who owns a team: Billing contact/);
  assert.match(msg, /sent this round early, without answering Q2 Invite by link; Q3 Seat limit/);
  assert.match(msg, /do not take your recommendation/);
  assert.doesNotMatch(msg, /If the interview is complete/);
});

test('a screenshot pasted into your own answer reaches the agent as a path it can open, after the item is filed away', () => {
  const { id, n } = round();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const name = store.savePasted(id, n, 'image/png', png);
  const only = store.savePasted(id, n, 'image/png', png);
  store.decide(id, n, { decision: 'answer', answers: [
    { id: 'Q1', choice: null, other: 'Like this', images: [name] }, { id: 'Q2', choice: null, other: '', images: [only] }, { id: 'Q3', choice: 0 },
  ] });
  store.fileAway(store.getItem(id)!);
  const msg = formatDecision(store.getItem(id)!, n)!;
  const file = store.pastedPath(store.getItem(id)!, n, name)!;
  assert.match(msg, /Q1 Who owns a team: wrote their own answer: Like this\n {2}With a screenshot/);
  assert.ok(msg.includes(`  ${file}`), msg);
  assert.match(msg, /Q2 Invite by link: answered with a screenshot only/);
  assert.doesNotMatch(msg, /sent this round early/, 'a screenshot alone is an answer');
  assert.ok(fs.existsSync(file));
});

test('only a picture can be pasted, and only for the version on screen', () => {
  const { id, n } = round();
  assert.throws(() => store.savePasted(id, n, 'text/html', Buffer.from('<script>')), /Only a picture/);
  assert.throws(() => store.savePasted(id, n + 1, 'image/png', Buffer.from('x')), /newer version/);
  assert.equal(store.pastedPath(store.getItem(id)!, n, '../item.json'), null);
});

test('a round sent again after an early answer replaces the open one and starts clean', () => {
  const opt = (label: string) => ({ label });
  const source = { agent: 'claude-code', cwd: REPO, repo: path.basename(REPO) };
  const { id, n } = store.send({
    kind: 'decision', bodyType: 'questions', title: 'Team accounts', source,
    body: { questions: [
      { id: 'Q1', title: 'Is this what you are after?', options: [opt('One queue for a team'), opt('A queue each')], recommended: 0, opens: true },
      { id: 'Q2', title: 'Who can invite?', options: [opt('The owner'), opt('Anyone')], recommended: 0 },
    ] },
  });
  assert.equal(store.saveEarly(id, n, { id: 'Q1', choice: 1 }), true);
  const msg = formatEarly(store.getItem(id)!, n, store.unreportedEarly(store.getItem(id)!, n));
  assert.match(msg, /Q1 Is this what you are after\?: A queue each/);
  assert.match(msg, new RegExp(`send the corrected round now with \`bateson send --item ${id} --questions -\``));

  const again = store.send({
    itemId: id, kind: 'decision', bodyType: 'questions', source,
    body: { questions: [
      { id: 'Q2', title: 'Who can invite?', options: [opt('The owner'), opt('Anyone')], recommended: 0 },
      { id: 'Q3', title: 'Can a person be in two teams?', options: [opt('No')], recommended: 0 },
    ] },
  });
  assert.deepEqual({ n: again.n, replaced: again.replaced }, { n, replaced: true });
  const item = store.getItem(id)!;
  assert.deepEqual(store.readQuestions(item, store.currentVersion(item)).map((q) => q.id), ['Q2', 'Q3']);
  assert.deepEqual(store.unreportedEarly(item, n), [], 'the early answer went with the round it was given on');
  assert.equal(store.readDraft(item, n), null);
});
