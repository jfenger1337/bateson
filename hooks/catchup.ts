#!/usr/bin/env node
// UserPromptSubmit and SessionStart. Hand the session any decision on what it sent that it has not received yet
// (on a prompt, or when it is resumed or compacted). Never one another session sent, even once that one has
// ended: it belongs to that conversation, and lands in an unrelated one if handed on. Resuming the session that
// asked gets it there; `bateson inbox` takes it on purpose.
import store, { reviewer, Reviewer } from '../lib/store.ts';
import path from 'node:path';
import { collect, checkoutOf } from '../lib/delivery.ts';
import { overridesNote } from '../lib/recall.ts';
import type { Who } from '../lib/delivery.ts';
import { input, guard } from './_io.ts';
import { snapshot, saveSnapshot, sweepSnapshots } from '../lib/worktree.ts';
import type { Config } from '../lib/types.ts';

guard(async () => {
  const hook = input();
  const event = hook.hook_event_name;
  // A prompt starts a turn that is yours: what it decides, you asked for, so it gets no reminder (hooks/remind.ts).
  const prompt = event === 'UserPromptSubmit';
  const config = store.readConfig();
  // What this session was last told about `bring`: at its start, or on the prompt after a change in Settings.
  const heard = store.sessionRecord(hook.session_id)?.heard;
  store.touchSession(hook.session_id, hook.cwd, prompt ? 'working' : 'idle', { transcript: hook.transcript_path, heard: config.bring, ...(prompt ? { turn: { human: true, reminded: false } } : {}) });
  // Where the working tree stands as the turn begins, for the Stop check.
  if (config.stopCheck) saveSnapshot(hook.session_id, snapshot(hook.cwd));
  if (event === 'SessionStart') sweepSnapshots();
  const who: Who = { sessionId: hook.session_id };
  const parts = event === 'SessionStart' ? [howTheyWork(config.bring, config.preview), lately(hook.cwd)].filter(Boolean) : [];
  if (prompt && heard) { const line = whatChanged(heard, config.bring); if (line) parts.push(line); }
  // "ama" anywhere in a message is the user asking to be interviewed; /ama loads the skill by itself.
  // bateson's own wake-up messages mention the ama skill; only something the user typed counts.
  const said = hook.prompt || '';
  if (prompt && AMA.test(said) && !/^\s*\/ama\b/i.test(said) && !/\bbateson: /.test(said)) parts.push(AMA_ASK);
  // You wrote in the terminal while this session has something waiting in the queue: if this message calls it
  // off, the agent takes it out of the queue rather than leaving you something to answer that nobody wants.
  if (prompt && who.sessionId) { const line = stillOpen(who.sessionId); if (line) parts.push(line); }
  // Decisions on what this session sent, and nothing else: no cwd, so nothing from other sessions in the repo.
  // Taken last, with nothing left to do but say them: a decision taken is marked delivered, so anything that failed
  // (or ran out the hook's time) between taking it and writing it out would lose it for good.
  const msgs = who.sessionId ? collect(who, `${event}:${hook.session_id}`) : [];
  if (msgs.length) {
    const lead = event === 'SessionStart'
      ? 'Responses from bateson to what this session sent, that had not reached it yet:'
      : 'While you were waiting, responses arrived from bateson:';
    parts.push(`${lead}\n\n${msgs.join('\n\n')}`);
  }
  if (!parts.length) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n\n') } }));
});

/** One line naming this session's items still waiting in the queue, or '' when there are none. */
function stillOpen(sessionId: string) {
  const open = store.pending().filter((r) => store.readSession(r.item)?.sessionId === sessionId);
  if (!open.length) return '';
  const names = open.map((r) => `"${r.v.title || r.item.title}" (${r.item.id})`).join(', ');
  const ids = open.map((r) => r.item.id).join(' ');
  return `bateson: ${open.length > 1 ? 'these are' : 'this is'} still waiting in ${reviewer()}'s queue: ${names}. If this message calls ${open.length > 1 ? 'them' : 'it'} off (stop, cancel, never mind, enough questions, go on without my answers), run \`bateson cancel ${ids}\` first, so ${open.length > 1 ? 'they leave' : 'it leaves'} the queue. Otherwise ignore this.`;
}

