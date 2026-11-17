import { useCallback, useEffect, useRef, useState } from 'react';
import type { Decision, Item, State } from '@lib/types';
import { Interview } from './Interview';
import { Review } from './Review';
import { Findings } from './Findings';
import { Empty } from './Empty';
import { Settings } from './Settings';
import { Splash } from './Splash';
import { Loading } from './Loading';
import { Spinner } from '@/components/ui/spinner';
import { Toaster, toast } from 'sonner';
import { Settings as Gear } from 'lucide-react';
import { MOD, MOD_KEY, modHeld } from './lib/keys';
import { setTheme } from '@/lib/theme';
import { forgetKept } from '@/lib/kept';


// `at` is the version's createdAt as you saw it: if the agent replaced that version since, the server refuses
// the decision instead of letting it land on text you never read.
interface Held { id: string; n: number; at: string; decision: Decision; label: string; timer: number; done?: boolean; undo?: () => void }

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [held, setHeld] = useState<Held[]>([]);
  const [settings, setSettings] = useState(false);
  const undoMs = useRef(4000);
  const heldRef = useRef<Held[]>([]);
  // The undo for the newest held decision, for ⌘Z.
  const undoRef = useRef<(() => void) | null>(null);
  heldRef.current = held;
  // The item on screen stays in front while it is still waiting, so a revision or a waiting session arriving
  // elsewhere does not pull it away mid-comment. Later clears it, to let the queue move on.
  const shownRef = useRef<string | undefined>(undefined);

  // The server says "change" for any file in the queue, agents' comings and goings included, and every 15 seconds
  // regardless. Most of those change nothing on screen, so an answer like the last one is let go, and the item in
  // front keeps its identity while it reads the same: what it worked out (the new parts of a revision, coloured
  // code) is not worked out again. Answers can cross on the way back; only the newest ask's counts.
  const asked = useRef(0);
  const lastText = useRef('');
  const lastShown = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const q = new URLSearchParams();
    const skip = heldRef.current.map((h) => h.id).join(',');
    if (skip) q.set('skip', skip);
    if (shownRef.current) q.set('prefer', shownRef.current);
    const mine = ++asked.current;
    try {
      const res = await fetch(`/api/state${q.toString() ? `?${q}` : ''}`);
      const text = await res.text();
      if (mine !== asked.current) return;
      setFailed(false);
      if (text === lastText.current) { shownRef.current = lastShown.current; return; }
      const s = JSON.parse(text);
      lastText.current = text;
      shownRef.current = lastShown.current = s.current?.id;
      setState((prev) => (prev?.current && s.current && JSON.stringify(prev.current) === JSON.stringify(s.current) ? { ...s, current: prev.current } : s));
      if (s.config) { undoMs.current = s.config.undoSeconds * 1000; setTheme(s.config.theme); }
    } catch { if (mine === asked.current) setFailed(true); }
  }, []);

  useEffect(() => {
    load();
    let es: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onmessage = () => load();
      // A new build: reload, unless you are mid-comment or mid-answer.
      es.addEventListener('reload', () => {
        const busy = document.activeElement?.tagName === 'TEXTAREA' || heldRef.current.length > 0;
        if (!busy) location.reload();
      });
      es.onerror = () => { es?.close(); setFailed(true); retry = window.setTimeout(connect, 2000); };
      es.onopen = () => setFailed(false);
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); };
  }, [load]);

  useEffect(() => { load(); }, [held, load]);

  const count = (state?.queue.length ?? 0);
  useEffect(() => { document.title = count ? `(${count}) bateson` : 'bateson'; }, [count]);

  const commit = useCallback(async (h: Held) => {
    h.done = true;
    const res = await fetch(`/api/items/${h.id}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: h.n, at: h.at, ...h.decision }),
    });
    setHeld((hs) => hs.filter((x) => x.id !== h.id));
    if (res.ok) forgetKept(h.id);
    if (!res.ok) {
      const { error, code } = await res.json().catch(() => ({ error: 'It did not go through.' }));
      // Refused because the agent sent a newer version meanwhile: that version is now waiting, so offer to bring it to the front.
      const action = code === 'stale'
        ? { label: 'Show it', onClick: () => { shownRef.current = h.id; load(); } }
        : { label: 'Dismiss', onClick: () => {} };
      toast(error, { duration: Infinity, action });
    }
  }, [load]);

  const decide = useCallback((item: Item, decision: Decision) => {
    const h: Held = { id: item.id, n: item.version.n, at: item.version.createdAt, decision, label: item.decisions[decision.decision] ?? decision.decision, timer: 0 };
    const ms = undoMs.current;
    if (ms <= 0) { setHeld((hs) => [...hs, h]); commit(h); return; }
    h.timer = window.setTimeout(() => commit(h), ms);
    const undo = () => {
      if (h.done) return;
      h.done = true;
      clearTimeout(h.timer);
      setHeld((hs) => hs.filter((x) => x.id !== h.id));
      if (undoRef.current === undo) undoRef.current = null;
    };
    h.undo = undo;
    undoRef.current = undo;
    setHeld((hs) => [...hs, h]);
  }, [commit]);

  const later = useCallback(async (item: Item) => {
    await fetch(`/api/items/${item.id}/later`, { method: 'POST' });
    if (shownRef.current === item.id) shownRef.current = undefined;
    load();
  }, [load]);

  // Commit anything held if the page closes, so nothing is lost.
  useEffect(() => {
    const flush = () => {
      for (const h of heldRef.current) {
        navigator.sendBeacon(`/api/items/${h.id}/decide`, new Blob([JSON.stringify({ n: h.n, at: h.at, ...h.decision })], { type: 'application/json' }));
      }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // The selection is drawn as a highlight on the text itself. WebKit's own selection paints whole blocks,
  // margins and gaps included, which reads as a slab of yellow across the page.
  useEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !H) return;
    document.documentElement.classList.add('own-selection');
    const paint = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { reg.delete('qr-selection'); return; }
      reg.set('qr-selection', new H(sel.getRangeAt(0).cloneRange()));
    };
    document.addEventListener('selectionchange', paint);
    return () => { document.removeEventListener('selectionchange', paint); reg.delete('qr-selection'); };
  }, []);

  // Key hints show only while ⌘ (Ctrl on Windows) is held.
  useEffect(() => {
    const root = document.documentElement;
    const on = (e: KeyboardEvent) => { if (e.key === MOD_KEY) root.classList.add('keys'); };
    const off = (e: KeyboardEvent) => { if (e.key === MOD_KEY || !modHeld(e)) root.classList.remove('keys'); };
    const clear = () => root.classList.remove('keys');
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', off);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('keyup', off); window.removeEventListener('blur', clear); };
  }, []);

  // ⌘, (Ctrl+, on Windows) opens settings; the Mac app's menu sends the same through an event.
  useEffect(() => {
    const open = () => setSettings((v) => !v);
    const onKey = (e: KeyboardEvent) => { if (modHeld(e) && e.key === ',') { e.preventDefault(); open(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('qr-settings', open);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('qr-settings', open); };
  }, []);

  // ⌘Z undoes the last held decision.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && undoRef.current && !isTyping(e)) { e.preventDefault(); undoRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const item = state?.current ?? null;
  const after = Math.max(0, count - 1);
  // Where you are in an interview or a set of findings: its dots sit in the bar, after the item's name.
  const [steps, setSteps] = useState<HTMLElement | null>(null);
  // The project is said only when the queue holds more than one, which is when it tells items apart.
  const projects = new Set(state?.queue.map((r) => r.repo).filter(Boolean)).size;
  // Back in an interview you already answered a round of: said in words on its first question only.
  const round = item?.kind === 'interview' ? item.history.filter((h) => h.bodyType === 'questions').length + 1 : 1;
  const [firstQ, setFirstQ] = useState(true);
  // The newest decision still on hold: the bar says what it was and offers to take it back, until it goes through.
  const said = [...held].reverse().find((h) => h.undo && !h.done);
  // A version the agent replaced before you decided keeps its number but is new text: it starts over, with
  // nothing carried from the one it replaced (answers, marks and comments belong to what you read).
  const viewKey = item ? `${item.id}:${item.version.n}:${item.version.createdAt}` : '';

  // Toasts sit just above the decision bar, which grows to two rows in a narrow window and is gone when the
  // queue is empty. So its height is measured, not assumed.
  useEffect(() => {
    const root = document.documentElement;
    const bar = document.querySelector<HTMLElement>('.decide');
    if (!bar) { root.style.setProperty('--decide-h', '0px'); return; }
    const ro = new ResizeObserver(() => root.style.setProperty('--decide-h', `${bar.offsetHeight}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [viewKey, settings]);

  return (
    <div className="frame">
      <header className={`bar${item ? ` hue-${item.hue}` : ''}`}>
        <div className="bar-left">
          <span className="wordmark">bateson</span>
          {said ? (
            <span className="bar-sentence said" role="status">
              {said.label}
              <button type="button" className="btn-link inline bar-undo" onClick={said.undo}>Undo</button>
              <span className="bar-key" aria-hidden>{MOD}Z</span>
            </span>
          ) : item && (
            // Keyed by the item, so the name arrives (a rise, a tint in its colour) only when the item changes.
            <span key={item.id} className="bar-name" title={item.title}>
              <span className="bar-title">{item.title}</span>
              {projects > 1 && item.source?.repo && <span className="bar-project">{item.source.repo}</span>}
              {round > 1 && firstQ && <span className="bar-round">round {round}</span>}
            </span>
          )}
          <span ref={setSteps} className="bar-steps" hidden={!!said} />
        </div>
        <div className="bar-right">
          {item && after > 0 && <span className="bar-sentence">{after === 1 ? 'One more after this' : `${after} more after this`}</span>}
          {failed && <span className="bar-sentence late"><Spinner variant="ellipsis" size={14} aria-hidden />Not connected. Is <span className="rec">bateson serve</span> running?</span>}
          {!failed && item && !settings && item.reach !== 'waiting' && (
            <span className="bar-sentence reach" role="status" title={reachLine(item)}>{reachLine(item)}</span>
          )}
        </div>
      </header>

      <main className="work">
        {settings ? (
          <Settings onClose={() => setSettings(false)} onChange={(c) => { undoMs.current = c.undoSeconds * 1000; setState((s) => s && { ...s, config: c }); }} />
        ) : !state ? <Loading /> : item ? (
          item.kind === 'interview'
            ? <Interview key={viewKey} item={item} steps={steps} panel={state.config.preview} onDecide={decide} onFirst={setFirstQ} />
            : item.kind === 'findings'
              ? <Findings key={viewKey} item={item} steps={steps} onDecide={decide} onLater={later} />
              : <Review key={viewKey} item={item} onDecide={decide} onLater={later} />
        ) : (
          <Empty agents={state.agents ?? []} writing={state.writing ?? []} />
        )}
      </main>

      {/* Only for what did not go through: one at a time, above the decision bar. Sonner keeps the live region and
          the stacking; the look is ours (.toast). A decision that went through is said in the bar instead. */}
      <Toaster
        position="bottom-center"
        visibleToasts={1}
        duration={3000}
        offset={{ bottom: 'calc(var(--decide-h, 60px) + 16px)' }}
        mobileOffset={{ bottom: 'calc(var(--decide-h, 60px) + 16px)' }}
        toastOptions={{ unstyled: true, classNames: { toast: 'toast', actionButton: 'btn-link inline toast-undo' } }}
      />

      {/* Settings, in the corner while ⌘ is held (:root.keys): the same as ⌘, for a hand already on the mouse. */}
      <button type="button" className="btn-icon lg corner-gear" aria-label="Settings" title={`Settings  ${MOD},`} aria-pressed={settings} onClick={() => setSettings((v) => !v)}>
        <Gear size={20} strokeWidth={1.75} aria-hidden />
      </button>

      <Splash />
    </div>
  );
}


/** Where an answer goes when no agent is waiting for it, so you know it will not wake anything now. */
function reachLine(item: Item) {
  const repo = item.source?.repo;
  return item.reach === 'its-session'
    ? 'Its agent stopped waiting. It gets your answer when you next write to it.'
    : `No session is waiting for it. The next one you start${repo ? ` in ${repo}` : ''} gets your answer.`;
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
}
