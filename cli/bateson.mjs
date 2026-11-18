#!/usr/bin/env node
// The bateson command: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file),
// then runs cli/bateson.ts. Started by a Node too old for it, it runs itself again with the one bateson was installed
// with, so an older Node first on PATH needs no wrapper.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript, useInstalledNode } from '../lib/node-check.mjs';

const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
useInstalledNode();
needTypeScript(`run \`node ${install}\` with it, so the command and the hooks use that Node`);

await import('./bateson.ts');
