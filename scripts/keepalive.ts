#!/usr/bin/env node
// The server at login on Windows, where there is no launchd. It does what launchd's plist does on a Mac: runs
// server/server.ts from this folder with its output in ~/.bateson/server.log, and starts it again when it stops.
// While it runs, ~/.bateson/server.pid holds its pid. The installer stops it, and the server under it, by writing
// ~/.bateson/server.stop: a file and not a kill, so a pid Windows has since given to another process is never at risk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
const PID = path.join(ROOT, 'server.pid');
const STOP = path.join(ROOT, 'server.stop');
fs.mkdirSync(ROOT, { recursive: true });
fs.rmSync(STOP, { force: true });
fs.writeFileSync(PID, String(process.pid));
const log = fs.openSync(path.join(ROOT, 'server.log'), 'a');

let child: ChildProcess | null = null;
let stopping = false;
let quick = 0;

function run() {
  const started = Date.now();
  child = spawn(process.execPath, [path.join(REPO, 'server', 'server.ts')], { cwd: REPO, stdio: ['ignore', log, log], windowsHide: true });
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
