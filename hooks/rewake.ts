#!/usr/bin/env node
// PostToolUse (Bash), asyncRewake. After `bateson send` (or `draft`, or `rearm`), wait in the background for
// the decision, then wake the session with it (exit 2: the output reaches the model). If this hook gives up,
// catchup.ts delivers later, to this session only: on its next prompt, or when it is resumed.
//
// Claude Code stops the hook after REWAKE_TIMEOUT_S. Shortly before that, it wakes the session to run
// `bateson rearm <id>`, which starts this hook again for another stretch: a wait outlasts the timeout without
// the session having to be prompted. Once the question is a day old it stops renewing and lets go quietly;
// the answer then reaches the session on its next prompt, and nothing wakes an agent every four hours for ever.
import store from '../lib/store.ts';
import type { StoredItem } from '../lib/store.ts';
import { register, release, awaitDecision } from '../lib/delivery.ts';
import { claudeProcessFor } from '../lib/agent.ts';
import { REWAKE_TIMEOUT_S } from '../lib/claude-settings.ts';
import { input, guard } from './_io.ts';

const SEND = /bateson\b[^\n]*\b(send|draft|rearm)\b/;
/** When to renew: this long into the wait (BATESON_REARM_AFTER, in seconds, for the tests), two minutes short of the timeout. */
const RENEW_AFTER_MS = (Number(process.env.BATESON_REARM_AFTER) || REWAKE_TIMEOUT_S - 120) * 1000;
/** Renew only while the question is younger than this. */
const RENEW_FOR_MS = 24 * 3600 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

guard(async () => {
  const hook = input();
  const cmd = String(hook.tool_input?.command || '');
  if (!SEND.test(cmd)) process.exit(0);
  const found = fromOutput(hook.tool_response) || fromCommand(cmd) || await sentBy(hook.session_id);
  if (!found) process.exit(0);
  const { id, n } = found;
  if (!register(id, { n, sessionId: hook.session_id, cwd: hook.cwd, transcriptPath: hook.transcript_path })) process.exit(0);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { release(id); process.exit(0); });

  // The session this waits for. When Claude Code goes (closed, crashed) or moves on to another conversation
  // (/clear), the decision is left for whoever may take it, instead of being handed to nobody.
  // Three readings in a row, so a list entry caught half-written does not count as the session going.
  const claude = claudeProcessFor(hook.session_id);
  const parent = process.ppid;
  let misses = 0;
  const alive = () => {
    const here = claude ? store.claudeSession(claude.pid)?.sessionId === claude.sessionId : process.ppid === parent;
    misses = here ? 0 : misses + 1;
    return misses < 3;
  };

  const res = await awaitDecision(id, {
    n, pid: process.pid, by: `rewake:${hook.session_id}`, early: true, alive, until: Date.now() + RENEW_AFTER_MS,
    to: { sessionId: hook.session_id, transcript: hook.transcript_path },
  });
  if (res.kind === 'timeout') {
    release(id);
    const item = store.getItem(id);
    const v = item && store.currentVersion(item);
    if (!item || !v || v.n !== n || Date.now() - Date.parse(v.createdAt) > RENEW_FOR_MS) process.exit(0);
    process.stderr.write(renewal(id, v.title || item.title) + '\n');
    process.exit(2);
  }
  if (res.kind !== 'decision' && res.kind !== 'early') process.exit(0);
  // The message first: it is taken, and nothing may stand between taking it and saying it.
  process.stderr.write(res.message + '\n');
  try { store.touchSession(hook.session_id, hook.cwd, 'working', { transcript: hook.transcript_path }); }
  catch (e) { store.logHookError('rewake.ts touchSession', e); }
  process.exit(2);
});

/** What the session is woken with when the wait is about to run out: one command, and back to waiting. */
function renewal(id: string, title: string) {
  return `bateson: no response yet on "${title}" (${id}), and this wait is about to run out. Run \`bateson rearm ${id}\` now, then end your turn. Do nothing else and say nothing to the user: they have not answered yet, and this only keeps you waiting for them.`;
}

/** The first line `bateson send`, `draft` and `rearm` print: "queued q_... vN" or "waiting q_... vN". */
function fromOutput(r: unknown) {
  const o = r as { stdout?: unknown; output?: unknown; content?: unknown } | null | undefined;
  const out = typeof r === 'string' ? r : [o?.stdout, o?.output, o?.content].filter(Boolean).join('\n') || JSON.stringify(r ?? '');
  const m = /(?:queued|waiting) (q_[a-z0-9]+) v(\d+)/.exec(out);
  return m ? { id: m[1], n: Number(m[2]) } : null;
}

/** `bateson draft <id>` and `bateson rearm <id>` name their item, so their output is not needed (it was piped away, say). */
function fromCommand(cmd: string) {
  const m = /bateson\b[^\n]*\b(?:draft|rearm)\s+(q_[a-z0-9]+)/.exec(cmd);
  const item = m ? store.getItem(m[1]) : null;
  return item ? { id: item.id, n: store.currentVersion(item).n } : null;
}

/**
 * Without the first line (the output was piped through `tail`, or the command ran in the background and has
 * not finished), the item this session just sent: `bateson send` notes the session itself. Looked for over
 * the next 30 seconds, for a send still running in the background.
 */
async function sentBy(sessionId: string | undefined) {
  if (!store.validSession(sessionId)) return null;
  const since = Date.now() - 120_000;
  for (let i = 0; i < 60; i++) {
    let best: StoredItem | null = null;
    for (const it of store.allQueued()) {
      const v = store.currentVersion(it);
      if (Date.parse(v.createdAt) < since || store.readSession(it)?.sessionId !== sessionId) continue;
      if (store.waiter(it) || store.isDelivered(it, v.n)) continue;
      if (!best || v.createdAt > store.currentVersion(best).createdAt) best = it;
    }
    if (best) return { id: best.id, n: store.currentVersion(best).n };
    await sleep(500);
  }
  return null;
}
