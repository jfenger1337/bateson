// The queue on disk, and the only module that knows its layout (docs/folder-format.md). Callers work with items
// and version numbers, never with paths. No dependencies, so hooks start fast.
//
//   <root>/items/<id>/item.json              written by the producer (the CLI)
//   <root>/items/<id>/v<N>/body.<ext>         the version's body
//   <root>/items/<id>/v<N>/files/*            attachments
//   <root>/items/<id>/v<N>/replies.json       a revision's answers to what the version before asked
//   <root>/items/<id>/v<N>/decision.json      written by the reviewer (server), once
//   <root>/items/<id>/v<N>/delivered.json     an agent was handed the decision; created exclusively, so once
//   <root>/items/<id>/v<N>/confirmed.json     a wake-up's delivery was found in the session's transcript
//   <root>/items/<id>/v<N>/redelivered.json   a wake-up's delivery was lost and the decision handed over again, once
//   <root>/items/<id>/v<N>/early/<Q>.json     answers given before the round was sent (and <Q>.reported.json)
//   <root>/items/<id>/v<N>/draft.json         follow-ups the agent drafted after an early answer
//   <root>/items/<id>/v<N>/stopped.json       the session that was writing the next round ended its turn
//   <root>/items/<id>/session.json            the agent session that sent it
//   <root>/items/<id>/waiter.json             a live hook waiting on it: { pid, sessionId, n }; touched every poll
//   <root>/items/<id>/later.json              moved to the back of the queue
//   <root>/done/<id>/withdrawn.json           its agent cancelled it (`bateson cancel`): { at, by, n }
//   <root>/done/<id>/                         delivered items, same layout
//   <root>/sessions/<session>.json            sessions at work (hooks); <session>.tree is lib/worktree.ts's
//   <root>/config.json                        settings
//   <root>/hooks.log                          what went wrong in a hook (they never stop a session to say so)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Answer, BodyType, Config, Decision, Finding, Hue, Question, Reply, Round, Source } from './types.ts';

const HUES: Hue[] = ['slate', 'terracotta', 'moss', 'plum', 'ochre'];

// ---- The files' shapes. The store wrote them (or a producer did, following docs/folder-format.md), so what it
// reads back is taken at its word.

/** A version as item.json lists it. */
export interface StoredVersion { n: number; bodyType: BodyType; note?: string; title?: string; createdAt: string; replaced?: true }
/** item.json. `kind` is the producer's: 'decision' for an interview, 'review' for anything else. */
export interface ItemFile {
  id: string; kind: 'review' | 'decision'; title: string; createdAt: string; updatedAt: string;
  source: Source; versions: StoredVersion[]; hue?: Hue;
}
/** An item as the store hands it out: item.json and the folder it lives in, which only the store looks at. */
export type StoredItem = ItemFile & { readonly dir: string };
export type Body = string | Round | { findings: Finding[] };
/**
 * decision.json: the reviewer's decision, with when it was made and `versionAt`, the createdAt of the version it
 * was made on. A version replaced in place keeps its number, so that is what tells a decision on the text the
 * reviewer saw from one on text that took its place meanwhile.
 */
export type DecisionFile = Decision & { decidedAt: string; versionAt?: string };
/** delivered.json. A wake-up's delivery also names the session and its transcript, where it can be checked. */
export interface Delivered { at: string; by?: string; sessionId?: string; transcript?: string }
/** waiter.json: a live hook waiting on version n. */
export interface Waiter { pid: number; sessionId?: string; n: number }
/** withdrawn.json: the agent cancelled the item at version n, because the user called it off in chat. */
export interface Withdrawn { at: string; by?: string; n: number }
/** session.json: the Claude Code session that sent the item, and so the only one its decision goes to while it runs. */
export interface ItemSession { agent?: string; sessionId: string; cwd?: string; transcriptPath?: string }
export type EarlyAnswer = Answer & { at: string };
export interface Draft { questions: Question[] }
/** sessions/<id>.json. */
export interface SessionRecord {
  sessionId: string; cwd?: string; repo: string; state: 'working' | 'idle'; at: string; since: string;
  transcript?: string; turn?: { human?: boolean; reminded?: boolean }; heard?: Config['bring'];
}
/** An attachment to send: a path, or { path, name } to store it under another name. */
export type Attachment = string | { path: string; name: string };

export const PORT = Number(process.env.BATESON_PORT || 4848);

export const DEFAULTS: Config = {
  name: '',                   // what agents call you ("Sam reviews it first"); empty: "the user"
  blocked: 'notify',          // when a session is blocked on you: 'notify' | 'notify-forward' | 'none'
  sound: true,                // notification sound
  hotkey: 'ctrl+option+space', // 'ctrl+option+space' | 'option+q' | 'cmd+shift+space' | 'off'
  undoSeconds: 4,             // how long a decision can be undone before the agent hears it: 0 to 10
  stopCheck: true,            // hooks/remind.ts: "did you just decide something on your own?", on turns you did not start
  theme: 'system',            // 'system' | 'light' | 'dark'
  preview: false,             // the panel beside a question for its `show`; off, questions are centred and in words only
  updates: true,              // once a day, ask GitHub whether there is a newer version (lib/update.ts)
  // What agents bring to you, set with /setup-bateson and told to every agent at session start (hooks/catchup.ts).
  // decisions: questions and decisions, taste calls included, as interview rounds. plans: a plan before big work.
  // findings: review findings before they are fixed. code: changes as a diff; off, finished work comes back as a report.
  bring: { decisions: true, plans: false, findings: false, code: false },
};
const CHOICES: Partial<Record<keyof Config, readonly unknown[]>> = { blocked: ['notify', 'notify-forward', 'none'], hotkey: ['ctrl+option+space', 'option+q', 'cmd+shift+space', 'off'], theme: ['system', 'light', 'dark'] };

