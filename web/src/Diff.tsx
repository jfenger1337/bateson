import { useMemo } from 'react';

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
        <section key={fi} className="diff-file">
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
