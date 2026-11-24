#!/usr/bin/env node
// How long bateson's parts take on this machine, against a scratch queue: `node scripts/bench.ts [--done 2000]`.
// Run `npm run build` first, so the hooks run from their bundles as they do when installed.
//
// It times what an agent or the reviewer waits for: each hook as Claude Code starts it, the `bateson` command, the
// server's answer to the page, and the things they are made of (starting Node, git, reading a file), once with an
// empty queue and once with `--done` finished items in it, so what grows with the queue shows. Nothing of yours is
// touched: the queue is a folder in the system's temp folder, removed at the end.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const DONE = arg('--done', 2000);
const RUNS = arg('--runs', 7);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bateson-bench-'));
const NODE = process.execPath;
const SESSION = 'bench-session';

const rows: [string, string, string][] = [];
const say = (what: string, empty: string, full = '') => { rows.push([what, empty, full]); console.log(`${what.padEnd(46)} ${empty.padStart(10)} ${full.padStart(10)}`); };
const ms = (n: number) => (n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n)} ms`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The median time of a command over a few runs, in ms. */
function time(exe: string, args: string[], { input, env, runs = RUNS, cwd = REPO }: { input?: string; env?: NodeJS.ProcessEnv; runs?: number; cwd?: string } = {}) {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    spawnSync(exe, args, { input: input ?? '', cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    times.push(performance.now() - t);
  }
  return median(times);
}

// ---- A queue with `n` finished interviews spread over the last half year, and three waiting. Written as files,
// following docs/folder-format.md: sending them through the store would read the whole queue for each.
function seed(root: string, n: number) {
  const question = (k: number) => ({ id: `Q${k}`, title: `Which way for part ${k}?`, body: 'Should it do the one thing or the other? '.repeat(8), options: [{ label: 'One', description: 'the first' }, { label: 'Two', description: 'the second' }], recommended: 0, recommendation: 'because of reasons '.repeat(5) });
  const body = JSON.stringify({ questions: [1, 2, 3].map(question) }, null, 2);
  const source = { agent: 'claude-code', cwd: REPO, top: REPO, repo: 'bateson', branch: 'main' };
  const write = (file: string, data: unknown) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const item = (base: string, i: number, at: string, done: boolean) => {
    const id = `q_${i.toString(36).padStart(5, '0')}${done ? 'd0ne00' : 'wa1t00'}`;
    const dir = path.join(root, base, id);
    fs.mkdirSync(path.join(dir, 'v1'), { recursive: true });
    write(path.join(dir, 'item.json'), { id, kind: 'decision', title: `Item ${i}`, createdAt: at, updatedAt: at, source, hue: 'slate', versions: [{ n: 1, bodyType: 'questions', title: `Item ${i}`, createdAt: at }] });
    write(path.join(dir, 'v1', 'body.json'), body);
    write(path.join(dir, 'session.json'), { agent: 'claude-code', sessionId: done ? `old-${i % 40}` : SESSION, cwd: REPO });
    if (!done) return;
    write(path.join(dir, 'v1', 'decision.json'), { decision: 'answer', answers: [1, 2, 3].map((k) => ({ id: `Q${k}`, choice: k % 2 })), decidedAt: at, versionAt: at });
    write(path.join(dir, 'v1', 'delivered.json'), { at, by: `rewake:old-${i % 40}`, sessionId: `old-${i % 40}` });
  };
  fs.mkdirSync(path.join(root, 'items'), { recursive: true });
  fs.mkdirSync(path.join(root, 'done'), { recursive: true });
  const now = Date.now();
  const t = performance.now();
  // The newest is two days old: none is a delivery of the last day, which the hooks would check and mark.
  for (let i = 0; i < n; i++) item('done', i, new Date(now - 864e5 * (2 + 180 * (1 - i / n))).toISOString(), true);
  const took = performance.now() - t;
  for (let i = 0; i < 3; i++) item('items', i, new Date(now - 60_000 * (3 - i)).toISOString(), false);
  return took;
}

const EMPTY = path.join(TMP, 'empty');
const FULL = path.join(TMP, 'full');
seed(EMPTY, 0);
const seeding = seed(FULL, DONE);

console.log(`bateson bench: ${process.platform} ${os.release()}, Node ${process.versions.node}, ${os.cpus()[0]?.model.trim()}, ${DONE} done items\n`);
console.log(`${''.padEnd(46)} ${'empty'.padStart(10)} ${`${DONE} done`.padStart(10)}`);

// ---- What everything is made of.
say('start Node (node -e 0)', ms(time(NODE, ['-e', '0'])));
// Claude Code starts a hook through a shell: Git Bash on Windows.
const BASH = WIN ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => fs.existsSync(p)) : '/bin/sh';
const quoted = (p: string) => `"${p.replaceAll('\\', '/')}"`;
if (BASH) say(`start Node through ${WIN ? 'Git Bash' : 'sh'}`, ms(time(BASH, ['-c', `${quoted(NODE)} -e 0`])));
say('git rev-parse --show-toplevel', ms(time('git', ['rev-parse', '--show-toplevel'])));
say('git status --porcelain --untracked-files=all', ms(time('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])));
if (WIN) {
  // lib/agent.ts parentOnWindows: how the rewake hook and `bateson send` find the Claude Code process above them.
  say('PowerShell: every process and its parent', ms(time('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId FROM Win32_Process' | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { runs: 3 })));
}

// One file operation, the unit the queue's cost is counted in: over every done item's item.json, twice (the
// second time the system has them in memory).
{
  const ids = fs.readdirSync(path.join(FULL, 'done'));
  const per = (fn: (dir: string) => void) => { const t = performance.now(); for (const id of ids) fn(path.join(FULL, 'done', id)); return `${(((performance.now() - t) / Math.max(1, ids.length)) * 1000).toFixed(0)} µs`; };
  say('write a done item (5 files, 2 folders)', '', `${((seeding / Math.max(1, DONE)) * 1000).toFixed(0)} µs`);
  say('read item.json, first time', '', per((d) => fs.readFileSync(path.join(d, 'item.json'), 'utf8')));
  say('read item.json, again', '', per((d) => fs.readFileSync(path.join(d, 'item.json'), 'utf8')));
  say('stat item.json', '', per((d) => fs.statSync(path.join(d, 'item.json'))));
  say('look for a file that is not there', '', per((d) => fs.existsSync(path.join(d, 'withdrawn.json'))));
}

// ---- The hooks, each as Claude Code runs it: its launcher, with the event on stdin.
const env = (home: string): NodeJS.ProcessEnv => ({ BATESON_HOME: home, BATESON_PORT: '4871', BATESON_NO_OPEN: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION });
const event = (name: string, more: object = {}) => JSON.stringify({ hook_event_name: name, session_id: SESSION, cwd: REPO, ...more });
const hook = (file: string, input: string) => [EMPTY, FULL].map((home) => ms(time(NODE, [path.join(REPO, 'hooks', file)], { input, env: env(home) }))) as [string, string];
console.log('');
say('hook: rewake, a Bash call that is not bateson\'s', ...hook('rewake.mjs', event('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })));
say('hook: remind, after Bash (your own turn)', ...hook('remind.mjs', event('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })));
say('hook: remind, after Edit (your own turn)', ...hook('remind.mjs', event('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(REPO, 'README.md') } })));
say('hook: catchup, on a prompt', ...hook('catchup.mjs', event('UserPromptSubmit', { prompt: 'carry on' })));
say('hook: catchup, at session start', ...hook('catchup.mjs', event('SessionStart')));
say('hook: nudge, when a turn ends', ...hook('nudge.mjs', event('Stop')));
if (BASH) {
  const line = `${quoted(NODE)} ${quoted(path.join(REPO, 'hooks', 'remind.mjs'))}`;
  say(`hook: remind after Bash, through ${WIN ? 'Git Bash' : 'sh'}`, ...([EMPTY, FULL].map((home) => ms(time(BASH, ['-c', line], { input: event('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), env: env(home) }))) as [string, string]));
}

// ---- The command.
const round = path.join(TMP, 'round.json');
fs.writeFileSync(round, JSON.stringify({ questions: [1, 2].map((k) => ({ id: `Q${k}`, title: `Which way for part ${k}?`, body: 'One or the other?', options: [{ label: 'One', description: 'the first' }, { label: 'Two', description: 'the second' }], recommended: 0, recommendation: 'It is the smaller change.' })) }));
const cli = (...args: string[]) => [EMPTY, FULL].map((home) => ms(time(NODE, [path.join(REPO, 'cli', 'bateson.mjs'), ...args], { env: env(home), runs: 5 }))) as [string, string];
console.log('');
say('bateson (no arguments: the help)', ...cli());
say('bateson list', ...cli('list'));
say('bateson send --questions', ...cli('send', '--title', 'Bench', '--questions', round));
say('bateson recall', ...cli('recall'));
say('bateson recall <two words>', ...cli('recall', 'part', 'reasons'));
say('bateson inbox', ...cli('inbox'));

// ---- The server: what the page asks it, first and after.
async function server(home: string, port: number) {
  const child = spawn(NODE, [path.join(REPO, 'server', 'server.mjs')], { cwd: REPO, env: { ...process.env, ...env(home), BATESON_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  const get = (host: string, p: string) => new Promise<number>((resolve, reject) => {
    const t = performance.now();
    // A connection of its own each time, as a page's first request has.
    http.get({ host, port, path: p, agent: false, headers: { host: `localhost:${port}` } }, (res) => { res.resume(); res.on('end', () => resolve(performance.now() - t)); }).on('error', reject);
  });
  const started = performance.now();
  for (let i = 0; i < 100; i++) { try { await get('127.0.0.1', '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const up = performance.now() - started;
  const first = await get('127.0.0.1', '/api/state');
  const warm: number[] = [];
  for (let i = 0; i < 20; i++) warm.push(await get('127.0.0.1', '/api/state'));
  const byName: number[] = [];
  for (let i = 0; i < 5; i++) byName.push(await get('localhost', '/api/health').catch(() => NaN));
  const byAddress: number[] = [];
  for (let i = 0; i < 5; i++) byAddress.push(await get('127.0.0.1', '/api/health'));
  // The server listens on 127.0.0.1 only. A browser asked for "localhost" may try ::1 first: how long that takes to fail.
  const refused = await new Promise<number>((resolve) => {
    const t = performance.now();
    const s = net.connect({ host: '::1', port });
    const done = () => { s.destroy(); resolve(performance.now() - t); };
    s.on('error', done); s.on('connect', done); s.setTimeout(10_000, done);
  });
  child.kill();
  return { up, first, warm: median(warm), byName: median(byName), byAddress: median(byAddress), refused };
}
console.log('');
const [a, b] = [await server(EMPTY, 4872), await server(FULL, 4873)];
say('server: from start to answering', ms(a.up), ms(b.up));
say('server: the page\'s state, first time', ms(a.first), ms(b.first));
say('server: the page\'s state, after', ms(a.warm), ms(b.warm));
say('server: a request to 127.0.0.1', ms(a.byAddress), ms(b.byAddress));
say('server: a request to localhost', ms(a.byName), ms(b.byName));
say('a connection to [::1], where nothing listens', ms(a.refused), ms(b.refused));

// In a GitHub run, the same as a table on the run's page.
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### ${process.platform}, Node ${process.versions.node}`, '',
    `| what | empty queue | ${DONE} done items |`, '|---|--:|--:|',
    ...rows.map(([what, empty, full]) => `| ${what} | ${empty} | ${full} |`), '',
  ].join('\n'));
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a file still open on Windows: the temp folder is cleared by the system */ }
process.exit(0);
