// `bateson recall`: what the reviewer already decided, one short line each, so an agent can check before it asks
// again. Read straight from the queue's files on every call: no index, no model, nothing to keep in step.
import store from './store.ts';
import type { DecisionFile, StoredItem, StoredVersion } from './store.ts';
import type { Question } from './types.ts';

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
}

const MAX = 160;
const clip = (s: string, n = MAX) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function answers(item: StoredItem, v: StoredVersion, d: DecisionFile, base: Omit<Recalled, 'about' | 'said' | 'rest'>): Recalled[] {
  const qs = store.readQuestions(item, v);
  return (d.answers || []).flatMap((a): Recalled[] => {
    const q: Partial<Question> = qs.find((x) => x.id === a.id) || {};
    const rec = q.recommended != null ? q.options?.[q.recommended]?.label : undefined;
    let said: string, answer: string;
    if (a.other) { said = `wrote: "${clip(a.other)}"`; answer = norm(a.other); }
    else if (a.choice != null && q.options?.[a.choice]) {
      const label = q.options[a.choice].label;
      answer = norm(label);
      said = a.choice === q.recommended ? `${label} (the recommendation${a.accepted ? ', taken as it was' : ''})`
        : rec ? `${label} (over the recommended "${rec}")` : label;
    } else return [];
    const about = q.title || a.id;
    const rest = [item.title, q.body, ...(q.options || []).map((o) => `${o.label} ${o.description || ''}`)].join(' ');
    return [{ ...base, about, said, rest, key: `${base.repo}\0${norm(about)}`, answer }];
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

/** Every decision on record, delivered or not, newest first. */
export function everything(): Recalled[] {
  const out: Recalled[] = [];
  for (const item of [...store.allDone(), ...store.allQueued()]) {
    for (const v of item.versions) {
      const d = store.readDecision(item, v.n);
      if (!d) continue;
      const base = { id: item.id, at: d.decidedAt || v.createdAt, repo: item.source?.repo || '', top: item.source?.top };
      out.push(...(v.bodyType === 'questions' ? answers(item, v, d, base) : reviewed(item, v, d, base)));
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// Words in nearly every question ("Which ... should ...?"), which would match everything.
const COMMON = new Set('the and for with what which who how why when where should would could does this that these those are you your from into than then'.split(' '));
/** Words worth matching: three letters or more, and not one of the words nearly every question has. */
export const terms = (query: string) => [...new Set(norm(query).split(' ').filter((w) => w.length >= 3 && !COMMON.has(w)))];

/** How well a decision matches: 2 for each word in what it was about or what was said, 1 for each elsewhere. */
function score(r: Recalled, words: string[]) {
  const head = norm(`${r.about} ${r.said}`);
  const rest = norm(r.rest);
  return words.reduce((s, w) => s + (head.includes(w) ? 2 : rest.includes(w) ? 1 : 0), 0);
}

export interface Found extends Recalled { score: number; earlier: string }

/**
 * The decisions that match `query` (all of them, newest first, when it is empty), best first, then this
 * checkout's, then newest. A question answered more than once shows once, at its latest answer, with a note on
 * the earlier ones.
 */
export function recall(query: string, { top, repo, limit = 12 }: { top?: string; repo?: string; limit?: number } = {}) {
  const words = terms(query);
  const all = everything();
  // Group a question asked again (same repo, same words) under its latest answer.
  const groups = new Map<string, Recalled[]>();
  for (const r of all) if (r.key) groups.set(r.key, [...(groups.get(r.key) || []), r]);
  const here = (r: Recalled) => (top && r.top === top) || (!r.top && repo && r.repo === repo) ? 1 : 0;
  const found: Found[] = [];
  for (const r of all) {
    const group = r.key ? groups.get(r.key)! : [r];
    if (group[0] !== r) continue; // an older answer to a question asked again
    const s = words.length ? score(r, words) : 1;
    if (!s) continue;
    const before = group.slice(1);
    const differs = before.find((x) => x.answer !== r.answer);
    const earlier = !before.length ? '' : differs
      ? ` [changed: earlier "${clip(differs.said, 60)}" on ${differs.at.slice(0, 10)}]`
      : ` [same answer ${before.length + 1} times]`;
    found.push({ ...r, score: s, earlier });
  }
  found.sort((a, b) => b.score - a.score || here(b) - here(a) || b.at.localeCompare(a.at));
  return { words, total: found.length, shown: found.slice(0, limit) };
}

export function formatRecalled(r: Found) {
  return `${r.at.slice(0, 10)}  ${r.repo || '-'}  ${clip(r.about, 100)} -> ${r.said}${r.earlier}  (${r.id})`;
}
