#!/usr/bin/env node
// Stop. The turn is over: the session is idle, whatever interview round it was writing is no longer being
// written, and the working tree is recorded so the next turn's edits can be told apart (hooks/remind.ts).
// Whatever turn comes next without a prompt (a wake-up from bateson, a background task) is not yours, so it
// starts as human: false. Nothing here blocks: the decision reminder now comes during the turn, quietly.
import { markStopped, readConfig, touchSession } from '../lib/store.ts';
import { input, guard } from './_io.ts';
import { snapshot, saveSnapshot } from '../lib/worktree.ts';

guard(async () => {
  const hook = input();
  markStopped(hook.session_id);
  touchSession(hook.session_id, hook.cwd, 'idle', { transcript: hook.transcript_path, turn: { human: false, reminded: false } });
  if (process.env.BATESON_NUDGE === '0' || !readConfig().stopCheck) process.exit(0);
  saveSnapshot(hook.session_id, snapshot(hook.cwd));
});
