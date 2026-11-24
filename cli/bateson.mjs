#!/usr/bin/env node
// The bateson command: checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file),
// then runs cli/bateson.ts. Started by a Node too old for it, it runs itself again with the one bateson was installed
// with, so an older Node first on PATH needs no wrapper.
//
// The command runs from its bundle, cli/dist/bateson.js, which `npm run build` makes and which starts about three
// times faster than the TypeScript: an agent waits on every `bateson send` and `recall`. Only while the bundle is
// newer than every file that went into it (lib/bundle.mjs); otherwise from source, as the hooks do.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentBundle } from '../lib/bundle.mjs';
import { needTypeScript, useInstalledNode } from '../lib/node-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const install = path.join(HERE, '..', 'scripts', 'install.mjs');
useInstalledNode();
needTypeScript(`run \`node ${install}\` with it, so the command and the hooks use that Node`);

const built = currentBundle(path.join(HERE, 'dist'), 'bateson');
await import(built ? pathToFileURL(built).href : './bateson.ts');
