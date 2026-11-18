// The bateson command, the installer and the hooks start at plain JavaScript files (cli/bateson.mjs,
// scripts/install.mjs, hooks/*.mjs), so that a Node too old to run TypeScript says why it cannot run bateson
// instead of "Unknown file extension .ts".
import { childEnv, REPO, TMP } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
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

/** install.json naming a Node at another path than this one (a link to it), as an install on a newer Node notes it. */
function installedWith(fn: () => void) {
  const root = process.env.BATESON_HOME!;
  // With .exe on Windows, as install.json has it there: a program without an extension is not run at all.
  const node = path.join(root, process.platform === 'win32' ? 'installed-node.exe' : 'installed-node');
  fs.rmSync(node, { force: true });
  fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ node }));
  try { fn(); } finally { fs.rmSync(path.join(root, 'install.json')); fs.rmSync(node); }
}

test('started by an old Node, the command runs itself with the Node it was installed with', () => installedWith(() => {
  const r = run(CLI, ['list'], OLD_NODE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /Nothing is waiting/);
}));

test('when the installed Node cannot run it either, the command says so once instead of going round', () => installedWith(() => {
  const r = spawnSync(process.execPath, [CLI, 'list'], { env: childEnv({ NODE_OPTIONS: '--no-experimental-strip-types' }), cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.match(/TypeScript support turned off/g)?.length, 1);
}));

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

const HOOK = path.join(ROOT, 'hooks', 'catchup.mjs');
const hook = (flags: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [...flags, HOOK], {
  env: childEnv(env), cwd: REPO, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'L', cwd: REPO, prompt: 'hi' }), encoding: 'utf8',
});

test('on a Node older than 22.18, a hook tells the person (exit 1, not 2: the agent is not told) and logs it', () => {
  const log = path.join(process.env.BATESON_HOME!, 'hooks.log');
  fs.rmSync(log, { force: true });
  const r = hook(OLD_NODE);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '', 'nothing enters the session');
  assert.match(r.stderr, /needs Node 22\.18 or newer/);
  assert.match(r.stderr, /This is Node 20\.19\.5/);
  assert.match(r.stderr, /scripts[\\/]install\.mjs/);
  assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.match(fs.readFileSync(log, 'utf8'), /^\S+Z catchup\.ts bateson: needs Node 22\.18 or newer.* \| Install Node/m);
});

test('outside Claude Code, a hook on an old Node does nothing, as it would on a new one', () => {
  const r = hook(OLD_NODE, { CLAUDECODE: '' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('every hook in the settings is a launcher that runs on this Node', () => {
  for (const name of ['catchup', 'nudge', 'remind', 'rewake']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', `${name}.mjs`)], { env: childEnv(), cwd: REPO, input: '{}', encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

const SERVER = path.join(ROOT, 'server', 'server.mjs');
const KEEPALIVE = path.join(ROOT, 'scripts', 'keepalive.mjs');
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

test('on a Node that runs TypeScript, the server launcher starts the server, and takes back why it could not', async () => {
  const port = await freePort();
  const home = path.join(TMP, 'server-up');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'server.error'), 'bateson: needs Node 22.18 or newer\n');
  const child = spawn(process.execPath, [SERVER], { env: childEnv({ BATESON_HOME: home, BATESON_PORT: String(port) }), cwd: ROOT, stdio: 'ignore' });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(ok, 'the server answers');
    assert.ok(!fs.existsSync(path.join(home, 'server.error')), 'the Mac app no longer says it cannot start');
  } finally { child.kill(); }
});

test('on a Node older than 22.18, the server says so instead of starting, and leaves it for the Mac app', () => {
  const home = path.join(TMP, 'server-old-node');
  const r = spawnSync(process.execPath, [...OLD_NODE, SERVER], { env: childEnv({ BATESON_HOME: home, BATESON_PORT: '1' }), cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node 22\.18 or newer/);
  assert.match(r.stderr, /This is Node 20\.19\.5/);
  assert.match(r.stderr, /install\.mjs --login/);
  assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.equal(fs.readFileSync(path.join(home, 'server.error'), 'utf8'), r.stderr, 'server.error says what stderr does');
});

test('on a Node older than 22.18, the Windows login item says so in server.log, having no window', () => {
  const home = path.join(TMP, 'keepalive-home');
  const r = spawnSync(process.execPath, [...OLD_NODE, KEEPALIVE, '--home', home], { env: childEnv(), cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(home, 'server.log'), 'utf8'), /^\S+Z bateson: needs Node 22\.18 or newer.*\nInstall Node .*install\.mjs --login/m);
  assert.ok(!fs.existsSync(path.join(home, 'server.pid')), 'keepalive.ts never ran');
});
