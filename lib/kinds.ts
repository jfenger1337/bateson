// The kinds of version, each in one place: the decisions it takes and what they are called once made, what a
// revision after it has to answer (its asks), what the agent is told, and how its body is checked. The CLI, the
// server, the hooks and the app look a kind up here instead of switching on body types. A new kind is a new
// entry here and its view in web/src.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import store, { reviewer, Reviewer } from './store.ts';
import type { Attachment, DecisionFile, StoredItem, StoredVersion } from './store.ts';
import type { Anchor, Answer, Asked, Decision, DecisionName, Finding, Item, KindName, Mark, Question, Round, Show } from './types.ts';

/** One thing the reviewer asked of a version, keyed the way the agent replies to it. */
interface Ask { key: string; id: string; text: string; anchor: Anchor; title?: string }
interface Decided { item: StoredItem; v: StoredVersion; d: DecisionFile }

interface Kind {
  name: KindName;
  decisions: Partial<Record<DecisionName, string>>;
  /** What one ask is called when a revision answers it. */
  noun: string | null;
  asks(x: Decided): Ask[];
  tell(x: Decided & { asks: Ask[]; resend: string; who: string; Who: string }): string;
  /** Check a body as it is sent, and return it as it is stored. */
  validate?(body: unknown, cwd?: string): unknown;
}

/** The kind of a version: an interview round, findings, or a piece to review. */
export function kindOf(item: StoredItem, v = store.currentVersion(item)): Kind {
  if (v.bodyType === 'questions') return INTERVIEW;
  if (v.bodyType === 'findings') return FINDINGS;
  return REVIEW;
}

// ---- What a revision answers. An ask is one thing the reviewer asked of a version, keyed the way the agent
// replies to it: comments by number ("1"), kept findings by id ("F1").

const commentAsks = (d: DecisionFile): Ask[] => (d.decision === 'send-back' ? d.comments || [] : []).map((c, k) => ({ key: String(k + 1), id: c.id, text: c.text, anchor: c.anchor }));

function keptFindings(item: StoredItem, v: StoredVersion, d: DecisionFile) {
  const marks = d?.marks || [];
  return store.readFindings(item, v)
    .map((f): { f: Finding; m: Mark } => ({ f, m: marks.find((x) => x.id === f.id) || { id: f.id, mark: 'keep' } }));
}

function describeAnchor(a: Anchor | undefined) {
  if (!a || a.kind === 'item') return 'On the whole piece:';
  const where = a.file ? ` (${a.file}${a.line ? `:${a.line}` : ''}${a.side ? `, ${a.side}` : ''})` : '';
  const quote = a.quote ? `"${a.quote.length > 160 ? a.quote.slice(0, 157) + '...' : a.quote}"` : 'this';
  return `On ${quote}${where}:`;
}

const numbered = (asks: Ask[]) => asks.map((a) => `${a.key}. ${describeAnchor(a.anchor)}\n   ${a.text.replace(/\n/g, '\n   ')}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeAnswer(q: Partial<Question>, a: Answer) {
  if (a.other) return `wrote their own answer: ${a.other}`;
  if (a.choice != null && q?.options?.[a.choice]) {
    const label = `${q.options[a.choice].label}${a.accepted ? ' (your recommendation, accepted)' : ''}`;
    // Your written recommendation came with that option, conditions and all, so it is part of the answer.
    return a.choice === q.recommended && q.recommendation ? `${label}. With it, what you recommended: ${q.recommendation.trim().replace(/\n/g, '\n  ')}` : label;
  }
  return 'no answer';
}

const DROPPED = 'Dropped. Stop this line of work. Leave the changes as they are and do not revert anything unless asked.';

// ---- The kinds

const REVIEW = {
  name: 'review',
  decisions: { approve: 'Approved', 'send-back': 'Sent back', drop: 'Dropped' },
  noun: 'comment',
  asks: ({ d }) => commentAsks(d),
  tell({ d, asks, resend, Who }) {
    if (d.decision === 'approve') return 'Approved. Carry on with your task.';
    if (d.decision === 'drop') return DROPPED;
    return `Sent back with ${plural(asks.length, 'comment')}:\n\n${numbered(asks).join('\n')}\n\nRevise, then send the next version with \`${resend}\` (same body flags as before) and answer every comment by its number in one line: \`--done "1: what you changed"\` if you addressed it, \`--not "2: why not"\` if you did not. ${Who} sees each answer next to the comment. End your turn after sending.`;
  },
} satisfies Kind;

