import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Loading } from './Loading';
import { setTheme } from '@/lib/theme';
import { MAC } from './lib/keys';
import type { Config } from '@lib/types';

// ⌘, : a short list of settings, saved to ~/.bateson/config.json as you change them. Agents can read and
// change the same file (docs/folder-format.md).

type Bring = Config['bring'];
type Extra = 'plans' | 'findings' | 'code';
/** Besides the calls an agent is stuck on: the three ways to set the rest of `bring`. */
const ALSO: Record<'none' | 'plans' | 'all', Pick<Bring, Extra>> = {
  none: { plans: false, findings: false, code: false },
  plans: { plans: true, findings: false, code: false },
  all: { plans: true, findings: true, code: true },
};
type Also = keyof typeof ALSO;
const EXTRA_NAMES: Record<Extra, string> = { plans: 'plans', findings: 'review findings', code: 'code changes' };
/** Which of the three `bring` matches, or null for a mix that only config.json or /setup-bateson can make. */
const alsoOf = (b: Bring) => (Object.keys(ALSO) as Also[]).find((k) => (Object.keys(EXTRA_NAMES) as Extra[]).every((x) => ALSO[k][x] === b[x])) ?? null;

function sendHint(b: Bring, also: Also | null) {
  const asked = b.decisions ? '' : 'Agents ask you the calls they are stuck on in chat. ';
  if (also) return `${asked}Anything ${b.decisions ? '' : 'else '}you leave out, they handle themselves and tell you what they did.`;
  const set = (Object.keys(EXTRA_NAMES) as Extra[]).filter((x) => b[x]).map((x) => EXTRA_NAMES[x]);
  const list = set.length > 1 ? `${set.slice(0, -1).join(', ')} and ${set.at(-1)}` : set[0];
  return `${asked}Right now agents send you ${list}${b.decisions ? ' as well' : ''}. Pick one to change that.`;
}

/** bateson's hooks in Claude Code's settings: without them no answer reaches an agent. */
type Hooks = { state: 'ok' } | { state: 'missing'; busy: boolean; error?: string } | { state: 'fixed' };

