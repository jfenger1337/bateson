import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({ gfm: true, breaks: false });

/** An agent's markdown as HTML that cannot run: whatever HTML it carries is cleaned of scripts and handlers. */
export function markdownHtml(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
