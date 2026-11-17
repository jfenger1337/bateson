import { useEffect, useState } from 'react';
import type { State } from '@lib/types';
import { Ring } from './Ring';

// The empty queue: the agents at work on something they sent you.

// The entrance plays once per launch. Coming back here (from settings, from an item) shows the page as it is.
let arrived = false;


export function Empty({ agents, writing, update, onUpdate }: Pick<State, 'agents' | 'writing'> & { update?: State['update']; onUpdate: () => void }) {
  const now = useNow(30_000);
  const [again] = useState(arrived);
  useEffect(() => { arrived = true; }, []);

  const writingBySession = new Map(writing.filter((w) => w.sessionId).map((w) => [w.sessionId!, w]));
  // Each agent goes by its session's title; the repository is said only when they are not all in the same one.
  const manyRepos = new Set(agents.map((a) => a.repo)).size > 1;

  return (
    <div className={`calm${again ? ' again' : ''}`}>
      <h1 className="calm-head">All caught up</h1>
      {/* Only here, where nothing waits on you: a new version never comes between you and a question. */}
      {update?.state === 'available' && (
        <p className="calm-update">A new version of bateson is ready. <button type="button" className="btn-link" onClick={onUpdate}>See what’s new</button></p>
      )}

      {(agents.length > 0 || writing.length > 0) && (
        <ul className="agents">
          {agents.map((a, i) => {
            const w = writingBySession.get(a.sessionId);
            return (
              <li key={a.sessionId} style={{ animationDelay: `${450 + i * 70}ms` }}>
                <Ring kind="dashed" size={13} />
                <span className="agent-repo" title={a.repo}>{a.title || a.repo || 'a session'}</span>
                {a.title && manyRepos && a.repo && <span className="agent-where">{a.repo}</span>}
                <span className="agent-what">
                  {w ? (a.title === w.title ? `writing round ${w.next}` : <>writing round {w.next} of <span className="ink">{w.title}</span></>) : now - Date.parse(a.since) < 60_000 ? 'just started' : `working for ${ago(now - Date.parse(a.since), true)}`}
                </span>
              </li>
            );
          })}
          {writing.filter((w) => !w.sessionId || !agents.some((a) => a.sessionId === w.sessionId)).map((w, i) => (
            <li key={w.id} style={{ animationDelay: `${450 + (agents.length + i) * 70}ms` }}>
              <Ring kind="dashed" size={13} />
              <span className="agent-what">Round {w.next} of <span className="ink">{w.title}</span> is being written</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function ago(ms: number, bare = false) {
  const m = Math.round(ms / 60_000);
  const s = m < 1 ? (bare ? 'a moment' : 'just now') : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return bare || m < 1 ? s : `${s} ago`;
}
