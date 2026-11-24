import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({ gfm: true, breaks: false });

/**
 * What an agent's markdown may not carry, beyond scripts and handlers: a form (a click on it would post to bateson
 * from bateson's own page, past the server's checks), its controls, and styles that could lay a fake button over
 * the real ones or hide them. A class or an id would do the same through bateson's own stylesheet (class="splash"
 * covers the whole window, decision keys still working underneath), so neither is kept, but for the language marked
 * puts on a code block.
 */
const FORBID = {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'style'],
  FORBID_ATTR: ['style', 'action', 'formaction', 'id'],
};
// A link opens in a window of its own (the Mac app hands it to the browser): followed in place it would take
// bateson away from under you, and send whatever decision you could still undo.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A' && node.hasAttribute('href')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && !(node.nodeName === 'CODE' && /^language-[\w+#.-]+$/.test(data.attrValue))) data.keepAttr = false;
});

/** Whether an address is on this machine (bateson's own files, a dev server, a data: picture) and not out on the network. */
function local(url: string) {
  try {
    const u = new URL(url, location.href);
    return ['data:', 'blob:'].includes(u.protocol) || (/^https?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}
const localSet = (srcset: string) => srcset.split(',').every((part) => { const url = part.trim().split(/\s+/)[0]; return !url || local(url); });

/**
 * Nothing is fetched from the network just because an agent's markdown is on screen: a picture there would tell
 * its server that, and whatever the address carries, without a click. A remote picture becomes a link to it, which
 * you may follow; anything else that would load from elsewhere (a video, a poster, an SVG's image) loses the address.
 */
function keepLocal(html: string) {
  const box = document.createElement('template');
  box.innerHTML = html;
  for (const el of [...box.content.querySelectorAll('*')]) {
    const src = el.getAttribute('src');
    // Each address is judged by itself: a picture here with a larger one elsewhere (srcset) keeps the one here.
    for (const k of ['src', 'poster', 'background', ...(el.nodeName === 'A' ? [] : ['href', 'xlink:href'])]) {
      if (el.hasAttribute(k) && !local(el.getAttribute(k)!)) el.removeAttribute(k);
    }
    if (el.hasAttribute('srcset') && !localSet(el.getAttribute('srcset')!)) el.removeAttribute('srcset');
    if (el.nodeName === 'IMG' && src && !el.hasAttribute('src') && /^(https?:)?\/\//i.test(src.trim())) {
      const a = document.createElement('a');
      a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = el.getAttribute('alt')?.trim() || src;
      a.title = 'A picture from the network: not loaded until you open it';
      el.replaceWith(a);
    }
  }
  return box.innerHTML;
}

/** An agent's markdown as HTML that cannot run: whatever HTML it carries is cleaned of scripts and handlers. */
export function markdownHtml(text: string) {
  return keepLocal(DOMPurify.sanitize(marked.parse(text, { async: false }) as string, FORBID));
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
