// `bateson recall`: what the reviewer already decided, one short line each, so an agent can check before it asks
// again. Read straight from the queue's files: no index, no model. What was read is kept until a decision is added
// (everythingKept), so the next call reads one file and not every item.
import store from './store.ts';
import type { DecisionFile, StoredItem, StoredVersion } from './store.ts';
import type { Question, Source } from './types.ts';

/** One past decision: a question answered, a piece approved or sent back, a finding kept or dismissed. */
export interface Recalled {
  id: string;
  at: string;
  repo: string;
  top?: string;
  /** The question, or the item's title: what the decision was about. */
  about: string;
  /** What they decided, in words. */
  said: string;
  /** Searched, besides `about` and `said`: the question's body and options, the item's title. */
  rest: string;
  /** The same question answered again is grouped under this. */
  key?: string;
  /** For a grouped question: the answer as a comparable value. */
  answer?: string;
  /** They went against the agent: chose another option than the one recommended, or wrote their own answer. */
  override?: { chose: string; over?: string };
}

const MAX = 160;
const clip = (s: string, n = MAX) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function answers(item: StoredItem, v: StoredVersion, d: DecisionFile, base: Omit<Recalled, 'about' | 'said' | 'rest'>): Recalled[] {
  const qs = store.readQuestions(item, v);
  return (d.answers || []).flatMap((a): Recalled[] => {
    const q: Partial<Question> = qs.find((x) => x.id === a.id) || {};
    const rec = q.recommended != null ? q.options?.[q.recommended]?.label : undefined;
    let said: string, answer: string, override: Recalled['override'];
    if (a.other) { said = `wrote: "${clip(a.other)}"${a.images?.length ? ' (with a screenshot)' : ''}`; answer = norm(a.other); override = { chose: `their own answer, "${clip(a.other, 100)}"`, over: rec }; }
    else if (a.images?.length) { said = 'answered with a screenshot'; answer = `screenshot ${a.images.join(' ')}`; override = { chose: 'their own answer, a screenshot', over: rec }; }
    else if (a.choice != null && q.options?.[a.choice]) {
      const label = q.options[a.choice].label;
      answer = norm(label);
      said = a.choice === q.recommended ? `${label} (the recommendation${a.accepted ? ', taken as it was' : ''})`
        : rec ? `${label} (over the recommended "${rec}")` : label;
      if (rec && a.choice !== q.recommended) override = { chose: `"${clip(label, 80)}"`, over: rec };
    } else return [];
    const about = q.title || a.id;
    const rest = [item.title, q.body, ...(q.options || []).map((o) => `${o.label} ${o.description || ''}`)].join(' ');
    return [{ ...base, about, said, rest, key: `${base.repo}\0${norm(about)}`, answer, ...(override ? { override } : {}) }];
  });
}

function reviewed(item: StoredItem, v: StoredVersion, d: DecisionFile, base: Omit<Recalled, 'about' | 'said' | 'rest'>): Recalled[] {
  const about = v.title || item.title;
  if (v.bodyType === 'findings') {
    if (d.decision === 'drop') return [{ ...base, about, said: 'dropped the review', rest: v.note || '' }];
    const found = store.readFindings(item, v);
    return (d.marks || []).flatMap((m): Recalled[] => {
      const f = found.find((x) => x.id === m.id);
      if (!f) return [];
      if (m.mark === 'dismiss') return [{ ...base, about: f.title, said: `dismissed the finding${m.reason ? `: ${clip(m.reason)}` : ''}`, rest: `${about} ${f.body} ${f.file || ''}` }];
      return m.comment ? [{ ...base, about: f.title, said: `kept the finding: ${clip(m.comment)}`, rest: `${about} ${f.body} ${f.file || ''}` }] : [];
    });
  }
  if (d.decision === 'approve') return [{ ...base, about, said: 'approved', rest: v.note || '' }];
  if (d.decision === 'drop') return [{ ...base, about, said: 'dropped it', rest: v.note || '' }];
  if (d.decision === 'send-back') {
    const cs = d.comments || [];
    const quoted = cs.map((c, k) => `${k + 1}) ${c.anchor?.quote ? `on "${clip(c.anchor.quote, 40)}": ` : ''}${clip(c.text, 100)}`);
    return [{ ...base, about, said: `sent back: ${clip(quoted.join(' '), 2 * MAX)}`, rest: `${v.note || ''} ${cs.map((c) => c.text).join(' ')}` }];
  }
  return [];
}

