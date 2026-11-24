// Updating bateson from the app. bateson runs from its git checkout (the skills are links into it, the hooks and
// the command run from it), so an update is: fetch, fast-forward, install what changed, build, run the installer,
// and let the server quit so whatever keeps it running (launchd on a Mac, scripts/keepalive.ts on Windows) starts
// the new one (or, under `bateson serve`, the command does). A server nothing restarts says so, and the page's
// Restart starts its replacement. A checkout with changes or commits of its own is never touched. A failed update goes back to the
// commit it started from. What happened is kept in ~/.bateson/update.json, so the page can say it after a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from './store.ts';
import type { UpdateView } from './types.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
/** Linux inside WSL, where Windows starts the server at login as on native Windows (scripts/install.ts). */
export const WSL = process.platform === 'linux' && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()));
const DAY = 24 * 3600 * 1000;
const MAX_CHANGES = 30;
const MAC_APP = path.join(os.homedir(), 'Applications', 'bateson.app');
// What goes into the Mac app (mac/build.sh): an update that changes any of it rebuilds the app.
const MAC_APP_FILES = ['web/public/waiting.html', 'web/public/fonts/schibstedgrotesk-normal.woff2', 'web/public/fonts/LICENSE-SchibstedGrotesk.txt'];
const inMacApp = (f: string) => f.startsWith('mac/') || MAC_APP_FILES.includes(f);

/** Runs a command in the checkout; resolves with its output, or rejects with it on `output`. */
export type Run = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<string>;

/** The exit code that asks for the server to be started again. `bateson serve` restarts only on this one. */
export const RESTART = 75;

const NONE: UpdateView = { state: 'current', changes: [], more: 0 };
const home = (p: string) => p.replace(os.homedir(), '~');

export function readUpdate(file = path.join(store.ROOT, 'update.json')): UpdateView {
  try { return { ...NONE, ...JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateView }; } catch { return NONE; }
}

/** Whether a check is due: on, and none in the last day. */
export function due(v: UpdateView, now = Date.now()) {
  return !v.checkedAt || now - Date.parse(v.checkedAt) > DAY - 3600 * 1000;
}

/**
 * Commands in `cwd`, with this Node's folder first on PATH: launchd starts the server with a bare PATH, and npm
 * lives next to node. Git never stops to ask for a password.
 */
