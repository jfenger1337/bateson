// Syntax colour for the lines an agent shows: highlight.js core with only the languages we meet, a line at a
// time (the lines arrive as an excerpt, so there is no whole file to parse). Unknown files stay plain.
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import swift from 'highlight.js/lib/languages/swift';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';

const LANGS = { javascript, typescript, css, xml, json, swift, python, bash, yaml, markdown };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, keyof typeof LANGS> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  css: 'css', scss: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', json: 'json', swift: 'swift',
  py: 'python', sh: 'bash', zsh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', mdx: 'markdown',
};

/** One line as highlighted HTML (escaped by highlight.js), or null when the file's language is not one we colour. */
export function highlightLine(file: string, line: string): string | null {
  const language = BY_EXT[file.split('.').pop()?.toLowerCase() ?? ''];
  if (!language) return null;
  try { return hljs.highlight(line, { language, ignoreIllegals: true }).value; } catch { return null; }
}
