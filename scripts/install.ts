#!/usr/bin/env node
// Wire bateson into every Claude Code session on this machine (macOS, Windows or WSL): the CLI on PATH, the global
// skill, the hooks in ~/.claude/settings.json, and (with --login) the server at login. Idempotent. What it set up
// is noted in ~/.bateson/install.json, and --uninstall undoes exactly that. --only <agent> limits it to one agent.
// --launchd is the old name of --login and still works.
// Run it as scripts/install.mjs, which first checks that this Node can run it at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SETTINGS, writeHooks, stableNode, commandPath } from '../lib/claude-settings.ts';
import { AGENTS } from '../lib/agent.ts';
import { WSL } from '../lib/update.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
// A path to this Node that a Homebrew upgrade does not delete, for the login item (the hooks use the same).
const NODE = stableNode();
const WIN = process.platform === 'win32';
const BIN_DIR = path.join(HOME, '.local', 'bin');
const BIN = path.join(BIN_DIR, 'bateson');
const SKILL = path.join(HOME, '.claude', 'skills', 'bateson');
const SETUP = path.join(HOME, '.claude', 'skills', 'setup-bateson');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.bateson.server.plist');
// Windows has no launchd: a value in the user's Run key starts scripts/keepalive.mjs at login, which keeps the
// server running. conhost --headless runs it without a console window.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'bateson';
const WIN_LOGIN = `${RUN_KEY}\\${RUN_VALUE}`;
// In WSL the same Run key starts keepalive.mjs inside this distribution through wsl.exe, which keeps the
// distribution running while the server does. Its own value, so it never clashes with a native Windows install.
const WSL_VALUE = 'bateson-wsl';
const WSL_LOGIN = `${RUN_KEY}\\${WSL_VALUE}`;
const REG = fs.existsSync('/mnt/c/Windows/System32/reg.exe') ? '/mnt/c/Windows/System32/reg.exe' : 'reg.exe';
// The queue and the port this install is for. A server started at login has none of your shell's variables, so
// BATESON_HOME and BATESON_PORT, when set, are handed to it (launchd's plist, keepalive.ts's arguments).
const ROOT = path.resolve(process.env.BATESON_HOME || path.join(HOME, '.bateson'));
const PORT = Number.isInteger(Number(process.env.BATESON_PORT)) && Number(process.env.BATESON_PORT) > 0 ? String(Number(process.env.BATESON_PORT)) : '4848';
const SERVER_ENV: Record<string, string> = {
  ...(process.env.BATESON_HOME ? { BATESON_HOME: ROOT } : {}),
  ...(process.env.BATESON_PORT ? { BATESON_PORT: PORT } : {}),
};

const argv = process.argv.slice(2);
const args = new Set(argv);
const uninstall = args.has('--uninstall');
const login = args.has('--login') || args.has('--launchd');
// What an install set up, so that a later uninstall removes that and nothing else, whatever this file says by then.
const MANIFEST = path.join(ROOT, 'install.json');
interface Manifest { at: string; repo: string; node: string; agents: string[]; settings: string[]; madeSettings?: boolean; links: string[]; shims?: string[]; loginItem: string | null }
let installed: Partial<Manifest> | null = null;
try { installed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Partial<Manifest>; } catch { /* an install from before the note, or none */ }

// Every agent bateson is wired into is set up, unless --only names one.
const only = args.has('--only') ? argv[argv.indexOf('--only') + 1] : null;
if (args.has('--only') && !(only && only in AGENTS)) {
  console.error(`bateson: --only takes one of: ${Object.keys(AGENTS).join(', ')}.`);
  process.exit(1);
}

function log(s: string) { console.log(`  ${s}`); }

