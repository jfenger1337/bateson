// What a turn changed in the repository, however it changed it: the Edit tool, sed, a heredoc, a script.
// catchup.ts records the working tree when a prompt arrives and nudge.ts again when a turn ends; remind.ts
// compares against the last record. Outside a git repository there is nothing to compare, and remind.ts goes
// by the Edit and Write calls alone.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionsDir } from './store.ts';

/** sessions/<id>.tree: the checkout, its HEAD, and each changed or untracked file's "<status>|<mtime>|<size>" (or "<status>|gone"). */
export interface Snapshot { top: string; head: string | null; files: Record<string, string> }

const DIR = sessionsDir();
const DAY = 24 * 3600 * 1000;

function git(args: string[], cwd: string) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; }
}

/**
 * A folder's checkout and the commit HEAD is at, each null when there is none. A repository without a commit yet
 * has git fail on HEAD after it has said the checkout, so what it printed is read either way.
 */
function topAndHead(cwd: string): [string | null, string | null] {
  let out = '';
  try { out = execFileSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }); }
  catch (e) { out = String((e as { stdout?: unknown }).stdout ?? ''); }
  const [top, head] = out.split('\n').map((l) => l.trim());
  return [top || null, /^[0-9a-f]{40,64}$/.test(head || '') ? head : null];
}

/** The repository's HEAD and every changed or untracked file with a signature of its state. */
export function snapshot(cwd: string | undefined): Snapshot | null {
  if (!cwd) return null;
  // The checkout and its HEAD from one git process, not two: each start of git is slow on Windows, and this runs
  // on every prompt and at the end of every turn.
  const [top, head] = topAndHead(cwd);
  if (!top) return null;
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], top);
  if (out == null) return null;
  const files: Record<string, string> = {};
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // a rename carries its old path as the next entry
    let st = null;
    try { st = fs.statSync(path.join(top, p)); } catch { /* deleted */ }
    files[p] = `${xy}|${st ? `${Math.round(st.mtimeMs)}|${st.size}` : 'gone'}`;
  }
  return { top, head, files };
}

/** Files that changed between an earlier snapshot and now, commits made in between included. */
export function changedSince(before: Snapshot | null, now: Snapshot | null) {
  if (!before || !now || before.top !== now.top) return null;
  const changed = new Set<string>();
  // A file that was already changed when the turn began and has not been touched since, only committed (or
  // staged), is not an edit of this turn.
  const untouched = (p: string) => {
    const was = before.files[p];
    if (!was || was.endsWith('|gone')) return false;
    try { const st = fs.statSync(path.join(now.top, p)); return was.slice(3) === `${Math.round(st.mtimeMs)}|${st.size}`; } catch { return false; }
  };
  for (const [p, sig] of Object.entries(now.files)) if (before.files[p] !== sig && !untouched(p)) changed.add(p);
  for (const p of Object.keys(before.files)) if (!(p in now.files) && !untouched(p)) changed.add(p); // reverted, or edited and committed
  if (before.head && now.head && before.head !== now.head) {
    for (const p of (git(['diff', '--name-only', before.head, now.head], now.top) || '').split('\n')) if (p && !untouched(p)) changed.add(p);
  }
  return changed;
}

const file = (sessionId: string) => path.join(DIR, `${sessionId}.tree`);
const valid = (sessionId: string | undefined): sessionId is string => !!sessionId && /^[\w-]+$/.test(sessionId);

export function saveSnapshot(sessionId: string | undefined, snap: Snapshot | null) {
  if (!valid(sessionId) || !snap) return;
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(sessionId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, file(sessionId));
}

export function loadSnapshot(sessionId: string | undefined): Snapshot | null {
  if (!valid(sessionId)) return null;
  try { return JSON.parse(fs.readFileSync(file(sessionId), 'utf8')); } catch { return null; }
}

/** Forget the records of sessions gone a day. */
export function sweepSnapshots() {
  let files: string[] = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tree')); } catch { return; }
  for (const f of files) {
    try { if (Date.now() - fs.statSync(path.join(DIR, f)).mtimeMs > DAY) fs.rmSync(path.join(DIR, f), { force: true }); } catch { /* gone */ }
  }
}
