#!/usr/bin/env node
// The bateson command. bateson.ts is TypeScript, which Node runs as it is only from 22.18 on: an older Node stops at
// the file's extension ("Unknown file extension .ts") before a line of it runs, so no check inside it could ever
// speak. This file is plain JavaScript, kept to syntax any Node reads, so it can say what is wrong first.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!(process.features && process.features.typescript)) {
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.ts');
  console.error(major > 22 || (major === 22 && minor >= 18) ? [
    `bateson: this Node (${version}, at ${process.execPath}) has its TypeScript support turned off, and bateson needs it.`,
    'Remove --no-experimental-strip-types from how Node is started (look in NODE_OPTIONS), then run bateson again.',
  ].join('\n') : [
    `bateson: needs Node 22.18 or newer, which runs its TypeScript files directly. This is Node ${version}, at ${process.execPath}.`,
    `Install Node 22.18 or newer, then run \`node ${install}\` with it, so the command and the hooks use that Node.`,
  ].join('\n'));
  process.exit(1);
}

await import('./bateson.ts');