const INTERVIEW = {
  name: 'interview',
  decisions: { answer: 'Answered', drop: 'Ended' },
  noun: null,
  asks: () => [],
  tell({ item, v, d, resend, who }) {
    if (d.decision === 'drop') return DROPPED;
    const qs = store.readQuestions(item, v);
    const lines = (d.answers || []).map((a) => {
      const q: Partial<Question> = qs.find((x) => x.id === a.id) || {};
      return `- ${a.id} ${q.title || a.id}: ${describeAnswer(q, a)}`;
    });
    const draft = store.readDraft(item, v.n);
    const drafted = draft?.questions?.length
      ? `\n\nYou drafted ${plural(draft.questions.length, 'follow-up')} while ${who} answered (${draft.questions.map((q) => `${q.id} ${q.title}`).join('; ')}). Print them with \`bateson draft ${item.id} --show\`, check them against all the answers above, add what else the frontier needs, and send the next round now with \`${resend} --questions -\`.`
      : '';
    return `Answers for round ${v.n}:\n${lines.join('\n')}${drafted}\n\nIf this opens new questions, send the next round with \`${resend} --questions -\`. If the interview is complete, send the shared understanding for review as the interview's last version (see the ama skill).`;
  },
  validate: validateQuestions,
} satisfies Kind;

const FINDINGS = {
  name: 'findings',
  decisions: { findings: 'Findings sent', drop: 'Dropped' },
  noun: 'kept finding',
  asks: ({ item, v, d }) => d.decision !== 'findings' ? [] : keptFindings(item, v, d).filter(({ m }) => m.mark !== 'dismiss').map(({ f, m }) => ({
    key: f.id, id: f.id, title: f.title, text: m.comment || '',
    anchor: { kind: 'text', quote: f.title, ...(f.file ? { file: f.file, line: f.line } : {}) },
  })),
  tell({ item, v, d, resend, who, Who }) {
    if (d.decision === 'drop') return DROPPED;
    const all = keptFindings(item, v, d);
    const kept = all.filter(({ m }) => m.mark !== 'dismiss');
    const gone = all.filter(({ m }) => m.mark === 'dismiss');
    const where = (f: Finding) => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '');
    const keptLines = kept.map(({ f, m }) => `- ${f.id} [${f.severity}] ${f.title}${where(f)}${m.comment ? `\n  ${Who}: ${m.comment.replace(/\n/g, '\n  ')}` : ''}`);
    const goneLines = gone.map(({ f, m }) => `- ${f.id} ${f.title}${where(f)}${m.reason ? `: ${m.reason}` : ''}`);
    const dismissed = gone.length ? `\n\nDismissed, so do not raise these again:\n${goneLines.join('\n')}` : '';
    if (!kept.length) return `Every finding was dismissed. Nothing to fix; carry on.${dismissed}`;
    const ids = kept.map(({ f }) => f.id);
    return `Kept ${kept.length} of ${plural(all.length, 'finding')}. Fix these:\n${keptLines.join('\n')}${dismissed}\n\nThen ${store.readConfig().bring.code
      ? `send the fixes for a look: \`${resend} --title "<what you fixed>" --note "<where to look>" --diff [<base>]\` (base: the commit before your fixes; leave it out if they are not committed).`
      : `send a short report for a look, not the code: \`${resend} --title "<what you fixed>" --note "<where to look>" --stdin --type markdown\`, the body saying for each kept finding, in a sentence or two of plain words, what ${who} will now see and where. Add \`--attach <screenshot>\` of the result for every finding about how something looks.`} Answer each kept finding in one line: \`--done "${ids[0]}: what you fixed"\`, or \`--not "${ids[0]}: why not"\`. Answer ${ids.join(', ')}. End your turn after sending.`;
  },
  validate: validateFindings,
} satisfies Kind;

export const KINDS = { review: REVIEW, interview: INTERVIEW, findings: FINDINGS };

/**
 * Check a decision as the app posts it, before it is written: decision.json is written once, so one of the wrong
 * shape would leave its item stuck, never told to its agent. Only the kind's own decisions count (not a name
 * every object has, such as "constructor"), and each list holds what formatDecision reads, with the right types.
 * Throws an Error saying what is wrong.
 */
