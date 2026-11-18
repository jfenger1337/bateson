#!/usr/bin/env node
// The server: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file), then
// starts server/server.ts. What `npm start`, `bateson serve`, launchd and scripts/keepalive.ts run. On a Node that
// cannot, the reason goes to stderr, which is ~/.bateson/server.log for the server at login.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript } from '../lib/node-check.mjs';

const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
needTypeScript(`run \`node ${install} --login\` with it if the server starts at login, or start it again with that Node`);

const { start } = await import('./server.ts');
start();
