#!/usr/bin/env node
// What the login item runs on Windows: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs
// a .mjs file), then runs scripts/keepalive.ts with the same arguments. It runs without a window, so on a Node that
// cannot, the reason also goes to ~/.bateson/server.log (or the --home the install was made with).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript } from '../lib/node-check.mjs';

const install = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.mjs');
needTypeScript(`run \`node ${install} --login\` with it, so the server at login uses that Node`, (text) => {
  try {
    const i = process.argv.indexOf('--home');
    const root = (i > 0 && process.argv[i + 1]) || process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, 'server.log'), `${new Date().toISOString()} ${text}\n`);
  } catch { /* nowhere to write */ }
});

await import('./keepalive.ts');
