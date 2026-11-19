#!/usr/bin/env node
// Run as scripts/keepalive.mjs, which first checks that this Node can run it.
// The server at login on Windows, where there is no launchd. It does what launchd's plist does on a Mac: runs
// server/server.mjs from this folder with its output in ~/.bateson/server.log, and starts it again when it stops.
// While it runs, ~/.bateson/server.pid holds its pid. The installer stops it, and the server under it, by writing
// ~/.bateson/server.stop: a file and not a kill, so a pid Windows has since given to another process is never at risk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --home and --port: the BATESON_HOME and BATESON_PORT the install was made with, which a login has not set. They
// are set here, so the server under this (and anything it starts) uses the same queue and port.
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (arg('--home')) process.env.BATESON_HOME = arg('--home');
if (arg('--port')) process.env.BATESON_PORT = arg('--port');
const ROOT = process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
const PID = path.join(ROOT, 'server.pid');
const STOP = path.join(ROOT, 'server.stop');
fs.mkdirSync(ROOT, { recursive: true });
// One keepalive per queue. In WSL a send starts one when the server is down, so it can race the installer or
// another send: a second one would only fight the first for the port. On Linux /proc tells whether the pid in
// server.pid is a keepalive still running (a pid alone may since belong to something else); elsewhere this
// check is skipped.
if (process.platform === 'linux') {
  try {
    const other = Number(fs.readFileSync(PID, 'utf8').trim());
    if (other > 0 && other !== process.pid && fs.readFileSync(`/proc/${other}/cmdline`, 'utf8').includes('keepalive')) process.exit(0);
  } catch { /* no pid file, or that process is gone */ }
}
fs.rmSync(STOP, { force: true });
fs.writeFileSync(PID, String(process.pid));
const log = fs.openSync(path.join(ROOT, 'server.log'), 'a');

let child: ChildProcess | null = null;
let stopping = false;
let quick = 0;

function run() {
  const started = Date.now();
  child = spawn(process.execPath, [path.join(REPO, 'server', 'server.mjs')], { cwd: REPO, stdio: ['ignore', log, log], windowsHide: true });
  child.on('exit', () => {
    child = null;
    if (stopping) return;
    // One that fails at once (the port is taken, a broken build) is tried again less and less often, up to once a minute.
    quick = Date.now() - started < 10_000 ? quick + 1 : 0;
    setTimeout(run, Math.min(60_000, 1000 * 2 ** quick));
  });
}

function stop() {
  stopping = true;
  child?.kill();
  fs.rmSync(STOP, { force: true });
  try { if (fs.readFileSync(PID, 'utf8').trim() === String(process.pid)) fs.rmSync(PID); } catch { /* gone already */ }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
setInterval(() => { if (fs.existsSync(STOP)) stop(); }, 500);

run();
