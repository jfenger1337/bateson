#!/usr/bin/env node
// PostToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash). The first time a turn you did not start (a wake-up
// from bateson, a background task) edits the work, remind the agent, quietly, that calls which are yours go to
// the queue. It lands in the agent's context, not on your screen, and never stops the turn. Once per turn;
// never on a turn your prompt started, and not after the turn has already sent something.
import path from 'node:path';
import { readConfig, sessionRecord, touchSession, activeSessions, reviewer } from '../lib/store.ts';
import { input, guard } from './_io.ts';
import { snapshot, loadSnapshot, changedSince } from '../lib/worktree.ts';
import { checkoutOf } from '../lib/delivery.ts';

const EDITS = new Set<string | undefined>(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const inside = (file: string, root: string) => { const r = path.relative(root, file); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

guard(async () => {
  const hook = input();
  if (process.env.BATESON_NUDGE === '0' || !readConfig().stopCheck) process.exit(0);
  const rec = sessionRecord(hook.session_id);
  // Only a turn the Stop hook handed on as not yours. No record yet means a first turn, which a prompt started.
  if (rec?.turn?.human !== false || rec.turn.reminded) process.exit(0);
  const done = () => touchSession(hook.session_id, hook.cwd, rec.state === 'idle' ? 'working' : rec.state, { turn: { reminded: true } });

  const tool = hook.tool_name;
  if (tool === 'Bash') {
    const cmd = String(hook.tool_input?.command || '');
    // It already put something to the queue this turn: no need to ask.
    if (/bateson\b[^\n]*\bsend\b/.test(cmd)) { done(); process.exit(0); }
    // A shell edit (sed, a heredoc, a script) shows only in the working tree. Another agent at work in the same
    // repository could have made the change, so then it is not counted.
    const now = snapshot(hook.cwd);
    if (!now || !changedSince(loadSnapshot(hook.session_id), now)?.size) process.exit(0);
    if (activeSessions().some((s) => s.sessionId !== hook.session_id && s.cwd && (s.cwd === now.top || inside(s.cwd, now.top)))) process.exit(0);
  } else if (EDITS.has(tool)) {
    const file = hook.tool_input?.file_path || hook.tool_input?.notebook_path;
    const root = checkoutOf(hook.cwd);
    // Scratch files and reports outside the repository are not edits to the work.
    if (!file || !root || !inside(path.resolve(hook.cwd || '/', file), root)) process.exit(0);
  } else process.exit(0);

  done();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `bateson: ${reviewer()} did not start this turn, and it has begun changing files. If you are about to make a call that is ${reviewer()}'s (direction, a trade-off, copy or UI taste, a plan for big work), send it with \`bateson send\` and end your turn instead of building on it (a single question goes in chat instead). Otherwise carry on and do not mention this.`,
    },
  }));
});
