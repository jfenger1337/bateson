import { useMemo } from 'react';
import { useKept } from './lib/kept';

// A unified diff, file by file. Line numbers are drawn by CSS from data attributes, so they are not text:
// a selection's offsets and quote stay inside the code.

type Line = { t: 'add' | 'del' | 'ctx' | 'note'; text: string; old?: number; new?: number };
type Hunk = { header: string; lines: Line[] };
type File = { path: string; status?: string; hunks: Hunk[] };

export function parseDiff(text: string): File[] {
  const files: File[] = [];
  let f: File | null = null;
  let h: Hunk | null = null;
  let o = 0, n = 0;
  // What the hunk header said is still to come on each side. Until both run out, every line is the hunk's,
  // so a removed "-- comment" or an added "++ x" is code, not a file header.
  let oLeft = 0, nLeft = 0;
  for (const raw of text.split('\n')) {
    const inHunk = !!h && (oLeft > 0 || nLeft > 0);
    if (inHunk) {
      if (raw.startsWith('+')) { h!.lines.push({ t: 'add', text: raw.slice(1), new: n++ }); nLeft--; continue; }
      if (raw.startsWith('-')) { h!.lines.push({ t: 'del', text: raw.slice(1), old: o++ }); oLeft--; continue; }
      if (raw.startsWith('\\')) { h!.lines.push({ t: 'note', text: raw.slice(2) }); continue; }
      if (raw.startsWith(' ') || raw === '') { h!.lines.push({ t: 'ctx', text: raw.slice(1), old: o++, new: n++ }); oLeft--; nLeft--; continue; }
      oLeft = nLeft = 0; // a hunk cut short: read the line as what comes after it
    }
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(raw);
      f = { path: m ? m[1] : raw.slice(11), hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) { f = { path: '', hunks: [] }; files.push(f); }
    if (raw.startsWith('new file')) { f.status = 'new'; continue; }
    if (raw.startsWith('deleted file')) { f.status = 'deleted'; continue; }
    if (raw.startsWith('+++ ')) { const p = raw.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') f.path = p; continue; }
    if (raw.startsWith('--- ')) { const p = raw.slice(4).replace(/^a\//, ''); if (!f.path && p !== '/dev/null') f.path = p; continue; }
    if (/^(index |similarity |rename |old mode|new mode)/.test(raw)) continue;
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (hm) {
      o = Number(hm[1]); n = Number(hm[3]);
      oLeft = hm[2] != null ? Number(hm[2]) : 1; nLeft = hm[4] != null ? Number(hm[4]) : 1;
      h = { header: hm[5].trim(), lines: [] }; f.hunks.push(h);
      continue;
    }
    // A "\ No newline at end of file" after the hunk's last line still belongs to it.
    if (h && raw.startsWith('\\')) h.lines.push({ t: 'note', text: raw.slice(2) });
  }
  return files.filter((x) => x.hunks.length || x.path);
}

/** A diff's added and removed lines, in order, each with its marker: what newLines (changes.ts) compares and numbers. */
export function changedLines(text: string): string[] {
  return parseDiff(text).flatMap((f) => f.hunks.flatMap((hk) => hk.lines.filter((l) => l.t === 'add' || l.t === 'del').map((l) => (l.t === 'add' ? '+' : '-') + l.text)));
}

/** `fresh`: on a revision, the +/- lines that are new since the previous version, by their place among the diff's
 *  +/- lines (changedLines), tinted. By place and not by text: a new "}" does not make every "}" new. */
export function Diff({ text, fresh }: { text: string; fresh?: Set<number> }) {
  const files = useMemo(() => parseDiff(text), [text]);
  let changed = 0;
  const totals = files.reduce((acc, f) => {
    for (const hk of f.hunks) for (const l of hk.lines) { if (l.t === 'add') acc.add++; if (l.t === 'del') acc.del++; }
    return acc;
  }, { add: 0, del: 0 });
  return (
    <div className="diff">
      <p className="diff-sum">
        {files.length} file{files.length === 1 ? '' : 's'}, <span className="rec">+{totals.add} −{totals.del}</span>
      </p>
      {files.map((f, fi) => (
        <section key={fi} id={`diff-file-${fi}`} className="diff-file">
          <header className="diff-path rec">
            {f.path}
            {f.status && <span className="diff-status">{f.status}</span>}
          </header>
          {f.hunks.map((hk, hi) => (
            <div key={hi} className="diff-hunk">
              {hi > 0 && <div className="diff-gap" aria-hidden />}
              {hk.lines.map((l, li) => {
                const k = l.t === 'add' || l.t === 'del' ? changed++ : -1;
                return (
                <div
                  key={li}
                  className={`dl dl-${l.t}${fresh?.has(k) ? ' dl-fresh' : ''}`}
                  data-file={f.path}
                  data-line={l.new ?? l.old}
                  data-side={l.t === 'del' ? 'old' : 'new'}
                  data-o={l.old ?? ''}
                  data-n={l.new ?? ''}
                >
                  {/* The line break is text too, so a selection over several lines quotes them as lines. */}
                  <code>{l.text || '​'}{'\n'}</code>
                </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

const sizeOf = (f: File) => {
  let add = 0, del = 0;
  for (const hk of f.hunks) for (const l of hk.lines) { if (l.t === 'add') add++; if (l.t === 'del') del++; }
  return { add, del };
};

/** A diff of more than three files starts with a list of them: each with its size, a click to go to it, and a mark
 *  for the ones you have read, kept with your other unsent work on the item (`keep`, lib/kept.ts). It sits above the
 *  body, not in it, so nothing in it is ever part of what a comment quotes. */
export function DiffFiles({ text, keep }: { text: string; keep: string }) {
  const files = useMemo(() => parseDiff(text), [text]);
  const [seen, setSeen] = useKept<string[]>(`${keep}:seen`, () => []);
  if (files.length <= 3) return null;
  const sizes = files.map(sizeOf);
  const most = Math.max(1, ...sizes.map((s) => s.add + s.del));
  const total = sizes.reduce((acc, s) => ({ add: acc.add + s.add, del: acc.del + s.del }), { add: 0, del: 0 });
  const done = files.filter((f) => seen.includes(f.path)).length;
  const flip = (path: string) => setSeen((was) => (was.includes(path) ? was.filter((p) => p !== path) : [...was, path]));
  return (
    <nav className="diff-files" aria-label="Files in this change">
      <p className="diff-files-sum">
        <span>{files.length} files, <span className="rec">+{total.add} −{total.del}</span></span>
        <span className={done === files.length ? 'all' : undefined}>{done} of {files.length} read</span>
      </p>
      <ul>
        {files.map((f, i) => {
          const s = sizes[i];
          const read = seen.includes(f.path);
          return (
            <li key={i} className={read ? 'read' : undefined}>
              <button type="button" className="diff-files-mark" aria-pressed={read} aria-label={`${f.path}: read`} title={read ? 'Mark as not read' : 'Mark as read'} onClick={() => flip(f.path)}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button type="button" className="diff-files-path rec" title={`Go to ${f.path}`} onClick={() => document.getElementById(`diff-file-${i}`)?.scrollIntoView({ block: 'start' })}>
                {f.path}{f.status && <span className="diff-status">{f.status}</span>}
              </button>
              <span className="diff-files-n rec">+{s.add} −{s.del}</span>
              <span className="diff-files-bar" aria-hidden>
                <i className="add" style={{ width: `${(s.add / most) * 100}%` }} />
                <i className="del" style={{ width: `${(s.del / most) * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
