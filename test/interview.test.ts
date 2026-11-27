// What the agent is told about a round: every answer, and, when the round was sent early with Send now, which
// questions are still open so it asks them again instead of taking its own recommendation.
import { REPO, reset } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import store from '../lib/store.ts';
import { formatDecision, validateQuestions, validateFindings, attachImages, checkDecision, kindOf } from '../lib/kinds.ts';

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

test('a comment on a question\'s words goes with the answers, and the agent is told to ask again what it undermines', () => {
  const { id, n } = round();
  const anchor = { kind: 'text' as const, quote: 'Who owns', start: 0, end: 8, question: 'Q1' };
  store.decide(id, n, { decision: 'answer', answers: [
    { id: 'Q1', choice: 0, accepted: true }, { id: 'Q2', choice: 0, accepted: true }, { id: 'Q3', choice: 1, accepted: true },
  ], comments: [{ id: 'c1', anchor, text: 'Teams have no owner today:\nadmins share it.' }] });
  const msg = formatDecision(store.getItem(id)!, n)!;
  assert.match(msg, /Q1 Who owns a team: The creator \(your recommendation, accepted\) \(they commented on this question, see below\)/);
  assert.doesNotMatch(msg, /Q2 Invite by link: Yes \(your recommendation, accepted\) \(they commented/);
  assert.match(msg, /commented on a passage of this round/);
  assert.match(msg, /1\. In Q1 "Who owns a team", on "Who owns":\n {3}Teams have no owner today:\n {3}admins share it\./);
  assert.match(msg, /go through every question of this round/);
  assert.match(msg, /Ask that question again in the next round/);
  // One round of accepted options would normally be acted on at once; with a comment, what was made of it is shown first.
  assert.doesNotMatch(msg, /act on the answers now/);
  assert.match(msg, /one line for each comment/);
});

test('a comment on a round is checked against its questions', () => {
  const questions = [{ id: 'Q1', title: 'Who owns a team?', options: [{ label: 'The creator' }] }];
  const comment = (question: unknown) => ({ decision: 'answer', answers: [{ id: 'Q1', choice: 0 }], comments: [{ id: 'c', text: 'Wrong', anchor: { kind: 'text', quote: 'Who', question } }] });
  const kind = kindOf(store.getItem(round().id)!);
  assert.equal(checkDecision(kind, comment('Q1'), questions).comments?.[0].anchor.question, 'Q1');
  assert.throws(() => checkDecision(kind, comment('Q9'), questions), /comments do not fit/);
  assert.throws(() => checkDecision(kind, comment(4), questions), /not of the right shape/);
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

test('a finding shows images: each is attached under its own name, and anything but an image is refused', () => {
  const dir = fs.mkdtempSync(path.join(REPO, 'shots-'));
  fs.writeFileSync(path.join(dir, 'bug.png'), 'png');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'text');
  const body = validateFindings([
    { title: 'Low one', severity: 'low', body: '' },
    { title: 'Looks wrong', severity: 'high', body: '', show: ['bug.png', 'bug.png'] },
  ], dir);
  assert.equal(body.findings[0].title, 'Looks wrong');
  assert.deepEqual(body.findings[0].images, ['show1-bug.png', 'show2-bug.png']);
  assert.equal(body.findings[1].images, undefined);
  assert.deepEqual(body.files.map((f) => typeof f === 'string' ? f : f.name), ['show1-bug.png', 'show2-bug.png']);
  assert.ok(!('files' in JSON.parse(JSON.stringify(body))), 'the attachments are not stored in the body');
  assert.throws(() => validateFindings([{ title: 't', show: 'notes.txt' }], dir), /show is the path of an image/);
  assert.throws(() => validateFindings([{ title: 't', show: 'gone.png' }], dir), /no image gone.png/);
});

test('a plan shows its pictures: each path is attached once, by a name of its own, and the body names it by that', () => {
  const dir = fs.mkdtempSync(path.join(REPO, 'plan-'));
  fs.mkdirSync(path.join(dir, 'a')); fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'a', 'flow chart.png'), 'png');
  fs.writeFileSync(path.join(dir, 'b', 'flow chart.png'), 'png');
  const md = '![one](a/flow%20chart.png)\n![again](<a/flow chart.png>)\n<img src="b/flow chart.png">\n![web](https://example.com/x.png)\n';
  const { body, files } = attachImages(md, dir, new Set());
  assert.deepEqual(files.map((f) => typeof f === 'string' ? f : f.name), ['flow chart.png', 'img2-flow chart.png']);
  assert.equal(body, '![one](flow%20chart.png)\n![again](flow%20chart.png)\n<img src="img2-flow%20chart.png">\n![web](https://example.com/x.png)\n');
  assert.equal(attachImages('no pictures', dir).files.length, 0);
  assert.throws(() => attachImages('![x](gone.png)', dir), /shows gone.png, and there is no such image/);
});
