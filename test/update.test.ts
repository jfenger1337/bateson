// Updating from the app (lib/update.ts), against real git: a bare repository stands in for GitHub, a clone for
// ~/bateson. npm and the installer are stand-ins, so nothing is built.
import { TMP } from './setup.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openUpdater, runner, due } from '../lib/update.ts';
import type { Run } from '../lib/update.ts';

Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let n = 0;
let ORIGIN: string, LOCAL: string, OTHER: string, FILE: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Commit a change to `file` from `cwd`, and push it if `push`. */
function commit(cwd: string, file: string, text: string, msg: string, push = true) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
  if (push) git(cwd, 'push', '-q', 'origin', 'HEAD:main');
}

beforeEach(() => {
  const dir = path.join(TMP, `update-${++n}`);
  ORIGIN = path.join(dir, 'origin.git'); LOCAL = path.join(dir, 'bateson'); OTHER = path.join(dir, 'upstream-work');
  FILE = path.join(dir, 'update.json');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  git(dir, 'clone', '-q', ORIGIN, OTHER);
  git(OTHER, 'checkout', '-q', '-b', 'main');
  commit(OTHER, 'README.md', 'one\n', 'First');
  commit(OTHER, 'package-lock.json', '{}\n', 'Lockfile');
  git(dir, 'clone', '-q', ORIGIN, LOCAL);
});

/** git for real; npm and the installer pretend, failing when `fail` names them. Every call is noted. */
function fake(fail: string[] = []) {
  const real = runner(LOCAL);
  const calls: string[] = [];
  const run: Run = async (cmd, args, opts) => {
    const line = `${path.basename(cmd)} ${args.join(' ')}`;
    calls.push(line);
    if (cmd === 'git') return real(cmd, args, opts);
    if (fail.some((f) => line.startsWith(f))) throw Object.assign(new Error(`${line} failed`), { output: 'error TS2304: Cannot find name x.\n' });
    return '';
  };
  return { run, calls };
}

function updater(opts: { fail?: string[]; restartable?: boolean } = {}) {
  const { run, calls } = fake(opts.fail);
  let exited = 0;
  const u = openUpdater({ repo: LOCAL, file: FILE, run, restartable: () => opts.restartable ?? true, exit: () => { exited++; }, macApp: path.join(TMP, 'no-app') });
  return { u, calls, exited: () => exited };
}

test('up to date, then a new version with its changes listed newest first', async () => {
  const { u } = updater();
  assert.equal((await u.check()).state, 'current');
  commit(OTHER, 'README.md', 'two\n', 'Agents check what you already decided');
  commit(OTHER, 'README.md', 'three\n', 'New sessions hear your overrides');
  const v = await u.check();
  assert.equal(v.state, 'available');
  assert.deepEqual(v.changes.map((c) => c.subject), ['New sessions hear your overrides', 'Agents check what you already decided']);
  assert.ok(v.checkedAt && !due(v));
});

test('the changes leave out merges, which say only which branch came in', async () => {
  const { u } = updater();
  git(OTHER, 'checkout', '-q', '-b', 'side');
  commit(OTHER, 'side.md', 'x\n', 'A change made on a branch', false);
  git(OTHER, 'checkout', '-q', 'main');
  commit(OTHER, 'README.md', 'two\n', 'A change made on main', false);
  git(OTHER, 'merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side');
  git(OTHER, 'push', '-q', 'origin', 'HEAD:main');
  const v = await u.check();
  assert.equal(v.state, 'available');
  assert.deepEqual(v.changes.map((c) => c.subject).sort(), ['A change made on a branch', 'A change made on main']);
  assert.equal(v.more, 0);
});

test('Update fast-forwards, builds, runs the installer, then the server quits to be started again', async () => {
  const { u, calls, exited } = updater();
  commit(OTHER, 'README.md', 'two\n', 'A change');
  await u.check();
  const v = await u.apply();
  assert.equal(git(LOCAL, 'rev-parse', 'HEAD'), git(OTHER, 'rev-parse', 'HEAD'));
  assert.ok(calls.includes('npm run build'));
  assert.ok(calls.some((c) => c.endsWith(`${path.join('scripts', 'install.ts')} --updating`)), 'the installer is told it runs from an update');
  assert.ok(!calls.some((c) => c.startsWith('npm ci')), 'the dependencies did not change');
  assert.equal(v.state, 'current');
  assert.ok(v.updatedAt);
  await sleep(400);
  assert.equal(exited(), 1);
});

