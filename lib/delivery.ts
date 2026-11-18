// Getting a decision to the agent that asked, exactly once, and to no other. The rewake hook waits for it, the
// catch-up hook and `bateson inbox` hand over what nobody received, and `bateson wait` blocks on it. All of them
// go through claim(), so a decision is told once however many of them race.
//
// Who may take a decision: the session that sent the item, always. The hooks ask only for that. `bateson inbox`
// also asks for its checkout, and may then take one whose session has ended (by Claude Code's own list of
// running sessions); never one whose session is still open.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import store from './store.ts';
import type { StoredItem } from './store.ts';
import { formatDecision, formatEarly, deliveryMark } from './kinds.ts';
import { agent } from './agent.ts';

/**
 * Take delivery of a decided version: the message for the agent, to exactly one caller; null if it is not
 * decided yet or someone else already took it. The item is filed under done. `to` names the session it goes to
 * and its transcript, so a wake-up's delivery can be checked later.
 */
export function claim(id: string, n: number, by?: string, to: { sessionId?: string; transcript?: string } = {}) {
  const item = store.getItem(id);
  // Not while a send is writing the item's next version: what is decided may be about to change under it.
  if (!item || store.replacing(item) || !store.readDecision(item, n)) return null;
  // The message first: a decision that cannot be told is left undelivered (and the error logged by the caller),
  // never marked delivered and lost.
  const msg = formatDecision(item, n);
  if (msg == null || !store.claimDelivery(item, n, by, to)) return null;
  store.fileAway(item);
  return msg;
}

/** The decision on an item, delivered or not: for `bateson status`. */
export function peek(id: string) {
  const item = store.getItem(id);
  return item ? formatDecision(item, store.currentVersion(item).n) : null;
}

/** Note which session sent an item, keeping what is known of it already (its transcript) when it is the same one. */
export function own(item: StoredItem, s: { sessionId: string; cwd?: string; transcriptPath?: string }) {
  if (!store.validSession(s.sessionId)) return;
  const prev = store.readSession(item);
  const same = prev?.sessionId === s.sessionId;
  store.writeSession(item, {
    agent: agent(), sessionId: s.sessionId, cwd: s.cwd || (same ? prev?.cwd : undefined),
    transcriptPath: s.transcriptPath || (same ? prev?.transcriptPath : undefined),
  });
}

/** A hook is waiting on this version for its session: note who sent it and who is waiting. */
export function register(id: string, { pid = process.pid, n, sessionId, cwd, transcriptPath }: {
  pid?: number; n: number; sessionId?: string; cwd?: string; transcriptPath?: string;
}) {
  const item = store.getItem(id);
  if (!item) return false;
  if (sessionId) own(item, { sessionId, cwd, transcriptPath });
  store.writeWaiter(item, { pid, sessionId, n });
  return true;
}

/** Stop waiting, if the waiter is still this process's. */
export function release(id: string, pid = process.pid) {
  const item = store.getItem(id);
  if (item) store.clearWaiter(item, pid);
}

/** How a wait ended. See awaitDecision. */
export type Outcome = { kind: 'decision' | 'early'; message: string } | { kind: 'elsewhere' | 'gone' | 'withdrawn' | 'timeout' | 'abandoned' };

/**
 * Wait for the decision on version n of an item (the current version when n is left out).
 * Resolves to one of:
 *   { kind: 'decision', message }  the decision, claimed for this caller
 *   { kind: 'early', message }     answers to questions that open others, given before the rest of the round
 *   { kind: 'elsewhere' }          someone else took the decision, a newer version arrived, or a newer waiter took over
 *   { kind: 'gone' }               the item no longer exists
 *   { kind: 'withdrawn' }          its agent cancelled it (`bateson cancel`): there is nothing to wait for
 *   { kind: 'abandoned' }          `alive` said the session this waits for is not there any more
 *   { kind: 'timeout' }
 * With `pid`, the caller is the item's registered waiter: it touches waiter.json each time round, so others can
 * tell it is still there, and gives up as soon as it is not the waiter any more. `to` is passed on to claim().
 *
 * Between looks it waits `every` ms, but the item's folder is watched, so a decision or an early answer is seen
 * at once rather than at the next look. The looks are for what leaves no change there (the session going away),
 * and for a system where the watch says nothing. Each look reads several files, which Windows makes slow, so
 * they are spaced out. `pause`, given, replaces both the wait and the watch.
 */
