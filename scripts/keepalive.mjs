#!/usr/bin/env node
// What the login item runs on Windows: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs
// a .mjs file), then runs scripts/keepalive.ts with the same arguments. It runs without a window, so on a Node that
// cannot, the reason goes to ~/.bateson/server.log (or the --home the install was made with), and it stands in on
// the server's port with it, so the browser says why instead of waiting. Nothing starts it again, so it stays until
// the installer asks it to stop, as keepalive.ts does: server.pid while it runs, server.stop to end it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whyNot, serveWhy } from '../lib/node-check.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const install = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const why = whyNot(`run \`node ${install} --login\` with it, so the server at login uses that Node`);

if (why) {
  const root = arg('--home') || process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
  const PID = path.join(root, 'server.pid');
  const STOP = path.join(root, 'server.stop');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, 'server.log'), `${new Date().toISOString()} ${why}\n`);
    fs.rmSync(STOP, { force: true });
    fs.writeFileSync(PID, String(process.pid));
  } catch { /* nowhere to write */ }
  const server = serveWhy(why, Number(arg('--port') || process.env.BATESON_PORT || 4848));
  const stop = () => {
    server.close();
    fs.rmSync(STOP, { force: true });
    try { if (fs.readFileSync(PID, 'utf8').trim() === String(process.pid)) fs.rmSync(PID); } catch { /* gone already */ }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);
  setInterval(() => { if (fs.existsSync(STOP)) stop(); }, 500);
} else {
  await import('./keepalive.ts');
}