/** Every decision on record, delivered or not, newest first; only on items `which` lets through, if given. */
export function everything(which?: (item: StoredItem) => boolean): Recalled[] {
  const out: Recalled[] = [];
  for (const item of [...store.allDone(), ...store.allQueued()]) {
    if (which && !which(item)) continue;
    for (const v of item.versions) {
      const d = store.readDecision(item, v.n);
      if (!d) continue;
      const base = { id: item.id, at: d.decidedAt || v.createdAt, repo: item.source?.repo || '', top: item.source?.top };
      out.push(...(v.bodyType === 'questions' ? answers(item, v, d, base) : reviewed(item, v, d, base)));
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The same, from what was kept the last time when no decision has joined the record since (store.recordSig), in
 * cache/decisions.json. Working it out reads every item there has ever been, three files each: on Windows, where
 * opening a file is slow, `bateson recall` took half a second with 2000 items, and an agent runs it before it asks.
 * One file is read instead. The record itself stays the only source: the copy is dropped the moment its signature
 * is not the record's, and deleting it costs one slow recall.
 */
export function everythingKept(): Recalled[] {
  // Before the record is read: a decision made meanwhile gives another signature next time.
  const sig = store.recordSig();
  const kept = store.readCache('decisions') as { sig?: string; list?: Recalled[] } | null;
  if (kept?.sig === sig && Array.isArray(kept.list)) return kept.list;
  const list = everything();
  store.writeCache('decisions', { sig, list });
  return list;
}

// Words in nearly every question ("Which ... should ...?"), which would match everything.
const COMMON = new Set('the and for with what which who how why when where should would could does this that these those are you your from into than then'.split(' '));
/** A ticket or issue key (DEV-77996, ABC-12): one word to search for, never "dev" and "77996" apart. */
const KEY = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;

/** Words worth matching: ticket keys whole, then words of three letters or more that not nearly every question has. */
export const terms = (query: string) => {
  const keys = (query.match(KEY) || []).map(norm);
  const words = norm(query.replace(KEY, ' ')).split(' ').filter((w) => w.length >= 3 && !COMMON.has(w));
  return [...new Set([...keys, ...words])];
};

/** Whether `text` (normalised) has the word: at the start of a word, so "club" finds "clubs"; a key also ends there. */
function has(text: string, w: string) {
  if (!text.includes(w)) return false;
  const re = new RegExp(`(?:^| )${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\d$/.test(w) ? '(?= |$)' : ''}`);
  return re.test(text);
}

/** How well a decision matches: how many of the words it has anywhere, and a score that counts a word twice where it is
 * in what the decision was about or what was said. */
function score(r: Recalled, words: string[]) {
  const head = norm(`${r.about} ${r.said}`);
  const rest = norm(r.rest);
  let hits = 0, s = 0;
  for (const w of words) {
    if (has(head, w)) { hits++; s += 2; } else if (has(rest, w)) { hits++; s += 1; }
  }
  return { hits, s };
}

export interface Found extends Recalled { score: number; hits: number; earlier: string }

/** A question asked again (same repo, same words), its answers newest first, under one key. */
function grouped(all: Recalled[]) {
  const groups = new Map<string, Recalled[]>();
  for (const r of all) if (r.key) groups.set(r.key, [...(groups.get(r.key) || []), r]);
  return groups;
}

/** Whether a decision was made in this checkout: the same one, or by name where the item did not record one. */
const isHere = (s: Pick<Source, 'top' | 'repo'> | undefined, at: { top?: string; repo?: string }) =>
  !!s && ((!!at.top && s.top === at.top) || (!s.top && !!at.repo && s.repo === at.repo));

/**
 * The latest times they went against an agent in this checkout, newest first: another option than the one
 * recommended, or an answer of their own. A question answered again counts by its latest answer only.
 */
export function overrides(at: { top?: string; repo?: string }, limit = 5, all = everything((item) => isHere(item.source, at))): Recalled[] {
  const groups = grouped(all);
  return all.filter((r) => r.override && (!r.key || groups.get(r.key)![0] === r)).slice(0, limit);
}

/**
 * The same, from what was kept the last time when no decision has joined the record since (store.recordSig).
 * Every session start asks, and working it out reads every item there has ever been: three files each, which on
 * Windows, where opening a file is slow, held each new session up for longer with every decision made. Kept per
 * checkout in cache/overrides.json; a checkout's entry from an older record is dropped when one is added.
 */
function overridesKept(at: { top?: string; repo?: string }): Recalled[] {
  const key = `${at.top || ''}\0${at.repo || ''}`;
  // Before the record is read: a decision made meanwhile gives another signature next time.
  const sig = store.recordSig();
  type Kept = { [key: string]: { sig: string; list: Recalled[] } };
  const kept = (store.readCache('overrides') || {}) as Kept;
  const hit = Object.hasOwn(kept, key) ? kept[key] : null;
  if (hit?.sig === sig && Array.isArray(hit.list)) return hit.list;
  const list = overrides(at, 5, everythingKept().filter((r) => isHere({ top: r.top, repo: r.repo }, at)));
  const current = Object.fromEntries(Object.entries(kept).filter(([, v]) => v?.sig === sig));
  store.writeCache('overrides', { ...current, [key]: { sig, list } });
  return list;
}

/** What a session is told at its start: the overrides, one line each, or '' when there are none. */
export function overridesNote(at: { top?: string; repo?: string }, who: string) {
  const list = overridesKept(at);
  if (!list.length) return '';
  const lines = list.map((r) => `- ${r.at.slice(0, 10)} ${clip(r.about, 100)} They chose ${r.override!.chose}${r.override!.over ? ` over the recommended "${clip(r.override!.over, 80)}"` : ''}.`);
  return `Where ${who} went against an agent's recommendation in this repository lately, newest first. Weigh these when you recommend: they are evidence of what ${who} values, not rules, and \`bateson recall <words>\` finds the rest.\n${lines.join('\n')}`;
}

/**
 * The decisions that match `query` (all of them, newest first, when it is empty), best first, then this
 * checkout's, then newest. A question answered more than once shows once, at its latest answer, with a note on
 * the earlier ones.
 */
export function recall(query: string, { top, repo, limit = 12 }: { top?: string; repo?: string; limit?: number } = {}) {
  const words = terms(query);
  const all = everythingKept();
  const groups = grouped(all);
  const here = (r: Recalled) => isHere({ top: r.top, repo: r.repo }, { top, repo }) ? 1 : 0;
  const found: Found[] = [];
  for (const r of all) {
    const group = r.key ? groups.get(r.key)! : [r];
    if (group[0] !== r) continue; // an older answer to a question asked again
    const { hits, s } = words.length ? score(r, words) : { hits: 0, s: 1 };
    if (!s) continue;
    const before = group.slice(1);
    const differs = before.find((x) => x.answer !== r.answer);
    const earlier = !before.length ? '' : differs
      ? ` [changed: earlier "${clip(differs.said, 60)}" on ${differs.at.slice(0, 10)}]`
      : ` [same answer ${before.length + 1} times]`;
    found.push({ ...r, score: s, hits, earlier });
  }
  // Every word must match. One word alone matched nearly everything ("home club" found 133 decisions, every ticket
  // key found every ticket), so a decision with only some of them is shown only when none has all, and then only
  // those with more than half the words.
  const every = found.filter((f) => f.hits === words.length);
  const most = Math.floor(words.length / 2) + 1;
  const partial = words.length > 1 && !every.length;
  const kept = !words.length ? found : partial ? found.filter((f) => f.hits >= most && most < words.length) : every;
  kept.sort((a, b) => b.hits - a.hits || b.score - a.score || here(b) - here(a) || b.at.localeCompare(a.at));
  return { words, total: kept.length, shown: kept.slice(0, limit), partial };
}

export function formatRecalled(r: Found) {
  return `${r.at.slice(0, 10)}  ${r.repo || '-'}  ${clip(r.about, 100)} -> ${r.said}${r.earlier}  (${r.id})`;
}
