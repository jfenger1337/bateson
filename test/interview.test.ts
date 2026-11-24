// What the agent is told about a round: every answer, and, when the round was sent early with Send now, which
// questions are still open so it asks them again instead of taking its own recommendation.
import { REPO, reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import store from '../lib/store.ts';
import { formatDecision, validateQuestions, checkDecision, kindOf } from '../lib/kinds.ts';

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

// ---- What a round may be. Answers are matched to their question by id, as text, so a round whose ids cannot be
// matched (a number, the same one twice) could be sent but never answered.

test('a question id written as a number is taken as its digits, so its answer finds it', () => {
  const opt = (label: string) => ({ label });
  const round = validateQuestions({ questions: [
    { id: 1, title: 'Who owns a team?', options: [opt('The creator'), opt('Billing contact')] },
    { id: 2, title: 'Invite by link?', options: [opt('Yes'), opt('No')] },
  ] });
  assert.deepEqual(round.questions.map((q) => q.id), ['1', '2']);
  const { id, n } = store.send({ kind: 'decision', bodyType: 'questions', title: 'Team accounts', body: round, source: {} });
  store.decide(id, n, checkDecision(kindOf(store.getItem(id)!), { decision: 'answer', answers: [{ id: '1', choice: 1 }, { id: '2', choice: 0 }] }));
  const msg = formatDecision(store.getItem(id)!, n)!;
  assert.match(msg, /1 Who owns a team\?: Billing contact/);
  assert.doesNotMatch(msg, /sent this round early/);
});

test('a round that could not be answered is refused as it is sent, with what is wrong', () => {
  const opt = (label: string) => ({ label });
  const q = (over: object) => ({ questions: [{ id: 'Q1', title: 'Who owns a team?', options: [opt('The creator'), opt('Billing contact')], ...over }, { title: 'Invite by link?', options: [opt('Yes'), opt('No')] }] });
  assert.throws(() => validateQuestions(q({ id: 'Q2' })), /two questions have the id Q2/);
  assert.throws(() => validateQuestions(q({ id: 'a b/../c' })), /id is a short name/);
  assert.throws(() => validateQuestions(q({ id: { n: 1 } })), /id is a short name/);
  assert.throws(() => validateQuestions(q({ title: ['Who?'] })), /needs a title/);
  assert.throws(() => validateQuestions(q({ options: [{}, opt('B')] })), /option 1: .* needs its label/);
  assert.throws(() => validateQuestions(q({ options: [opt('A'), null] })), /option 2: .* needs its label/);
  assert.throws(() => validateQuestions(q({ recommended: 'length' })), /recommended must be an option index/);
  assert.throws(() => validateQuestions({ questions: [null, null] }), /question 1 is not an object/);
  assert.equal(validateQuestions(q({})).questions[1].id, 'Q2', 'a question without an id is numbered');
});