export function runner(cwd: string): Run {
  return (cmd, args, { timeout = 10 * 60_000 } = {}) => new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter), GIT_TERMINAL_PROMPT: '0' };
    // npm is npm.cmd on Windows, which Node only starts through a shell.
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: WIN && cmd === 'npm' });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(e, { output: out })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} stopped with code ${code}`), { output: out }));
    });
  });
}

/**
 * Whether something starts the server again when it quits. `bateson serve` does; on a Mac launchd is its parent (the
 * login item has KeepAlive); on Windows and in WSL scripts/keepalive.ts is, and its pid is in server.pid. Started some other way
 * (npm start), nothing is.
 */
export function supervised() {
  // `bateson serve` names itself, so a server it did not start (its child's child) does not count on it.
  if (process.env.BATESON_SERVE_PID && process.env.BATESON_SERVE_PID === String(process.ppid)) return true;
  if (process.platform === 'darwin') return process.ppid === 1 || (process.env.XPC_SERVICE_NAME || '').includes('com.bateson.server');
  if (WIN || WSL) { try { return fs.readFileSync(path.join(store.ROOT, 'server.pid'), 'utf8').trim() === String(process.ppid); } catch { return false; } }
  return false;
}

/**
 * The oldest Node a version of bateson runs on, from its package.json's engines.node, as [major, minor, patch]: null
 * when it names none, or in another form than ">=x.y.z" (a range this does not read is no reason to stop an update).
 */
export function needsNode(pkg: string): number[] | null {
  let range: unknown;
  try { range = (JSON.parse(pkg) as { engines?: { node?: unknown } })?.engines?.node; } catch { return null; }
  const m = typeof range === 'string' ? /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range) : null;
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}
const older = (a: number[], b: number[]) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]);
/** 24, 22.18 or 22.18.1, as people write a Node version. */
const version = (v: number[]) => (v[2] ? v.join('.') : v[1] ? `${v[0]}.${v[1]}` : String(v[0]));

/**
 * For a server nothing restarts: start the new one on its own, in the background with its output in server.log. It
 * waits for this one to quit and free the port (server/server.ts reads BATESON_REPLACES).
 */
export function relaunch(repo = REPO) {
  fs.mkdirSync(store.ROOT, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(store.ROOT, 'server.log'), 'a');
  spawn(process.execPath, [path.join(repo, 'server', 'server.mjs')], {
    cwd: repo, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, BATESON_REPLACES: String(process.pid), BATESON_SERVE_PID: '' },
  }).unref();
  fs.closeSync(log);
}

/** The last lines a failed command printed, for the page. */
function tail(e: unknown) {
  const out = String((e as { output?: string }).output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = out.slice(-3).join(' ') || (e as Error).message || String(e);
  return last.length > 300 ? `...${last.slice(-297)}` : last;
}

export function openUpdater({
  repo = REPO, file = path.join(store.ROOT, 'update.json'), run = runner(repo), restartable = supervised,
  exit = () => process.exit(RESTART), replace = () => relaunch(repo), onChange = () => {}, macApp = MAC_APP, node = process.versions.node,
}: { repo?: string; file?: string; run?: Run; restartable?: () => boolean; exit?: () => void; replace?: () => void; onChange?: () => void; macApp?: string; node?: string } = {}) {
  let busy = false;
  const read = () => readUpdate(file);
  function save(v: UpdateView) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
    fs.renameSync(tmp, file);
    onChange();
    return v;
  }
  const git = async (...args: string[]) => (await run('git', args)).trim();
  const where = home(repo);

  /** Fetch, and say whether there is a new version and whether it can be installed from here. */
  async function check(): Promise<UpdateView> {
    if (busy) return read();
    busy = true;
    try { return save(await look()); } finally { busy = false; }
  }

  async function look(): Promise<UpdateView> {
    const prev = read();
    const kept = { updatedAt: prev.updatedAt, note: prev.note };
    const checkedAt = new Date().toISOString();
    let upstream: string;
    try { upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); } catch {
      return { ...NONE, ...kept, checkedAt, state: 'blocked', reason: `${where} does not follow a branch on GitHub, so bateson cannot update it. Update it there by hand with git.` };
    }
    try { await run('git', ['fetch', '--quiet', upstream.split('/')[0]], { timeout: 60_000 }); } catch {
      return { ...prev, checkedAt, error: 'GitHub could not be reached. bateson tries again tomorrow.' };
    }
    // Installed, but this server is still the old one: a check keeps saying so until it is restarted (recover()
    // clears it when the new one starts).
    if (!Number(await git('rev-list', '--count', 'HEAD..@{u}'))) return prev.state === 'restart' ? { ...prev, checkedAt } : { ...NONE, ...kept, checkedAt };
    // The changes are said by what they do: a merge says only which branch came in, so merges are left out.
    const behind = (await git('log', '--no-merges', '--format=%h%x09%s', 'HEAD..@{u}')).split('\n').filter(Boolean)
      .map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; });
    const changes = behind.slice(0, MAX_CHANGES);
    const more = behind.length - changes.length;
    const ahead = Number(await git('rev-list', '--count', '@{u}..HEAD'));
    // Porcelain lines are "XY path": not trimmed, or the first loses a column. An npm install that rewrote the
    // lockfile is not a change of yours; the update puts it back.
    const changed = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean)
      .map((l) => l.slice(3)).filter((f) => f !== 'package-lock.json');
    // A new version that needs a newer Node than the one bateson runs on would install, then fail to start (the
    // server, the hooks and the command all run on it): say so now, and touch nothing.
    const need = needsNode(await git('show', '@{u}:package.json').catch(() => ''));
    const blocked = ahead
      ? `${where} has ${ahead === 1 ? 'a commit' : `${ahead} commits`} of your own, so bateson leaves it alone. Merge the new version there with git pull.`
      : changed.length ? `You have changed ${changed.length === 1 ? 'a file' : `${changed.length} files`} in ${where} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}), so bateson leaves it alone. Commit or undo ${changed.length === 1 ? 'it' : 'them'}, then check again.`
        : need && older(node.split('.').map(Number), need) ? `The new version needs Node ${version(need)} or newer, and bateson runs on Node ${node} (${home(process.execPath)}). Install a newer Node, run node ${path.join(repo, 'scripts', 'install.mjs')} --login with it, then check again.`
          : '';
    return { ...kept, checkedAt, changes, more, state: blocked ? 'blocked' : 'available', ...(blocked ? { reason: blocked } : {}) };
  }

  /** Install the new version. Resolves once it is in place (or undone); the server quits right after. */
  async function apply(): Promise<UpdateView> {
    if (busy) return read();
    busy = true;
    let v: UpdateView = read();
    const step = (s: string) => save({ ...v, state: 'updating', step: s, reason: undefined, error: undefined });
    try {
      v = save(await look());
      if (v.state !== 'available') return v;
      const old = await git('rev-parse', 'HEAD');
      const files = (await git('diff', '--name-only', 'HEAD', '@{u}')).split('\n');
      const deps = files.some((f) => f === 'package.json' || f === 'package-lock.json');
      step('Getting the new version');
      await run('git', ['checkout', '--', 'package-lock.json']).catch(() => {});
      await git('merge', '--ff-only', '--quiet', '@{u}');
      try {
        if (deps) { step('Installing what it needs'); await run('npm', ['ci', '--no-audit', '--no-fund']); }
        step('Building'); await run('npm', ['run', 'build']);
        // --updating: the installer leaves the server to quit by itself (below); restarting it from here would stop this.
        step('Setting it up'); await run(process.execPath, [path.join(repo, 'scripts', 'install.ts'), '--updating']);
      } catch (e) {
        step('Going back to the version you had');
        try {
          await git('reset', '--keep', old);
          if (deps) await run('npm', ['ci', '--no-audit', '--no-fund']);
          await run('npm', ['run', 'build']);
          // The new installer may have got as far as changing the hooks: the old one puts its own back.
          await run(process.execPath, [path.join(repo, 'scripts', 'install.ts'), '--updating']);
        } catch { /* best effort: the old code is still what is running */ }
        return save({ ...v, state: 'failed', step: undefined, reason: `The update did not go through, so bateson went back to the version you had. ${tail(e)}` });
      }
      let note: string | undefined;
      // The Mac window is its own small app, rebuilt only when it changed and only if it is installed.
      if (process.platform === 'darwin' && files.some(inMacApp) && fs.existsSync(macApp)) {
        step('Rebuilding the Mac app');
        try { await run('bash', [path.join(repo, 'mac', 'build.sh'), '--install']); await run('open', [macApp]); }
        catch { note = `The Mac app could not be rebuilt. Run mac/build.sh --install in ${where}.`; }
      }
      const updatedAt = new Date().toISOString();
      if (!restartable()) return save({ ...NONE, checkedAt: v.checkedAt, updatedAt, note, state: 'restart', reason: 'The server running now is still the old one: restart it to finish.' });
      save({ ...NONE, checkedAt: v.checkedAt, updatedAt, note });
      setTimeout(exit, 300); // after the response, so the page hears it went through
      return read();
    } catch (e) {
      return save({ ...v, state: 'failed', step: undefined, reason: `The update did not start. ${tail(e)}` });
    } finally { busy = false; }
  }

  /**
   * Quit, for the new version to start: whatever keeps the server running starts it again, and when nothing does,
   * its replacement is started first. Not while an update is under way.
   */
  function restart() {
    if (busy) return false;
    busy = true;
    if (!restartable()) replace();
    setTimeout(exit, 300); // after the response
    return true;
  }

  /** At start: an update the last server never finished (it was stopped partway) is said as failed. */
  function recover() {
    const v = read();
    // Waiting for a restart, and this is it: done.
    if (v.state === 'restart') { save({ ...v, state: 'current', reason: undefined }); return; }
    if (v.state === 'updating') save({ ...v, state: 'failed', step: undefined, reason: `The update stopped partway, when bateson was closed. Check ${where} with git status, then update again.` });
  }

  return { read, check, apply, restart, recover };
}
