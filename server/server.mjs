#!/usr/bin/env node
// The server: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file), then
// starts server/server.ts. What `npm start`, `bateson serve`, launchd and scripts/keepalive.ts run. On a Node that
// cannot, the reason goes to stderr, which is ~/.bateson/server.log for the server at login, and to
// ~/.bateson/server.error, where the Mac app reads it to say why it has no server; a server that starts removes it.
// Started by launchd (with --login), it also stands in on the port for a minute, so a browser says why too, then
// exits for launchd to try again: a Node fixed meanwhile is picked up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whyNot, serveWhy } from '../lib/node-check.mjs';

const root = process.env.BATESON_HOME ? path.resolve(process.env.BATESON_HOME) : path.join(os.homedir(), '.bateson');
const error = path.join(root, 'server.error');
const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
const why = whyNot(`run \`node ${install} --login\` with it if the server starts at login, or start it again with that Node`);

if (why) {
  console.error(why);
  try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(error, why + '\n'); } catch { /* stderr has it */ }
  if (process.argv.includes('--login')) {
    serveWhy(why, Number(process.env.BATESON_PORT || 4848));
    setTimeout(() => process.exit(1), Number(process.env.BATESON_STAND_IN_MS) || 60_000);
  } else process.exit(1);
} else {
  fs.rmSync(error, { force: true });
  const { start } = await import('./server.ts');
  start();
}
