#!/usr/bin/env node
// The bateson command: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file),
// then runs cli/bateson.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript } from '../lib/node-check.mjs';

const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
needTypeScript(`run \`node ${install}\` with it, so the command and the hooks use that Node`);

await import('./bateson.ts');
