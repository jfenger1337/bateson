// Imported first by every test file: a scratch queue, a scratch list of Claude Code sessions and a scratch
// repository, set up before lib/store.ts reads its environment. Nothing touches ~/.bateson or ~/.claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bateson-test-')));
export const HOME = path.join(TMP, 'queue');
export const CLAUDE = path.join(TMP, 'claude-sessions');
export const REPO = path.join(TMP, 'repo');
export const OTHER = path.join(TMP, 'other-repo');
for (const d of [HOME, CLAUDE, REPO, OTHER]) fs.mkdirSync(d, { recursive: true });
for (const d of [REPO, OTHER]) execFileSync('git', ['init', '-q'], { cwd: d });

process.env.BATESON_HOME = HOME;
process.env.BATESON_CLAUDE_DIR = CLAUDE;
process.env.BATESON_PORT = '1'; // nothing listens there: "the app is not running", at once
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

/** Claude Code process `pid` is running session `sessionId` (as Claude Code's own list would say). */
export function sessionOpen(pid: number, sessionId: string) {
  fs.writeFileSync(path.join(CLAUDE, `${pid}.json`), JSON.stringify({ pid, sessionId, status: 'idle' }));
}
/** That process is gone. */
export function sessionClosed(pid: number) {
  fs.rmSync(path.join(CLAUDE, `${pid}.json`), { force: true });
}
/** Every Claude Code session closed, and the queue empty: a clean start for each test. */
export function reset() {
  for (const d of [CLAUDE, path.join(HOME, 'items'), path.join(HOME, 'done'), path.join(HOME, 'sessions'), path.join(HOME, 'recent'), path.join(HOME, 'hue.json')]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  fs.mkdirSync(CLAUDE, { recursive: true });
}

/** The environment for a child process (the CLI, a hook): the scratch queue, Claude Code's marker, and none of the session variables of whatever runs the tests. */
export function childEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: TMP, USERPROFILE: TMP /* Windows' home */, CLAUDECODE: '1', BATESON_NO_OPEN: '1', ...extra };
  for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) if (!(k in extra)) delete env[k];
  return env;
}
