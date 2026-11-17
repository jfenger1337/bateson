#!/usr/bin/env node
// bateson: send work that needs the user's judgment or context, and read their response.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store, { PORT, reviewer, Reviewer, BODY_TYPES } from '../lib/store.ts';
import { KINDS, toAnswer } from '../lib/kinds.ts';
import { peek, awaitDecision, collect, own, claim, pendingFor } from '../lib/delivery.ts';
import { agent, canWake, currentSession } from '../lib/agent.ts';
import { recall, formatRecalled } from '../lib/recall.ts';
import type { Attachment, Body, StoredItem } from '../lib/store.ts';
import type { BodyType, Question, Reply, Source } from '../lib/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `bateson: a review queue for what needs human judgment.

  bateson send --title <t> --note <n> <body> [--attach <file>]... [--item <id>]
      body, exactly one of:
        --questions <file|->   an interview round (JSON, see below)
        --findings <file|->    review findings to keep or dismiss one by one (JSON, see below)
        --file <path>          a markdown or text file (by extension)
        --diff [<base>]        git diff of the working tree against <base> (default HEAD), untracked files included
        --stdin                read the body from stdin; add --type markdown|text|diff (default markdown)
      --item <id>              the next version of an item: a revision, or the next interview round
      --done "<n>: <text>"     on a revision: comment <n> addressed, and what you changed (repeat per comment)
      --not "<n>: <text>"      on a revision: comment <n> not addressed, and why

  bateson draft <id> --questions -|--none|--show
                             follow-ups drafted after an early answer; hidden until the round is sent
  bateson status <id>       where an item stands, and the response if there is one
  bateson wait <id> [--timeout <s>]   wait for the response and print it (where nothing can wake you)
  bateson rearm <id>        keep waiting to be woken, when bateson tells you the wait is about to run out
  bateson inbox             responses for this session, and for this repo's sessions that have ended, not yet received
  bateson list              what is waiting for review
  bateson recall [<words>] [--limit <n>]
                            what they already decided, one line each: answers, approvals, send-backs, findings
                            kept with a comment or dismissed. Best match first; with no words, the latest.
  bateson config [--set -]  print the settings, or change them with a JSON patch on stdin (see /setup-bateson)
  bateson serve             run the app on http://localhost:${PORT}

Interview round JSON:
  { "questions": [ { "id": "Q1", "title": "Install scope", "body": "markdown: the question and its trade-offs",
                     "options": [ { "label": "Global", "description": "why" }, ... ], "recommended": 0,
                     "recommendation": "markdown: why, and on what conditions, without repeating the option's name",
                     "opens": true, "show": "shots/install.png" } ] }
  A round has two or more questions: a single question is asked in chat, never sent.
  Options come in a natural order (smallest change first, cheapest first), never by preference. A yes or no question
  has one option, your answer. "recommendation" shows under the recommended option; picking the recommended option accepts it whole, and the answer quotes it.
  "opens": true marks a question whose answer decides later questions. Its answer reaches you early.
  "show", on a question or on an option: the thing the question is about, shown with it. A path to an image (png, jpg,
  gif, webp, svg), a recording (mp4, webm, mov: played with a timeline) or a sound (wav, mp3, m4a, aiff: played when
  the reviewer points at its option), or to a text file with lines ("src/app.css:10-30", at most 60), or a localhost URL shown
  live ("http://localhost:5173/settings?variant=b"), or written out here: { "text": "..." }, { "markdown": "..." }
  or { "html": "<button>...</button>" } (a component example, rendered in a sandbox). A .md, .txt or .html file
  without lines is shown the same way. One or a list.

Findings JSON (a list, or { "findings": [...] }):
  [ { "title": "Token check skips expired tokens", "severity": "high" | "medium" | "low",
      "file": "src/auth.ts", "line": 42, "body": "markdown: what is wrong and why it matters",
      "fix": "optional markdown: the suggested fix" } ]
  Sorted highest severity first and numbered F1, F2, ...; the code around each line is captured as you send.
