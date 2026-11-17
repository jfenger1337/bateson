import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keptKey, useKept } from './lib/kept';
import type { Anchor, Comment, Decision, Item } from '@lib/types';
import { locate, newLines, proseChanges } from './changes';
import { Markdown, markdownHtml } from './Markdown';
import { Diff } from './Diff';
import { isTyping } from './App';
import { MOD } from './lib/keys';

// Comment on the work. Select any passage and comment on it; on code the comment also records the file and line.
// On writing, pointing at a bullet or paragraph puts a mark beside it that comments on the whole of it. Each note
// sits under the block it is about, in the reading column; a commented passage takes the highlighter (CSS Custom
// Highlight API, so the work's DOM is untouched). On a revision, each reply to a comment sits under the change it made.

interface Picked { anchor: Anchor; x: number; y: number }
/** The block of writing under the pointer, and where its mark goes. */
interface Pointed { el: HTMLElement; x: number; y: number }
/** Where a note sits: under a passage, under the title, or after everything else. */
type Place = Range[] | 'title' | 'end';

const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, .dl, .plain';
const POINTABLE = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table';
const GAP = 10;

export function Review({ item, onDecide, onLater }: { item: Item; onDecide: (i: Item, d: Decision) => void; onLater: (i: Item) => void }) {
  const v = item.version;
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const [comments, setComments] = useKept<Comment[]>(`${keptKey(item)}:comments`, () => []);
  // `send`: the note was opened by Send back with nothing written yet, so saving it sends it. `id`: a written note
  // reopened to edit.
  const [draft, setDraft] = useState<{ anchor: Anchor; text: string; send?: boolean; id?: string } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const [markHot, setMarkHot] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // The reply under the pointer, or the one whose change is: both light up together.
  const [hot, setHot] = useState<string | null>(null);
  const prev = item.previous;
  const asked = prev?.comments ?? [];
  const onCode = v.bodyType === 'diff';
  // For each reply (a0, a1, ...), the change it made in this version.
  const links = useRef(new Map<string, Range[]>());

  const freshLines = useMemo(() => (prev && v.bodyType === 'diff' && prev.bodyType === 'diff' ? newLines(prev.body, v.body as string) : undefined), [prev, v]);

  // A revision: each changed sentence takes a tint, whole, and each reply finds the change it made.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    links.current = new Map();
    if (!root || !prev) return;
    if (v.bodyType === 'diff') {
      asked.forEach((c, k) => {
        if (c.reply?.addressed && c.anchor.file) links.current.set(`a${k}`, changedRows(root, c.anchor.file, c.anchor.line, prev.bodyType === 'diff'));
      });
      return;
    }
    if (prev.bodyType === 'diff' || prev.bodyType === 'findings' || !reg || !H) return;
    const before = document.createElement('div');
    if (prev.bodyType === 'markdown') before.innerHTML = markdownHtml(prev.body);
    else before.textContent = prev.body;
    const old = before.textContent ?? '';
    const changes = proseChanges(old, root.textContent ?? '');
    const toRanges = (spans: [number, number][]) => spans.map(([start, end]) => rangeAt(root, { kind: 'text', start, end })).filter((r): r is Range => !!r);
    asked.forEach((c, k) => {
      const at = c.reply?.addressed && c.anchor.kind === 'text' ? locate(old, c.anchor.quote, c.anchor.start, c.anchor.end) : null;
      if (at) links.current.set(`a${k}`, toRanges(changes.at(at[0], at[1])));
    });
    reg.set('qr-new', new H(...toRanges(changes.changed)));
    return () => { reg.delete('qr-new'); };
  }, [prev, v]);

  useLayoutEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !H) return;
    reg.set('qr-new-hot', new H(...(hot ? links.current.get(hot) ?? [] : [])));
    return () => { reg.delete('qr-new-hot'); };
  }, [hot]);

  // A selection inside the work offers a comment, just above it.
  useEffect(() => {
    const onUp = () => {
      window.setTimeout(() => {
        const sel = window.getSelection();
        const root = bodyRef.current;
        if (!sel || sel.isCollapsed || !root || !sel.rangeCount) { setPicked(null); return; }
        const range = sel.getRangeAt(0).cloneRange();
        if (!root.contains(range.startContainer)) { setPicked(null); return; }
        // A triple click on the last paragraph runs on past the work; the part inside it is what was meant.
        if (!root.contains(range.endContainer)) range.setEnd(root, root.childNodes.length);
        const anchor = anchorFrom(root, range, range.toString());
        if (!anchor.quote?.trim()) { setPicked(null); return; }
        const first = range.getClientRects()[0] ?? range.getBoundingClientRect();
        setPicked({ anchor, x: first.left, y: Math.max(60, first.top - 38) });
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('keyup', onUp); };
  }, []);

  // On writing, the block level with the pointer, from the left gutter to the end of the line, gets a mark in the
  // gutter. Nested blocks: the innermost wins, as it comes later in the document.
  useEffect(() => {
    if (onCode) return;
    let at: { x: number; y: number } | null = null;
    const find = () => {
      const root = bodyRef.current;
      if (!at || !root) { setPointed(null); return; }
      const box = root.getBoundingClientRect();
      if (at.x < box.left - 56 || at.x > box.right || at.y < box.top || at.y > box.bottom) { setPointed(null); return; }
      let el: HTMLElement | null = null;
      for (const b of root.querySelectorAll<HTMLElement>(POINTABLE)) {
        const r = b.getBoundingClientRect();
        if (at.y >= r.top && at.y <= r.bottom) el = b;
      }
      if (!el) { setPointed(null); return; }
      const half = (parseFloat(getComputedStyle(el).lineHeight) || 24) / 2;
      const next = { el, x: box.left - 40, y: el.getBoundingClientRect().top + half };
      setPointed((was) => (was && was.el === next.el && was.y === next.y ? was : next));
    };
    const onMove = (e: MouseEvent) => { at = { x: e.clientX, y: e.clientY }; find(); };
    document.addEventListener('mousemove', onMove);
    window.addEventListener('scroll', find, true);
    return () => { document.removeEventListener('mousemove', onMove); window.removeEventListener('scroll', find, true); };
  }, [onCode]);
  useEffect(() => { if (!pointed) setMarkHot(false); }, [pointed]);

  const startComment = useCallback((anchor: Anchor, send = false) => {
    setDraft({ anchor, text: '', send });
    setPicked(null);
  }, []);

  const save = () => {
    if (!draft?.text.trim()) { setDraft(null); return; }
    if (draft.id) {
      const text = draft.text.trim();
      setComments((cs) => cs.map((x) => (x.id === draft.id ? { ...x, text } : x)));
      setDraft(null);
      return;
    }
    const c = { id: Math.random().toString(36).slice(2, 9), anchor: draft.anchor, text: draft.text.trim() };
    if (draft.send) { setDraft(null); onDecide(item, { decision: 'send-back', comments: [...comments, c].sort(byPosition) }); return; }
    setComments((cs) => [...cs, c].sort(byPosition));
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  // The highlighter on every commented passage; a stronger one on the comment you are on.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!root || !reg || !H) return;
    const ranges = (list: Anchor[]) => list.map((a) => rangeAt(root, a)).filter((r): r is Range => !!r);
    reg.set('qr-note', new H(...ranges(comments.filter((c) => c.id !== active).map((c) => c.anchor))));
    const hotNotes = [...comments.filter((c) => c.id === active).map((c) => c.anchor), ...(draft ? [draft.anchor] : [])];
    reg.set('qr-note-active', new H(...ranges(hotNotes)));
    reg.set('qr-pointed', new H(...(markHot && pointed && !draft ? [blockRange(pointed.el)] : [])));
    return () => { reg.delete('qr-note'); reg.delete('qr-note-active'); reg.delete('qr-pointed'); };
  }, [comments, active, draft, markHot, pointed]);

  // Each card's place, by its key: a note by the passage it quotes, a reply by its change.
  const placeOf = useCallback((key: string): Place => {
    const root = bodyRef.current;
    const at = (a: Anchor): Place => {
      if (a.kind === 'item' || !root) return 'title';
      // A triple click ends on the line break after its block; the note belongs under the block, not after it.
      const text = root.textContent ?? '';
      let end = a.end ?? 0;
      while (end > (a.start ?? 0) + 1 && /\s/.test(text[end - 1])) end--;
      const r = rangeAt(root, { ...a, end });
      return r ? [r] : 'end';
    };
    if (key === 'draft') return draft ? at(draft.anchor) : 'end';
    if (key.startsWith('a')) { const r = links.current.get(key); return r?.length ? r : 'end'; }
    const c = comments.find((x) => x.id === key);
    return c ? at(c.anchor) : 'end';
  }, [comments, draft]);

  // Lay the notes out under the block their place is in, which makes room for them.
  const pushed = useRef(new Map<HTMLElement, { margin: string; transition: string }>());
  const unpush = () => {
    for (const [el, was] of pushed.current) { el.style.marginBottom = was.margin; el.style.transition = was.transition; }
    pushed.current.clear();
  };
  const layout = useCallback(() => {
    const notes = notesRef.current;
    unpush();
    if (!notes) return;
    const cards = [...notes.querySelectorAll<HTMLElement>('[data-slot]')];
    const blockOf = (p: Place): HTMLElement | null => {
      if (p === 'title') return titleRef.current;
      if (p === 'end') return bodyRef.current;
      const n = p[p.length - 1].endContainer;
      return (n.nodeType === 1 ? n as Element : n.parentElement)?.closest<HTMLElement>(BLOCK) ?? bodyRef.current;
    };
    const groups = new Map<HTMLElement, HTMLElement[]>();
    for (const el of cards) {
      const b = blockOf(placeOf(el.dataset.slot!));
      if (b) groups.set(b, [...(groups.get(b) ?? []), el]);
    }
    for (const [b, els] of groups) {
      pushed.current.set(b, { margin: b.style.marginBottom, transition: b.style.transition });
      // No transition while we read the block's own margin: with reduced motion everything eases for 1ms, and the
      // read would still see the margin we pushed, so each layout would add the room again.
      b.style.transition = 'none';
      const room = els.reduce((h, el) => h + el.offsetHeight + GAP, GAP);
      b.style.marginBottom = `${parseFloat(getComputedStyle(b).marginBottom) + room}px`;
    }
    const t = notes.getBoundingClientRect().top;
    for (const [b, els] of groups) {
      let y = b.getBoundingClientRect().bottom - t + GAP;
      for (const el of els) { el.style.top = `${Math.round(y)}px`; y += el.offsetHeight + GAP; }
    }
  }, [placeOf]);

  useLayoutEffect(layout);
  useEffect(() => {
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
    const ro = new ResizeObserver(again);
    if (bodyRef.current) ro.observe(bodyRef.current);
    notesRef.current?.querySelectorAll('[data-slot]').forEach((el) => ro.observe(el));
    window.addEventListener('resize', again);
    document.fonts?.ready.then(again);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', again); };
  });
  useEffect(() => unpush, []);

  // Pointing at a changed passage lights the reply it answers.
  const onBodyMove = (e: React.MouseEvent) => {
    if (!links.current.size) return;
    let found: string | null = null;
    for (const [key, ranges] of links.current) {
      if (ranges.some((r) => [...r.getClientRects()].some((b) => e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom))) { found = key; break; }
    }
    if (found !== hot) setHot(found);
  };

  const whole: Anchor = { kind: 'item' };
  const commentOn = (el: HTMLElement) => { const root = bodyRef.current; if (root) startComment(anchorFrom(root, blockRange(el), blockRange(el).toString())); };
  // With nothing written yet, Send back asks what should change first.
  const sendBack = () => { if (comments.length) onDecide(item, { decision: 'send-back', comments }); else if (!draft) startComment(whole, true); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘⏎ is the main action everywhere: here, Approve. With comments written it sends them back instead, so
      // a note is never thrown away by the shortcut.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isTyping(e)) {
        e.preventDefault();
        if (comments.length) sendBack(); else onDecide(item, { decision: 'approve' });
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c' && picked) { e.preventDefault(); startComment(picked.anchor); }
      else if (e.key === 'c' && pointed && !draft) { e.preventDefault(); commentOn(pointed.el); }
      else if (e.key === 'a') { e.preventDefault(); onDecide(item, { decision: 'approve' }); }
      else if (e.key === 's') { e.preventDefault(); sendBack(); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); onLater(item); }
      else if (e.key === 'D') { e.preventDefault(); onDecide(item, { decision: 'drop' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hasNotes = comments.length > 0 || !!draft || asked.length > 0;
  const fromFindings = prev?.bodyType === 'findings';

  return (
    <article className="page review arrive">
      <div className="review-main">
        <h1 ref={titleRef} className="work-title commentable" onClick={() => startComment(whole)} title="Comment on the whole piece">{item.title}</h1>
        {v.note && <p className="note">{v.note}</p>}

        <div ref={bodyRef} className={`body body-${v.bodyType}`} onMouseMove={onBodyMove} onMouseLeave={() => setHot(null)}>
          {v.bodyType === 'markdown' && <Markdown className="prose" text={v.body as string} />}
          {v.bodyType === 'text' && <div className="prose plain">{v.body as string}</div>}
          {v.bodyType === 'diff' && <Diff text={v.body as string} fresh={freshLines} />}
        </div>

        {v.files.length > 0 && (
          <section className="files">
            {v.files.map((f) => {
              const src = `/api/items/${item.id}/files/${v.n}/${encodeURIComponent(f)}`;
              return /\.(png|jpe?g|gif|webp|svg)$/i.test(f)
                ? <figure key={f}><img src={src} alt={f} /><figcaption className="rec">{f}</figcaption></figure>
                : <a key={f} className="rec file-link" href={src} target="_blank" rel="noreferrer">{f}</a>;
            })}
          </section>
        )}
      </div>

      {hasNotes && (
        <aside ref={notesRef} className="notes" aria-label="Your comments">
          {asked.map((c, k) => {
            const key = `a${k}`;
            const done = !!c.reply?.addressed;
            const lead = fromFindings ? c.title ?? c.anchor.quote : c.text;
            return (
              <div
                key={c.id ?? k}
                data-slot={key}
                className={`note-card asked-card${c.reply ? (done ? ' is-done' : ' is-not') : ''}${hot === key ? ' hot' : ''}`}
                aria-label={`Your ${fromFindings ? 'finding' : 'comment'} on version ${prev!.n}`}
                onMouseEnter={() => setHot(key)}
                onMouseLeave={() => setHot(null)}
              >
                {c.anchor.kind === 'item' && <p className="note-where">On the whole piece</p>}
                {fromFindings && c.anchor.file && <p className="note-where"><span className="rec">{c.anchor.file}{c.anchor.line ? `:${c.anchor.line}` : ''}</span></p>}
                {lead && <p className="note-text">{lead}</p>}
                {fromFindings && c.text && <p className="asked-comment">{c.text}</p>}
                {!fromFindings && c.anchor.kind === 'text' && c.anchor.quote && (
                  done ? <p className="asked-was"><s>{clip(c.anchor.quote)}</s></p> : <p className="asked-was"><q>{clip(c.anchor.quote)}</q></p>
                )}
                <p className="reply">
                  <span className="reply-mark">{c.reply ? (done ? (fromFindings ? 'Fixed' : 'Addressed') : 'Not changed') : 'No reply'}</span>
                  {c.reply && <span className="reply-text">{c.reply.text}</span>}
                </p>
              </div>
            );
          })}
          {comments.filter((c) => c.id !== draft?.id).map((c) => (
            <div
              key={c.id}
              data-slot={c.id}
              className={`note-card mine${active === c.id ? ' active' : ''}`}
              onMouseEnter={() => setActive(c.id)}
              onMouseLeave={() => setActive(null)}
              onClick={(e) => { if (!(e.target as Element).closest('button')) setDraft({ anchor: c.anchor, text: c.text, id: c.id }); }}
            >
              <Where anchor={c.anchor} />
              <p className="note-text">{c.text}</p>
              <button className="btn-quiet sm note-remove" onClick={() => { setComments((cs) => cs.filter((x) => x.id !== c.id)); setActive(null); }}>Remove</button>
            </div>
          ))}
          {draft && (
            <div data-slot="draft" className="note-card composing drop-in">
              <Where anchor={draft.anchor} />
              <textarea
                autoFocus
                className="note-field"
                rows={3}
                placeholder="What should change?"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
                  if (e.key === 'Escape') setDraft(null);
                }}
              />
              <div className="note-actions">
                <button className="btn-quiet sm" onClick={() => setDraft(null)}>Cancel</button>
                <button className="btn-primary sm" onClick={save} disabled={!draft.text.trim()}>{draft.send ? 'Send back' : draft.id ? 'Save' : 'Add'} <span className="key on-ink">{MOD}⏎</span></button>
              </div>
            </div>
          )}
        </aside>
      )}

      {pointed && !picked && !draft && (
        <button
          className="point-mark"
          style={{ left: pointed.x, top: pointed.y - 12 }}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setMarkHot(true)}
          onMouseLeave={() => setMarkHot(false)}
          onClick={() => commentOn(pointed.el)}
          aria-label="Comment on this"
          title="Comment on this (C)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      )}

      {picked && !draft && (
        <button
          className="pick-btn drop-in"
          style={{ left: Math.min(picked.x, window.innerWidth - 140), top: picked.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => startComment(picked.anchor)}
        >
          Comment <span className="key on-ink">C</span>
        </button>
      )}

      <footer className="decide">
        <div className="decide-in">
          <p className="decide-sentence">
            {comments.length
              ? `${comments.length} comment${comments.length === 1 ? '' : 's'}. Sending back gives the agent exactly these.`
              : onCode
                ? 'Select anything to comment on it, or click the title to comment on the whole piece.'
                : null}
          </p>
          <div className="decide-actions">
            <button className="btn-quiet" onClick={() => onDecide(item, { decision: 'drop' })} title="The agent stops and leaves its changes (shift D)">Drop</button>
            <button className="btn-ghost" onClick={() => onLater(item)}>Later <span className="key">L</span></button>
            <button className="btn-pill lg" onClick={sendBack}>Send back <span className="key">S</span></button>
            <button className="btn-primary" onClick={() => onDecide(item, { decision: 'approve' })}>
              Approve <span className="key on-ink">A</span>
            </button>
          </div>
        </div>
      </footer>
    </article>
  );
}

function Where({ anchor }: { anchor: Anchor }) {
  if (anchor.kind === 'item') return <p className="note-where">On the whole piece</p>;
  return (
    <p className="note-where">
      {anchor.file && <span className="rec">{anchor.file}{anchor.line ? `:${anchor.line}` : ''} </span>}
      <q>{anchor.quote ? clip(anchor.quote) : ''}</q>
    </p>
  );
}

/** A long quote, cut at a word near 90 characters. */
function clip(q: string) {
  if (q.length <= 90) return q;
  const cut = q.slice(0, 90);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)) + '…';
}

/** The lines of a file that a reply changed: in a revision of a diff, the run of new lines nearest the line the
 *  comment was on; after findings, the run of changed lines nearest the finding. */
function changedRows(root: HTMLElement, file: string, line: number | undefined, freshOnly: boolean): Range[] {
  const rows = [...root.querySelectorAll<HTMLElement>('.dl')].filter((r) => r.dataset.file === file && (freshOnly ? r.classList.contains('dl-fresh') : r.matches('.dl-add, .dl-del')));
  const runs: HTMLElement[][] = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].nextElementSibling === r) last.push(r); else runs.push([r]);
  }
  const lineOf = (r: HTMLElement) => Number(r.dataset.line) || 0;
  const best = runs.sort((x, y) => Math.abs(lineOf(x[0]) - (line ?? 0)) - Math.abs(lineOf(y[0]) - (line ?? 0)))[0] ?? [];
  return best.map((r) => { const g = document.createRange(); g.selectNodeContents(r.querySelector('code') ?? r); return g; });
}

