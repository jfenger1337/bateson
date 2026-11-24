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
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && !(node.nodeName === 'CODE' && /^language-[\w+#.-]+$/.test(data.attrValue))) data.keepAttr = false;
});

/** An agent's markdown as HTML that cannot run: whatever HTML it carries is cleaned of scripts and handlers. */
export function markdownHtml(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, FORBID);
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
