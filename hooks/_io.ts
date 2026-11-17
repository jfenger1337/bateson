// Shared by the hooks: read the hook's JSON input, and stay quiet on any error so a hook never breaks a session
// (the error goes to ~/.bateson/hooks.log instead).
import fs from 'node:fs';
import path from 'node:path';
import { agent } from '../lib/agent.ts';
import { logHookError } from '../lib/store.ts';

/** What Claude Code sends a hook on stdin: the fields bateson reads, each kept only if it has the right type. */
export interface HookInput {
  hook_event_name?: string; session_id?: string; cwd?: string; transcript_path?: string; tool_name?: string; prompt?: string;
  tool_input?: { command?: string; file_path?: string; notebook_path?: string };
  tool_response?: unknown;
}

type Loose = { [key: string]: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' ? v as Loose : undefined);

export function input(): HookInput {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
  const h = obj(parsed) || {};
  const t = obj(h.tool_input);
  return {
    hook_event_name: str(h.hook_event_name), session_id: str(h.session_id), cwd: str(h.cwd),
    transcript_path: str(h.transcript_path), tool_name: str(h.tool_name), prompt: str(h.prompt),
    tool_input: t && { command: str(t.command), file_path: str(t.file_path), notebook_path: str(t.notebook_path) },
    tool_response: h.tool_response,
  };
}

export function guard(fn: () => unknown) {
  // Other tools read Claude Code's settings and run the hooks they find there. These are written for Claude Code
  // alone, so anywhere else they do nothing.
  if (agent() !== 'claude-code') process.exit(0);
  // Nothing a hook does wrong may stop a session, so it exits quietly; but it is written down in
  // ~/.bateson/hooks.log, and Settings says when the last day has any.
  Promise.resolve().then(fn).catch((e) => {
    logHookError(path.basename(process.argv[1] || 'hook').replace(/\.mjs$/, '.ts'), e); // hooks/<name>.mjs runs <name>.ts
    if (process.env.BATESON_DEBUG) process.stderr.write(`bateson hook: ${(e as Error).stack}\n`);
    process.exit(0);
  });
}
