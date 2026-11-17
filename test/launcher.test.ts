// The bateson command starts at cli/bateson.mjs, plain JavaScript, so that a Node too old to run TypeScript says
// why it cannot run bateson instead of "Unknown file extension .ts".
import { childEnv, REPO } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bateson.mjs');
// Node 20 has no process.features.typescript; a Node without TypeScript support is the nearest this Node gets.
const OLD_NODE = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.19.5"});`;
const run = (flags: string[]) => spawnSync(process.execPath, [...flags, LAUNCHER, 'list'], { env: childEnv(), cwd: REPO, encoding: 'utf8' });

test('on a Node that runs TypeScript, the launcher runs the CLI', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing is waiting/);
});

test('on a Node older than 22.18, it says which Node it found and what to do', () => {
  const r = run(['--no-experimental-strip-types', '--import', OLD_NODE]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /needs Node 22\.18 or newer/);
  assert.match(r.stderr, /This is Node 20\.19\.5/);
  assert.match(r.stderr, /scripts[\\/]install\.ts/);
  assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
});

test('on a new Node with TypeScript turned off, it names the flag instead of asking for a newer Node', () => {
  const r = run(['--no-experimental-strip-types']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TypeScript support turned off/);
  assert.match(r.stderr, /--no-experimental-strip-types/);
  assert.doesNotMatch(r.stderr, /needs Node 22\.18/);
});