export async function awaitDecision(id: string, { n, pid, by, to, alive, until = Infinity, every = 2000, early = false, pause }: {
  n?: number; pid?: number; by?: string; to?: { sessionId?: string; transcript?: string }; alive?: () => boolean;
  until?: number; every?: number; early?: boolean; pause?: (ms: number) => Promise<unknown>;
} = {}): Promise<Outcome> {
  let stop = null as (() => void) | null;
  let changed = false;
  let wake = null as (() => void) | null;
  const watched = (ms: number) => new Promise<void>((resolve) => {
    if (changed) { resolve(); return; }
    const done = () => { clearTimeout(timer); wake = null; resolve(); };
    let timer = setTimeout(done, ms);
    // A send or a decision writes a few files in a row: look once they are written, not at the first. Never more
    // than a few looks a second, whatever keeps changing in the folder.
    wake = () => { clearTimeout(timer); timer = setTimeout(done, 200); };
  });
  try {
    return await waitFor(id, { n, pid, by, to, alive, until, every, early, pause: pause ?? watched, before: (item) => {
      changed = false;
      if (!pause && !stop) stop = store.watchItem(item, () => { changed = true; wake?.(); });
    } });
  } finally { stop?.(); }
}

async function waitFor(id: string, { n, pid, by, to, alive, until, every, early, pause, before }: {
  n?: number; pid?: number; by?: string; to?: { sessionId?: string; transcript?: string }; alive?: () => boolean;
  until: number; every: number; early: boolean; pause: (ms: number) => Promise<unknown>; before: (item: StoredItem) => void;
}): Promise<Outcome> {
  for (;;) {
    const item = store.getItem(id);
    if (!item) return { kind: 'gone' };
    before(item);
    if (store.readWithdrawn(item)) { if (pid != null) store.clearWaiter(item, pid); return { kind: 'withdrawn' }; }
    const v = store.currentVersion(item);
    const want = n ?? v.n;
    if (pid != null && store.readWaiter(item)?.pid !== pid) return { kind: 'elsewhere' };
    if (v.n !== want) { if (pid != null) store.clearWaiter(item, pid); return { kind: 'elsewhere' }; }
    // Checked before taking the decision: a waiter whose session is gone must leave it for a session that is not.
    if (alive && !alive()) { if (pid != null) store.clearWaiter(item, pid); return { kind: 'abandoned' }; }
    // A send writing the next version: wait for it, and see what it left.
    if (!store.replacing(item) && store.readDecision(item, want)) {
      const message = claim(id, want, by, to);
      if (message) return { kind: 'decision', message };
      if (!store.replacing(item)) return { kind: 'elsewhere' };
    }
    if (early) {
      const answers = store.unreportedEarly(item, want);
      if (answers.length) {
        store.markEarlyReported(item, want, answers.map((a) => a.id));
        if (pid != null) store.clearWaiter(item, pid);
        return { kind: 'early', message: formatEarly(item, want, answers) };
      }
    }
    if (Date.now() >= until) return { kind: 'timeout' };
    if (pid != null) store.beat(item, pid);
    await pause(every);
  }
}

const tops = new Map<string, string>();
/**
 * The checkout a folder belongs to: its git top level, so a session started in a subfolder still counts as the
 * same repository. A worktree is its own checkout, usually some other piece of work. Outside git, the folder.
 */
export function checkoutOf(dir: string | undefined) {
  if (!dir) return null;
  if (!tops.has(dir)) {
    let top = null;
    try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null; } catch { /* not git, or gone */ }
    tops.set(dir, path.resolve(top || dir)); // resolved, like source.top: git says C:/x on Windows
  }
  return tops.get(dir)!;
}

/** Who is asking for decisions: their own session, and the checkout they work in for decisions nobody can take any more. */
export interface Who { sessionId?: string; cwd?: string }

/**
 * Whether `who` may take an item's decision: it is theirs (sent from their session), or it comes from their
 * checkout and the session that sent it has ended. Items a live hook is waiting on are left to it.
 */
