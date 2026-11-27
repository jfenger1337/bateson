import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keptKey, useKept } from './lib/kept';
import type { Anchor, Comment, Decision, Item } from '@lib/types';
import { locate, newLines, proseChanges } from './changes';
import { Markdown, markdownHtml } from './Markdown';
import { Diff, DiffFiles } from './Diff';
import { isTyping, Reach } from './App';
import { keyOf } from './lib/keys';
import { easeNote, reduced } from '@/lib/motion';

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
// Narrower than this, a reply under its passage is folded to one line until you open it: the reading column has
// no margin beside it, so open replies would push the text apart.
const NARROW = window.matchMedia('(max-width: 1000px)');
function useNarrow() {
  const [narrow, setNarrow] = useState(NARROW.matches);
  useEffect(() => {
    const on = () => setNarrow(NARROW.matches);
    NARROW.addEventListener('change', on);
    return () => NARROW.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Review({ item, onDecide, onLater }: { item: Item; onDecide: (i: Item, d: Decision) => void; onLater: (i: Item) => void }) {
  const v = item.version;
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const [comments, setComments] = useKept<Comment[]>(`${keptKey(item)}:comments`, () => []);
  // `send`: the note was opened by Send back with nothing written yet, so saving it sends it. `id`: a written note
  // reopened to edit. Kept like the comments, so opening Settings or a reload does not lose what is half written.
  const [draft, setDraft] = useKept<{ anchor: Anchor; text: string; send?: boolean; id?: string } | null>(`${keptKey(item)}:draft`, () => null);
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
  // For each reply that changed nothing there, the passage it is about, as it stands in this version.
  const homes = useRef(new Map<string, Range[]>());
  // A reply jumped to: its card and its passage light up for a moment.
  const [pulse, setPulse] = useState<string | null>(null);
  const narrow = useNarrow();
  // The replies opened on a narrow window. Jumping to one opens it too.
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const unfold = (key: string, open = true) => setUnfolded((u) => { const n = new Set(u); if (open) n.add(key); else n.delete(key); return n; });
  const pulseTimer = useRef<number | undefined>(undefined);

  // Where a reply is in this version: the change it made, else the passage it is about.
  const passageOf = (key: string): Range[] => { const r = links.current.get(key); return r?.length ? r : homes.current.get(key) ?? []; };

  // The version's attachments, and those its markdown already shows in place: they are not listed again under it.
  const filesBase = `/api/items/${item.id}/files/${v.n}/`;
  const inline = useMemo(() => { const used = new Set<string>(); if (v.bodyType === 'markdown') markdownHtml(v.body as string, filesBase, used); return used; }, [v, filesBase]);
  const listed = v.files.filter((f) => !inline.has(f));
  const freshLines = useMemo(() => (prev && v.bodyType === 'diff' && prev.bodyType === 'diff' ? newLines(prev.body, v.body as string) : undefined), [prev, v]);

  // A revision: each changed sentence takes a tint, whole, and each reply finds the change it made.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    links.current = new Map();
    homes.current = new Map();
    if (!root || !prev) return;
    if (v.bodyType === 'diff') {
      asked.forEach((c, k) => {
        if (c.reply?.addressed && c.anchor.file) links.current.set(`a${k}`, changedRows(root, c.anchor.file, c.anchor.line, prev.bodyType === 'diff'));
      });
      return;
    }
    if (prev.bodyType === 'diff' || prev.bodyType === 'findings' || !reg || !H) return;
    const before = document.createElement('div');
    if (prev.bodyType === 'markdown') before.innerHTML = markdownHtml(prev.body, `/api/items/${item.id}/files/${prev.n}/`);
    else before.textContent = prev.body;
    const old = before.textContent ?? '';
    const changes = proseChanges(old, root.textContent ?? '');
    const toRanges = (spans: [number, number][]) => spans.map(([start, end]) => rangeAt(root, { kind: 'text', start, end })).filter((r): r is Range => !!r);
    asked.forEach((c, k) => {
      const at = c.reply?.addressed && c.anchor.kind === 'text' ? locate(old, c.anchor.quote, c.anchor.start, c.anchor.end) : null;
      if (at) links.current.set(`a${k}`, toRanges(changes.at(at[0], at[1])));
    });
    // A reply that changed nothing sits under the passage it is about, which keeps a dotted underline.
    const now = root.textContent ?? '';
    asked.forEach((c, k) => {
      if (links.current.get(`a${k}`)?.length || c.anchor.kind !== 'text') return;
      const at = locate(now, c.anchor.quote, c.anchor.start, c.anchor.end);
      if (at) homes.current.set(`a${k}`, toRanges([at]));
    });
    reg.set('qr-new', new H(...toRanges(changes.changed)));
    reg.set('qr-asked', new H(...[...homes.current.values()].flat()));
    return () => { reg.delete('qr-new'); reg.delete('qr-asked'); };
  }, [prev, v]);

  useLayoutEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !H) return;
    const lit = hot ?? pulse;
    reg.set('qr-new-hot', new H(...(lit ? passageOf(lit) : [])));
    return () => { reg.delete('qr-new-hot'); };
  }, [hot, pulse]);

  // A selected passage of the work, as an anchor for a comment; null when the range is not in the work.
  const anchorOf = useCallback((range: Range) => {
    const root = bodyRef.current;
    if (!root || !root.contains(range.startContainer)) return null;
    // A triple click on the last paragraph runs on past the work; the part inside it is what was meant.
    if (!root.contains(range.endContainer)) range.setEnd(root, root.childNodes.length);
    const anchor = anchorFrom(root, range, range.toString());
    return anchor.quote?.trim() ? anchor : null;
  }, []);

  // A selection inside the work offers a comment, just above it.
  useEffect(() => {
    const onUp = () => {
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) { setPicked(null); return; }
        const range = sel.getRangeAt(0).cloneRange();
        const anchor = anchorOf(range);
        if (!anchor) { setPicked(null); return; }
        const first = range.getClientRects()[0] ?? range.getBoundingClientRect();
        setPicked({ anchor, x: first.left, y: Math.max(60, first.top - 38) });
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('keyup', onUp); };
  }, [anchorOf]);

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

  // A note with words in it not yet added is never replaced by another: whatever would open one (the title, a
  // selection, the gutter, C, the right-click menu, another comment) takes you back to it instead. A comment
  // reopened and not changed holds nothing back, so it gives way.
  const unsaved = !!draft?.text.trim() && (!draft.id || comments.find((x) => x.id === draft.id)?.text !== draft.text.trim());
  const openDraft = useCallback((next: NonNullable<typeof draft>) => {
    if (unsaved) { reveal(); return false; }
    setDraft(next);
    return true;
  }, [unsaved, setDraft]);
  const startComment = useCallback((anchor: Anchor, send = false) => {
    if (!openDraft({ anchor, text: '', send })) return false;
    setPicked(null);
    return true;
  }, [openDraft]);

  // Comment, from the right-click menu (Menu.tsx): on the selection as it was when the menu opened, since clicking
  // a row in the menu can clear it.
  useEffect(() => {
    const onComment = (e: Event) => {
      const anchor = anchorOf((e as CustomEvent<Range>).detail);
      // An open box keeps its element, so autoFocus does not run again.
      if (anchor && startComment(anchor)) window.setTimeout(focusNote);
    };
    window.addEventListener('qr-comment', onComment);
    return () => window.removeEventListener('qr-comment', onComment);
  }, [anchorOf, startComment]);

  const save = () => {
    if (!draft?.text.trim()) { setDraft(null); return; }
    // Editing a comment that was removed meanwhile: the text is kept, as a new comment where it was.
    if (draft.id && comments.some((x) => x.id === draft.id)) {
      const text = draft.text.trim();
      setComments((cs) => cs.map((x) => (x.id === draft.id ? { ...x, text } : x)));
      setDraft(null);
      return;
    }
    const c = { id: Math.random().toString(36).slice(2, 9), anchor: draft.anchor, text: draft.text.trim() };
    if (draft.send) {
      // Added as well as sent, so an Undo brings the review back with the note on it.
      const all = [...comments, c].sort(byPosition);
      setComments(all);
      setDraft(null);
      onDecide(item, { decision: 'send-back', comments: all });
      return;
    }
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
    if (key.startsWith('a')) {
      const r = passageOf(key);
      return r.length ? r : asked[Number(key.slice(1))]?.anchor.kind === 'item' ? 'title' : 'end';
    }
    const c = comments.find((x) => x.id === key);
    return c ? at(c.anchor) : 'end';
  }, [comments, draft, asked]);

  // Lay the notes out under the block their place is in, which makes room for them. The room is kept from one pass
  // to the next and changed only when it has to be: taking it away to measure the block without it shortened the
  // page for a moment, which pulled a page scrolled to its foot back up, and the scroll started the next pass.
  // `was` is the block's own inline margin and transition, put back when it holds no note; `base` its margin
  // before any room.
  // `held` is which notes the room was last made for. When that changes (a note opens, is saved, is taken away)
  // the room eases to its new size, and the text under it glides instead of jumping; the notes further down follow,
  // as layout() runs again on each step of the body's height. A note growing as you type is not eased here: it
  // eases its own height (easeNote), and the room follows that step by step. `still` holds all of it off where
  // nothing was opened or closed: the first pass on a page that already has notes, and a pass after a new width.
  const made = useRef(new Map<HTMLElement, { was: string; transition: string; base: number; held: string }>());
  const easing = useRef(new WeakMap<HTMLElement, Animation>());
  const still = useRef(true);
  useEffect(() => { still.current = false; }, []);
  const easeRoom = useCallback((el: HTMLElement, from: number, to: number) => {
    easing.current.get(el)?.cancel();
    if (still.current || reduced() || !el.animate || Math.abs(from - to) < 2) return;
    easing.current.set(el, el.animate([{ marginBottom: `${from}px` }, { marginBottom: `${to}px` }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' })); // --dur-settle, --ease-out
  }, []);
  const release = useCallback((keep?: Map<HTMLElement, unknown>) => {
    for (const [el, m] of made.current) {
      if (keep?.has(el)) continue;
      const from = parseFloat(el.style.marginBottom);
      el.style.marginBottom = m.was;
      el.style.transition = m.transition;
      made.current.delete(el);
      if (Number.isFinite(from)) easeRoom(el, from, m.base);
    }
  }, [easeRoom]);
  const layout = useCallback(() => {
    const notes = notesRef.current;
    if (!notes) { release(); return; }
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
    release(groups);
    for (const [b, els] of groups) {
      let m = made.current.get(b);
      if (!m) {
        m = { was: b.style.marginBottom, transition: b.style.transition, base: 0, held: '' };
        // Room just released and still easing shut: ended too, for the same read.
        easing.current.get(b)?.cancel();
        // No transition on the block while it holds room: with reduced motion everything eases for 1ms, so a margin
        // read while one runs (a block given room again just after it was released) is still the old, pushed one.
        // Turning it off ends any that runs, so the read below is the block's own margin.
        b.style.transition = 'none';
        m.base = parseFloat(getComputedStyle(b).marginBottom) || 0;
        made.current.set(b, m);
      }
      const room = els.reduce((h, el) => h + el.offsetHeight + GAP, GAP);
      const want = `${m.base + room}px`;
      const held = els.map((el) => el.dataset.slot).join(' ');
      if (b.style.marginBottom !== want) {
        const from = m.held ? parseFloat(b.style.marginBottom) : m.base;
        b.style.marginBottom = want;
        if (held !== m.held && Number.isFinite(from)) easeRoom(b, from, m.base + room);
      }
      m.held = held;
    }
    const box = notes.getBoundingClientRect();
    const t = box.top;
    for (const [b, els] of groups) {
      let y = b.getBoundingClientRect().bottom - t + GAP;
      for (const el of els) { el.style.top = `${Math.round(y)}px`; y += el.offsetHeight + GAP; }
    }
    // Each reply's number, in the margin right of the passage it is about: the same number as on its card.
    const root = bodyRef.current;
    const taken: { top: number; left: number }[] = [];
    for (const m of notes.querySelectorAll<HTMLElement>('[data-mark]')) {
      const p = placeOf(m.dataset.mark!);
      const first = Array.isArray(p) ? p[0].getClientRects()[0] : undefined;
      if (!root || !first || !Array.isArray(p)) { m.hidden = true; continue; }
      // A passage that starts on a paragraph's edge starts in the prose itself, or in the line break between two
      // blocks: its block is the next one, not the whole column, so its number sits by the words like the others.
      const n = p[0].startContainer;
      let at: Node | null = n.nodeType === 1 ? n.childNodes[p[0].startOffset] ?? n : n;
      while (at && at.nodeType !== 1 && at.parentElement?.classList.contains('prose')) at = at.nextSibling;
      let b = !at ? n.parentElement! : at.nodeType === 1 ? at as Element : at.parentElement!;
      while (b.parentElement && b.parentElement !== root && !b.parentElement.classList.contains('prose')) b = b.parentElement;
      // No room in the margin (a phone, where the words run to the edge): no number, rather than one over the last
      // words of the line. The card under the passage carries the same number, and opens when you tap it.
      const right = b.getBoundingClientRect().right;
      if (right + 12 + 20 > box.right) { m.hidden = true; continue; }
      const top = Math.round(first.top - t + (first.height - 20) / 2);
      let left = right + 12 - box.left;
      while (taken.some((x) => Math.abs(x.top - top) < 20 && Math.abs(x.left - left) < 24)) left += 24;
      taken.push({ top, left });
      m.hidden = false;
      m.style.top = `${top}px`;
      m.style.left = `${Math.round(left)}px`;
    }
  }, [placeOf, release]);

  useLayoutEffect(layout);
  // A note that opens is focused only once it is in its place, and the view glides to it. Focused as it mounted
  // (autoFocus), it was still at the top of the notes, so the browser threw the page up there and the note landed
  // out of sight below. Keyed by where the note is, so opening it on another passage moves the view there too.
  const shown = useRef<string | null>(null);
  const draftAt = draft ? `${draft.id ?? ''}:${draft.anchor.kind}:${draft.anchor.start ?? ''}:${draft.anchor.end ?? ''}` : null;
  useLayoutEffect(() => {
    if (draftAt === shown.current) return;
    shown.current = draftAt;
    if (draftAt) reveal();
  });
  useEffect(() => {
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
    // A new width can change a block's own margin (a narrow window sets smaller type), so it is measured afresh.
    const resized = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { still.current = true; release(); layout(); still.current = false; }); };
    const ro = new ResizeObserver(again);
    if (bodyRef.current) ro.observe(bodyRef.current);
    notesRef.current?.querySelectorAll('[data-slot]').forEach((el) => ro.observe(el));
    window.addEventListener('resize', resized);
    document.fonts?.ready.then(again);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', resized); };
  });
  useEffect(() => () => { still.current = true; release(); }, [release]);

  // Pointing at a changed passage lights the reply it answers.
  const onBodyMove = (e: React.MouseEvent) => {
    if (!links.current.size) return;
    let found: string | null = null;
    for (const [key, ranges] of links.current) {
      if (ranges.some((r) => [...r.getClientRects()].some((b) => e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom))) { found = key; break; }
    }
    if (found !== hot) setHot(found);
  };

  // Jumping between a reply's card and its passage: the view glides to it, and both light up for a moment.
  const glide = (top: number, bottom: number) => {
    const upper = (document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0) + 16;
    const foot = (document.querySelector('.decide')?.getBoundingClientRect().top ?? window.innerHeight) - 16;
    if (top >= upper && bottom <= foot) return;
    const by = top - upper - Math.max(0, (foot - upper - (bottom - top)) / 3);
    window.scrollBy({ top: by, behavior: reduced() ? 'auto' : 'smooth' });
  };
  const flash = (key: string) => {
    clearTimeout(pulseTimer.current);
    setPulse(null);
    requestAnimationFrame(() => setPulse(key));
    pulseTimer.current = window.setTimeout(() => setPulse(null), 1400);
  };
  useEffect(() => () => clearTimeout(pulseTimer.current), []);
  const toCard = (key: string) => {
    const card = notesRef.current?.querySelector<HTMLElement>(`[data-slot="${key}"]`);
    if (!card) return;
    unfold(key);
    // Measured once it has opened and the room under its passage has grown to fit it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = card.getBoundingClientRect();
      glide(r.top, r.bottom);
      flash(key);
    }));
  };
  const toPassage = (key: string) => {
    const p = placeOf(key);
    const r = p === 'title' ? titleRef.current?.getBoundingClientRect() : p === 'end' ? null : p[0].getBoundingClientRect();
    if (!r) return;
    glide(r.top, r.bottom);
    flash(key);
  };
  // What the agent did with each comment on the version before, counted, each count a way to step through them.
  const stateOf = (c: (typeof asked)[number]) => (!c.reply ? 'none' : c.reply.addressed ? 'done' : c.reply.answered ? 'answered' : 'kept');
  const tally = (['done', 'answered', 'kept', 'none'] as const).map((st) => ({ st, keys: asked.flatMap((c, k) => (stateOf(c) === st ? [`a${k}`] : [])) })).filter((x) => x.keys.length);
  const stepped = useRef<Record<string, number>>({});
  const step = (st: string, keys: string[]) => {
    const i = ((stepped.current[st] ?? -1) + 1) % keys.length;
    stepped.current[st] = i;
    toCard(keys[i]);
  };

  const whole: Anchor = { kind: 'item' };
  const commentOn = (el: HTMLElement) => { const root = bodyRef.current; if (root) startComment(anchorFrom(root, blockRange(el), blockRange(el).toString())); };
  // The comments as they would be sent: a note written but not added yet (the box still open, perhaps unfocused)
  // counts, so sending back never leaves it behind.
  const withDraft = (): Comment[] => {
    const text = draft?.text.trim();
    if (!draft || !text) return comments;
    if (draft.id && comments.some((x) => x.id === draft.id)) return comments.map((x) => (x.id === draft.id ? { ...x, text } : x));
    return [...comments, { id: Math.random().toString(36).slice(2, 9), anchor: draft.anchor, text }].sort(byPosition);
  };
  // With nothing written yet, Send back asks what should change first.
  const sendBack = () => {
    const all = withDraft();
    // The note is added as well as sent, so an Undo brings the review back with it on.
    if (all.length) { setComments(all); setDraft(null); onDecide(item, { decision: 'send-back', comments: all }); }
    else if (!draft) startComment(whole, true);
  };
  // An approval carries no comments, so once you have written one (added, or still in the box) Approve becomes
  // Send back: the button, A and ⌘⏎ all send the comments. Remove them to approve.
  const noted = withDraft().length > 0;
  const approve = () => { if (noted) sendBack(); else onDecide(item, { decision: 'approve' }); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key held down decides once: its repeats would land on the next item as it arrives, and decide that unread.
      if (e.repeat && !isTyping(e)) return;
      // ⌘⏎ is the main action everywhere: here, Approve, or Send back once there are comments.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isTyping(e)) {
        e.preventDefault();
        approve();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = keyOf(e);
      if (key === 'c' && picked) { e.preventDefault(); startComment(picked.anchor); }
      else if (key === 'c' && pointed && !draft) { e.preventDefault(); commentOn(pointed.el); }
      else if (key === 'a') { e.preventDefault(); approve(); }
      else if (key === 's') { e.preventDefault(); sendBack(); }
      else if (key === 'l' || key === 'L') { e.preventDefault(); onLater(item); }
      else if (key === 'D') { e.preventDefault(); onDecide(item, { decision: 'drop' }); }
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

        {v.bodyType === 'diff' && <DiffFiles text={v.body as string} keep={keptKey(item)} />}
        <div ref={bodyRef} data-comments className={`body body-${v.bodyType}`} onMouseMove={onBodyMove} onMouseLeave={() => setHot(null)}>
          {v.bodyType === 'markdown' && <Markdown className="prose" text={v.body as string} files={filesBase} />}
          {v.bodyType === 'text' && <div className="prose plain">{v.body as string}</div>}
          {v.bodyType === 'diff' && <Diff text={v.body as string} fresh={freshLines} />}
        </div>

        {listed.length > 0 && (
          <section className="files">
            {listed.map((f) => {
              const src = filesBase + encodeURIComponent(f);
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
            const st = stateOf(c);
            const label = st === 'none' ? 'No reply' : st === 'done' ? (fromFindings ? 'Fixed' : 'Changed') : st === 'answered' ? 'Answered' : (fromFindings ? 'Not fixed' : 'Kept');
            const num = fromFindings ? c.id : String(k + 1);
            // The passage first, as one muted line, then what you said, then the agent's answer.
            const about = fromFindings ? c.title ?? c.anchor.quote : c.anchor.kind === 'text' ? c.anchor.quote : null;
            const mine = c.text;
            const folded = narrow && !unfolded.has(key);
            return (
              <div
                key={c.id ?? k}
                data-slot={key}
                className={`note-card asked-card is-${st}${folded ? ' folded' : ''}${hot === key ? ' hot' : ''}${pulse === key ? ' flash' : ''}`}
                aria-label={`Your ${fromFindings ? 'finding' : 'comment'} ${num} on version ${prev!.n}: ${label}`}
                aria-expanded={narrow ? !folded : undefined}
                onMouseEnter={() => setHot(key)}
                onMouseLeave={() => setHot(null)}
                onClick={(e) => {
                  if (window.getSelection()?.toString() || (e.target as Element).closest('a')) return;
                  // Folded, a click opens it; open on a narrow window, its top line folds it again.
                  if (folded) unfold(key);
                  else if (narrow && (e.target as Element).closest('.asked-head')) unfold(key, false);
                  else toPassage(key);
                }}
                title={folded ? 'Open the reply' : fromFindings ? undefined : 'Show the passage'}
              >
                <p className="asked-head">
                  <span className="asked-n">{num}</span>
                  <span className="asked-state">{label}</span>
                  {fromFindings && c.anchor.file && <span className="rec asked-file">{c.anchor.file}{c.anchor.line ? `:${c.anchor.line}` : ''}</span>}
                  {/* Folded: the reply's first words, else what you said, on the one line there is. */}
                  {folded && <span className="asked-gist">{c.reply?.text ?? mine}</span>}
                  {narrow && <span className="asked-fold" aria-hidden="true" />}
                </p>
                {!folded && (c.anchor.kind === 'item' && !fromFindings
                  ? <p className="asked-was">On the whole piece</p>
                  : about && <p className="asked-was">{st === 'done' && !fromFindings ? <s>{clip(about)}</s> : <q>{clip(about)}</q>}</p>)}
                {!folded && mine && <p className="asked-mine">{mine}</p>}
                {!folded && c.reply && <p className="asked-reply">{c.reply.text}</p>}
              </div>
            );
          })}
          {!fromFindings && v.bodyType !== 'diff' && asked.map((c, k) => (
            <button
              key={`m${k}`}
              data-mark={`a${k}`}
              hidden
              className={`asked-mark is-${stateOf(c)}${hot === `a${k}` || pulse === `a${k}` ? ' hot' : ''}`}
              onClick={() => toCard(`a${k}`)}
              onMouseEnter={() => setHot(`a${k}`)}
              onMouseLeave={() => setHot(null)}
              aria-label={`Comment ${k + 1}: show the reply`}
            >
              {k + 1}
            </button>
          ))}
          {comments.filter((c) => c.id !== draft?.id).map((c) => (
            <div
              key={c.id}
              data-slot={c.id}
              className={`note-card mine${active === c.id ? ' active' : ''}`}
              onMouseEnter={() => setActive(c.id)}
              onMouseLeave={() => setActive(null)}
              onClick={(e) => { if (!(e.target as Element).closest('button')) openDraft({ anchor: c.anchor, text: c.text, id: c.id }); }}
            >
              <Where anchor={c.anchor} />
              <p className="note-text">{c.text}</p>
              <button className="btn-quiet sm note-remove" onClick={() => { setComments((cs) => cs.filter((x) => x.id !== c.id)); setActive(null); }}>Remove</button>
            </div>
          ))}
          {/* The note eases to its height as what you write takes another line (easeNote). The room under its block
              and the notes below it follow by themselves: layout() runs on each step of the card's height. */}
          {draft && (
            <div key={draft.id ?? 'new'} ref={easeNote} data-slot="draft" className="note-card composing drop-in">
              <Where anchor={draft.anchor} />
              <textarea
                className="note-field"
                rows={3}
                placeholder="What should change?"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => {
                  // ⏎ adds the comment, shift ⏎ starts a new line in it.
                  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); if (draft.text.trim()) save(); }
                  if (e.key === 'Escape') setDraft(null);
                }}
              />
              <div className="note-actions">
                <button className="btn-quiet sm" onClick={() => setDraft(null)}>Cancel</button>
                <button className="btn-primary sm" onClick={save} disabled={!draft.text.trim()}>{draft.send ? 'Send back' : draft.id ? 'Save' : 'Add'} <span className="key on-ink">⏎</span></button>
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
            <Reach item={item} />
            {tally.length > 0 && (
              <span className="asked-tally">
                {asked.length === 1 ? 'Your comment' : `Your ${asked.length} ${fromFindings ? 'findings' : 'comments'}`} on v{prev!.n}:{' '}
                {tally.map((x, i) => (
                  <span key={x.st}>
                    {i > 0 && ', '}
                    <button className={`tally-btn is-${x.st}`} onClick={() => step(x.st, x.keys)} title="Go to the next one">
                      {x.keys.length} {x.st === 'done' ? (fromFindings ? 'fixed' : 'changed') : x.st === 'answered' ? 'answered' : x.st === 'kept' ? (fromFindings ? 'not fixed' : 'kept') : 'without a reply'}
                    </button>
                  </span>
                ))}
                .{' '}
              </span>
            )}
            {comments.length
              ? `${comments.length} comment${comments.length === 1 ? '' : 's'}. Sending back gives the agent exactly these.`
              : onCode
                ? 'Select anything to comment on it, or click the title to comment on the whole piece.'
                : null}
          </p>
          <div className="decide-actions">
            <button className="btn-quiet" onClick={() => onDecide(item, { decision: 'drop' })} title="The agent stops and leaves its changes (shift D)">Drop</button>
            <button className="btn-ghost" onClick={() => onLater(item)}>Later <span className="key">L</span></button>
            {noted ? (
              <button className="btn-primary" onClick={sendBack}>
                Send back <span className="key on-ink">S</span>
              </button>
            ) : (
              <>
                <button className="btn-pill lg" onClick={sendBack}>Send back <span className="key">S</span></button>
                <button className="btn-primary" onClick={approve}>
                  Approve <span className="key on-ink">A</span>
                </button>
              </>
            )}
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

const focusNote = () => document.querySelector<HTMLTextAreaElement>('.note-field')?.focus({ preventScroll: true });

/** Focus the open note and bring it into view, with the passage it is about above it when both fit: between the
 *  bar at the top and the decision bar at the foot, which both sit over the page. */
function reveal() {
  focusNote();
  const card = document.querySelector<HTMLElement>('.note-card.composing');
  if (!card) return;
  // Where it lands, not where its drop-in starts (8px higher): offsets from the notes, which are not animated.
  const notes = card.offsetParent?.getBoundingClientRect().top ?? 0;
  const box = { top: notes + card.offsetTop, bottom: notes + card.offsetTop + card.offsetHeight };
  const top = (document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0) + 16;
  const foot = (document.querySelector('.decide')?.getBoundingClientRect().top ?? window.innerHeight) - 16;
  // The passage is the block just above the note; 120px of it is enough to see what the note is on.
  const from = Math.max(box.top - 120, box.bottom - (foot - top));
  const by = box.bottom > foot ? box.bottom - foot : from < top ? from - top : 0;
  if (Math.abs(by) < 2) return;
  window.scrollBy({ top: by, behavior: reduced() ? 'auto' : 'smooth' });
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
