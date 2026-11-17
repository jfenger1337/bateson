// What the app is sent: the queue, the item in front of you, and who is at work while it is empty. The
// shapes are lib/types.ts, the contract the app reads too; `npm run typecheck` checks both sides against it.
import store, { reviewer } from './store.ts';
import { kindOf, previousOf } from './kinds.ts';
import { reachOf } from './delivery.ts';
import type { StoredItem } from './store.ts';
import type { Item, Round, State, Summary } from './types.ts';

export function itemView(item: StoredItem): Item {
  const v = store.currentVersion(item);
  const kind = kindOf(item, v);
  return {
    id: item.id,
    hue: store.hueOf(item),
    kind: kind.name,
    decisions: kind.decisions,
    title: v.title || item.title,
    source: item.source,
    createdAt: item.createdAt,
    version: {
      n: v.n, bodyType: v.bodyType, note: v.note, createdAt: v.createdAt, replaced: !!v.replaced,
      body: store.readBody(item, v), files: store.attachments(item, v.n),
    },
    previous: previousOf(item, v),
    history: item.versions.slice(0, -1).map((pv) => ({
      n: pv.n, title: pv.title, note: pv.note, bodyType: pv.bodyType,
      body: pv.bodyType === 'questions' ? store.readBody(item, pv) as Round : undefined,
      decision: store.readDecision(item, pv.n),
    })),
    waiting: !!store.waiter(item),
    reach: reachOf(item),
  };
}

/**
 * The page's state. `skip`: items the page is holding a decision on (the seconds Undo is offered). `prefer`:
 * the item on screen, which stays in front while it is still waiting, so a revision arriving does not pull it
 * away from under you.
 */
export function stateView({ skip = [], prefer }: { skip?: string[]; prefer?: string } = {}): State {
  const all = [...store.allQueued(), ...store.allDone()]; // listed once: done grows with every decision
  const live = store.liveSessions(); // and Claude Code's sessions once, for both lists that need them
  const rows = store.pending().filter((r) => !skip.includes(r.item.id));
  // Items waiting from before items had colours take theirs in the order they arrived.
  for (const r of [...rows].sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt))) store.hueOf(r.item);
  const front = rows.find((r) => r.item.id === prefer) || rows[0];
  const sent = lastSentBy(all);
  return {
    reviewer: reviewer(),
    queue: rows.map((r) => ({ id: r.item.id, n: r.v.n, title: r.v.title || r.item.title, kind: kindOf(r.item, r.v).name, repo: r.item.source?.repo, waiting: r.waiting })),
    current: front ? itemView(front.item) : null,
    config: store.readConfig(),
    writing: store.writing(all, live).map(({ id, title, next, sessionId }) => ({ id, title, next, sessionId })),
    cancelled: store.withdrawnSince(Date.now() - 10 * 60 * 1000, all.filter((it) => !store.isQueued(it)))
      .map(({ item, w }) => ({ id: item.id, title: store.versionOf(item, w.n)?.title || item.title, at: w.at })),
    // Only agents that have sent you something today: a session that is just busy has nothing coming your way.
    agents: store.activeSessions(live).filter(({ sessionId }) => sent.has(sessionId))
      .map(({ sessionId, repo, title, since }) => ({ sessionId, repo, title: sent.get(sessionId) || title || undefined, since })),
  };
}

/**
 * The title of the latest item each session sent in the last day: only these sessions are listed as at work,
 * and each goes by it, so its row reads the same as the question it put to you.
 */
function lastSentBy(all: StoredItem[]): Map<string, string> {
  const day = Date.now() - 24 * 3600 * 1000;
  const best = new Map<string, { at: string; title: string }>();
  for (const it of all) {
    const v = store.currentVersion(it);
    if (Date.parse(v.createdAt) < day) continue;
    const id = store.readSession(it)?.sessionId;
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || v.createdAt > prev.at) best.set(id, { at: v.createdAt, title: v.title || it.title });
  }
  return new Map([...best].map(([id, b]) => [id, b.title]));
}

/** For the Mac shell's menubar and Dock badge: cheap enough to poll. */
export function summaryView(): Summary {
  const rows = store.pending();
  return {
    count: rows.length,
    config: store.readConfig(),
    waiting: rows.filter((r) => r.waiting).map((r) => ({ id: r.item.id, n: r.v.n, title: r.v.title || r.item.title, repo: r.item.source?.repo })),
  };
}
