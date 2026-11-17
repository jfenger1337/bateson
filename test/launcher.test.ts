// The bateson command and the installer start at plain JavaScript files (cli/bateson.mjs, scripts/install.mjs), so
// that a Node too old to run TypeScript says why it cannot run bateson instead of "Unknown file extension .ts".
import { childEnv, REPO } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'bateson.mjs');
const INSTALL = path.join(ROOT, 'scripts', 'install.mjs');
// Node 20 has no process.features.typescript; a Node without TypeScript support is the nearest this Node gets.
const OLD_NODE = ['--no-experimental-strip-types', '--import', `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.19.5"});`];
const run = (file: string, args: string[], flags: string[] = []) =>
  spawnSync(process.execPath, [...flags, file, ...args], { env: childEnv(), cwd: REPO, encoding: 'utf8' });

test('on a Node that runs TypeScript, the command runs the CLI', () => {
  const r = run(CLI, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing is waiting/);
});

test('on a Node older than 22.18, the command says which Node it found and to run the installer with a newer one', () => {
  const r = run(CLI, ['list'], OLD_NODE);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /needs Node 22\.18 or newer/);
  assert.match(r.stderr, /This is Node 20\.19\.5/);
  assert.match(r.stderr, /scripts[\\/]install\.mjs/);
  assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
});

test('on a new Node with TypeScript turned off, it names the flag instead of asking for a newer Node', () => {
  const r = run(CLI, ['list'], ['--no-experimental-strip-types']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TypeScript support turned off/);
  assert.match(r.stderr, /--no-experimental-strip-types/);
  assert.doesNotMatch(r.stderr, /needs Node 22\.18/);
});

test('the installer runs install.ts with its arguments', () => {
  // A bad --only stops it before it touches anything, and shows the arguments got through.
  const r = run(INSTALL, ['--only', 'nobody']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--only takes one of/);
});

test('on a Node older than 22.18, the installer says so before changing anything, uninstall included', () => {
  for (const args of [['--login'], ['--uninstall']]) {
    const r = run(INSTALL, args, OLD_NODE);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '', 'nothing was done');
    assert.match(r.stderr, /needs Node 22\.18 or newer/);
    assert.match(r.stderr, /This is Node 20\.19\.5/);
    assert.match(r.stderr, /run this again with it/);
    assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  }
});