test('new dependencies are installed first', async () => {
  const { u, calls } = updater();
  commit(OTHER, 'package-lock.json', '{"v":2}\n', 'New dependency');
  await u.apply();
  assert.ok(calls.indexOf('npm ci --no-audit --no-fund') < calls.indexOf('npm run build'));
});

test('a failed build goes back to the version they had and says why', async () => {
  const { u, exited } = updater({ fail: ['npm run build'] });
  const before = git(LOCAL, 'rev-parse', 'HEAD');
  commit(OTHER, 'README.md', 'two\n', 'Broken');
  const v = await u.apply();
  assert.equal(v.state, 'failed');
  assert.match(v.reason!, /went back to the version you had\. error TS2304/);
  assert.equal(git(LOCAL, 'rev-parse', 'HEAD'), before);
  assert.equal(v.changes.length, 1, 'the new version is still there to try again');
  await sleep(400);
  assert.equal(exited(), 0);
});

test('changed files or commits of their own: never touched', async () => {
  commit(OTHER, 'README.md', 'two\n', 'Upstream');
  fs.writeFileSync(path.join(LOCAL, 'README.md'), 'mine\n');
  const { u } = updater();
  let v = await u.apply();
  assert.equal(v.state, 'blocked');
  assert.match(v.reason!, /changed a file in .* \(README\.md\)/);
  assert.equal(fs.readFileSync(path.join(LOCAL, 'README.md'), 'utf8'), 'mine\n');
  git(LOCAL, 'checkout', '--', 'README.md');
  commit(LOCAL, 'mine.txt', 'x\n', 'Mine', false);
  v = await u.check();
  assert.equal(v.state, 'blocked');
  assert.match(v.reason!, /has a commit of your own/);
});

test('a lockfile npm rewrote does not block the update; it is put back', async () => {
  commit(OTHER, 'README.md', 'two\n', 'Upstream');
  fs.writeFileSync(path.join(LOCAL, 'package-lock.json'), '{"rewritten":true}\n');
  const { u } = updater();
  assert.equal((await u.check()).state, 'available');
  assert.equal((await u.apply()).state, 'current');
  assert.equal(git(LOCAL, 'status', '--porcelain'), '');
});

test('a server started by hand is not stopped: it says to restart it', async () => {
  commit(OTHER, 'README.md', 'two\n', 'Upstream');
  const { u, exited } = updater({ restartable: false });
  const v = await u.apply();
  assert.equal(v.state, 'restart');
  assert.match(v.reason!, /Restart bateson serve/);
  await sleep(400);
  assert.equal(exited(), 0);
  // The next check, by this same old server, still says to restart; the new server's start clears it.
  assert.equal((await u.check()).state, 'restart');
  u.recover();
  assert.equal(u.read().state, 'current');
});

test('an update left halfway by a closed server is said as failed at the next start', () => {
  fs.writeFileSync(FILE, JSON.stringify({ state: 'updating', step: 'Building', changes: [], more: 0 }));
  const { u } = updater();
  u.recover();
  assert.equal(u.read().state, 'failed');
  assert.match(u.read().reason!, /stopped partway/);
});

test('GitHub out of reach: the last answer stands, with a note', async () => {
  const { u } = updater();
  await u.check();
  git(LOCAL, 'remote', 'set-url', 'origin', path.join(TMP, 'nowhere.git'));
  const v = await u.check();
  assert.equal(v.state, 'current');
  assert.match(v.error!, /could not be reached/);
});

test('an installer that fails is undone by the old one, after going back', async () => {
  const { u, calls } = updater({ fail: ['node'] });
  commit(OTHER, 'README.md', 'two\n', 'Installer breaks');
  const v = await u.apply();
  assert.equal(v.state, 'failed');
  const installs = calls.filter((c) => c.includes(`${path.join('scripts', 'install.ts')} --updating`));
  assert.equal(installs.length, 2, 'the new installer, then the old one on the way back');
  assert.ok(calls.lastIndexOf(installs[1]) > calls.findIndex((c) => c.startsWith('git reset --keep')));
});
