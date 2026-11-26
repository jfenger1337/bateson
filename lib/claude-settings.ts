// bateson's hooks in Claude Code's ~/.claude/settings.json: whether they are all there, and writing them in or
// out. The installer (scripts/install.ts) and the app's Settings (server/server.ts) both go through here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** settings.json is the user's own file, edited by hand and by other tools: nothing in it is taken on trust. */
type Loose = { [key: string]: unknown };
interface Hook { type: 'command'; command: string; [option: string]: unknown }
interface Entry { matcher?: string; hooks: Hook[] }

const WIN = process.platform === 'win32';
/**
 * A path as it goes into a command line. On Windows with forward slashes: Claude Code runs hooks through Git Bash
 * there, which reads a backslash in quotes as an escape, and Node, git and cmd.exe all take forward slashes.
 */
export const commandPath = (p: string) => (WIN ? p.replaceAll('\\', '/') : p);

const HOOKS = commandPath(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'hooks'));
export const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = '_bateson';

/**
 * The path to this Node that survives an upgrade. process.execPath is the binary itself, and on a Mac with
 * Homebrew that is inside a folder named for its version, which `brew upgrade` deletes: every hook would then
 * fail without a word. A link to the same binary on PATH, or in Homebrew's bin, stays put. Without one, the
 * binary's own path.
 */
export function stableNode(exec = process.execPath, dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
  let real: string;
  try { real = fs.realpathSync(exec); } catch { return exec; }
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, WIN ? 'node.exe' : 'node');
    if (p === real) continue;
    try { if (fs.realpathSync(p) === real) return p; } catch { /* none here */ }
  }
  return exec;
}

/**
 * This Node, quoted, as a hook's command starts. Worked out when a hook's command is first needed (the installer,
 * Settings) and not when this file is loaded: every hook and every `bateson` command loads it, and looking for this
 * Node in each folder on PATH is a file lookup per folder and more, on every tool call.
 */
let node: string | undefined;
const NODE = () => (node ??= `"${commandPath(stableNode())}" `);
/** The Node a hook command runs with: the quoted path it starts with. */
const nodeOf = (command: string) => /^"([^"]+)"/.exec(command)?.[1] ?? null;

/**
 * How long Claude Code lets the rewake hook wait, in seconds. The hook renews itself a little before this runs
 * out (hooks/rewake.ts), so a wait is not cut off at four hours while the session that asked is still open.
 */
export const REWAKE_TIMEOUT_S = 14400;

const hook = (file: string, extra: Loose = {}): Hook => ({ type: 'command', command: `${NODE()}"${HOOKS}/${file}"`, ...extra });
let built: Record<string, Entry | Entry[]> | undefined;
const ENTRIES = () => (built ??= {
  PreToolUse: { matcher: 'AskUserQuestion', hooks: [hook('ask.mjs', { timeout: 30 })] },
  PostToolUse: [
    { matcher: 'Bash', hooks: [hook('rewake.mjs', { asyncRewake: true, timeout: REWAKE_TIMEOUT_S, rewakeSummary: 'bateson: a response arrived, or a wait was renewed', rewakeMessage: 'From bateson' })] },
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [hook('remind.mjs', { timeout: 10 })] },
  ],
  UserPromptSubmit: { hooks: [hook('catchup.mjs', { timeout: 10 })] },
  SessionStart: { hooks: [hook('catchup.mjs', { timeout: 10 })] },
  Stop: { hooks: [hook('nudge.mjs', { timeout: 10 })] },
});

const commandsOf = (e: unknown) => {
  const hooks = (e as Loose | null | undefined)?.hooks;
  return Array.isArray(hooks) ? hooks.map((h) => String((h as Loose | null | undefined)?.command || '')) : [];
};

/** settings.json as it is on disk: its text, and the object (`{}` for a missing or empty file). Throws if it is not JSON. */
function read(file: string): { raw: string; settings: unknown } {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  try { return { raw, settings: raw.trim() ? JSON.parse(raw) : {} }; } catch (e) {
    throw Object.assign(new Error(`${file} is not valid JSON (${(e as Error).message})`), { code: 'invalid' });
  }
}