const AMA = path.join(HOME, '.claude', 'skills', 'ama');
const links = [
  // On Windows the command is a pair of small scripts instead (below): a link to a .ts file does not run there.
  ...(WIN ? [] : [[BIN, path.join(REPO, 'cli', 'bateson.mjs')]]),
  [SKILL, path.join(REPO, 'skill', 'bateson')],
  [SETUP, path.join(REPO, 'skill', 'setup-bateson')],
  [AMA, path.join(REPO, 'skill', 'ama')],
];
// Checked before anything is touched, so a folder in the way never leaves half an install behind.
if (!uninstall) for (const [link] of links) {
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    console.error(`bateson: ${link.replace(HOME, '~')} exists and is not a link. Move it away, then run this again; nothing was changed.`);
    process.exit(1);
  }
}
if (!uninstall && WIN) for (const file of [BIN, `${BIN}.cmd`]) {
  if (fs.existsSync(file) && !isShim(file)) {
    console.error(`bateson: ${file.replace(HOME, '~')} exists and is not bateson's. Move it away, then run this again; nothing was changed.`);
    process.exit(1);
  }
}

// ---- settings.json hooks
const madeSettings = installed?.madeSettings ?? !fs.existsSync(SETTINGS);
let hooks;
try { hooks = writeHooks({ uninstall }); } catch (e) {
  const { code, message } = e as NodeJS.ErrnoException;
  if (code !== 'invalid') throw e;
  console.error(`bateson: ${message}. Fix it, then run this again; nothing was changed.`);
  process.exit(1);
}
for (const event of hooks.skipped) log(`skipped ${event}: its entry in settings.json is not a list`);
if (hooks.changed) log(`${uninstall ? 'removed' : 'added'} hooks in ${SETTINGS}${hooks.backup ? ` (backup: ${path.basename(hooks.backup)})` : ''}`);
else log('hooks already up to date');
if (uninstall && installed?.madeSettings) {
  let empty = false;
  try { empty = JSON.stringify(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))) === '{}'; } catch { /* gone, or not ours to judge */ }
  if (empty) { fs.rmSync(SETTINGS); log(`removed ${SETTINGS}, which the install had made`); }
}

// ---- CLI and skills.
// `grilling` is the skill Matt Pocock's skills (grill-me, improve-codebase-architecture, ...) call to interview.
// Only someone who already has one gets ours: theirs moves to ~/.claude/skills-backup, and two lines that load
// `ama` take its place, so those interviews come through bateson. Uninstall puts theirs back.
const GRILLING = path.join(HOME, '.claude', 'skills', 'grilling');
const BACKUP = path.join(HOME, '.claude', 'skills-backup', 'grilling');
// Links an earlier install made at paths this one no longer uses.
if (uninstall) for (const link of installed?.links || []) {
  if (link !== GRILLING && !links.some(([l]) => l === link) && fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) { fs.unlinkSync(link); log(`removed ${link.replace(HOME, '~')}`); }
}
for (const [link, target] of links) {
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) fs.unlinkSync(link);
  if (uninstall) { if (st?.isSymbolicLink()) log(`removed ${link.replace(HOME, '~')}`); }
  else {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    linkFolder(target, link);
    log(`linked ${link.replace(HOME, '~')}`);
  }
}

