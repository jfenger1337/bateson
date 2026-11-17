#!/usr/bin/env node
// The installer: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file), then
// runs scripts/install.ts with the same arguments. The hooks and the command use the Node that runs this.
import { needTypeScript } from '../lib/node-check.mjs';

needTypeScript('run this again with it');

await import('./install.ts');