`;

// Flags whose value is the next argument whatever it looks like: a note may well start with "--".
const VALUE_FLAGS = new Set(['title', 'note', 'file', 'type', 'item', 'timeout', 'questions', 'findings', 'limit']);

/** The command line as parsed: the words, then each flag's value (true for a flag that takes none). */
interface Args {
  _: string[]; attach: (string | undefined)[]; replies: { addressed: boolean; raw: string | undefined }[];
  title?: string; note?: string; file?: string; type?: string; item?: string; timeout?: string; questions?: string; findings?: string; limit?: string;
  diff?: string; set?: string | true; stdin?: true; none?: true; show?: true;
  [flag: string]: unknown;
}

function parseArgs(argv: string[]) {
  const out: Args = { _: [], attach: [], replies: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith('--');
    if (VALUE_FLAGS.has(key)) {
      if (next === undefined) die(`--${key} needs a value.`);
      out[key] = next; i++; continue;
    }
    if (key === 'attach') { out.attach.push(next); i++; continue; }
    if (key === 'done' || key === 'not') { out.replies.push({ addressed: key === 'done', raw: next }); i++; continue; }
    if (['stdin', 'none', 'show'].includes(key)) { out[key] = true; continue; }
    if (key === 'diff') { out.diff = takesValue ? next : 'HEAD'; if (takesValue) i++; continue; }
    if ((key === 'questions' || key === 'findings') && next === '-') { out[key] = '-'; i++; continue; }
    out[key] = takesValue ? next : true;
    if (takesValue) i++;
  }
  return out;
}

function die(msg: string): never { process.stderr.write(`bateson: ${msg}\n`); process.exit(1); }

function git(args: string[], cwd = process.cwd()) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return null; }
}

function source(): Source {
  const cwd = process.cwd();
  const top = git(['rev-parse', '--show-toplevel']);
  return {
    agent: agent(), // who sent it; 'unknown' outside the agents bateson is wired into
    cwd,
    top: top ? path.resolve(top) : undefined, // the checkout: decisions reach later sessions anywhere in it (resolved: git says C:/x on Windows)
    repo: path.basename(top || cwd),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || undefined,
  };
}

function readStdin() { return fs.readFileSync(0, 'utf8'); }

function diffBody(base: string) {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') die('--diff needs a git repository.');
  let diff = git(['diff', '--no-color', base]) ?? die(`git diff ${base} failed.`);
  // Untracked files are part of the change too, anywhere in the repository: git diff covers all of it, but
  // ls-files only lists the folder it runs in, so both run from the top.
  const top = git(['rev-parse', '--show-toplevel']) ?? undefined;
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], top) || '').split('\n').filter(Boolean);
  for (const f of untracked) {
    try {
      execFileSync('git', ['diff', '--no-color', '--no-index', '/dev/null', f], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { const out = (e as { stdout?: string }).stdout; if (out) diff += (diff ? '\n' : '') + out.trim(); }
  }
  if (!diff.trim()) die('the diff is empty: nothing changed against ' + base + '.');
  return diff;
}

/** A kind's check of a body, with its complaint as the CLI's. */
function check<T>(validate: () => T): T {
  try { return validate(); } catch (e) { die((e as Error).message); }
}

/**
 * Whether the server answers, and how many bateson pages are open: null when it does not say, which a server
 * started before this version does not. A page may well be open then, so nothing is opened.
 */
async function appStatus(): Promise<{ running: boolean; pages: number | null }> {
  try {
    // 127.0.0.1, where the server listens: on Windows "localhost" tries ::1 first, and a refused connection
    // there takes long enough to miss the timeout.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return { running: false, pages: null };
    const body = await res.json().catch(() => ({})) as { pages?: unknown };
    return { running: true, pages: typeof body.pages === 'number' ? body.pages : null };
  } catch { return { running: false, pages: null }; }
}

/**
 * Windows has no bateson app for now, so nothing there tells the reviewer a question is waiting. On Windows, and
 * in WSL, a send opens the page itself: in a window of its own (Chrome's or Edge's --app, no tabs or address bar),
 * else in the default browser through explorer.exe. BATESON_NO_OPEN turns it off, and BATESON_OPEN_WITH names
 * another program to open the address with (for trying it off Windows).
 */
function pageOpener(url: string): { exe: string; args: string[] } | null {
  if (process.env.BATESON_NO_OPEN) return null;
  if (process.env.BATESON_OPEN_WITH) return { exe: process.env.BATESON_OPEN_WITH, args: [url] };
  let roots: string[], windir: string;
  if (process.platform === 'win32') {
    roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
    windir = process.env.SystemRoot || 'C:\\Windows';
  } else if (process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()))) {
    roots = ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)'];
    windir = '/mnt/c/Windows';
  } else return null;
  // Chrome first, where it is installed (it is likely theirs), then Edge, which every Windows machine has.
  for (const browser of [['Google', 'Chrome', 'Application', 'chrome.exe'], ['Microsoft', 'Edge', 'Application', 'msedge.exe']]) {
    for (const root of roots) {
      const exe = path.join(root, ...browser);
      if (fs.existsSync(exe)) return { exe, args: [`--app=${url}`] };
    }
  }
  const explorer = path.join(windir, 'explorer.exe');
  return fs.existsSync(explorer) ? { exe: explorer, args: [url] } : null;
}

function openPage(): boolean {
  const how = pageOpener(`http://localhost:${PORT}/`);
  if (!how) return false;
  try {
    const child = spawn(how.exe, how.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function cmdSend(o: Args) {
  if (!o.title && !o.item) die('--title is required.');
  if (!o.note && !o.questions) die('--note is required: what this is and where to look.');
  let bodyType: BodyType, body: Body;
  let shown: Attachment[] = [];
  const sources = ['questions', 'findings', 'file', 'diff', 'stdin'].filter((k) => o[k]);
  if (sources.length !== 1) die('give exactly one body: --questions, --findings, --file, --diff or --stdin.');
  if (o.findings) {
    bodyType = 'findings';
    const raw = o.findings === '-' ? readStdin() : fs.readFileSync(o.findings, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) { die(`--findings is not valid JSON: ${(e as Error).message}`); }
    body = check(() => KINDS.findings.validate(parsed));
  } else if (o.questions) {
    bodyType = 'questions';
    const raw = o.questions === '-' ? readStdin() : fs.readFileSync(o.questions, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) { die(`--questions is not valid JSON: ${(e as Error).message}`); }
    const round = check(() => KINDS.interview.validate(parsed, process.cwd()));
    body = round;
    if (round.questions.length < 2) die(`a single question is not sent to bateson. Ask it in chat, with your recommendation; bateson is for rounds of two or more questions.`);
    shown = round.files;
    const looks = round.questions.some((q) => [q.show, ...q.options.map((x) => x.show)].some((list) => list?.some((s) => !('audio' in s))));
    if (!store.readConfig().preview && (looks || o.attach.length)) die(`${Reviewer()} has the preview panel turned off in Settings, so a question is shown as words only and nothing in "show" or --attach would be seen (a sound on an option still plays). Send the round without them, and put what they need to know in the question and the options.`);
  } else if (o.file) {
    if (!fs.existsSync(o.file)) die(`no file ${o.file}`);
    body = fs.readFileSync(o.file, 'utf8');
    bodyType = /\.(md|markdown|mdx)$/i.test(o.file) ? 'markdown' : /\.(diff|patch)$/i.test(o.file) ? 'diff' : 'text';
  } else if (o.diff) {
    bodyType = 'diff';
    body = diffBody(o.diff);
  } else {
    const type = o.type || 'markdown';
    if (!(BODY_TYPES as string[]).includes(type) || type === 'questions' || type === 'findings') die('--type is markdown, text or diff.');
    bodyType = type as BodyType;
    body = readStdin();
  }
  const attach = o.attach.map((f) => (f && fs.existsSync(f) ? f : die(`no attachment ${f}`)));
  const kind = bodyType === 'questions' ? 'decision' : 'review';
  if (o.item) {
    const it = findOrDie(o.item);
    if (bodyType === 'findings' && store.currentVersion(it).bodyType !== 'findings') die('findings start a new item; leave out --item.');
  }
  const replies = parseReplies(o);
  const res = store.send({ itemId: o.item, kind, bodyType, title: o.title, note: o.note, body, attachments: [...attach, ...shown], source: source(), replies });
  // The item belongs to this session from now on, whether or not the rewake hook ever runs: its decision goes
  // to no other session while this one is open (lib/delivery.ts).
  const sessionId = currentSession();
  const sent = store.getItem(res.id);
  if (sessionId && sent) own(sent, { sessionId, cwd: process.cwd() });
  const { running, pages } = await appStatus();
  // The rewake hook reads the first line, so keep its shape.
  console.log(`queued ${res.id} v${res.n}${res.replaced ? ' (replaced the unread version)' : ''}`);
  if (running && pages === 0 && openPage()) console.log(`(Opened the bateson window for ${reviewer()}.)`);
  if (running && pages === null && pageOpener('')) console.log(`(The bateson server is older than this command. Tell ${reviewer()} to run the installer again, which restarts it.)`);
  if (!running) console.log(`(The bateson app is not running. It is waiting in ~/.bateson; ${reviewer()} can start the app with \`bateson serve\`.)`);
  // What the agent does next depends on whether anything can wake it, which it cannot know and this can check.
  // The bateson skill tells agents to do what the last line says, so this stays last.
  console.log(canWake()
    ? `${Reviewer()} will see it in bateson. You will be woken with the response. End your turn now unless you have independent work that does not depend on it; do not ask the same thing in chat.`
    : `${Reviewer()} will see it in bateson. Nothing can wake you here, so wait for the response: run \`bateson wait ${res.id}\` now, and again each time it tells you to. Do not ask the same thing in chat.`);
}

// A revision answers everything it was asked: each comment by number (--done "1: ..." or --not "2: ..."), or
// after findings each kept finding by its id (--done "F1: ...").
function parseReplies(o: Args): Reply[] {
  const replies = o.replies.map(({ addressed, raw }): Reply => {
    const m = /^\s*([A-Za-z]?\d+)\s*[:.)-]\s*([\s\S]+)$/.exec(raw || '');
    if (!m) die(`--${addressed ? 'done' : 'not'} needs "<comment number or finding id>: <one line>", got ${JSON.stringify(raw ?? '')}.`);
    const key = m[1].toUpperCase();
    return { comment: /^\d+$/.test(key) ? Number(key) : key, addressed, text: m[2].trim() };
  });
  if (!o.item) { if (replies.length) die('--done and --not answer comments on a revision; they need --item.'); return replies; }
  const item = findOrDie(o.item);
  const { keys, noun } = toAnswer(item);
  const what = noun || 'comment';
  const extra = replies.filter((r) => !keys.includes(String(r.comment)));
  if (extra.length) die(`${keys.length ? `the ${what}s to answer are ${keys.join(', ')}` : 'there is nothing to answer'}; not ${extra.map((r) => r.comment).join(', ')}.`);
  const missing = keys.filter((k) => !replies.some((r) => String(r.comment) === k));
  if (missing.length) die(`answer every ${what}: add --done "<${what === 'comment' ? 'n' : 'id'}>: what you changed" or --not "<${what === 'comment' ? 'n' : 'id'}>: why not" for ${missing.join(', ')}. \`bateson status ${item.id}\` shows them.`);
  return replies;
}

async function cmdDraft(o: Args) {
  const id = o._[1];
  const item = findOrDie(id);
  if (o.show) {
    // The drafts for the round just answered: the current version's, or the one before if a new round went out.
    const draft = [...item.versions].reverse().map((x) => store.readDraft(item, x.n)).find(Boolean);
    console.log(JSON.stringify(draft || { questions: [] }, null, 2));
    return;
  }
  let questions: Question[] = [];
  if (!o.none) {
    if (o.questions !== '-' && !(typeof o.questions === 'string' && fs.existsSync(o.questions))) die('draft needs --questions <file|-> or --none.');
    const raw = o.questions === '-' ? readStdin() : fs.readFileSync(o.questions, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) { die(`--questions is not valid JSON: ${(e as Error).message}`); }
    questions = check(() => KINDS.interview.validate(parsed)).questions;
  }
  const res = questions.length ? store.saveDraft(id, questions) : { n: store.currentVersion(item).n, count: 0 };
  // The rewake hook reads the first line, so keep its shape.
  console.log(`waiting ${id} v${res.n}`);
  console.log(questions.length ? `Saved ${questions.length} drafted follow-up${questions.length === 1 ? '' : 's'}. End your turn; the rest of the round will wake you.` : 'Nothing drafted. End your turn; the rest of the round will wake you.');
}

function findOrDie(id: string | undefined): StoredItem {
  if (!id) die('give the item id (q_...). `bateson list` shows what is waiting.');
  const item = store.getItem(id);
  if (!item) die(`no item ${id}`);
  return item;
}

function cmdStatus(o: Args) {
  const item = findOrDie(o._[1]);
  const v = store.currentVersion(item);
  console.log(peek(item.id) || `${item.id} v${v.n} "${v.title || item.title}" is waiting for review.`);
}

// How long an agent that cannot be woken keeps asking before it ends its turn: waiting spends the person's usage.
const WAIT_FOR = 10 * 60 * 1000;

async function cmdWait(o: Args) {
  const item = findOrDie(o._[1]);
  const id = item.id;
  const sentAt = Date.parse(store.currentVersion(item).createdAt);
  // Claude Code lets a command run for minutes; other agents cut one off within the minute.
  const seconds = o.timeout == null ? (agent() === 'claude-code' ? 540 : 25) : Number(o.timeout);
  if (!(seconds > 0)) die(`--timeout is a number of seconds, not ${JSON.stringify(o.timeout)}.`);
  const res = await awaitDecision(id, { by: 'wait', until: Date.now() + seconds * 1000 });
  if (res.kind === 'decision') console.log(res.message);
  else if (res.kind === 'elsewhere') console.log(`bateson: the response on ${id} already reached a session. \`bateson status ${id}\` shows it.`);
  else if (Date.now() - sentAt < WAIT_FOR) console.log(`bateson: still waiting on ${id}. Run \`bateson wait ${id}\` again.`);
  else console.log(`bateson: still waiting on ${id} after ten minutes. Stop waiting: end your turn, and tell ${reviewer()} their response will be picked up when they next write. ${agent() === 'claude-code' ? 'It reaches this session by itself when they do.' : 'When they do, run `bateson inbox` before anything else.'}`);
}

// The rewake hook wakes the session shortly before Claude Code would stop it, and asks for this: the hook
// starts again on this command (it reads the first line, as after a send) and waits another stretch.
function cmdRearm(o: Args) {
  const item = findOrDie(o._[1]);
  const v = store.currentVersion(item);
  if (store.readDecision(item, v.n)) {
    // Answered in the meantime: hand it over here rather than wait for it, if it is this session's to take.
    const mine = pendingFor({ sessionId: currentSession() }).some((it) => it.id === item.id);
    const msg = mine ? claim(item.id, v.n, 'rearm') : null;
    console.log(msg ?? `bateson: the response on ${item.id} is not this session's to take, or already reached a session. End your turn.`);
    return;
  }
  // The rewake hook reads the first line, so keep its shape.
  console.log(`waiting ${item.id} v${v.n}`);
  console.log(canWake()
    ? 'Still waiting. End your turn now and say nothing: you will be woken with the response.'
    : `Nothing can wake you here: run \`bateson wait ${item.id}\` instead.`);
}

function cmdInbox() {
  // This session's own responses, and those from sessions in this repo that have ended: never one whose
  // session is still open, which would take it from the conversation that asked. The hooks never hand on another
  // session's response; this does, because an agent runs it on purpose.
  const msgs = collect({ sessionId: currentSession(), cwd: process.cwd() }, 'inbox');
  console.log(msgs.length ? msgs.join('\n\n') : 'bateson: no responses for this session, or from this repo\'s ended sessions.');
}

function cmdList() {
  const rows = store.pending();
  if (!rows.length) { console.log('Nothing is waiting.'); return; }
  for (const r of rows) console.log(`${r.item.id} v${r.v.n}  ${r.waiting ? '(a session is waiting)  ' : ''}${r.v.title || r.item.title}  [${r.item.source?.repo || ''}]`);
}

function cmdRecall(o: Args) {
  const query = o._.slice(1).join(' ');
  const limit = o.limit == null ? 12 : Number(o.limit);
  if (!(Number.isInteger(limit) && limit > 0)) die(`--limit is a whole number, not ${JSON.stringify(o.limit)}.`);
  const here = source();
  const { words, total, shown } = recall(query, { top: here.top, repo: here.repo, limit });
  if (query.trim() && !words.length) die('give words of three letters or more to search for, or none for the latest decisions.');
  const who = reviewer();
  if (!shown.length) { console.log(query.trim() ? `bateson: nothing ${who} decided matches "${query.trim()}".` : `bateson: ${who} has not decided anything yet.`); return; }
  console.log(`${query.trim() ? `${total} decision${total === 1 ? '' : 's'} by ${who} matching "${query.trim()}", best match first` : `${Reviewer()}'s latest decisions`}${total > shown.length ? ` (the first ${shown.length}; --limit for more)` : ''}:`);
  for (const r of shown) console.log(formatRecalled(r));
  // What to do with it, last, where agents look.
  console.log(`\nA question answered here is settled: do not ask it again unless something has changed, and then say what changed and name the earlier answer and its date. A past answer is evidence, not the default: recommend on the merits, and say so when you lean away from it. A whole item is in ${path.join(store.ROOT, 'done', '<id>')}.`);
}

function cmdConfig(o: Args) {
  if (o.set === undefined) { console.log(JSON.stringify(store.readConfig(), null, 2)); return; }
  if (o.set !== '-') die('--set reads a JSON patch from stdin: bateson config --set - <<< \'{"bring":{"plans":true}}\'');
  let patch: unknown;
  try { patch = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { die(`--set needs JSON on stdin: ${(e as Error).message}`); }
  console.log(JSON.stringify(store.writeConfig(patch), null, 2));
}

function cmdServe() {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'server', 'server.ts')], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
try {
  if (cmd === 'send') await cmdSend(o);
  else if (cmd === 'draft') await cmdDraft(o);
  else if (cmd === 'status') cmdStatus(o);
  else if (cmd === 'wait') await cmdWait(o);
  else if (cmd === 'rearm') cmdRearm(o);
  else if (cmd === 'inbox') cmdInbox();
  else if (cmd === 'list') cmdList();
  else if (cmd === 'recall') cmdRecall(o);
  else if (cmd === 'serve') cmdServe();
  else if (cmd === 'config') cmdConfig(o);
  else process.stdout.write(HELP);
} catch (e) { die((e as Error).message); }
