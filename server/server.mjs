#!/usr/bin/env node
// The server: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file), then
// starts server/server.ts. What `npm start`, `bateson serve`, launchd and scripts/keepalive.ts run. On a Node that
// cannot, the reason goes to stderr, which is ~/.bateson/server.log for the server at login, and to
// ~/.bateson/server.error, where the Mac app reads it to say why it has no server; a server that starts removes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript } from '../lib/node-check.mjs';

const root = process.env.BATESON_HOME ? path.resolve(process.env.BATESON_HOME) : path.join(os.homedir(), '.bateson');
const error = path.join(root, 'server.error');
const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
needTypeScript(`run \`node ${install} --login\` with it if the server starts at login, or start it again with that Node`, (text) => {
  try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(error, text + '\n'); } catch { /* stderr has it */ }
});
fs.rmSync(error, { force: true });

const { start } = await import('./server.ts');
start();
