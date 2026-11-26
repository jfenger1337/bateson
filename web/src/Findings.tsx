import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { easeHeight, swap } from './lib/motion';
import { keptKey, useKept } from './lib/kept';
import { usePageHeight } from './lib/fit';
import type { Decision, Finding, Item, Mark } from '@lib/types';
import { Markdown } from './Markdown';
import { Ring } from './Ring';
import { isTyping, onTabbedButton, Reach } from './App';

// Findings one at a time, like an interview. K keeps, X dismisses (with an optional reason), C comments. A finding
// you pass without marking counts as kept: its ring stays dashed until you touch it.

interface Draft { mark: 'keep' | 'dismiss'; reason: string; comment: string; touched: boolean; field: 'reason' | 'comment' | null }

const ADVANCE_MS = 220;
const SEVERITY: Record<Finding['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function Findings({ item, onDecide, onLater }: { item: Item; onDecide: (i: Item, d: Decision) => void; onLater: (i: Item) => void }) {
  const list = (item.version.body as { findings: Finding[] }).findings ?? [];
  const kk = keptKey(item);
  const [drafts, setDrafts] = useKept<Record<string, Draft>>(`${kk}:drafts`, () =>
    Object.fromEntries(list.map((f) => [f.id, { mark: 'keep', reason: '', comment: '', touched: false, field: null }])),
  );
  const [at, setAt] = useKept(`${kk}:at`, () => 0);
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  // A finding's picture, full size, over the page until a click or Esc.
  const [zoom, setZoomNow] = useState<string | null>(null);
  const setZoom = (src: string | null) => swap('zoom', () => flushSync(() => setZoomNow(src)));
  const filesBase = `/api/items/${item.id}/files/${item.version.n}/`;
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const reviewing = at === list.length;
  const f = list[at] as Finding | undefined;
  const d = f ? drafts[f.id] : null;
  const kept = list.filter((x) => drafts[x.id].mark === 'keep').length;
  const commenting = !!d && d.mark === 'keep' && (d.field === 'comment' || !!d.comment.trim());
  const plainKeep = !!d && d.mark === 'keep' && !commenting;

  const set = (id: string, patch: Partial<Draft>) => setDrafts((ds) => ({ ...ds, [id]: { ...ds[id], ...patch, touched: true } }));

  const go = (i: number) => {
    clearTimeout(timer.current);
    const n = Math.max(0, Math.min(list.length, i));
    if (n === at) return;
    const root = document.documentElement.style;
    root.setProperty('--q-dir', n > at ? '1' : '-1');
    root.setProperty('--q-from', '0px');
    swap('question', () => flushSync(() => { setDir(n > at ? 'fwd' : 'back'); setAt(n); }));
  };
  const later = (by = 1) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => go(at + by), ADVANCE_MS); };
  const focusField = () => window.setTimeout(() => fieldRef.current?.focus(), 0);

  const keep = () => { if (!f) return; set(f.id, { mark: 'keep', field: null, comment: '' }); later(); };
  // Dismissing is done at once; the reason field opens in case you want to say why. ⏎ goes on either way.
  const dismiss = () => { if (!f) return; clearTimeout(timer.current); set(f.id, { mark: 'dismiss', field: 'reason' }); focusField(); };
  // A comment keeps the finding and tells the agent how to fix it.
  const comment = () => { if (!f) return; clearTimeout(timer.current); set(f.id, { mark: 'keep', field: 'comment' }); focusField(); };

  const send = () => {
    const marks: Mark[] = list.map((x) => {
      const dx = drafts[x.id];
      return dx.mark === 'dismiss'
        ? { id: x.id, mark: 'dismiss', ...(dx.reason.trim() ? { reason: dx.reason.trim() } : {}) }
        : { id: x.id, mark: 'keep', ...(dx.comment.trim() ? { comment: dx.comment.trim() } : {}) };
    });
    onDecide(item, { decision: 'findings', marks });
  };
  const next = () => { if (reviewing) send(); else go(at + 1); };

  useEffect(() => () => clearTimeout(timer.current), []);
  // The finding's height, for the drop above it (app.css).
  const pageRef = usePageHeight<HTMLElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key held down acts once (the arrows aside): its repeats would land on the next item as it arrives.
      if (e.repeat && !isTyping(e) && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (zoom) { if (e.key === 'Escape') { e.preventDefault(); setZoom(null); } return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (isTyping(e)) (e.target as HTMLElement).blur(); send(); return; }
      if (isTyping(e)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // ⏎ on a button reached with Tab presses that button. After a click the button keeps the focus without showing
      // it, and ⏎ goes on as everywhere else.
      if (e.key === 'Enter' && onTabbedButton(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
      else if (e.key === 'k' && f) { e.preventDefault(); keep(); }
      else if (e.key === 'x' && f) { e.preventDefault(); dismiss(); }
      else if (e.key === 'c' && f) { e.preventDefault(); comment(); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); onLater(item); }
      else if (e.key === 'D') { e.preventDefault(); onDecide(item, { decision: 'drop' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ring = (x: Finding) => {
    const dx = drafts[x.id];
    return dx.touched ? 'dot' : 'dashed';
  };

  return (
    <article ref={pageRef} className={`page interview findings arrive hue-${item.hue}`}>
        {/* The dots sit just above the finding, where you are reading: how far through the list you are, at a glance. */}
        <nav className="iv-steps iv-round" aria-label="Findings">
          {list.map((x, i) => (
            <button
              key={x.id}
              className={`iv-step${i === at ? ' here' : ''}${drafts[x.id].mark === 'dismiss' ? ' gone' : ''}`}
              onClick={() => go(i)}
              aria-current={i === at ? 'step' : undefined}
              title={`${x.id} ${x.title}`}
            >
              <Ring kind={i === at ? 'open' : ring(x)} size={10} />
            </button>
          ))}
        </nav>
      {at === 0 && item.version.note && <p className="note">{item.version.note}</p>}

      {reviewing ? (
        <section key="summary" className={`iv-q iv-${dir}`}>
          <h1 className="iv-title">{kept === list.length ? `Keep all ${list.length}` : `Keep ${kept} of ${list.length}`}</h1>
          <ol className="iv-summary fd-summary">
            {list.map((x, i) => {
              const dx = drafts[x.id];
              const note = dx.mark === 'dismiss' ? dx.reason.trim() : dx.comment.trim();
              return (
                <li key={x.id}>
                  <button className="iv-sum-row" onClick={() => go(i)}>
                    <span className="iv-sum-n">{i + 1}</span>
                    <span className="iv-sum-q">{x.id} · {SEVERITY[x.severity]}{x.file ? ` · ${x.file}${x.line ? `:${x.line}` : ''}` : ''}</span>
                    <span className="iv-sum-a">
                      <span className={dx.mark === 'dismiss' ? 'fd-gone' : undefined}>{x.title}</span>
                      <span className="fd-sum-mark">{dx.mark === 'dismiss' ? 'Dismissed' : dx.touched ? 'Kept' : 'Kept (not marked)'}{note ? `: ${note}` : ''}</span>
                    </span>
                    <span className="iv-sum-edit">Change</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : f && d && (
        <section key={f.id} className={`iv-q iv-${dir}`}>
          <p className="kicker fd-kicker">
            <span className={`fd-sev fd-${f.severity}`}>{SEVERITY[f.severity]}</span>
            <span>{f.id}</span>
            {f.file && <span className="rec">{f.file}{f.line ? `:${f.line}` : ''}</span>}
          </p>
          <h1 className="iv-title">{f.title}</h1>
          {f.excerpt && (
            <div className="fd-code" aria-label={`${f.file} around line ${f.line}`}>
              {f.excerpt.lines.map((l, i) => {
                const n = f.excerpt!.start + i;
                return <div key={n} className={`fd-line${n === f.line ? ' here' : ''}`} data-n={n}><code>{l || '​'}</code></div>;
              })}
            </div>
          )}
          {f.body && <Markdown className="prose q-body" text={f.body} />}
          {!!f.images?.length && (
            <div className="fd-shots">
              {f.images.map((name) => {
                const src = filesBase + encodeURIComponent(name);
                return <img key={name} src={src} alt="" title="Click to see it large" onClick={() => setZoom(src)} />;
              })}
            </div>
          )}
          {/* The fix before the choice: you decide having read what the agent would do. */}
          {f.fix && (
            <div className="fd-fix">
              <p className="fd-fix-head">Suggested fix</p>
              <Markdown className="prose" text={f.fix} />
            </div>
          )}
          <div className="options fd-marks" role="radiogroup" aria-label={`What to do with ${f.id}`}>
            <button role="radio" aria-checked={plainKeep} className={`opt${plainKeep ? ' chosen' : ''}${plainKeep && !d.touched ? ' assumed' : ''}`} onClick={keep}>
              <span className="opt-ring"><Ring kind={plainKeep ? (d.touched ? 'dot' : 'dashed') : 'open'} size={18} /></span>
              <span className="opt-text"><span className="opt-label">Keep</span><span className="opt-desc">The agent fixes it.</span></span>
              <span className="key opt-key">K</span>
            </button>
            <div ref={easeHeight} className={`opt own${commenting ? ' chosen' : ''}`}>
              {commenting || d.comment ? (
                <>
                  <span className="opt-ring"><Ring kind={commenting ? 'dot' : 'open'} size={18} /></span>
                  <textarea
                    ref={(el) => { if (d.field === 'comment') fieldRef.current = el; }}
                    className="own-field"
                    rows={2}
                    placeholder="Keep it, and tell the agent how to fix it"
                    value={d.comment}
                    onFocus={() => set(f.id, { mark: 'keep', field: 'comment' })}
                    onChange={(e) => set(f.id, { comment: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); next(); }
                    }}
                  />
                </>
              ) : (
                <button className="own-open" onClick={comment}>
                  <span className="opt-ring"><Ring kind="open" size={18} /></span>
                  <span className="opt-text"><span className="opt-label">Comment</span><span className="opt-desc">Keep it, and say how to fix it.</span></span>
                  <span className="key opt-key">C</span>
                </button>
              )}
            </div>
            <div ref={easeHeight} className={`opt own${d.mark === 'dismiss' ? ' chosen' : ''}`}>
              {d.mark === 'dismiss' ? (
                <>
                  <span className="opt-ring"><Ring kind="dot" size={18} /></span>
                  <span className="opt-text fd-dismissed">
                    <span className="opt-label">Dismissed</span>
                    <input
                      ref={(el) => { if (d.field === 'reason') fieldRef.current = el; }}
                      className="own-field fd-reason"
                      placeholder="Why, if you want to say (⏎ to go on)"
                      value={d.reason}
                      onChange={(e) => set(f.id, { reason: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); next(); }
                      }}
                    />
                  </span>
                </>
              ) : (
                <button className="own-open" onClick={dismiss}>
                  <span className="opt-ring"><Ring kind="open" size={18} /></span>
                  <span className="opt-text"><span className="opt-label">Dismiss</span><span className="opt-desc">The agent leaves it and does not raise it again.</span></span>
                  <span className="key opt-key">X</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {zoom && (
        <div className="zoomed" role="dialog" aria-label="Picture, full size" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
        </div>
      )}

      <footer className="decide">
        <div className="decide-in">
          <p className="decide-sentence">
            <Reach item={item} />
            {list.length - kept ? `${kept} kept, ${list.length - kept} dismissed.` : `All ${list.length} kept so far.`} Unmarked findings count as kept.
          </p>
          <div className="decide-actions">
            <button className="btn-quiet" onClick={() => onDecide(item, { decision: 'drop' })} title="The agent stops (shift D)">Drop</button>
            <button className="btn-ghost" onClick={() => onLater(item)}>Later <span className="key">L</span></button>
            {at > 0 && <button className="btn-pill lg" onClick={() => go(at - 1)}>Back <span className="key">←</span></button>}
            {reviewing ? (
              <button className="btn-primary" onClick={send}>Send <span className="key on-ink">⏎</span></button>
            ) : (
              <button className="btn-primary" onClick={next}>Next <span className="key on-ink">⏎</span></button>
            )}
          </div>
        </div>
      </footer>
    </article>
  );
}
