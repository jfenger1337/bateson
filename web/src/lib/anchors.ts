import type { Anchor } from '@lib/types';

// Anchors: character offsets into a piece of text on screen, plus the quote and its surroundings, and for a diff the
// file and line the selection starts on. Review.tsx anchors comments on the work with them, Interview.tsx comments
// on a question's words.

function offsetOf(root: Node, node: Node, offset: number) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

export function anchorFrom(root: HTMLElement, range: Range, quote: string): Anchor {
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

export function rangeAt(root: HTMLElement, a: Anchor): Range | null {
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

/** A long quote, cut at a word near 90 characters. */
export function clip(q: string) {
  if (q.length <= 90) return q;
  const cut = q.slice(0, 90);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)) + '…';
}