/** A block's own text: a list item without the list nested in it. */
function blockRange(el: HTMLElement): Range {
  const r = document.createRange();
  r.selectNodeContents(el);
  const nested = el.querySelector(':scope > ul, :scope > ol');
  if (nested) r.setEndBefore(nested);
  return r;
}

function byPosition(a: Comment, b: Comment) {
  return (a.anchor.start ?? -1) - (b.anchor.start ?? -1);
}

// ---- Anchors: character offsets into the work's text, plus the quote and its surroundings, and for a diff the
// file and line the selection starts on.

function offsetOf(root: Node, node: Node, offset: number) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

function anchorFrom(root: HTMLElement, range: Range, quote: string): Anchor {
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  const all = root.textContent ?? '';
  const el = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer as Element)?.closest('[data-line]') as HTMLElement | null;
  return {
    kind: 'text',
    quote: quote.trim(),
    prefix: all.slice(Math.max(0, start - 40), start),
    suffix: all.slice(end, end + 40),
    start, end,
    ...(el ? { file: el.dataset.file, line: Number(el.dataset.line), side: el.dataset.side as 'old' | 'new' } : {}),
  };
}

function rangeAt(root: HTMLElement, a: Anchor): Range | null {
  if (a.kind !== 'text' || a.start == null || a.end == null) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Node | null = null, startOff = 0, endNode: Node | null = null, endOff = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (!startNode && a.start <= pos + len) { startNode = n; startOff = a.start - pos; }
    if (a.end <= pos + len) { endNode = n; endOff = a.end - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  return r;
}