function mayTake(it: StoredItem, { sessionId, cwd }: Who, live: ReturnType<typeof store.liveSessions>, here: string | null) {
  if (store.waiter(it)) return false;
  const owner = store.readSession(it)?.sessionId;
  if (sessionId && owner === sessionId) return true;
  if (!here) return false;
  return (it.source?.top || checkoutOf(it.source?.cwd)) === here && store.ownerGone(it, live);
}

/** Decided items nobody has received that `who` may take (see mayTake). */
export function pendingFor(who: Who) {
  const live = store.liveSessions();
  const here = who.cwd ? checkoutOf(who.cwd) : null;
  return store.undelivered().filter((it) => mayTake(it, who, live, here));
}

/** How long after a wake-up its delivery is given to show in the transcript before it counts as lost. */
const SETTLE_MS = 60_000;

/**
 * Wake-up deliveries that never reached their conversation, which `who` may take: the hook handed the decision
 * over and exited, but the transcript of the session it went to does not have it (the session closed or crashed
 * at that moment, or the hook was stopped between taking the decision and handing it on). Deliveries found in
 * their transcript are marked confirmed on the way, and are not looked at again.
 */
export function lostFor(who: Who) {
  const live = store.liveSessions();
  const here = who.cwd ? checkoutOf(who.cwd) : null;
  const out: { item: StoredItem; n: number }[] = [];
  for (const { item, n, delivered } of store.unconfirmed()) try {
    if (Date.now() - Date.parse(delivered.at) < SETTLE_MS) continue;
    const transcript = delivered.transcript || store.readSession(item)?.transcriptPath;
    // Nowhere to look: there is no telling, and asking again on every prompt would repeat it for ever.
    if (!transcript) { store.confirmDelivery(item, n); continue; }
    let text: string | null = null;
    try { text = fs.readFileSync(transcript, 'utf8'); } catch { /* gone with its session: lost */ }
    if (text?.includes(deliveryMark(item.id, n))) { store.confirmDelivery(item, n); continue; }
    if (mayTakeLost(item, who, delivered.sessionId, live, here)) out.push({ item, n });
  } catch (e) { store.logHookError('lostFor', e); } // moved meanwhile (sent again, say): looked at next time
  return out;
}

function mayTakeLost(it: StoredItem, { sessionId, cwd }: Who, deliveredTo: string | undefined, live: ReturnType<typeof store.liveSessions>, here: string | null) {
  const owner = deliveredTo || store.readSession(it)?.sessionId;
  if (sessionId && owner === sessionId) return true;
  if (!here || !cwd) return false;
  return (it.source?.top || checkoutOf(it.source?.cwd)) === here && (!owner || !live || !live.has(owner));
}

const AGAIN = 'bateson: this response was handed to a session earlier but may not have reached it. If you already have it, ignore this.';

/** Claim everything pendingFor() and lostFor() find: the messages, in order. */
export function collect(who: Who, by: string) {
  // The lost ones first, each on its own: a delivery to check can fail (its item moved meanwhile), and nothing that
  // goes wrong there may come after a fresh decision has been taken and so cost it.
  const again: string[] = [];
  for (const { item, n } of lostFor(who)) {
    try {
      const m = formatDecision(item, n);
      if (m != null && store.claimRedelivery(item, n, by)) again.push(`${AGAIN}\n${m}`);
    } catch (e) { store.logHookError('collect: redelivery', e); }
  }
  const fresh = pendingFor(who).map((it) => claim(it.id, store.currentVersion(it).n, by)).filter((m) => m !== null);
  return [...fresh, ...again];
}

/**
 * Where an undecided item's decision will go, for the app: a hook is waiting for it ('waiting'), the session
 * that sent it is still open and gets it on its next prompt ('its-session'), or that session has ended and gets
 * it if resumed, or `bateson inbox` in its checkout takes it ('ended').
 */
export function reachOf(item: StoredItem, live = store.liveSessions()): 'waiting' | 'its-session' | 'ended' {
  if (store.waiter(item)) return 'waiting';
  return store.ownerGone(item, live) ? 'ended' : 'its-session';
}