// What the reviewer chose in Settings or /setup-bateson, as every session hears it at the start. Each kind of
// work: what to send when it is on, its short name, and what to do instead when it is off.
const AMA = /(^|[^\w/`-])(ama|ask me anything)(?![\w`-]| skill)/i;
const AMA_ASK = 'They asked for an ama: load the `ama` skill and interview them in bateson about what this message names, or about the work at hand if it names nothing.';

const YOURSELF = 'decide or fix those yourself and say what you did';
type Bring = Config['bring'];
const BRING: Record<keyof Bring, { send: string; name: string; instead: string }> = {
  decisions: {
    send: 'questions and decisions as interview rounds (direction, trade-offs, taste such as copy, UI and naming, and context only they have), two or more questions to a round. A single question is asked in chat, never sent',
    name: 'questions or decisions',
    instead: 'ask them in chat. An interview they ask for themselves (/ama) still goes to bateson',
  },
  plans: { send: 'plans before big work', name: 'plans', instead: YOURSELF },
  findings: { send: 'review findings, before you fix them', name: 'review findings', instead: YOURSELF },
  code: { send: 'code changes, as a diff', name: 'code for review', instead: YOURSELF },
};
const WORK = Object.keys(BRING) as (keyof Bring)[];
const REPORT = 'When finished work needs a look, send a short report in plain words, with screenshots of anything visual, not the code.';
const or = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];

function howTheyWork(bring: Bring, preview: boolean) {
  const who = reviewer();
  const on = WORK.filter((k) => bring[k]);
  const off = WORK.filter((k) => !bring[k] && BRING[k].instead === YOURSELF);
  return [
    `How ${who} works with bateson (their choices in Settings or /setup-bateson, which override the bateson skill's list of what to send).`,
    on.length ? `Send ${who} ${on.map((k) => BRING[k].send).join('; ')}.` : `Send ${who} nothing unless they ask.`,
    bring.decisions ? '' : `Do not send ${BRING.decisions.name}: ${BRING.decisions.instead}.`,
    off.length ? `Do not send ${or(off.map((k) => BRING[k].name))}: ${YOURSELF}.` : '',
    bring.code ? '' : REPORT,
    preview || !bring.decisions ? '' : 'Ask in words only: they have the preview panel off, so leave `show` and attachments out of questions (a sound on an option still plays).',
  ].filter(Boolean).join(' ');
}

/**
 * The latest times the reviewer went against an agent in this checkout (lib/recall.ts), or ''. It changes only
 * when they answer something, so it costs little more than its length. Reading old answers must never cost the
 * session the rest of what it is told, so a failure here is logged and left out.
 */
function lately(cwd: string | undefined) {
  if (!cwd) return '';
  try {
    const top = checkoutOf(cwd)!;
    return overridesNote({ top, repo: path.basename(top) }, reviewer());
  } catch (e) { store.logHookError('catchup.ts lately', e); return ''; }
}

/** One line for a running session whose `bring` changed since it was told, or '' when nothing did. */
function whatChanged(was: Bring, now: Bring) {
  const added = WORK.filter((k) => now[k] && !was[k]);
  const dropped = WORK.filter((k) => !now[k] && was[k]);
  if (!added.length && !dropped.length) return '';
  const yourself = dropped.filter((k) => BRING[k].instead === YOURSELF);
  return [
    `${Reviewer()} just changed what agents send them in bateson, and this replaces what you were told before.`,
    added.length ? `Now also send ${added.map((k) => BRING[k].send).join('; ')}.` : '',
    dropped.includes('decisions') ? `Stop sending ${BRING.decisions.name}: ${BRING.decisions.instead}.` : '',
    yourself.length ? `Stop sending ${or(yourself.map((k) => BRING[k].name))}: ${YOURSELF}.` : '',
    dropped.includes('code') ? REPORT : '',
  ].filter(Boolean).join(' ');
}
