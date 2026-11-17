import { useState } from 'react';
import { Spinner } from './components/ui/spinner';
import type { UpdateView } from '@lib/types';

// Settings › Updates: where a new version stands, what is in it, and the one button to install it
// (lib/update.ts does the work). It follows the server's update.json, which the page reads with the rest of the state.

export function UpdatePanel({ update }: { update: UpdateView }) {
  const [asking, setAsking] = useState<'check' | 'install' | null>(null);
  const [lost, setLost] = useState(false);

  const check = async () => {
    setAsking('check');
    try { await fetch('/api/update/check', { method: 'POST', headers: { 'content-type': 'application/json' } }); setLost(false); } catch { setLost(true); }
    setAsking(null);
  };
  const install = async () => {
    setAsking('install');
    try { await fetch('/api/update', { method: 'POST', headers: { 'content-type': 'application/json' } }); setLost(false); } catch { setLost(true); }
    setAsking(null);
  };

  const u = update;
  const n = u.changes.length + u.more;
  const changes = n > 0 && (
    <ul className="set-changes">
      {u.changes.map((c) => <li key={c.hash}>{c.subject}</li>)}
      {u.more > 0 && <li className="more">and {u.more} more</li>}
    </ul>
  );
  const checked = u.checkedAt ? `Checked ${ago(u.checkedAt)}.` : 'Not checked yet.';
  const recently = u.updatedAt && Date.now() - Date.parse(u.updatedAt) < 24 * 3600 * 1000 ? `Updated ${ago(u.updatedAt)}.` : '';

  let title: string, hint: string, action: React.ReactNode = null;
  switch (u.state) {
    case 'available':
      title = n === 1 ? 'A new version is ready, with one change' : `A new version is ready, with ${n} changes`;
      hint = 'bateson restarts by itself afterwards. Agents waiting on you keep waiting.';
      action = <button type="button" className="btn-pill" disabled={!!asking} onClick={install}>Update</button>;
      break;
    case 'updating':
      title = 'Updating';
      hint = `${u.step || 'Starting'}…`;
      action = <Spinner variant="ellipsis" size={16} aria-hidden />;
      break;
    case 'blocked':
      title = n ? 'A new version is out, but bateson cannot install it' : 'bateson cannot update itself';
      hint = u.reason || '';
      action = <button type="button" className="btn-pill" disabled={!!asking} onClick={check}>{asking === 'check' ? 'Checking…' : 'Check again'}</button>;
      break;
    case 'failed':
      title = 'The update did not go through';
      hint = u.reason || '';
      action = <button type="button" className="btn-pill" disabled={!!asking} onClick={install}>Try again</button>;
      break;
    case 'restart':
      title = 'Updated';
      hint = u.reason || '';
      break;
    default:
      title = 'bateson is up to date';
      hint = [recently, u.note, checked, u.error].filter(Boolean).join(' ');
      action = <button type="button" className="btn-pill" disabled={!!asking} onClick={check}>{asking === 'check' ? 'Checking…' : 'Check now'}</button>;
  }
  if (lost) hint = `${hint} bateson’s server did not answer. Try again in a moment.`.trim();

  return (
    <div className={`set-row set-update${u.state === 'failed' || u.state === 'blocked' ? ' warn' : ''}`}>
      <div className="set-head-row">
        <div className="set-text">
          <p className="set-title">{title}</p>
          {hint && <p className="set-hint">{hint}</p>}
        </div>
        <div className="set-control">{action}</div>
      </div>
      {u.state !== 'current' && u.state !== 'restart' && changes}
    </div>
  );
}

/** "3 min ago", "2 h ago", "yesterday", or a date. */
export function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
