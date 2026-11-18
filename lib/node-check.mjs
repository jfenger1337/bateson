// Whether this Node can run bateson, asked before anything loads a .ts file. bateson is TypeScript, which Node runs as
// it is only from 22.18 on: an older Node stops at the extension ("Unknown file extension .ts") before a line of it
// runs, so no check inside a .ts file could ever speak. This file and the launchers that import it (cli/bateson.mjs,
// scripts/install.mjs, hooks/*.mjs, server/server.mjs, scripts/keepalive.mjs) are plain JavaScript, kept to syntax
// any Node reads, so they can say what is wrong first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

/**
 * Whether this Node runs TypeScript. Without it, the command started by an older Node first on PATH (a terminal
 * opened while an older nvm default was in force, say) runs itself again with the Node bateson was installed with,
 * as noted in install.json, the same one the hooks use. It never returns then: it exits as that run did.
 */
export function useInstalledNode() {
  if (process.features && process.features.typescript) return;
  if (process.env.BATESON_RERUN) return; // that Node, too, could not: say so instead of going round
  let node;
  try {
    const root = process.env.BATESON_HOME ? path.resolve(process.env.BATESON_HOME) : path.join(os.homedir(), '.bateson');
    node = JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8')).node;
  } catch (e) { return; }
  if (typeof node !== 'string' || !node || path.resolve(node) === process.execPath || !fs.existsSync(node)) return;
  const env = Object.assign({}, process.env, { BATESON_RERUN: '1' });
  const run = spawnSync(node, process.argv.slice(1), { stdio: 'inherit', env: env });
  if (run.error) return;
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status === null ? 1 : run.status);
}

/** Why this Node cannot run bateson, and `next` (what to do once there is a newer Node); null when it can. */
export function whyNot(next) {
  if (process.features && process.features.typescript) return null;
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  return (major > 22 || (major === 22 && minor >= 18) ? [
    `bateson: this Node (${version}, at ${process.execPath}) has its TypeScript support turned off, and bateson needs it.`,
    'Remove --no-experimental-strip-types from how Node is started (look in NODE_OPTIONS), then run this again.',
  ] : [
    `bateson: needs Node 22.18 or newer, which runs its TypeScript files directly. This is Node ${version}, at ${process.execPath}.`,
    `Install Node 22.18 or newer, then ${next}.`,
  ]).join('\n');
}

/**
 * Exit with what is wrong, and `next` (what to do once there is a newer Node), unless this Node runs TypeScript.
 * `said`, if given, also gets the text before the exit.
 */
export function needTypeScript(next, said) {
  const text = whyNot(next);
  if (!text) return;
  console.error(text);
  if (said) said(text);
  process.exit(1);
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Stand in for the server at login on a Node that cannot run it: answer on its port with why, so a browser says so
 * instead of waiting for ever. A page gets that in bateson's colours (and reloads into bateson once the real server
 * answers); the API gets 503 with { ok: false, error }, which an open page shows in its bar. Only for this machine,
 * as server/server.ts is. Returns the server, to close; a port already taken leaves nothing to answer on, and exits.
 */
export function serveWhy(text, port) {
  const server = http.createServer((req, res) => {
    if (!LOCAL.test(req.headers.host || '')) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"Not this host"}'); return; }
    const api = (req.url || '').startsWith('/api/');
    res.writeHead(503, { 'content-type': api ? 'application/json' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(api ? JSON.stringify({ ok: false, error: text }) : whyPage(text));
  });
  server.on('error', () => process.exit(1));
  server.listen(port, '127.0.0.1');
  return server;
}

/** The page: web/public/sw.js's waiting page, saying why instead. */
function whyPage(text) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#FCFCFB">
<title>bateson</title>
<script>
  (function () {
    var t = 'system';
    try { t = localStorage.getItem('bateson:theme') || t; } catch (e) {}
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    if (t === 'dark') document.querySelector('meta[name="theme-color"]').content = '#141414';
  })();
</script>
<style>
  @font-face { font-family: 'Schibsted Grotesk'; font-weight: 400 900; font-display: swap; src: url('/fonts/schibstedgrotesk-normal.woff2') format('woff2'); }
  :root { --work: #FCFCFB; --muted: #5F5B54; --ink: #1E2126; }
  [data-theme='dark'] { color-scheme: dark; --work: #141414; --muted: #99948C; --ink: #E8E3DA; }
  html, body { margin: 0; height: 100%; background: var(--work); color: var(--muted); }
  body { display: flex; align-items: center; justify-content: center; padding: 0 16px;
    font: 14px/1.5 'Schibsted Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  main { max-width: 560px; }
  h1 { margin: 0 0 12px; font-size: inherit; font-weight: 600; color: var(--ink); }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  /* Installed as an app with no title bar of its own: this strip is where the window is dragged from. */
  .drag { position: fixed; top: 0; left: 0; right: 0; height: env(titlebar-area-height, 0px); -webkit-app-region: drag; app-region: drag; }
</style>
</head>
<body>
<div class="drag"></div>
<main><h1>The bateson server cannot start.</h1><p>${escape(text)}</p></main>
<script>
  setInterval(function () {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) { if (r.ok) location.reload(); }, function () {});
  }, 2000);
</script>
</body>
</html>`;
}