// ---- the command on Windows: bateson.cmd for cmd and PowerShell, and a shell script for Git Bash, where Claude
// Code runs its commands. Both start the CLI with the same Node as the hooks.
const SHIMS: [string, string][] = WIN ? [
  [`${BIN}.cmd`, `@echo off\r\nrem bateson: the command, made by scripts/install.ts\r\n"${NODE}" "${path.join(REPO, 'cli', 'bateson.mjs')}" %*\r\n`],
  [BIN, `#!/bin/sh\n# bateson: the command, made by scripts/install.ts\nexec "${commandPath(NODE)}" "${commandPath(path.join(REPO, 'cli', 'bateson.mjs'))}" "$@"\n`],
] : [];
for (const [file, text] of [...SHIMS, ...(uninstall && WIN ? (installed?.shims || []).map((f) => [f, ''] as [string, string]) : [])]) {
  const exists = fs.existsSync(file);
  if (exists && !isShim(file)) {
    if (uninstall) continue;
    throw new Error(`${file} exists and is not bateson's; move it away first`);
  }
  if (uninstall) { if (exists) { fs.rmSync(file); log(`removed ${file.replace(HOME, '~')}`); } continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  log(`wrote ${file.replace(HOME, '~')}`);
}
if (WIN && !uninstall && !(process.env.PATH || '').split(path.delimiter).some((d) => d && path.resolve(d).toLowerCase() === BIN_DIR.toLowerCase())) {
  log(`${BIN_DIR.replace(HOME, '~')} is not on your PATH: add it, so that \`bateson\` is found`);
}
{
  // Ours points into this folder, or into the one an earlier install ran from.
  const ours = [REPO, installed?.repo].filter(Boolean).map(r => path.join(r as string, 'skill', 'grilling'));
  const exists = (p: string) => !!fs.lstatSync(p, { throwIfNoEntry: false });
  const isOurs = fs.lstatSync(GRILLING, { throwIfNoEntry: false })?.isSymbolicLink() && ours.includes(linkTarget(GRILLING));
  if (isOurs) fs.unlinkSync(GRILLING);
  if (uninstall) {
    if (isOurs) log(`removed ${GRILLING.replace(HOME, '~')}`);
    if (exists(BACKUP) && !exists(GRILLING)) { fs.renameSync(BACKUP, GRILLING); log('restored your grilling skill'); }
  } else if (isOurs ? exists(BACKUP) : exists(GRILLING)) {
    if (!isOurs) {
      fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
      // A backup from before is kept beside it, never deleted: it may be the only copy of a skill you had.
      if (exists(BACKUP)) {
        const older = `${BACKUP}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(BACKUP, older);
        log(`kept the grilling skill backed up before at ${older.replace(HOME, '~')}`);
      }
      fs.renameSync(GRILLING, BACKUP);
      log(`moved your grilling skill to ${BACKUP.replace(HOME, '~')}`);
    }
    linkFolder(path.join(REPO, 'skill', 'grilling'), GRILLING);
    log(`linked ${GRILLING.replace(HOME, '~')}, so your grill skills interview through bateson`);
  } else if (isOurs) log(`removed ${GRILLING.replace(HOME, '~')}: you have no grilling skill of your own`);
}
// Folders the install made and uninstall emptied. rmdir refuses any that still hold something.
if (uninstall) for (const dir of [path.dirname(BIN), path.dirname(path.dirname(BIN)), path.dirname(SKILL), path.dirname(BACKUP)]) {
  try { fs.rmdirSync(dir); } catch { /* not empty, or not there */ }
}

// ---- your name, as agents say it ("Sam reviews it first"). Only when none is set: the first word of git's
// user.name. Settings changes it; left empty, agents say "the user".
if (!uninstall) {
  const CONFIG = path.join(ROOT, 'config.json');
  let config: { name?: unknown } = {};
  // A settings file that is there but not JSON (a hand edit) is left alone: writing over it would lose every setting in it.
  let readable = !fs.existsSync(CONFIG);
  try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}; readable = true; } catch { /* none yet, or not JSON */ }
  if (readable && !config.name) {
    let gitName = '';
    try { gitName = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim().split(/\s+/)[0] || ''; } catch { /* no git name */ }
    if (gitName) {
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
      fs.writeFileSync(CONFIG, JSON.stringify({ ...config, name: gitName.slice(0, 40) }, null, 2));
      log(`agents will call you ${gitName} (change it in Settings)`);
    }
  }
}

// ---- the server at login
if (WIN) {
  // An update restarts a server an earlier --login set up, with or without --login this time: `bateson` runs
  // from this folder at once, and a server left on the old code disagrees with it.
  const running = fs.existsSync(path.join(ROOT, 'server.pid'));
  // Run from an update in the app (--updating), the server running is the one doing the update: it is left to quit
  // by itself once the update is in, and keepalive.ts starts it again on the new code. Stopping it here would stop
  // the update halfway.
  const updating = args.has('--updating');
  if (login || uninstall || installed?.loginItem || running) {
    if (!updating) stopWindowsServer();
    if (uninstall) {
      try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' }); log('removed the login item'); } catch { /* there was none */ }
    } else {
      const keepalive = path.join(REPO, 'scripts', 'keepalive.mjs');
      const extra = [...(SERVER_ENV.BATESON_HOME ? ['--home', ROOT] : []), ...(SERVER_ENV.BATESON_PORT ? ['--port', PORT] : [])];
      const quoted = extra.map((a) => (a.startsWith('--') ? a : `"${a}"`)).join(' ');
      execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `conhost.exe --headless "${NODE}" "${keepalive}"${quoted ? ` ${quoted}` : ''}`, '/f'], { stdio: 'ignore' });
      if (!updating) spawn(NODE, [keepalive, ...extra], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log(`the server starts at login (${WIN_LOGIN}): http://localhost:${PORT}`);
    }
  }
} else if (WSL) {
  // As on Windows, an update restarts a server an earlier --login set up, and one started by the app's update is
  // left to quit by itself (keepalive.ts starts it again on the new code).
  const running = fs.existsSync(path.join(ROOT, 'server.pid'));
  const updating = args.has('--updating');
  if (login || uninstall || installed?.loginItem || running) {
    if (!updating) stopWindowsServer();
    if (uninstall) {
      try { execFileSync(REG, ['delete', RUN_KEY, '/v', WSL_VALUE, '/f'], { stdio: 'ignore' }); log('removed the login item'); } catch { /* there was none */ }
    } else {
      const keepalive = path.join(REPO, 'scripts', 'keepalive.mjs');
      const extra = [...(SERVER_ENV.BATESON_HOME ? ['--home', ROOT] : []), ...(SERVER_ENV.BATESON_PORT ? ['--port', PORT] : [])];
      const quoted = extra.map((a) => (a.startsWith('--') ? a : `"${a}"`)).join(' ');
      const distro = process.env.WSL_DISTRO_NAME ? `-d "${process.env.WSL_DISTRO_NAME}" ` : '';
      try {
        execFileSync(REG, ['add', RUN_KEY, '/v', WSL_VALUE, '/t', 'REG_SZ', '/d', `conhost.exe --headless wsl.exe ${distro}--exec "${NODE}" "${keepalive}"${quoted ? ` ${quoted}` : ''}`, '/f'], { stdio: 'ignore' });
        log(`the server starts at Windows login (${WSL_LOGIN}): http://localhost:${PORT}`);
      } catch {
        log('could not reach reg.exe from WSL, so the server does not start at login; bateson send starts it when it is down');
      }
      if (!updating) spawn(NODE, [keepalive, ...extra], { cwd: REPO, detached: true, stdio: 'ignore' }).unref();
    }
  }
} else if (process.platform !== 'darwin') {
  // Plain Linux has no login item yet: launchd is a Mac's, and the Run key Windows'.
  if (login) log('there is no login item on Linux yet: start the server with `bateson serve`');
} else if (login || (uninstall && fs.existsSync(PLIST))) {
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (uninstall) {
    fs.rmSync(PLIST, { force: true });
    for (const key of ['port', 'home']) try { execFileSync('defaults', ['delete', 'app.bateson', key], { stdio: 'ignore' }); } catch { /* none saved */ }
    log('removed the login item');
  }
  else {
    const logFile = path.join(ROOT, 'server.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    // Paths go into XML: one with & or < in it (~/Code/R&D) would otherwise make a plist launchd refuses.
    const xml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bateson.server</string>
  <key>ProgramArguments</key><array><string>${xml(NODE)}</string><string>${xml(path.join(REPO, 'server', 'server.mjs'))}</string><string>--login</string></array>
  <key>WorkingDirectory</key><string>${xml(REPO)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>${Object.keys(SERVER_ENV).length ? `
  <key>EnvironmentVariables</key><dict>${Object.entries(SERVER_ENV).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>` : ''}
</dict></plist>
`);
    // The Mac app, opened from Finder, has no BATESON_PORT or BATESON_HOME to go by: the server's port and queue are
    // saved in its defaults, where it looks (mac/Sources/App.swift). Only here, with the plist: they always agree.
    // The queue is where the app reads server.error, why the server cannot start, when it has no server to ask.
    try {
      if (SERVER_ENV.BATESON_PORT) { execFileSync('defaults', ['write', 'app.bateson', 'port', '-int', PORT], { stdio: 'ignore' }); log(`the Mac app looks for the server on port ${PORT}`); }
      else execFileSync('defaults', ['delete', 'app.bateson', 'port'], { stdio: 'ignore' });
    } catch { /* nothing saved to take out */ }
    try {
      if (SERVER_ENV.BATESON_HOME) execFileSync('defaults', ['write', 'app.bateson', 'home', '-string', ROOT], { stdio: 'ignore' });
      else execFileSync('defaults', ['delete', 'app.bateson', 'home'], { stdio: 'ignore' });
    } catch { /* nothing saved to take out */ }
    try { execFileSync('launchctl', ['load', PLIST], { stdio: 'pipe' }); } catch (e) {
      throw new Error(`launchd did not take ${PLIST}, so the server is not running: ${String((e as { stderr?: unknown }).stderr || (e as Error).message).trim()}`);
    }
    log(`the server starts at login: http://localhost:${PORT}`);
  }
} else if (!uninstall && installed?.loginItem && fs.existsSync(PLIST) && !args.has('--updating')) {
  // Installed again by hand (after a git pull, say) without --login: the server launchd keeps running is on the
  // old code, so it is started again, as on Windows. An update from the app quits the server itself instead.
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/com.bateson.server`], { stdio: 'ignore' });
    log('restarted the server, so it runs this version');
  } catch { /* not loaded: it starts at the next login */ }
}

if (uninstall) fs.rmSync(MANIFEST, { force: true });
else {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  const manifest: Manifest = {
    at: new Date().toISOString(), repo: REPO, node: NODE, agents: Object.keys(AGENTS),
    settings: [SETTINGS], madeSettings, links: links.map(([link]) => link), shims: SHIMS.map(([file]) => file),
    loginItem: login || installed?.loginItem ? (WIN ? WIN_LOGIN : WSL ? WSL_LOGIN : process.platform === 'darwin' ? PLIST : null) : null,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

/** One of the two files of the command on Windows, written by an earlier install. */
function isShim(file: string) {
  try { return fs.readFileSync(file, 'utf8').includes('bateson: the command, made by scripts/install.ts'); } catch { return false; }
}

/** A link to a folder. On Windows a junction, which needs neither admin rights nor Developer Mode. */
function linkFolder(target: string, link: string) {
  fs.symlinkSync(target, link, WIN ? 'junction' : undefined);
}

/** Where a link points, comparable with a path from path.join (Windows hands junctions back as \\?\C:\...). */
function linkTarget(link: string) {
  return path.resolve(fs.readlinkSync(link).replace(/^\\\\\?\\/, ''));
}

/**
 * Stop the server an earlier --login started on Windows or in WSL: ask keepalive.ts to stop, with the server under it, and
 * wait for it to go (scripts/keepalive.ts says why it is a file).
 */
function stopWindowsServer() {
  const root = ROOT;
  const pid = path.join(root, 'server.pid');
  if (!fs.existsSync(pid)) return;
  // On Linux (WSL), a pid whose process is gone is left from an earlier run: nothing would read server.stop, and a
  // keepalive started meanwhile would take the stop meant for the old one. It is cleared at once instead.
  if (process.platform === 'linux') {
    let alive = false;
    try { alive = fs.readFileSync(`/proc/${fs.readFileSync(pid, 'utf8').trim()}/cmdline`, 'utf8').includes('keepalive'); } catch { /* gone */ }
    if (!alive) { fs.rmSync(pid, { force: true }); return; }
  }
  fs.writeFileSync(path.join(root, 'server.stop'), '');
  const until = Date.now() + 5000;
  while (fs.existsSync(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (fs.existsSync(pid)) {
    // Nothing answered: what was running is gone, and left its note behind.
    fs.rmSync(pid, { force: true });
    fs.rmSync(path.join(root, 'server.stop'), { force: true });
  } else log('stopped the running server');
}

console.log(uninstall ? 'bateson uninstalled.' : 'bateson installed. New Claude Code sessions pick up the hooks and the skills.\nOut of the box, agents bring you questions and decisions only. Run /setup-bateson in Claude Code to choose what else comes to you.');