/**
 * The events whose bateson hook is not in settings.json, pointing at this repository's hooks with a Node that
 * is still there. Which Node it is does not matter (an install from another Node version still counts), only
 * that it can run: one removed by an upgrade counts as missing, so Settings offers to reconnect.
 */
export function missingHooks(file = SETTINGS) {
  let settings;
  try { ({ settings } = read(file)); } catch { return Object.keys(ENTRIES()); }
  const hooks = (settings as Loose | null | undefined)?.hooks;
  const there = (hooks && typeof hooks === 'object' ? hooks : {}) as Loose;
  return Object.entries(ENTRIES()).filter(([event, entries]) => {
    const listed = there[event];
    const commands = Array.isArray(listed) ? listed.flatMap(commandsOf) : [];
    const runs = (c: string) => { const node = nodeOf(c); return !node || fs.existsSync(node); };
    // An install from before the launchers ran hooks/<name>.ts itself, which works as well on a Node that can.
    const either = (ours: string) => [ours.slice(NODE().length), ours.slice(NODE().length).replace(/\.mjs"$/, '.ts"')];
    return [entries].flat().flatMap(commandsOf).some((ours) => !commands.some((c) => either(ours).some((o) => c.includes(o)) && runs(c)));
  }).map(([event]) => event);
}

/**
 * Take bateson's hooks out of settings.json and, unless `uninstall`, put the current ones back in. Other hooks
 * are left as they are. A changed file is written whole, after a copy of the old one is kept next to it.
 * Throws (code 'invalid') and changes nothing when the file is not JSON.
 */
export function writeHooks({ file = SETTINGS, uninstall = false } = {}): { changed: boolean; backup: string | null; skipped: string[] } {
  const { raw, settings: read_ } = read(file);
  const settings = (read_ && typeof read_ === 'object' && !Array.isArray(read_) ? read_ : {}) as Loose;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks as Loose;
  for (const event of Object.keys(hooks)) {
    const listed = hooks[event];
    if (!Array.isArray(listed)) continue; // not ours to fix
    // Ours by the mark, or by pointing at this repository's hooks: editing settings elsewhere can drop the mark.
    hooks[event] = listed.filter((x) => {
      const e = x as Loose | null | undefined;
      const its = e?.hooks;
      return !e?.[MARK] && !(Array.isArray(its) && its.length && its.every((h) => String((h as Loose | null | undefined)?.command || '').includes(HOOKS + '/')));
    });
    if (!(hooks[event] as unknown[]).length) delete hooks[event];
  }
  const skipped: string[] = [];
  if (!uninstall) {
    for (const [event, entry] of Object.entries(ENTRIES())) {
      if (hooks[event] != null && !Array.isArray(hooks[event])) { skipped.push(event); continue; }
      for (const e of [entry].flat()) ((hooks[event] ??= []) as unknown[]).push({ ...e, [MARK]: true });
    }
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  // Written back in the file's own indent and line ending, so an install then an uninstall leaves it as it was.
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? (raw.trim() && !raw.trim().includes('\n') ? 0 : 2);
  let next = JSON.stringify(settings, null, indent) + (raw && !raw.endsWith('\n') ? '' : '\n');
  // A backup with exactly these settings is the file from before bateson, layout and all: put that text back.
  if (uninstall) {
    const same = JSON.stringify(settings);
    const dir = path.dirname(file), prefix = `${path.basename(file)}.bak-bateson-`;
    for (const name of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => n.startsWith(prefix)).sort()) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      try { if (JSON.stringify(text.trim() ? JSON.parse(text) : {}) === same) { next = text; break; } } catch { /* not JSON */ }
    }
  }
  if (next === raw) return { changed: false, backup: null, skipped };
  let backup: string | null = `${file}.bak-bateson-${Date.now()}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup); else backup = null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Through a link (dotfiles kept elsewhere), the file it points to is the one changed, and the link stays; and the
  // file keeps who may read it, since settings can hold tokens.
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* not there yet */ }
  const mode = fs.statSync(target, { throwIfNoEntry: false })?.mode;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, mode === undefined ? undefined : { mode: mode & 0o777 });
  if (mode !== undefined) fs.chmodSync(tmp, mode & 0o777);
  fs.renameSync(tmp, target); // never a half-written settings file
  return { changed: true, backup, skipped };
}
