// Whether this Node can run bateson, asked before anything loads a .ts file. bateson is TypeScript, which Node runs as
// it is only from 22.18 on: an older Node stops at the extension ("Unknown file extension .ts") before a line of it
// runs, so no check inside a .ts file could ever speak. This file and the launchers that import it (cli/bateson.mjs,
// scripts/install.mjs, hooks/*.mjs, server/server.mjs, scripts/keepalive.mjs) are plain JavaScript, kept to syntax
// any Node reads, so they can say what is wrong first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Whether this Node runs TypeScript. Without it, the command started by an older Node first on PATH (a terminal
 * opened while an older nvm default was in force, say) runs itself again with the Node bateson was installed with,
 * as noted in install.json, the same one the hooks use. It never returns then: it exits as that run did.
 */
export function useInstalledNode() {
  if (process.features && process.features.typescript) return;
  if (process.env.BATESON_RERUN) return; // that Node, too, could not: say so instead of going round
  let node;
  try {
    const root = process.env.BATESON_HOME ? path.resolve(process.env.BATESON_HOME) : path.join(os.homedir(), '.bateson');
    node = JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8')).node;
  } catch (e) { return; }
  if (typeof node !== 'string' || !node || path.resolve(node) === process.execPath || !fs.existsSync(node)) return;
  const env = Object.assign({}, process.env, { BATESON_RERUN: '1' });
  const run = spawnSync(node, process.argv.slice(1), { stdio: 'inherit', env: env });
  if (run.error) return;
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status === null ? 1 : run.status);
}

/**
 * Exit with what is wrong, and `next` (what to do once there is a newer Node), unless this Node runs TypeScript.
 * `said`, if given, also gets the text before the exit.
 */
export function needTypeScript(next, said) {
  if (process.features && process.features.typescript) return;
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const text = (major > 22 || (major === 22 && minor >= 18) ? [
    `bateson: this Node (${version}, at ${process.execPath}) has its TypeScript support turned off, and bateson needs it.`,
    'Remove --no-experimental-strip-types from how Node is started (look in NODE_OPTIONS), then run this again.',
  ] : [
    `bateson: needs Node 22.18 or newer, which runs its TypeScript files directly. This is Node ${version}, at ${process.execPath}.`,
    `Install Node 22.18 or newer, then ${next}.`,
  ]).join('\n');
  console.error(text);
  if (said) said(text);
  process.exit(1);
}