export function checkDecision(kind: Kind, body: unknown): Decision {
  const b = (body && typeof body === 'object' ? body : {}) as Loose;
  const { decision } = b;
  if (typeof decision !== 'string' || !Object.hasOwn(kind.decisions, decision)) throw new Error(`A ${kind.name} item cannot be decided with ${String(decision)}`);
  const str = (v: unknown) => v == null || typeof v === 'string';
  const num = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v));
  const list = (k: string, ok: (x: Loose) => boolean) => {
    const v = b[k];
    if (v == null) return undefined;
    if (!Array.isArray(v) || !v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && ok(x as Loose))) throw new Error(`${k} are not of the right shape`);
    return v;
  };
  const comments = list('comments', (c) => typeof c.id === 'string' && typeof c.text === 'string' && !!c.anchor && typeof c.anchor === 'object'
    && ['text', 'item'].includes((c.anchor as Loose).kind as string)
    && ['quote', 'prefix', 'suffix', 'file'].every((k) => str((c.anchor as Loose)[k]))
    && ['start', 'end', 'line'].every((k) => num((c.anchor as Loose)[k]))
    && [undefined, null, 'old', 'new'].includes((c.anchor as Loose).side as string));
  const answers = list('answers', (a) => typeof a.id === 'string' && (a.choice == null || Number.isInteger(a.choice)) && str(a.other) && (a.accepted == null || typeof a.accepted === 'boolean'));
  const marks = list('marks', (m) => typeof m.id === 'string' && ['keep', 'dismiss'].includes(m.mark as string) && str(m.reason) && str(m.comment));
  if (decision === 'send-back' && !comments?.length) throw new Error('Send back needs a comment');
  return {
    decision: decision as DecisionName,
    ...(comments ? { comments: comments as Decision['comments'] } : {}),
    ...(answers ? { answers: answers as Decision['answers'] } : {}),
    ...(marks ? { marks: marks as Decision['marks'] } : {}),
  };
}

// ---- Built on the kinds

/** What the reviewer asked of a decided version, in the order the agent was told. */
export function asks(item: StoredItem, v: StoredVersion) {
  const d = v && store.readDecision(item, v.n);
  return d ? kindOf(item, v).asks({ item, v, d }) : [];
}

/** The last decided version before the one a new send would write: the asks a revision answers. */
export function answeredVersion(item: StoredItem) {
  const vs = item.versions;
  const last = vs[vs.length - 1];
  const decided = store.readDecision(item, last.n) ? last : vs[vs.length - 2];
  return decided && store.readDecision(item, decided.n) ? decided : null;
}

/** What a revision has to answer, and what each one is called: { keys: ["1", "2"] | ["F1"], noun }. */
export function toAnswer(item: StoredItem) {
  const pv = answeredVersion(item);
  return { keys: pv ? asks(item, pv).map((a) => a.key) : [], noun: pv ? kindOf(item, pv).noun : 'comment' };
}

/** The version before v and what was asked of it, each ask with the agent's reply in v. */
export function previousOf(item: StoredItem, v: StoredVersion): Item['previous'] {
  const i = item.versions.findIndex((x) => x.n === v.n);
  const pv = i > 0 ? item.versions[i - 1] : null;
  if (!pv || pv.bodyType === 'questions' || v.bodyType === 'questions') return null;
  const replies = store.readReplies(item, v.n);
  const comments: Asked[] = asks(item, pv).map((a) => ({
    id: a.id, text: a.text, anchor: a.anchor, ...(a.title ? { title: a.title } : {}),
    reply: replies.find((r) => String(r.comment) === a.key) || null,
  }));
  // Neither is a round, so the body is text: a findings body is not shown again.
  return { n: pv.n, bodyType: pv.bodyType, body: pv.bodyType === 'findings' ? '' : store.readBody(item, pv) as string, comments };
}

/** What the agent is told about a decision, or null while there is none. */
/**
 * How a delivered decision names itself: lib/delivery.ts looks for exactly this in a session's transcript to
 * tell whether a wake-up reached it.
 */
export const deliveryMark = (id: string, n: number) => `(${id}, v${n})`;

export function formatDecision(item: StoredItem, n: number) {
  const v = store.versionOf(item, n) || store.currentVersion(item);
  const d = store.readDecision(item, v.n);
  if (!d) return null;
  const head = `bateson: ${reviewer()} responded to "${v.title || item.title}" ${deliveryMark(item.id, v.n)}.`;
  const kind = kindOf(item, v);
  const body = kind.decisions[d.decision]
    ? kind.tell({ item, v, d, asks: kind.asks({ item, v, d }), resend: `bateson send --item ${item.id}`, who: reviewer(), Who: Reviewer() })
    : d.decision;
  return `${head}\n${body}`;
}