export function Settings({ onClose, onChange }: { onClose: () => void; onChange: (c: Config) => void }) {
  const [c, setC] = useState<Config | null>(null);
  const [hooks, setHooks] = useState<Hooks>({ state: 'ok' });
  const [errors, setErrors] = useState<{ count: number; last: string | null }>({ count: 0, last: null });

  useEffect(() => { fetch('/api/config').then((r) => r.json()).then(setC).catch(() => {}); }, []);
  useEffect(() => {
    fetch('/api/hooks').then((r) => r.json()).then((h: { missing: string[]; errors?: { count: number; last: string | null } }) => {
      if (h.missing.length) setHooks({ state: 'missing', busy: false });
      if (h.errors) setErrors(h.errors);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (patch: Partial<Config>) => {
    if (!c) return;
    setC({ ...c, ...patch });
    if (patch.theme) setTheme(patch.theme);
    const res = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const next = await res.json();
    setC(next);
    onChange(next);
  };

  const reconnect = async () => {
    setHooks({ state: 'missing', busy: true });
    try {
      const res = await fetch('/api/hooks', { method: 'POST' });
      const body: { missing?: string[]; error?: string; code?: string } = await res.json();
      if (res.ok && !body.missing?.length) return setHooks({ state: 'fixed' });
      setHooks({ state: 'missing', busy: false, error: body.code === 'invalid'
        ? '~/.claude/settings.json is not valid JSON, so nothing was changed. Fix the file, then try again.'
        : `That did not work${body.error ? ` (${body.error})` : ''}. Running the installer again puts it right.` });
    } catch {
      setHooks({ state: 'missing', busy: false, error: 'bateson’s server did not answer. Try again in a moment.' });
    }
  };

  if (!c) return <Loading />;
  const also = alsoOf(c.bring);

  return (
    <article className="page settings arrive">
      <header className="set-head">
        <button type="button" className="btn-icon set-back" aria-label="Back" title="Back  esc" onClick={onClose}>
          <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <h1 className="iv-title">Settings</h1>
      </header>

      {hooks.state !== 'ok' && (
        <div className={`set-warn${hooks.state === 'fixed' ? ' fixed' : ''}`} role="status">
          <div className="set-text">
            <p className="set-title">{hooks.state === 'fixed' ? 'Answers reach agents again.' : 'Answers cannot reach agents.'}</p>
            <p className="set-hint">
              {hooks.state === 'fixed' ? 'bateson is back in Claude Code’s settings. A copy of the old file sits next to it.'
                : hooks.error ?? 'bateson has dropped out of Claude Code’s settings. Reconnecting puts it back and keeps a copy of the old file.'}
            </p>
          </div>
          {hooks.state === 'missing' && (
            <button type="button" className="btn-pill" disabled={hooks.busy} onClick={reconnect}>{hooks.busy ? 'Reconnecting…' : 'Reconnect'}</button>
          )}
        </div>
      )}

      {errors.count > 0 && (
        <div className="set-warn" role="status">
          <div className="set-text">
            <p className="set-title">{errors.count === 1 ? 'A hook failed in the last day.' : `Hooks failed ${errors.count} times in the last day.`}</p>
            <p className="set-hint">
              An answer may not have reached its agent. The details are in <span className="rec">~/.bateson/hooks.log</span>
              {errors.last ? <>; the latest: <span className="rec">{errors.last.slice(0, 160)}</span></> : null}.
            </p>
          </div>
        </div>
      )}

      <h2 className="set-group">You</h2>
      <Row title="Your name" hint="What agents call you, as in “Sam reviews it first”. Left empty, they say “the user”.">
        <NameField value={c.name} onSave={(name) => save({ name })} />
      </Row>
      <Row title="Appearance">
        <Seg value={c.theme} onChange={(v) => save({ theme: v })} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} />
      </Row>
      <Row title="Preview beside questions" hint="Not available for now. Every question is centred, and agents ask in words only.">
        {/* Shown but not offered yet: the side-by-side layout is parked, and `preview` in config.json still turns it on. */}
        <Switch disabled on={c.preview} onChange={(v) => save({ preview: v })} />
      </Row>
      <Row title="Notification sound">
        <Switch on={c.sound} onChange={(v) => save({ sound: v })} />
      </Row>
      <Row title="Hotkey" hint="Shows and hides the bateson window.">
        <Seg value={c.hotkey} onChange={(v) => save({ hotkey: v })} options={MAC
          ? [['ctrl+option+space', '⌃⌥Space'], ['option+q', '⌥Q'], ['cmd+shift+space', '⌘⇧Space'], ['off', 'Off']]
          // The same settings in the Windows app: option is Alt, and cmd is Ctrl.
          : [['ctrl+option+space', 'Ctrl+Alt+Space'], ['option+q', 'Alt+Q'], ['cmd+shift+space', 'Ctrl+Shift+Space'], ['off', 'Off']]} />
      </Row>
      <Row title="Time to undo" hint="The agent hears nothing until this has passed.">
        <Seg value={String(c.undoSeconds)} onChange={(v) => save({ undoSeconds: Number(v) })} options={undoOptions(c.undoSeconds)} />
      </Row>

      <h2 className="set-group">Agents</h2>
      <Row title="When a session is waiting on you">
        <Seg value={c.blocked} onChange={(v) => save({ blocked: v })} options={[['notify', 'Notify me'], ['notify-forward', 'Notify and open bateson'], ['none', 'Nothing']]} />
      </Row>
      <div className="set-row set-send">
        <div className="set-text">
          <p className="set-title">What agents send you</p>
          <p className="set-hint">{sendHint(c.bring, also)}</p>
        </div>
        <div className="set-sub">
          <span>Calls an agent is stuck on</span>
          <Switch label="Calls an agent is stuck on" on={c.bring.decisions} onChange={(v) => save({ bring: { ...c.bring, decisions: v } })} />
        </div>
        <div className="set-sub">
          <span>Also</span>
          <Seg value={also} onChange={(v) => save({ bring: { ...c.bring, ...ALSO[v] } })} options={[['none', 'Nothing more'], ['plans', 'Plans'], ['all', 'Plans and code review']]} />
        </div>
      </div>
      <Row title="Remind agents to ask you" hint="When an agent starts changing files on a turn you did not start, it is quietly reminded to send you any call that is yours. You never see the reminder.">
        <Switch on={c.stopCheck} onChange={(v) => save({ stopCheck: v })} />
      </Row>

      <p className="set-file rec">~/.bateson/config.json</p>
    </article>
  );
}

/** The usual choices, plus whatever config.json says if it is something else (it allows 0 to 10). */
function undoOptions(current: number): [string, string][] {
  const opts: [string, string][] = [['0', 'No undo'], ['2', '2 s'], ['4', '4 s'], ['8', '8 s']];
  if (!opts.some(([v]) => v === String(current))) opts.push([String(current), `${current} s`]);
  return opts.sort((a, b) => Number(a[0]) - Number(b[0]));
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <p className="set-title">{title}</p>
        {hint && <p className="set-hint">{hint}</p>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** `value` null: config.json holds something none of the options is, so none is picked. */
function Seg<T extends string>({ value, options, onChange }: { value: T | null; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={`seg-item${value === v ? ' on' : ''}`} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

/** Saved when you leave the field or press Return, not on every keystroke. */
function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value) onSave(v.trim()); };
  return (
    <input
      className="set-input" value={v} placeholder="the user" maxLength={40} spellCheck={false} aria-label="Your name"
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.nativeEvent.stopPropagation(); setV(value); } }}
    />
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}
