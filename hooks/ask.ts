#!/usr/bin/env node
// PreToolUse (AskUserQuestion). A question an agent asks with Claude Code's own form waits in that terminal,
// where nobody may be looking, and Claude Code goes on without an answer after a while. So the form is not
// shown: its questions go to the queue as an interview round, and the agent is told to wait for the answers
// the way it waits after `bateson send` (`bateson rearm <id>`, which starts hooks/rewake.ts).
//
// The terminal's form is left alone for a single question, which is asked in chat and never sent; when the
// reviewer turned this off in Settings, or has questions and decisions turned off altogether; when nothing can
// wake the session (a headless run); when a question lets several options be picked, which a round cannot
// show; and when anything here fails.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store, { Reviewer } from '../lib/store.ts';
import { canWake } from '../lib/agent.ts';
import { input, guard } from './_io.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bateson.mjs'); // the launcher: it runs the command from its bundle when that is built
type Loose = { [key: string]: unknown };
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * AskUserQuestion's input as an interview round and the item's title, or null when it cannot be one. An option
 * the agent marked "(Recommended)", as Claude Code tells it to, is the round's recommendation.
 */
export function toRound(asked: unknown): { title: string; questions: Loose[] } | null {
  if (!Array.isArray(asked) || !asked.length) return null;
  const questions: Loose[] = [];
  const headers: string[] = [];
  for (const raw of asked as Loose[]) {
    if (!raw || typeof raw !== 'object' || raw.multiSelect === true) return null;
    const asks = text(raw.question);
    const options = Array.isArray(raw.options) ? (raw.options as Loose[]).filter((o) => o && text(o.label)) : [];
    if (!asks || options.length < 2) return null;
    let recommended: number | undefined;
    const MARK = /\s*\(recommended\)\s*$/i;
    const opts = options.map((o, i) => {
      const label = text(o.label);
      if (MARK.test(label) && recommended === undefined) recommended = i;
      return { label: label.replace(MARK, '') || label, ...(text(o.description) ? { description: text(o.description) } : {}) };
    });
    // A round's title is the question itself and ends in a question mark (lib/kinds.ts).
    const title = /\?$/.test(asks) ? asks : `${asks.replace(/[.:;,\s]+$/, '')}?`;
    questions.push({ title, options: opts, ...(recommended === undefined ? {} : { recommended }) });
    if (text(raw.header)) headers.push(text(raw.header));
  }
  const title = (headers.length ? headers.join(', ') : String(questions[0].title)).slice(0, 80);
  return { title, questions };
}

guard(async () => {
  const hook = input();
  if (hook.tool_name !== 'AskUserQuestion') process.exit(0);
  const config = store.readConfig();
  if (!config.terminalQuestions || !config.bring.decisions || !canWake()) process.exit(0);
  const round = toRound(hook.tool_input?.questions);
  // One question is asked in chat, never sent (skill/bateson/SKILL.md), and the terminal's form is chat.
  if (!round || round.questions.length < 2) process.exit(0);
  // Through the command, so that all a send does happens here too: the item is tied to this session, and the
  // window is opened where nothing else would tell the reviewer (Windows).
  const sent = spawnSync(process.execPath, [CLI, 'send', '--title', round.title, '--questions', '-'], {
    input: JSON.stringify({ questions: round.questions }), cwd: hook.cwd || process.cwd(), encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, ...(store.validSession(hook.session_id) ? { CLAUDE_CODE_SESSION_ID: hook.session_id } : {}) },
  });
  const id = /^queued (q_[a-z0-9]+) v\d+/.exec(sent.stdout || '')?.[1];
  if (!id) throw new Error(`the questions could not be sent, so the terminal asks them: ${(sent.stderr || String(sent.error || '')).trim()}`);
  const reason = `bateson: ${Reviewer()} answers a round of questions in bateson, not in the terminal, so these were sent there as "${round.title}" (${id}). Run \`bateson rearm ${id}\` now, then end your turn: you will be woken with the answers. Do not ask again, in chat or with AskUserQuestion, and do not go on with work that depends on the answers.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
});
