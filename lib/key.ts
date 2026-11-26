// Who may talk to the server. It listens on this machine only, but every account on the machine can reach that:
// without a key, another person logged in here could read your queue, answer for you (and an answer is an
// instruction to your agent) or start an update. So the server keeps a key in the queue's folder, which only you
// can read, and answers the API only to who has it: the command and the Mac app read the file, and a page is given
// a cookie when `bateson open` (or a send, on Windows) opens it with a ticket: a one-time address good for half a
// minute, so the key itself is never on a command line for other accounts to see.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import store, { PORT } from './store.ts';

const FILE = () => path.join(store.ROOT, 'key');

/** The key, made the first time it is asked for. Two processes asking at once agree on the one that got there first. */
export function accessKey(): string {
  const read = () => { try { return fs.readFileSync(FILE(), 'utf8').trim(); } catch { return ''; } };
  const had = read();
  if (had) return had;
  store.ensureDirs();
  // Written whole to a file of its own, then linked into place, which fails if a key is there already: no one ever
  // reads a key file that is there but still empty. An empty one (left by a crash, or a full disk, before this was
  // so) is no key, and is replaced.
  const tmp = `${FILE()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    const st = fs.statSync(FILE(), { throwIfNoEntry: false });
    if (st && st.size === 0 && Date.now() - st.mtimeMs > 5000) fs.rmSync(FILE(), { force: true });
    try { fs.linkSync(tmp, FILE()); } catch (e) {
      // A file system without hard links: written in place, if no other got there first.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fs.copyFileSync(tmp, FILE(), fs.constants.COPYFILE_EXCL);
    }
  } catch { /* nowhere to write: said below */ } finally { fs.rmSync(tmp, { force: true }); }
  const key = read();
  if (!key) throw new Error(`bateson could not write its key to ${FILE()}.`);
  return key;
}

/** Whether `given` is the key, compared without saying how much of it was right. */
export function sameKey(given: string | undefined, key: string) {
  if (!given) return false;
  const hash = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(given), hash(key));
}

/**
 * An address that opens bateson signed in, from the running server: null when it does not answer, or is a version
 * from before it asked who is there (its plain address opens it then).
 */
export async function ticketUrl(): Promise<string | null> {
  try {
    // 127.0.0.1, where the server listens (cli/bateson.ts appStatus says why not localhost).
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ticket`, {
      method: 'POST', signal: AbortSignal.timeout(2000),
      headers: { host: `localhost:${PORT}`, 'content-type': 'application/json', authorization: `Bearer ${accessKey()}` },
    });
    const { ticket } = (res.ok ? await res.json() : {}) as { ticket?: unknown };
    return typeof ticket === 'string' ? `http://localhost:${PORT}/?ticket=${ticket}` : null;
  } catch { return null; }
}