const BODY_EXT: Record<BodyType, string> = { markdown: 'md', text: 'txt', diff: 'diff', questions: 'json', findings: 'json' };
const JSON_BODIES = new Set<BodyType>(['questions', 'findings']);
export const BODY_TYPES = Object.keys(BODY_EXT) as BodyType[];

const now = () => new Date().toISOString();

function readJson(file: string, fallback: unknown = null): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  replace(tmp, file);
}

/**
 * Rename over a file. Windows refuses while another process (the server reading it, a virus scanner) has the
 * file open for a moment, so there it tries again for up to a second.
 */
function replace(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      const { code } = e as NodeJS.ErrnoException;
      if (process.platform !== 'win32' || i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function pidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * What Claude Code itself says about its running sessions: each live process keeps ~/.claude/sessions/<pid>.json
 * with its current session id and whether it is busy. A Map of session id to status, or null when there is no
 * such folder to ask (another machine's layout, or a test queue).
 */
function claudeSessions(dir: string | null): Map<string, string> | null {
  if (!dir) return null;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return null; }
  const out = new Map<string, string>();
  for (const f of files) {
    let s: { sessionId?: string; pid?: number; status?: string } | null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (s?.sessionId && pidAlive(s.pid ?? Number.parseInt(f, 10))) out.set(s.sessionId, String(s.status || ''));
  }
  return out;
}

/** One Claude Code process's entry in that list: the session it is on now, if the process is alive. */
function claudeSessionOf(dir: string | null, pid: number): { sessionId: string; status: string } | null {
  if (!dir || !Number.isInteger(pid) || pid <= 1) return null;
  let s: { sessionId?: string; pid?: number; status?: string } | null;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')); } catch { return null; }
  return s?.sessionId && pidAlive(pid) ? { sessionId: s.sessionId, status: String(s.status || '') } : null;
}

/** How long a waiter may go without touching waiter.json before it counts as gone (it touches it every second). */
const WAITER_STALE_MS = 15_000;

/**
 * A queue in a folder. The default one is `BATESON_HOME` or ~/.bateson.
 * `claudeDir` is where Claude Code lists its live sessions: `BATESON_CLAUDE_DIR` if set, else ~/.claude/sessions;
 * a queue in BATESON_HOME goes without unless BATESON_CLAUDE_DIR names one.
 */
export function openStore(
  root = process.env.BATESON_HOME || path.join(os.homedir(), '.bateson'),
  { claudeDir = process.env.BATESON_CLAUDE_DIR || (process.env.BATESON_HOME ? null : path.join(os.homedir(), '.claude', 'sessions')) }: { claudeDir?: string | null } = {},
) {
  const ITEMS = path.join(root, 'items');
  const DONE = path.join(root, 'done');
  const SESSIONS = path.join(root, 'sessions');
  const CONFIG = path.join(root, 'config.json');
  const HOOK_LOG = path.join(root, 'hooks.log');

  const vdir = (item: StoredItem, n: number) => path.join(item.dir, `v${n}`);
  const vfile = (item: StoredItem, n: number, name: string) => path.join(vdir(item, n), name);
  const ifile = (item: StoredItem, name: string) => path.join(item.dir, name);

  // ---- Settings

  function readConfig(): Config {
    const c = (readJson(CONFIG, {}) || {}) as Partial<Config>;
    const pick = <K extends keyof Config>(k: K): Config[K] => c[k] ?? DEFAULTS[k];
    // Only the keys bateson knows, so a setting it no longer has drops out of the file on the next change.
    return {
      name: pick('name'), blocked: pick('blocked'), sound: pick('sound'), hotkey: pick('hotkey'), undoSeconds: pick('undoSeconds'),
      stopCheck: pick('stopCheck'), theme: pick('theme'), preview: pick('preview'), updates: pick('updates'), bring: { ...DEFAULTS.bring, ...(c.bring || {}) },
    };
  }

  /** Change settings. Unknown keys and values of the wrong shape are ignored. */
  function writeConfig(patch: unknown): Config {
    const next = readConfig();
    const set = (k: keyof Config, v: unknown) => { (next as Record<keyof Config, unknown>)[k] = v; };
    for (const [k, v] of Object.entries(patch || {}) as [string, unknown][]) {
      if (!(k in DEFAULTS)) continue;
      const key = k as keyof Config;
      const choices = CHOICES[key];
      if (key === 'bring') {
        for (const [b, on] of Object.entries(v || {}) as [string, unknown][]) if (b in DEFAULTS.bring && typeof on === 'boolean') next.bring[b as keyof Config['bring']] = on;
      } else if (choices) { if (choices.includes(v)) set(key, v); }
      else if (key === 'name') { if (typeof v === 'string') next.name = v.trim().slice(0, 40); }
      else if (key === 'undoSeconds') { if (typeof v === 'number' && Number.isFinite(v)) next.undoSeconds = Math.max(0, Math.min(10, Math.round(v))); }
      else if (typeof v === typeof DEFAULTS[key]) set(key, v);
    }
    fs.mkdirSync(root, { recursive: true });
    writeJson(CONFIG, next);
    return next;
  }

  // ---- Items

  function ensureDirs() {
    fs.mkdirSync(ITEMS, { recursive: true });
    fs.mkdirSync(DONE, { recursive: true });
  }

  function newId() {
    return 'q_' + Date.now().toString(36).slice(-5) + crypto.randomBytes(3).toString('hex');
  }

  function locate(id: unknown) {
    if (typeof id !== 'string' || !/^q_[a-z0-9]+$/.test(id)) return null;
    for (const base of [ITEMS, DONE]) {
      const dir = path.join(base, id);
      if (fs.existsSync(path.join(dir, 'item.json'))) return dir;
    }
    return null;
  }

  // The server reads the whole queue, done items included, on every change. What it read before is kept: an
  // item.json is only ever replaced whole (writeJson renames over it), so a new inode, time or size means a new
  // file; a decision or a delivery is written once and never changes. The text is kept, not the object, so a
  // caller can change what it gets without changing the next caller's copy.
  const seen = new Map<string, { sig: string; text: string }>();
  const once = new Map<string, string>();

  function readItemJson(file: string): unknown {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) { seen.delete(file); return null; }
    const sig = `${st.ino}:${st.mtimeMs}:${st.size}`;
    let hit = seen.get(file);
    if (hit?.sig !== sig) {
      try { hit = { sig, text: fs.readFileSync(file, 'utf8') }; } catch { return null; }
      seen.set(file, hit);
    }
    try { return JSON.parse(hit.text); } catch { return null; }
  }

  /** A file written once (decision.json, delivered.json): read until it is there, then remembered. */
  function readOnce(file: string): unknown {
    let text = once.get(file);
    if (text === undefined) {
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      try { JSON.parse(text); } catch { return null; } // still being written
      once.set(file, text);
    }
    return JSON.parse(text);
  }

  /** item.json with its folder attached, out of sight: the store's own business. */
  function withDir(file: ItemFile, dir: string): StoredItem {
    Object.defineProperty(file, 'dir', { value: dir, enumerable: false });
    return file as StoredItem;
  }

  function load(dir: string): StoredItem | null {
    const item = readItemJson(path.join(dir, 'item.json')) as ItemFile | null;
    return item ? withDir(item, dir) : null;
  }

  /** The item as it is now, wherever it lives; or null. */
  function getItem(id: unknown) { const dir = locate(id); return dir ? load(dir) : null; }

  function listDir(base: string): StoredItem[] {
    try {
      return fs.readdirSync(base).filter((d) => d.startsWith('q_')).map((d) => load(path.join(base, d))).filter((it) => !!it);
    } catch { return []; }
  }
  const allQueued = () => listDir(ITEMS);
  const allDone = () => listDir(DONE);
  const isQueued = (item: StoredItem) => item.dir.startsWith(ITEMS + path.sep);

  const currentVersion = (item: StoredItem) => item.versions[item.versions.length - 1];
  const versionOf = (item: StoredItem, n: number) => item.versions.find((v) => v.n === n) || null;

  /**
   * A version's decision, or null. One made on an earlier body of the same version number (it was replaced in
   * place while the reviewer decided) is not this version's: it is ignored, and forgotten so a later one is read.
   */
  function readDecision(item: StoredItem, n: number) {
    const file = vfile(item, n, 'decision.json');
    const at = versionOf(item, n)?.createdAt;
    const stale = (d: DecisionFile | null) => !!d?.versionAt && !!at && d.versionAt !== at;
    let d = readOnce(file) as DecisionFile | null;
    if (stale(d)) { once.delete(file); d = readOnce(file) as DecisionFile | null; }
    return stale(d) ? null : d;
  }
  const readDelivered = (item: StoredItem, n: number) => readOnce(vfile(item, n, 'delivered.json')) as Delivered | null;
  const isDelivered = (item: StoredItem, n: number) => { const f = vfile(item, n, 'delivered.json'); return once.has(f) || fs.existsSync(f); };

  function readBody(item: StoredItem, v: StoredVersion): Body {
    const file = vfile(item, v.n, `body.${BODY_EXT[v.bodyType]}`);
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!JSON_BODIES.has(v.bodyType)) return raw;
    try { return JSON.parse(raw); } catch { return { [v.bodyType]: [] } as unknown as Body; }
  }
  /** A round's questions; none for a body that is not a round. */
  const readQuestions = (item: StoredItem, v: StoredVersion): Question[] => (readBody(item, v) as Partial<Round>).questions || [];
  /** A findings body's findings; none for a body that is not one. */
  const readFindings = (item: StoredItem, v: StoredVersion): Finding[] => (readBody(item, v) as { findings?: Finding[] }).findings || [];

  function attachments(item: StoredItem, n: number) {
    try { return fs.readdirSync(vfile(item, n, 'files')).filter((f) => !f.startsWith('.')); } catch { return []; }
  }

  /** An attachment's bytes, or null. The name is a plain file name: nothing outside the version's files. */
  function readAttachment(item: StoredItem, n: number, name: string) {
    if (!Number.isInteger(n) || name !== path.basename(name) || name.startsWith('.')) return null;
    const file = path.join(vfile(item, n, 'files'), name);
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file) : null;
  }

  const readReplies = (item: StoredItem, n: number) => (readJson(vfile(item, n, 'replies.json'), []) || []) as Reply[];

  /**
   * Create an item, or add the next version to an existing one (`itemId`). A version that was never decided is
   * replaced in place: the reviewer only ever sees the latest unread one, and each version keeps a fresh
   * `createdAt`, which is what a decision is checked against.
   */
  function send({ itemId, kind, bodyType, title, note, body, attachments: files = [], source, replies }: {
    itemId?: string; kind: ItemFile['kind']; bodyType: BodyType; title?: string; note?: string; body: Body;
    attachments?: Attachment[]; source: Source; replies?: Reply[];
  }) {
    if (!BODY_EXT[bodyType]) throw new Error(`Unknown body type ${bodyType}`);
    ensureDirs();
    const at = now();
    let item = itemId ? getItem(itemId) : null;
    if (itemId && !item) throw new Error(`No item ${itemId}. Leave out --item to start a new one.`);
    let dir;
    if (item) {
      dir = item.dir;
      // A finished item coming back for another round re-enters the queue.
      if (!isQueued(item)) {
        const back = path.join(ITEMS, path.basename(dir));
        fs.renameSync(dir, back);
        dir = back;
      }
      item = load(dir)!;
      const last = currentVersion(item);
      const lastDecided = !!readDecision(item, last.n);
      let n;
      if (!lastDecided) {
        n = last.n; // replace in place
        fs.rmSync(vdir(item, n), { recursive: true, force: true });
        item.versions.pop();
      } else n = last.n + 1;
      item.versions.push({ n, bodyType, note, title, createdAt: at, replaced: !lastDecided || undefined });
      item.title = title || item.title;
      item.updatedAt = at;
      item.source = { ...item.source, ...source };
      fs.rmSync(path.join(dir, 'later.json'), { force: true });
      // Sent again after it was cancelled: it is back in the queue, as asked.
      fs.rmSync(path.join(dir, 'withdrawn.json'), { force: true });
    } else {
      const id = newId();
      dir = path.join(ITEMS, id);
      fs.mkdirSync(dir, { recursive: true });
      item = withDir({ id, kind, title: title!, createdAt: at, updatedAt: at, source, versions: [{ n: 1, bodyType, note, title, createdAt: at }] }, dir);
    }
    const v = currentVersion(item);
    fs.mkdirSync(vdir(item, v.n), { recursive: true });
    fs.writeFileSync(vfile(item, v.n, `body.${BODY_EXT[bodyType]}`), JSON_BODIES.has(bodyType) ? JSON.stringify(body, null, 2) : String(body));
    if (replies?.length) writeJson(vfile(item, v.n, 'replies.json'), replies);
    if (files.length) {
      fs.mkdirSync(vfile(item, v.n, 'files'), { recursive: true });
      for (const file of files) {
        const [from, name] = typeof file === 'string' ? [file, path.basename(file)] : [file.path, file.name];
        fs.copyFileSync(from, path.join(vfile(item, v.n, 'files'), name));
      }
    }
    item.hue ??= freeHue(item.id);
    writeJson(path.join(dir, 'item.json'), item);
    // A decision the reviewer made while this was being written was made on the text it replaced (item.json still
    // said so): it is not a decision on this version, which is waiting now.
    const made = readJson(vfile(item, v.n, 'decision.json')) as DecisionFile | null;
    if (made && made.versionAt !== v.createdAt) dropDecision(item, v.n);
    return { id: item.id, n: v.n, replaced: !!v.replaced };
  }

  /**
   * Write the reviewer's decision on a version, once. `at` is the version's createdAt as the reviewer saw it:
   * a version replaced since (same number, new body) is refused, so an approval never lands on unseen text.
   */
  function decide(id: string, n: number, decision: Decision, { at }: { at?: string } = {}) {
    const item = getItem(id);
    if (!item) throw new Error('No such item');
    const v = currentVersion(item);
    if (readWithdrawn(item)) throw Object.assign(new Error('Its agent cancelled this, so your answer was not sent.'), { code: 'withdrawn' });
    if (v.n !== n || (at && v.createdAt !== at)) throw Object.assign(new Error('A newer version arrived.'), { code: 'stale' });
    const file = vfile(item, n, 'decision.json');
    const stale = () => Object.assign(new Error('A newer version arrived.'), { code: 'stale' });
    let fd;
    for (let tries = 0; ; tries++) {
      try { fd = fs.openSync(file, 'wx'); break; } catch (e) {
        const { code } = e as NodeJS.ErrnoException;
        if (code === 'ENOENT') throw stale(); // the version's folder is being replaced right now
        if (code !== 'EEXIST') throw e;
        // Left from an earlier body of this version number: not a decision on this one.
        if (tries === 0 && !readDecision(item, n)) { dropDecision(item, n); continue; }
        throw Object.assign(new Error('This was already decided.'), { code: 'decided' });
      }
    }
    fs.writeSync(fd, JSON.stringify({ ...decision, decidedAt: now(), versionAt: v.createdAt } satisfies DecisionFile, null, 2));
    fs.closeSync(fd);
    // The version was replaced while this was written: the new body has not been seen. The CLI drops this
    // decision once its item.json is written; say so now.
    if (getItem(id)?.versions.at(-1)?.createdAt !== v.createdAt) throw stale();
    fs.rmSync(path.join(item.dir, 'later.json'), { force: true });
  }

  /** Remove a decision that is not the version's (see readDecision). */
  function dropDecision(item: StoredItem, n: number) {
    const file = vfile(item, n, 'decision.json');
    fs.rmSync(file, { force: true });
    once.delete(file);
  }

  function later(id: string) {
    const item = getItem(id);
    if (item) writeJson(ifile(item, 'later.json'), { at: now() });
  }

  const readWithdrawn = (item: StoredItem) => readJson(ifile(item, 'withdrawn.json')) as Withdrawn | null;

  /**
   * The agent calls an item off, because the user told it to in chat: it leaves the queue (filed under done,
   * like a delivered item), a hook waiting on it lets go without waking anyone, and the app refuses a decision
   * on it. An answer given but not yet received is never handed on. Says what the item was doing:
   * 'waiting' for the reviewer, 'answered' but not received, 'received' (the agent had the last answer), or
   * 'already' cancelled.
   */
  function withdraw(item: StoredItem, by?: string): 'waiting' | 'answered' | 'received' | 'already' {
    if (readWithdrawn(item)) return 'already';
    const v = currentVersion(item);
    // Written before the decision is looked at: a decision made from here on is refused (decide()).
    writeJson(ifile(item, 'withdrawn.json'), { at: now(), by, n: v.n } satisfies Withdrawn);
    let was: 'waiting' | 'answered' | 'received' = 'waiting';
    if (readDecision(item, v.n)) was = claimDelivery(item, v.n, 'cancel') ? 'answered' : 'received';
    fileAway(item);
    return was;
  }

  /** Items cancelled by their agent since `since`, for the app to say so if one was in front of you. */
  function withdrawnSince(since: number, all = allDone()) {
    const out: { item: StoredItem; w: Withdrawn }[] = [];
    for (const item of all) {
      const w = readWithdrawn(item);
      if (w && Date.parse(w.at) >= since) out.push({ item, w });
    }
    return out;
  }

  // ---- Delivery. lib/delivery.ts is the one caller.

  /** Claim the delivery of a decided version: true for exactly one caller, ever. */
  function claimDelivery(item: StoredItem, n: number, by?: string, to: { sessionId?: string; transcript?: string } = {}) {
    try { fs.writeFileSync(vfile(item, n, 'delivered.json'), JSON.stringify({ at: now(), by, ...to } satisfies Delivered), { flag: 'wx' }); }
    catch { return false; }
    return true;
  }

  // A wake-up hands its decision to Claude Code and exits; whether it reached the conversation shows only in the
  // session's transcript afterwards. lib/delivery.ts checks, and hands a lost one over again, once.
  const isConfirmed = (item: StoredItem, n: number) => fs.existsSync(vfile(item, n, 'confirmed.json'));
  const confirmDelivery = (item: StoredItem, n: number) => writeJson(vfile(item, n, 'confirmed.json'), { at: now() });
  function claimRedelivery(item: StoredItem, n: number, by?: string) {
    try { fs.writeFileSync(vfile(item, n, 'redelivered.json'), JSON.stringify({ at: now(), by }), { flag: 'wx' }); }
    catch { return false; }
    confirmDelivery(item, n);
    return true;
  }
  /** Wake-up deliveries of the last day nobody has checked yet: { item, n, delivered }. */
  function unconfirmed() {
    const day = Date.now() - 24 * 3600 * 1000;
    const out: { item: StoredItem; n: number; delivered: Delivered }[] = [];
    for (const item of [...allQueued(), ...allDone()]) {
      const { n } = currentVersion(item);
      const d = readDelivered(item, n);
      if (!d || !d.by?.startsWith('rewake:') || Date.parse(d.at) < day || isConfirmed(item, n)) continue;
      out.push({ item, n, delivered: d });
    }
    return out;
  }

  /** File a delivered item under done, and forget its waiter. */
  function fileAway(item: StoredItem) {
    fs.rmSync(ifile(item, 'waiter.json'), { force: true });
    if (!isQueued(item)) return;
    fs.mkdirSync(DONE, { recursive: true });
    try { fs.renameSync(item.dir, path.join(DONE, path.basename(item.dir))); } catch { /* already moved */ }
  }

  const readSession = (item: StoredItem) => readJson(ifile(item, 'session.json')) as ItemSession | null;
  const writeSession = (item: StoredItem, s: ItemSession) => writeJson(ifile(item, 'session.json'), s);
  const readWaiter = (item: StoredItem) => readJson(ifile(item, 'waiter.json')) as Waiter | null;
  const writeWaiter = (item: StoredItem, w: Waiter) => writeJson(ifile(item, 'waiter.json'), w);
  /** The waiter is still at it: touch waiter.json, if it is still `pid`'s. */
  function beat(item: StoredItem, pid: number) {
    const f = ifile(item, 'waiter.json');
    if (readWaiter(item)?.pid !== pid) return;
    const t = new Date();
    try { fs.utimesSync(f, t, t); } catch { /* gone meanwhile */ }
  }
  /** Remove the waiter, only if it is still `pid`'s (a newer send of the item has its own). */
  function clearWaiter(item: StoredItem, pid?: number | null) {
    const w = readWaiter(item);
    if (w && (pid == null || w.pid === pid)) fs.rmSync(ifile(item, 'waiter.json'), { force: true });
  }
  /**
   * Is a live session waiting on this item right now? Its process must be alive and must have touched
   * waiter.json lately: a process id can be reused by something else once the hook is gone.
   */
  function waiter(item: StoredItem) {
    const w = readWaiter(item);
    if (!w || !pidAlive(w.pid)) return null;
    let mtime = 0;
    try { mtime = fs.statSync(ifile(item, 'waiter.json')).mtimeMs; } catch { return null; }
    return Date.now() - mtime < WAITER_STALE_MS ? w : null;
  }

  /**
   * Whether the session that sent an item has ended, by Claude Code's list of running sessions. An item no
   * session claimed, or a machine without that list, counts as ended: `bateson inbox` in its checkout may take its decision.
   */
  function ownerGone(item: StoredItem, live = liveSessions()) {
    const id = readSession(item)?.sessionId;
    return !id || !live || !live.has(id);
  }

  /** Items whose current version is decided but no agent has received it yet. */
  function undelivered() {
    return allQueued().filter((it) => {
      const v = currentVersion(it);
      return readDecision(it, v.n) && !isDelivered(it, v.n);
    });
  }

  // ---- Early answers and drafts. A question marked `opens` has follow-ups that depend on it. Its answer goes to
  // the agent as soon as it is given, the agent drafts just those follow-ups, and the drafts are handed back
  // with the rest of the round.

  /** `answer` as the app sent it: anything with a plain id is kept as it came. */
  function saveEarly(id: string, n: number, answer: unknown) {
    const item = getItem(id);
    if (!item) throw new Error('No such item');
    if (readWithdrawn(item)) throw new Error('Its agent cancelled this.');
    const v = currentVersion(item);
    if (v.n !== n) throw new Error('A newer version arrived.');
    if (!answer || typeof answer !== 'object' || !('id' in answer) || typeof answer.id !== 'string' || !/^[\w-]+$/.test(answer.id)) throw new Error('Bad answer');
    const aid = answer.id;
    const q = readQuestions(item, v).find((x) => x.id === aid);
    if (!q?.opens) return false;
    fs.mkdirSync(vfile(item, n, 'early'), { recursive: true });
    writeJson(path.join(vfile(item, n, 'early'), `${aid}.json`), { ...answer, at: now() });
    return true;
  }

  /** Early answers no agent has seen yet. */
  function unreportedEarly(item: StoredItem, n: number) {
    const d = vfile(item, n, 'early');
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.json') && !f.endsWith('.reported.json'))
        .filter((f) => !fs.existsSync(path.join(d, f.replace(/\.json$/, '.reported.json'))))
        .map((f) => readJson(path.join(d, f)) as EarlyAnswer | null).filter((a) => !!a);
    } catch { return []; }
  }

  function markEarlyReported(item: StoredItem, n: number, ids: string[]) {
    for (const id of ids) writeJson(path.join(vfile(item, n, 'early'), `${id}.reported.json`), { at: now() });
  }

  const readDraft = (item: StoredItem, n: number) => readJson(vfile(item, n, 'draft.json')) as Draft | null;

  /** Add drafted follow-ups to the current round's draft, replacing any with the same id. */
  function saveDraft(id: string, questions: Question[]) {
    const item = getItem(id);
    if (!item) throw new Error(`No item ${id}`);
    const n = currentVersion(item).n;
    const draft = readDraft(item, n) || { questions: [] };
    for (const q of questions) {
      const i = draft.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) draft.questions[i] = q; else draft.questions.push(q);
    }
    writeJson(vfile(item, n, 'draft.json'), draft);
    return { n, count: draft.questions.length };
  }

  // ---- The queue in review order, and what the empty queue shows.

  /** The next colour in turn after the newest item's, skipping every colour an item still waiting has. */
  function freeHue(id: string): Hue {
    const others = [...allQueued(), ...allDone()].filter((it) => it.id !== id && it.hue);
    const waiting = new Set(others.filter((it) => isQueued(it) && !readDecision(it, currentVersion(it).n)).map((it) => it.hue));
    const newest = others.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.hue;
    const turn = HUES.map((_, i) => HUES[((newest ? HUES.indexOf(newest) + 1 : 0) + i) % HUES.length]);
    return turn.find((h) => !waiting.has(h)) ?? turn[0];
  }

  /** An item's colour. One sent before items had colours is given its colour the first time it is asked for. */
  function hueOf(item: StoredItem): Hue {
    if (!item.hue) {
      item.hue = freeHue(item.id);
      writeJson(path.join(item.dir, 'item.json'), item);
    }
    return item.hue;
  }

  function pending() {
    const rows = allQueued().filter((it) => !readDecision(it, currentVersion(it).n) && !readWithdrawn(it)).map((it) => {
      const v = currentVersion(it);
      const lat = readJson(ifile(it, 'later.json')) as { at: string } | null;
      const w = waiter(it);
      // 0: a next round or revision; 1: a live session is waiting; 2: everything else; 3: put off with Later.
      const rank = lat ? 3 : v.n > 1 ? 0 : w ? 1 : 2;
      return { item: it, v, rank, waiting: !!w, at: lat ? lat.at : v.createdAt };
    });
    rows.sort((a, b) => a.rank - b.rank || a.at.localeCompare(b.at));
    return rows;
  }

  /**
   * Interviews whose answers an agent has received and whose next round it is presumably writing: the answers
   * were delivered in the last 15 minutes, no newer round has arrived, and that session has not ended its turn
   * since (the Stop hook marks that with stopped.json). `all`: every item, and `live`: liveSessions(), when the
   * caller has them already.
   */
  function writing(all = [...allQueued(), ...allDone()], live = liveSessions()) {
    const out: { id: string; title: string; next: number; sessionId?: string }[] = [];
    const t = Date.now();
    for (const it of all) {
      const v = currentVersion(it);
      if (v.bodyType !== 'questions' || readDecision(it, v.n)?.decision !== 'answer' || readWithdrawn(it)) continue;
      const del = readDelivered(it, v.n);
      if (!del || t - Date.parse(del.at) > 15 * 60 * 1000) continue;
      if (fs.existsSync(vfile(it, v.n, 'stopped.json'))) continue;
      const sessionId = readSession(it)?.sessionId;
      if (stillBusy(live, sessionId) === false) continue; // interrupted, cleared or closed: nobody is writing it
      out.push({ id: it.id, title: v.title || it.title, next: v.n + 1, sessionId });
    }
    return out;
  }

  /** The session ended its turn: whatever it was writing, it is not writing any more. */
  function markStopped(sessionId: string | undefined) {
    if (!sessionId) return;
    for (const w of writing()) {
      if (w.sessionId !== sessionId) continue;
      const item = getItem(w.id);
      if (item) writeJson(vfile(item, currentVersion(item).n, 'stopped.json'), { at: now() });
    }
  }

  // ---- Sessions at work. The hooks note when a session starts on a prompt (working) and when its turn ends
  // (idle), so an empty queue can show which agents are busy and where.

  const validSession = (s: unknown): s is string => typeof s === 'string' && /^[\w-]+$/.test(s);

  /**
   * Note where a session stands. `turn` describes the turn that starts or ends here: { human } says whether
   * your prompt started it (a turn that starts without one, a wake-up, inherits human: false from the last
   * stop), and { reminded } whether it has had the decision reminder (hooks/remind.ts). `heard` is the `bring`
   * setting the session was last told (hooks/catchup.ts), so a change can be told to it once.
   */
  function touchSession(sessionId: string | undefined, cwd: string | undefined, state: SessionRecord['state'],
    { transcript, turn, heard }: { transcript?: string; turn?: SessionRecord['turn']; heard?: Config['bring'] } = {}) {
    if (!validSession(sessionId)) return;
    fs.mkdirSync(SESSIONS, { recursive: true });
    const file = path.join(SESSIONS, `${sessionId}.json`);
    const prev = readJson(file, {}) as Partial<SessionRecord>;
    const at = now();
    writeJson(file, {
      ...prev,
      sessionId, cwd: cwd || prev.cwd, repo: path.basename(cwd || prev.cwd || ''), state, at,
      since: state === 'working' && prev.state === 'working' ? prev.since : at,
      transcript: transcript || prev.transcript,
      turn: turn ? { ...prev.turn, ...turn } : prev.turn,
      heard: heard || prev.heard,
    });
  }

  /** A session's record, as touchSession left it. */
  const sessionRecord = (sessionId: unknown) => (validSession(sessionId) ? readJson(path.join(SESSIONS, `${sessionId}.json`)) as SessionRecord | null : null);

  /**
   * A session's name in a few words: the title Claude Code gives it (what /resume lists), or the one set with
   * /rename. Claude Code appends it to the transcript every turn, so the end of the file usually has it; the
   * whole file is read once at most. Cached until the transcript changes.
   */
  const titles = new Map<string, { mtime: number; title: string | null; full: boolean }>();
  function sessionTitle(transcript: string | undefined): string | null {
    if (!transcript) return null;
    let st;
    try { st = fs.statSync(transcript); } catch { return null; }
    const hit = titles.get(transcript);
    if (hit && hit.mtime === st.mtimeMs) return hit.title;
    const find = (text: string): string | null => {
      const custom = [...text.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)].pop();
      const ai = custom ? null : [...text.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)].pop();
      const m = custom || ai;
      try { return m ? JSON.parse(`"${m[1]}"`) : null; } catch { return null; }
    };
    let title = null;
    let full = hit?.full ?? false;
    try {
      const size = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(transcript, 'r');
      try { fs.readSync(fd, buf, 0, size, st.size - size); } finally { fs.closeSync(fd); }
      title = find(buf.toString('utf8'));
      if (!title && !hit?.title && !full && st.size > size) { title = find(fs.readFileSync(transcript, 'utf8')); full = true; }
    } catch { /* unreadable: keep what we had */ }
    title = title || hit?.title || null;
    titles.set(transcript, { mtime: st.mtimeMs, title, full });
    return title;
  }

  /**
   * Whether a session is still in its turn, by Claude Code's own account: its process is alive, still on this
   * session (a /clear moves it to a new one), and not idle. The hooks alone cannot tell, because an interrupted
   * turn or a closed terminal never reaches the Stop hook. Undefined when Claude Code's list is not there to ask.
   */
  const stillBusy = (live: Map<string, string> | null, sessionId: string | undefined) => (live ? !!sessionId && live.has(sessionId) && live.get(sessionId) !== 'idle' : undefined);

  /**
   * Sessions working right now: marked working by the hooks and still busy in Claude Code. Without Claude Code's
   * list, busy within the last 45 minutes stands in. Day-old records go.
   */
  function activeSessions(live = liveSessions()) {
    const t = Date.now();
    let files: string[] = [];
    try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: (SessionRecord & { title: string | null })[] = [];
    for (const f of files) {
      const s = readJson(path.join(SESSIONS, f)) as SessionRecord | null;
      if (!s) continue;
      const age = t - Date.parse(s.at);
      if (age > 24 * 3600 * 1000) { fs.rmSync(path.join(SESSIONS, f), { force: true }); continue; }
      if (s.state === 'working' && (stillBusy(live, s.sessionId) ?? age < 45 * 60 * 1000)) out.push({ ...s, title: sessionTitle(s.transcript) });
    }
    return out.sort((a, b) => b.since.localeCompare(a.since)); // newest first: a session that just started is on top
  }

  /** Claude Code's running sessions and their status (claudeSessions), read once for a caller that asks twice. */
  const liveSessions = () => claudeSessions(claudeDir);
  /** The session a Claude Code process is on now, or null if it is not one (or not alive). */
  const claudeSession = (pid: number) => claudeSessionOf(claudeDir, pid);

  // ---- What went wrong in hooks. A hook never stops a session to say so, so it is written down here instead,
  // one line each, and Settings counts the last day's.

  function logHookError(hook: string, e: unknown) {
    try {
      fs.mkdirSync(root, { recursive: true });
      const st = fs.statSync(HOOK_LOG, { throwIfNoEntry: false });
      if (st && st.size > 256 * 1024) fs.renameSync(HOOK_LOG, `${HOOK_LOG}.old`);
      const msg = (e instanceof Error ? e.stack || e.message : String(e)).split('\n').slice(0, 4).join(' | ');
      fs.appendFileSync(HOOK_LOG, `${now()} ${hook} ${msg}\n`);
    } catch { /* nowhere to write: nothing more to do */ }
  }
  /** The hook errors of the last day: how many, and the latest line. */
  function hookErrors(since = Date.now() - 24 * 3600 * 1000) {
    let lines: string[] = [];
    try { lines = fs.readFileSync(HOOK_LOG, 'utf8').split('\n').filter(Boolean); } catch { return { count: 0, last: null }; }
    const recent = lines.filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) >= since);
    return { count: recent.length, last: recent.at(-1) ?? null };
  }

  /** Where lib/worktree.ts keeps a session's working-tree record. */
  const sessionsDir = () => SESSIONS;

  return {
    ROOT: root, readConfig, writeConfig, ensureDirs,
    getItem, allQueued, allDone, isQueued, currentVersion, versionOf, readDecision, isDelivered, readBody,
    readQuestions, readFindings, attachments, readAttachment, readReplies, send, decide, later,
    readWithdrawn, withdraw, withdrawnSince,
    claimDelivery, fileAway, readSession, writeSession, readWaiter, writeWaiter, clearWaiter, waiter, undelivered,
    beat, ownerGone, isConfirmed, confirmDelivery, claimRedelivery, unconfirmed,
    saveEarly, unreportedEarly, markEarlyReported, readDraft, saveDraft,
    pending, hueOf, writing, markStopped,
    validSession, touchSession, sessionRecord, activeSessions, liveSessions, claudeSession, sessionsDir,
    logHookError, hookErrors,
  };
}

const store = openStore();
export default store;

/** Who reviews, as agents are told: BATESON_REVIEWER, else the name in settings, else "the user". */
export function reviewer() {
  return process.env.BATESON_REVIEWER || store.readConfig().name || 'the user';
}

/** The same, to start a sentence with. */
export function Reviewer() {
  const r = reviewer();
  return r[0].toUpperCase() + r.slice(1);
}
export const {
  ROOT, readConfig, writeConfig, ensureDirs,
  getItem, allQueued, allDone, isQueued, currentVersion, versionOf, readDecision, isDelivered, readBody,
  readQuestions, readFindings, attachments, readAttachment, readReplies, send, decide, later,
  readWithdrawn, withdraw, withdrawnSince,
  claimDelivery, fileAway, readSession, writeSession, readWaiter, writeWaiter, clearWaiter, waiter, undelivered,
  beat, ownerGone, isConfirmed, confirmDelivery, claimRedelivery, unconfirmed,
  saveEarly, unreportedEarly, markEarlyReported, readDraft, saveDraft,
  pending, hueOf, writing, markStopped,
  validSession, touchSession, sessionRecord, activeSessions, liveSessions, claudeSession, sessionsDir,
  logHookError, hookErrors,
} = store;