export function formatEarly(item: StoredItem, n: number, answers: Answer[]) {
  const qs = store.readQuestions(item, store.versionOf(item, n)!);
  const lines = answers.map((a) => {
    const q: Partial<Question> = qs.find((x) => x.id === a.id) || {};
    return `- ${a.id} ${q.title || ''}: ${describeAnswer(q, a)}`;
  });
  const these = answers.length > 1 ? 'these answers' : 'this answer';
  return `bateson: early answer${answers.length > 1 ? 's' : ''} in "${item.title}" (${item.id}, round ${n}). ${Reviewer()} is still answering the rest of the round.\n${lines.join('\n')}\n\nDraft only the follow-up questions that depend on ${these}: no research, no building. Save them with \`bateson draft ${item.id} --questions -\` (same JSON as a round, ids continuing the interview's numbering). They stay hidden until the round is sent. If nothing follows from it, run \`bateson draft ${item.id} --none\`. Either way, that command keeps you waiting for the rest of the round, so end your turn right after it.`;
}

// ---- Checking bodies as they are sent: JSON an agent wrote, so nothing about it is taken on trust until it
// passes. Each throws an Error with a message for the agent.

type Loose = Record<string, unknown>;

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO = /\.(wav|mp3|m4a|aiff?)$/i;
const SHOW_LINES = 60;

/**
 * Check a round. With `cwd`, each `show` (a path, or "path:10-30" for lines of a text file) becomes what the
 * app displays: an image is copied in as an attachment (listed on the body's hidden `files`), code is kept as
 * its lines, copy (.md, .txt) and markup (.html) as their text, a localhost URL is shown live. Without `cwd` (a draft, sent again later) a `show` is only checked for shape.
 */
export function validateQuestions(body: unknown, cwd?: string): Round & { readonly files: Attachment[] } {
  if (!body || typeof body !== 'object' || !('questions' in body) || !Array.isArray(body.questions) || !body.questions.length) throw new Error('--questions needs { "questions": [ ... ] } with at least one question.');
  if ('context' in body && body.context != null) throw new Error('a round has no "context" any more: write each fact into the question that needs it, and send again.');
  const files: Attachment[] = [];
  const shown = (owner: Loose, what: string) => {
    if (owner.show == null) return;
    const list: unknown[] = Array.isArray(owner.show) ? owner.show : [owner.show];
    if (list.some((s) => !(typeof s === 'string' ? s.trim() : inlineShow(s)))) throw new Error(`${what}: show is a file path, a localhost URL, or { "text" | "markdown" | "html": "..." } written out here; one or a list.`);
    if (cwd) owner.show = list.map((s) => (typeof s === 'string' ? resolveShow(s.trim(), cwd, files, what) : inlineShow(s)));
  };
  (body.questions as Loose[]).forEach((q, i) => {
    q.id = q.id || `Q${i + 1}`;
    if (!q.title) throw new Error(`question ${q.id} needs a title.`);
    if (!/\?\s*$/.test(String(q.title))) throw new Error(`question ${q.id}: the title is the question itself and ends in a question mark ("Which turns should get the reminder?", not "Which turns get checked").`);
    if (!Array.isArray(q.options) || !q.options.length) throw new Error(`question ${q.id} needs options: two to four, or for a yes or no question one, your answer.`);
    const options = q.options as Loose[];
    if (options.length === 1 && q.recommended !== 0) throw new Error(`question ${q.id}: a single option is your answer to a yes or no question, so set "recommended": 0.`);
    if (q.recommended != null && !options[q.recommended as number]) throw new Error(`question ${q.id}: recommended must be an option index.`);
    if (q.recommendation != null && (typeof q.recommendation !== 'string' || !q.recommendation.trim())) throw new Error(`question ${q.id}: recommendation is your answer written out, as markdown.`);
    if (q.recommendation && q.recommended == null) throw new Error(`question ${q.id}: a recommendation needs "recommended", the option it leans to.`);
    shown(q, `question ${q.id}`);
    options.forEach((o, k) => shown(o, `question ${q.id}, option ${k + 1}`));
  });
  Object.defineProperty(body, 'files', { value: files, enumerable: false });
  return body as Round & { files: Attachment[] };
}

const INLINE = ['text', 'markdown', 'html'];
const SHOW_BYTES = 200 * 1024;

/** Something to show written out in the round itself: copy as text or markdown, or a component as HTML. */
function inlineShow(s: unknown): Show | null {
  if (!s || typeof s !== 'object') return null;
  const keys = Object.keys(s);
  const k = keys[0];
  const value = (s as Loose)[k];
  if (keys.length !== 1 || !INLINE.includes(k) || typeof value !== 'string' || !value.trim() || value.length > SHOW_BYTES) return null;
  return { [k]: value } as Show;
}

