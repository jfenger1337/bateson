import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Item } from '@lib/types';

// What you have done on an item but not sent yet: answers picked, findings marked, comments left. Kept in
// sessionStorage so a reload (a new build of the app, ⌘R, the server coming back) puts it back where it was.
// The Mac app's web view keeps sessionStorage across reloads; a new launch starts clean.

const PREFIX = 'bateson:kept:';

/** One version of one item: a newer version starts fresh. */
export const keptKey = (item: Item) => `${item.id}:${item.version.n}:${item.version.createdAt}`;

function read<T>(key: string): T | undefined {
  try {
    const s = sessionStorage.getItem(PREFIX + key);
    return s == null ? undefined : (JSON.parse(s) as T);
  } catch { return undefined; }
}

function write(key: string, value: unknown) {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private window or full: only this reload is lost */ }
}

/** useState that survives a reload. */
export function useKept<T>(key: string, init: () => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read<T>(key) ?? init());
  // Nothing is written while there is nothing to keep: an item only looked at leaves nothing behind. A value
  // already kept is always written, so going back to empty is kept too.
  useEffect(() => {
    let kept = false;
    try { kept = sessionStorage.getItem(PREFIX + key) != null; } catch { /* no storage */ }
    if (kept || JSON.stringify(value) !== JSON.stringify(init())) write(key, value);
  }, [key, value]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue];
}

/** A ref that survives a reload; call save() after changing it. */
export function useKeptRef<T>(key: string, init: () => T) {
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = read<T>(key) ?? init();
  return { ref: ref as { current: T }, save: () => write(key, ref.current) };
}

/** Once a decision has gone through, its item's kept work is no longer needed. */
export function forgetKept(itemId: string) {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(`${PREFIX}${itemId}:`)) sessionStorage.removeItem(k);
    }
  } catch { /* nothing kept */ }
}
