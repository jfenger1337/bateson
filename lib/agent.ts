// Which coding agent is running this command or hook, as far as its environment says. Claude Code sets
// CLAUDECODE=1 for the shell commands and the hooks it starts (seen in 2.1.325). A tool that only reads Claude
// Code's settings and runs the hooks it finds there (Cursor does) does not set it.
import { execFileSync } from 'node:child_process';
import { missingHooks } from './claude-settings.ts';
import store from './store.ts';

/** The agents bateson is wired into, by the name an item records as its sender. */
export const AGENTS = { 'claude-code': 'Claude Code' } as const;

export type AgentName = keyof typeof AGENTS | 'unknown';

export function agent(env: NodeJS.ProcessEnv = process.env): AgentName {
  return env.CLAUDECODE === '1' ? 'claude-code' : 'unknown';
}

/**
 * Whether a response can wake the session this command runs in: Claude Code, with a person at it (a headless
 * `claude -p` run ends with its turn), and bateson's wake-up hook in its settings. Anything else waits.
 */
export function canWake(env: NodeJS.ProcessEnv = process.env): boolean {
  return agent(env) === 'claude-code' && !/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '') && !missingHooks().includes('PostToolUse');
}

/**
 * Windows has no `ps`: every process's parent, read once from WMI. Process ids are reused there, so a parent may
 * be gone and its id taken; that does no harm, since an ancestor only counts when Claude Code lists it.
 */
let windowsParents: Map<number, number> | null = null;
function parentOnWindows(pid: number): number | null {
  if (!windowsParents) {
    windowsParents = new Map();
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        // Only the two fields: the whole Win32_Process object for every process takes WMI many seconds.
        "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId FROM Win32_Process' | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(p) && Number.isInteger(pp)) windowsParents.set(p, pp);
      }
    } catch { /* no PowerShell: no ancestors beyond the parent */ }
  }
  const n = windowsParents.get(pid);
  return n && n > 4 && n !== pid ? n : null;
}

function parentOf(pid: number): number | null {
  if (process.platform === 'win32') return parentOnWindows(pid);
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
}

/**
 * The Claude Code process this command or hook runs under, and the session it is on now: the nearest ancestor
 * that has an entry in Claude Code's list of running sessions (~/.claude/sessions/<pid>.json). CLAUDE_PID is
 * tried first where Claude Code sets it. Null outside Claude Code, or where that list is not kept.
 */
export function claudeAncestor(env: NodeJS.ProcessEnv = process.env): { pid: number; sessionId: string } | null {
  if (agent(env) !== 'claude-code') return null;
  const fromEnv = Number.parseInt(env.CLAUDE_PID || '', 10);
  if (Number.isInteger(fromEnv)) { const s = store.claudeSession(fromEnv); if (s) return { pid: fromEnv, sessionId: s.sessionId }; }
  let pid: number | null = process.ppid;
  for (let i = 0; pid && i < 12; i++) {
    const s = store.claudeSession(pid);
    if (s) return { pid, sessionId: s.sessionId };
    pid = parentOf(pid);
  }
  return null;
}

/**
 * The Claude Code session this command runs in, so an item is tied to it from the moment it is sent and its
 * decision goes to no other session while this one is open. CLAUDE_CODE_SESSION_ID where Claude Code sets it,
 * else the session of the Claude Code process above this one. Undefined outside Claude Code.
 */
export function currentSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (agent(env) !== 'claude-code') return undefined;
  const fromEnv = env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv && store.validSession(fromEnv)) return fromEnv;
  return claudeAncestor(env)?.sessionId;
}
