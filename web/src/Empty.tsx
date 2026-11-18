import { useEffect, useState } from 'react';
import type { State } from '@lib/types';
import { Ring } from './Ring';
import { Pixel } from './Pixel';

// The empty queue: the agents at work on something they sent you.

// The entrance plays once per launch. Coming back here (from settings, from an item) shows the page as it is.
let arrived = false;
// The AMAs already on the page: one that ends while you are here rises in at the top, as the page did when it arrived.
const seen = new Set<string>();


export function Empty({ agents, writing, amas, update, onUpdate }: Pick<State, 'agents' | 'writing' | 'amas'> & { update?: State['update']; onUpdate: () => void }) {
  const now = useNow(30_000);
  const [again] = useState(arrived);
  useEffect(() => { arrived = true; }, []);
  useEffect(() => { for (const a of amas) seen.add(a.id); }, [amas]);

  const writingBySession = new Map(writing.filter((w) => w.sessionId).map((w) => [w.sessionId!, w]));
  // Each agent goes by its session's title; the repository is said only when they are not all in the same one.
  const manyRepos = new Set(agents.map((a) => a.repo)).size > 1;
  const manyAmaRepos = new Set(amas.map((a) => a.repo)).size > 1;

  return (
    <div className={`calm${again ? ' again' : ''}`}>
      <Settled />
      {/* Only here, where nothing waits on you: a new version never comes between you and a question. */}
      {update?.state === 'available' && (
        <p className="calm-update"><Pixel name="gift" still={again} />A new version of bateson is ready. <button type="button" className="btn-link" onClick={onUpdate}>See what’s new</button></p>
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

      {/* The AMAs behind you, newest on top, each fainter than the one above it. */}
      {amas.length > 0 && (
        <ul className="amas" aria-label="Recent AMAs">
          {amas.map((a, i) => (
            <li key={a.id} className={again && !seen.has(a.id) ? 'new' : undefined}
              style={{ '--i': i, animationDelay: again ? undefined : `${450 + (agents.length + writing.length + i) * 70}ms` } as React.CSSProperties}>
              <Ring kind="dot" size={13} />
              <span className="ama-title">{a.title}</span>
              {a.repo && manyAmaRepos && <span className="ama-meta">{a.repo}</span>}
              <span className="ama-when">{when(a.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** When an AMA ended, as you would say it: the time today, "yesterday", the weekday this week, else the date. */
function when(iso: string, now: number) {
  const d = new Date(iso);
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// One filled dot, quietly in grey: in bateson's notation a decided thing, so nothing is left pending.
// The same inked edge as the logo (Logo.tsx), under its own filter so it does not depend on the bar being there.
function Settled() {
  return (
    <svg className="calm-mark" width="28" height="28" viewBox="0 0 12 12" fill="currentColor" role="img" aria-label="Nothing waiting on you">
      <defs>
        <filter id="bt-rough-calm" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.25" numOctaves="2" seed="4" result="noise" /><feDisplacementMap in="SourceGraphic" in2="noise" scale="0.5" xChannelSelector="R" yChannelSelector="G" /></filter>
      </defs>
      <circle cx="6" cy="6" r="4.6" filter="url(#bt-rough-calm)" />
    </svg>
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
