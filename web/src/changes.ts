// What is new in a revision. Myers' diff over words (prose) or lines (diffs). Removed text is not shown in the
// work: a revision reads as the new version, with each changed sentence tinted as a whole.
import { changedLines } from './Diff';

/** For each token of `b`, the index of the token of `a` it is matched with in the longest common subsequence,
 *  or -1 where `b` has something new. Null when the two are too different to say. */
function matches(a: string[], b: string[], maxD = 2000): Int32Array | null {
  const mb = new Int32Array(b.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { mb[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; mb[eb] = ea; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  if (!A.length || !B.length) return mb;
  const N = A.length, M = B.length, off = N + M;
  const v = new Int32Array(2 * off + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(N + M, maxD); d++) {
    trace.push(v.slice(off - d, off + d + 1)); // only diagonals -d..d can be read back at this step
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) {
        // Walk back through the snapshots; every diagonal step is a match.
        let cx = N, cy = M;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const down = kk === -dd || (kk !== dd && pv[dd + kk - 1] < pv[dd + kk + 1]);
          const pk = down ? kk + 1 : kk - 1;
          const px = pv[dd + pk], py = px - pk;
          while (cx > px && cy > py) { cx--; cy--; mb[s + cy] = s + cx; }
          cx = px; cy = py;
        }
        while (cx > 0 && cy > 0) { cx--; cy--; mb[s + cy] = s + cx; }
        return mb;
      }
    }
  }
  return null;
}

const words = (t: string) => t.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? [];
const starts = (toks: string[]) => { const o: number[] = []; let p = 0; for (const t of toks) { o.push(p); p += t.length; } return o; };

/** Sentences of a text as [start, end) without their trailing space. Line breaks end one too, so a heading or a
 *  list item never runs into what follows it. */
function sentences(text: string): [number, number][] {
  const out: [number, number][] = [];
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const { index, segment } of seg.segment(text)) {
    let at = index;
    for (const part of segment.split('\n')) {
      const lead = part.length - part.trimStart().length;
      const body = part.trim();
      if (body) out.push([at + lead, at + lead + body.length]);
      at += part.length + 1;
    }
  }
  return out;
}

export interface ProseChanges {
  /** Each changed sentence of the new text, whole. */
  changed: [number, number][];
  /** The changed sentences that stand where [start, end) of the old text was: what a comment there led to. */
  at(start: number, end: number): [number, number][];
}

export function proseChanges(prev: string, next: string): ProseChanges {
  const none: ProseChanges = { changed: [], at: () => [] };
  const a = words(prev), b = words(next);
  const mb = matches(a, b);
  if (!mb || !mb.some((x) => x >= 0)) return none; // nothing in common: tinting everything says nothing
  const ma = new Int32Array(a.length).fill(-1);
  mb.forEach((i, j) => { if (i >= 0) ma[i] = j; });
  const as = starts(a), bs = starts(b);
  const sents = sentences(next);
  const sentenceAt = (pos: number) => sents.findIndex(([s, e]) => pos >= s && pos < e);
  const hit = new Set<number>();
  // Something new: its sentence changed.
  b.forEach((t, j) => { if (mb[j] < 0 && /\S/.test(t)) hit.add(sentenceAt(bs[j])); });
  // Something taken out: the sentence it was taken from changed. That is the sentence of the word kept before it,
  // unless that word ended a sentence; then the cut opened the next one.
  a.forEach((t, i) => {
    if (ma[i] >= 0 || !/\S/.test(t)) return;
    let k = i - 1;
    while (k >= 0 && (ma[k] < 0 || !/\S/.test(a[k]))) k--;
    let n = i + 1;
    while (n < a.length && (ma[n] < 0 || !/\S/.test(a[n]))) n++;
    const before = k >= 0 && !/^[.!?]$/.test(a[k]);
    if (before || n >= a.length) { if (k >= 0) hit.add(sentenceAt(bs[ma[k]])); }
    else hit.add(sentenceAt(bs[ma[n]]));
  });
  hit.delete(-1);
  const changed = [...hit].sort((x, y) => x - y).map((k) => sents[k]);
  const at = (start: number, end: number) => {
    // The region of the new text between the last word kept before the old passage and the first kept after it.
    let lo = 0, hi = next.length;
    for (let i = 0; i < a.length; i++) {
      if (as[i] + a[i].length <= start) { if (ma[i] >= 0) lo = bs[ma[i]] + a[i].length; }
      else if (as[i] >= end && ma[i] >= 0) { hi = bs[ma[i]]; break; }
    }
    const out = changed.filter(([s, e]) => (lo < hi ? s < hi && e > lo : s <= lo && e >= lo));
    // A rewrite often runs on: changed sentences straight after, on the same line, belong to it too.
    for (let k = changed.indexOf(out[out.length - 1]) + 1; out.length && k < changed.length; k++) {
      if (!/^[ \t]*$/.test(next.slice(out[out.length - 1][1], changed[k][0]))) break;
      out.push(changed[k]);
    }
    return out;
  };
  return { changed, at };
}

/** Where a passage of the old text was: its offsets if they still hold the quote, else the quote found again. */
export function locate(text: string, quote: string | undefined, start?: number, end?: number): [number, number] | null {
  if (!quote) return null;
  if (start != null && end != null && text.slice(start, end).trim() === quote.trim()) return [start, end];
  const k = text.indexOf(quote.trim());
  return k < 0 ? null : [k, k + quote.trim().length];
}

/** For a diff: which of its +/- lines are new against the previous diff, by their place among them (changedLines). */
export function newLines(prev: string, next: string): Set<number> {
  const a = changedLines(prev), b = changedLines(next);
  const mb = matches(a, b);
  if (!mb || !mb.some((x) => x >= 0)) return new Set();
  return new Set(b.map((_, j) => j).filter((j) => mb[j] < 0));
}