function resolveShow(spec: string, cwd: string, files: Attachment[], what: string): Show {
  // A page running on this machine, shown live: the agent's dev server, a route with the variant switched on.
  if (/^https?:\/\//i.test(spec)) {
    let url;
    try { url = new URL(spec); } catch { throw new Error(`${what}: ${spec} is not a URL.`); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${what}: only a page on this machine (http://localhost:...) can be shown live, not ${url.hostname}. Send a screenshot instead.`);
    return { url: url.href };
  }
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec)!;
  const file = path.resolve(cwd, m[1]);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${what}: no file ${m[1]} to show.`);
  if (IMAGE.test(file) || VIDEO.test(file) || AUDIO.test(file)) {
    const name = `show${files.length + 1}-${path.basename(file)}`;
    files.push({ path: file, name });
    return VIDEO.test(file) ? { video: name } : AUDIO.test(file) ? { audio: name } : { image: name };
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) throw new Error(`${what}: ${m[1]} is not an image (png, jpg, gif, webp, svg), a video (mp4, webm, mov), a sound (wav, mp3, m4a, aiff) or text.`);
  // A whole file of copy or markup is shown as what it is; anything else, or a range of lines, as code.
  if (!m[2]) {
    const kind = /\.(md|markdown|mdx)$/i.test(file) ? 'markdown' : /\.txt$/i.test(file) ? 'text' : /\.html?$/i.test(file) ? 'html' : null;
    if (kind) {
      if (text.length > SHOW_BYTES) throw new Error(`${what}: ${m[1]} is too long to show whole; give lines ("${m[1]}:1-60").`);
      return { [kind]: text } as Show;
    }
  }
  const lines = text.replace(/\n$/, '').split('\n');
  const start = m[2] ? Number(m[2]) : 1;
  const end = Math.min(lines.length, m[3] ? Number(m[3]) : m[2] ? start : lines.length, start + SHOW_LINES - 1);
  if (start < 1 || start > lines.length || end < start) throw new Error(`${what}: ${spec} is outside the file (${lines.length} lines).`);
  return { file: m[1], start, lines: lines.slice(start - 1, end) };
}

const SEVERITY: Record<string, Finding['severity'] | undefined> = { critical: 'high', high: 'high', major: 'high', medium: 'medium', moderate: 'medium', low: 'low', minor: 'low', nit: 'low', info: 'low' };
const RANK: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Check findings, sort them highest severity first, number them, and keep the code around each line. */
export function validateFindings(parsed: unknown, cwd = process.cwd()): { findings: Finding[] } {
  const list = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown } | null | undefined)?.findings;
  if (!Array.isArray(list) || !list.length) throw new Error('--findings needs a list of findings: [ { "title": ..., "severity": ..., ... } ].');
  let top = cwd;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
  const out = (list as (Loose | null)[]).map((f, i) => {
    if (!f || typeof f.title !== 'string' || !f.title.trim()) throw new Error(`finding ${i + 1} needs a title.`);
    const severity = SEVERITY[String(f.severity || 'medium').toLowerCase()];
    if (!severity) throw new Error(`finding ${i + 1}: severity is high, medium or low, not ${JSON.stringify(f.severity)}.`);
    const line = f.line != null ? Number(f.line) : undefined;
    if (line != null && !(line > 0)) throw new Error(`finding ${i + 1}: line must be a positive number.`);
    const x: Omit<Finding, 'id'> = { title: f.title.trim(), severity, body: String(f.body || ''), ...(f.fix ? { fix: String(f.fix) } : {}) };
    if (f.file) Object.assign(x, { file: String(f.file), ...(line ? { line } : {}) }, excerpt([cwd, top], String(f.file), line));
    return { x, i };
  });
  out.sort((a, b) => RANK[a.x.severity] - RANK[b.x.severity] || a.i - b.i);
  return { findings: out.map(({ x }, k) => ({ id: `F${k + 1}`, ...x })) };
}

/** The lines around a finding, so the app can show the code as it was when the finding was sent. */
function excerpt(bases: string[], file: string, line: number | undefined): Pick<Finding, 'excerpt'> {
  if (!line) return {};
  for (const base of bases) {
    let text;
    try { text = fs.readFileSync(path.resolve(base, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    if (line > lines.length) return {};
    const start = Math.max(1, line - 6);
    return { excerpt: { start, lines: lines.slice(start - 1, Math.min(lines.length, line + 6)) } };
  }
  return {};
}
