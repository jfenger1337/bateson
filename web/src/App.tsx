import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Config, Decision, Item, State } from '@lib/types';
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
import { setMotion, swap } from '@/lib/motion';
import { forgetKept } from '@/lib/kept';
import { Logo } from './Logo';
import { AppMenu } from './Menu';


// `at` is the version's createdAt as you saw it: if the agent replaced that version since, the server refuses
// the decision instead of letting it land on text you never read.
/** The server's answer to a look at the queue: its text, and how many changes the server had told of by then. */
interface Answer { ok: boolean; status: number; text: string; told: number }
const ask = async (url: string): Promise<Answer> => {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, text: await res.text(), told: Number(res.headers.get('x-bateson-told') || NaN) };
};
/** The first look, asked for by the page itself before this script had started (index.html); taken once. */
let taken = false;
function early(): Promise<Answer> | undefined {
  // Read once only: once deleted, the name would find any element of the page named so (a picture in an agent's
  // markdown, <img name="__batesonState">), and every later look at the queue would fail on it.
  if (taken) return undefined;
  taken = true;
  const w = window as unknown as { __batesonState?: unknown };
  const p = w.__batesonState;
  delete w.__batesonState;
  return p instanceof Promise ? (p as Promise<Answer>) : undefined;
}

interface Held { id: string; n: number; at: string; decision: Decision; label: string; timer: number; done?: boolean; undone?: boolean; sent?: boolean; undo?: () => void }

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [locked, setLocked] = useState(false);
  // Why the server cannot start, when what answers in its place says (lib/node-check.mjs: a Node too old for it).
  const [why, setWhy] = useState<string | null>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [settings, setSettingsNow] = useState(false);
  const settingsRef = useRef(false);
  settingsRef.current = settings;
  // Settings and back is a swap of the whole work, as the next item is.
  const setSettings = useCallback((v: boolean | ((was: boolean) => boolean)) => swap('item', () => flushSync(() => setSettingsNow(v))), []);
  const undoMs = useRef(4000);
  const heldRef = useRef<Held[]>([]);
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
  // How many changes the server had told of when it gave the answer on screen, how many it says it has told of now
  // (the live updates say so as they connect), and how many looks are on their way. A look that turns out older than
  // the updates' connecting is taken again; one that is not saves the second look every page used to open with.
  const told = useRef(NaN);
  const toldNow = useRef(NaN);
  const flying = useRef(0);
  const lastView = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const q = new URLSearchParams();
    const skip = heldRef.current.map((h) => h.id).join(',');
    if (skip) q.set('skip', skip);
    if (shownRef.current) q.set('prefer', shownRef.current);
    const mine = ++asked.current;
    flying.current++;
    try {
      const res = await (early() ?? ask(`/api/state${q.toString() ? `?${q}` : ''}`)).finally(() => { flying.current--; });
      const text = res.text;
      if (mine !== asked.current) return;
      told.current = res.told;
      // Something was told between this look and the live updates connecting: it may not be in this answer.
      if (res.told < toldNow.current) { toldNow.current = NaN; load(); }
      // Not the queue: what stands in for a server that cannot start answers 503 with why (lib/node-check.mjs).
      // Not this browser's to see yet: the server answers only a page it was opened for (lib/key.ts).
      setLocked(res.status === 401);
      if (res.status === 401) return;
      if (!res.ok) { setFailed(true); return; }
      setFailed(false);
      if (text === lastText.current) { shownRef.current = lastShown.current; return; }
      const s: State = JSON.parse(text);
      // The item in front of you went because its agent cancelled it (you told it to stop, in its terminal):
      // say so, rather than have it vanish.
      const gone = lastShown.current && lastShown.current !== s.current?.id ? s.cancelled?.find((c) => c.id === lastShown.current) : undefined;
      if (gone && !heldRef.current.some((h) => h.id === gone.id)) toast(`Cancelled by its agent: ${gone.title}`);
      // What you had started on an item its agent cancelled is not needed any more.
      for (const c of s.cancelled || []) forgetKept(c.id);
      lastText.current = text;
      shownRef.current = lastShown.current = s.current?.id;
      const put = () => setState((prev) => (prev?.current && s.current && JSON.stringify(prev.current) === JSON.stringify(s.current) ? { ...s, current: prev.current } : s));
      // Another thing in front (the next item, a new version of this one, the empty page): the old leaves as it
      // arrives. Behind settings nothing on screen changes, and the first answer has nothing to leave.
      const view = s.current ? `${s.current.id}:${s.current.version.n}:${s.current.version.createdAt}` : '';
      if (lastView.current !== undefined && lastView.current !== view && !settingsRef.current) swap('item', () => flushSync(put)); else put();
      lastView.current = view;
      if (s.config) { undoMs.current = s.config.undoSeconds * 1000; setTheme(s.config.theme); setMotion(s.config.motion); }
    } catch { if (mine === asked.current) setFailed(true); }
  }, []);

  useEffect(() => {
    load();
    let es: EventSource | null = null;
    let retry: number | undefined;
    let reloading: number | undefined;
    let first = true;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onmessage = (e) => {
        // The updates connecting, the first time: the page has just looked, or is looking. Only if the server has
        // told of a change since that look is there anything new. When they connect again, anything may have changed.
        const hello = /^hello (\d+)$/.exec(String(e.data));
        if (hello && first) {
          first = false;
          toldNow.current = Number(hello[1]);
          if (flying.current > 0 || told.current >= toldNow.current) return;
        }
        first = false;
        load();
      };
      // A new build: reload, unless you are mid-comment or mid-answer.
      es.addEventListener('reload', () => {
        const reload = () => {
          const busy = document.activeElement?.tagName === 'TEXTAREA' || heldRef.current.length > 0;
          // Not now, then as soon as you are done: the page would otherwise stay on the old build.
          if (busy) { clearTimeout(reloading); reloading = window.setTimeout(reload, 2000); } else location.reload();
        };
        reload();
      });
      es.onerror = () => {
        es?.close(); setFailed(true); retry = window.setTimeout(connect, 2000);
        fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then(
          (h: { error?: unknown }) => setWhy(typeof h.error === 'string' ? h.error : null), () => setWhy(null));
      };
      es.onopen = () => { setFailed(false); setWhy(null); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); clearTimeout(reloading); };
  }, [load]);

  // Again whenever a decision is held or let go: the queue is asked without the held items. Not when the page
  // opens, which has asked already.
  const opened = useRef(false);
  useEffect(() => { if (opened.current) load(); else opened.current = true; }, [held, load]);

  const count = (state?.queue.length ?? 0);
  useEffect(() => { document.title = count ? `(${count}) bateson` : 'bateson'; }, [count]);

  const commit = useCallback(async (h: Held) => {
    h.done = true;
    // The server restarts after an update: a decision made at that moment is tried again for a few seconds
    // rather than lost. Until it lands, the item stays held, so it is not shown again under you.
    let res: Response | null = null;
    let tries = 0;
    for (; tries < 6 && !res; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 1000));
      try {
        res = await fetch(`/api/items/${h.id}/decide`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ n: h.n, at: h.at, ...h.decision }),
        });
      } catch { /* not answering yet */ }
    }
    setHeld((hs) => hs.filter((x) => x.id !== h.id));
    if (!res) {
      toast('Your decision did not reach bateson: the server is not answering. The item is back in the queue; decide it again.', { duration: Infinity, action: { label: 'Dismiss', onClick: () => {} } });
      return;
    }
    const body = res.ok ? null : await res.json().catch(() => ({ error: 'It did not go through.' }));
    // A try that went through but whose answer was lost, then tried again: it is decided, by this.
    const landed = res.ok || (tries > 1 && body?.code === 'decided');
    if (landed) forgetKept(h.id);
    else {
      const { error, code } = body;
      // Refused because the agent sent a newer version meanwhile: that version is now waiting, so offer to bring it
      // to the front. Refused because the agent cancelled it ('withdrawn'): the message says so, and that is all.
      const action = code === 'stale'
        ? { label: 'Show it', onClick: () => { shownRef.current = h.id; load(); } }
        : { label: 'Dismiss', onClick: () => {} };
      toast(error, { duration: Infinity, action });
    }
  }, [load]);

  const decide = useCallback((item: Item, decision: Decision) => {
    // A double click or a key pressed twice decides once: a second held decision would outlive the Undo of the first.
    if (heldRef.current.some((x) => x.id === item.id)) return;
    const h: Held = { id: item.id, n: item.version.n, at: item.version.createdAt, decision, label: item.decisions[decision.decision] ?? decision.decision, timer: 0 };
    const ms = undoMs.current;
    heldRef.current = [...heldRef.current, h]; // at once, not at the next render
    if (ms <= 0) { setHeld((hs) => [...hs, h]); commit(h); return; }
    h.timer = window.setTimeout(() => commit(h), ms);
    const undo = () => {
      if (h.done) return;
      h.done = true;
      h.undone = true;
      clearTimeout(h.timer);
      shownRef.current = h.id; // back in front, where it was decided
      setHeld((hs) => hs.filter((x) => x.id !== h.id));
    };
    h.undo = undo;
    setHeld((hs) => [...hs, h]);
  }, [commit]);

  const later = useCallback(async (item: Item) => {
    try {
      const res = await fetch(`/api/items/${item.id}/later`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      toast('Later did not go through: bateson’s server did not take it. Try again in a moment.');
      return;
    }
    if (shownRef.current === item.id) shownRef.current = undefined;
    load();
  }, [load]);

  // Commit anything held if the page closes, so nothing is lost: one still waiting out its Undo, and one being sent
  // (tried again while the server restarts), which the closing page would cut off; a second arrival is refused as
  // already decided. Each is then done: its timer stops, so a page brought back from the browser's cache does not
  // send it a second time, and it is let go when that happens.
  useEffect(() => {
    const flush = () => {
      for (const h of heldRef.current) {
        if (h.undone || h.sent) continue;
        h.done = true;
        h.sent = true;
        clearTimeout(h.timer);
        navigator.sendBeacon(`/api/items/${h.id}/decide`, new Blob([JSON.stringify({ n: h.n, at: h.at, ...h.decision })], { type: 'application/json' }));
        forgetKept(h.id);
      }
    };
    const back = (e: PageTransitionEvent) => { if (e.persisted) setHeld((hs) => hs.filter((h) => !h.sent)); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('pageshow', back);
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('pageshow', back); };
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

  // ⌘Z undoes the newest decision still on hold: the one the bar offers to take back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z' || isTyping(e)) return;
      const last = [...heldRef.current].reverse().find((h) => h.undo && !h.done);
      if (last) { e.preventDefault(); last.undo!(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const item = state?.current ?? null;
  // Where you are in an interview or a set of findings: its dots sit in the bar, after the item's name.
  // The project is said only when the queue holds more than one, which is when it tells items apart.
  const projects = new Set(state?.queue.map((r) => r.repo).filter(Boolean)).size;
  // The newest decision still on hold: the bar says what it was and offers to take it back, until it goes through.
  const said = [...held].reverse().find((h) => h.undo && !h.done);
  // A version the agent replaced before you decided keeps its number but is new text: it starts over, with
  // nothing carried from the one it replaced (answers, marks and comments belong to what you read).
  const viewKey = item ? `${item.id}:${item.version.n}:${item.version.createdAt}` : '';

  // A review opens with its title on the page, an interview with its name beside the dots, so the bar names the item
  // only once that has scrolled under it.
  const [titleOnPage, setTitleOnPage] = useState(false);
  useLayoutEffect(() => {
    const title = settings ? null : document.querySelector<HTMLElement>('.work-title, .iv-name');
    if (!title) { setTitleOnPage(false); return; }
    const barH = Math.round(document.querySelector('.bar')?.getBoundingClientRect().height ?? 0);
    setTitleOnPage(title.getBoundingClientRect().bottom > barH);
    const io = new IntersectionObserver(([e]) => setTitleOnPage(e.isIntersecting), { rootMargin: `-${barH}px 0px 0px 0px` });
    io.observe(title);
    return () => io.disconnect();
  }, [viewKey, settings]);
  const project = projects > 1 ? item?.source?.repo : undefined;

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

  // The theme from the right-click menu: saved as the Appearance setting is (Settings.tsx).
  // One the server does not take is put back as it was.
  const theme = useCallback(async (t: Config['theme']) => {
    let was: Config['theme'] | undefined;
    const show = (x: Config['theme']) => { setTheme(x); setState((s) => { if (s && x === t) was ??= s.config.theme; return s && { ...s, config: { ...s.config, theme: x } }; }); };
    show(t);
    try {
      const res = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: t }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      if (was) show(was);
      toast('The appearance did not save: bateson’s server did not take it. Try again in a moment.');
    }
  }, []);

  return (
    <AppMenu
      theme={state?.config.theme ?? 'system'}
      onTheme={theme}
      onSettings={() => setSettings(true)}
      later={item && !settings && item.kind !== 'interview' ? () => later(item) : undefined}
      undo={said?.undo ? { label: said.label, run: said.undo } : undefined}
    >
    <div className="frame">
      <header className={`bar${item ? ` hue-${item.hue}` : ''}`}>
        <div className="bar-left">
          <Logo />
          {said ? (
            <span className="bar-sentence said" role="status">
              {said.label}
              <button type="button" className="btn-link inline bar-undo" onClick={said.undo}>Undo</button>
              <span className="bar-key" aria-hidden>{MOD}Z</span>
            </span>
          ) : item && (!titleOnPage || project) && (
            // Keyed by the item, so the name arrives (a rise, a tint in its colour) only when the item changes.
            <span key={item.id} className="bar-name" title={item.title}>
              {!titleOnPage && <span className="bar-title">{item.title}</span>}
              {project && <span className="bar-project">{project}</span>}
            </span>
          )}
        </div>
        <div className="bar-right">
          {failed && !locked && (why
            // Reloading shows the page that says why in full, with what to do; it is a link, so nothing half written is lost unasked.
            ? <span className="bar-sentence late" title={why}>The bateson server cannot start. <a className="bar-undo" href="/">See why</a></span>
            : <span className="bar-sentence late"><Spinner variant="ellipsis" size={14} aria-hidden />Not connected. Is <span className="rec">bateson serve</span> running?</span>)}
        </div>
      </header>

      <main className="work">
        {locked ? <Locked /> : settings ? (
          <Settings update={state?.update} theme={state?.config.theme} onClose={() => setSettings(false)} onChange={(c) => { undoMs.current = c.undoSeconds * 1000; setState((s) => s && { ...s, config: c }); }} />
        ) : !state ? <Loading /> : item ? (
          item.kind === 'interview'
            ? <Interview key={viewKey} item={item} panel={state.config.preview} onDecide={decide} />
            : item.kind === 'findings'
              ? <Findings key={viewKey} item={item} onDecide={decide} onLater={later} />
              : <Review key={viewKey} item={item} onDecide={decide} onLater={later} />
        ) : (
          <Empty agents={state.agents ?? []} writing={state.writing ?? []} amas={state.amas ?? []} update={state.update} onUpdate={() => setSettings(true)} />
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

      <Splash waiting={failed || (state ? !!state.current : undefined)} />
    </div>
    </AppMenu>
  );
}


/** Where an answer goes when no agent is waiting for it, so you know it will not wake anything now. */
/** Whether the answer reaches the agent that asked, said above the decision buttons when it would not at once. */
export function Reach({ item }: { item: Item }) {
  if (item.reach === 'waiting') return null;
  // Two wordings, one shown: on a phone the full one took two or three lines of a bar that sits over the work, so
  // it says the same in a line (app.css, .reach-short). The hidden one is display: none, so a screen reader reads one.
  return (
    <span className="decide-reach" role="status">
      <span className="reach-long">{reachLine(item)}</span>
      <span className="reach-short">{reachLine(item, true)}</span>
    </span>
  );
}

function reachLine(item: Item, short = false) {
  const repo = item.source?.repo;
  if (item.reach === 'its-session') return short ? 'Its agent stopped waiting. It hears this when you next write.' : 'Its agent stopped waiting. It gets your answer when you next write to it.';
  return short ? 'Its session has ended. Resume it to deliver this.' : `The session that asked${repo ? ` in ${repo}` : ''} has ended. It gets your answer if you resume it.`;
}

// Whether the focus was last moved with Tab, not the mouse. :focus-visible cannot say: a key pressed on a button
// that was clicked makes it match, and the key in question is the one being asked about.
let tabbed = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbed = true; }, true);
window.addEventListener('pointerdown', () => { tabbed = false; }, true);

/** A key pressed on a button or a link that Tab brought the focus to: the key is that button's. */
export function onTabbedButton(e: KeyboardEvent) {
  return tabbed && !!(e.target as HTMLElement | null)?.closest?.('button, a[href]');
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  // In a menu, keys move and pick in the menu: none is a shortcut for the item behind it.
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable || !!t.closest?.('[role="menu"]'));
}

/**
 * What a page shows that the server will not answer: one opened by address alone, in a browser bateson has not
 * been opened in before. The command opens it signed in, and this page goes on by itself once it is (it keeps asking).
 */
function Locked() {
  return (
    <div className="calm again">
      <div className="locked">
        <h1>This browser is not signed in to your bateson</h1>
        <p>Run <span className="rec">bateson open</span> in a terminal, or ask your agent to. It opens bateson here, and this browser stays signed in.</p>
        <p className="locked-why">bateson answers only you: other accounts on this machine can reach its address too, and an answer here is an instruction to your agent.</p>
      </div>
    </div>
  );
}
