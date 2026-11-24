// Full or reduced motion: the setting ("motion" in config.json), or the system's when the setting is "system".
// The answer goes on <html data-motion>, which base.css and app.css read, and reduced() answers the same for the
// code that moves things itself (Splash, Pixel). index.html sets it before the first paint from the copy kept in
// localStorage, so the launch splash already knows. "full" is for someone whose system asks for reduced motion
// everywhere (Windows' Animation effects off) but who wants bateson to move.

export type Motion = 'system' | 'full' | 'reduced';
const KEY = 'bateson:motion';
const system = window.matchMedia('(prefers-reduced-motion: reduce)');
let pref: Motion = 'system';

function paint() {
  document.documentElement.dataset.motion = pref === 'system' ? (system.matches ? 'reduced' : 'full') : pref;
}

export const reduced = () => document.documentElement.dataset.motion === 'reduced';

export function setMotion(next: Motion | undefined) {
  pref = next === 'full' || next === 'reduced' ? next : 'system';
  try { localStorage.setItem(KEY, pref); } catch { /* private window: the system's motion until the config loads */ }
  paint();
}

system.addEventListener('change', paint);

// What a swap changes, which says what on the page takes part (app.css, "Swaps"): `item` is the whole work (the
// next item, settings and back), `question` one question for another inside an item, `zoom` a picture's full size.
export type Swap = 'item' | 'question' | 'zoom';

type Doc = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * A change of what is on screen, with the old leaving as the new arrives (the browser's view transition). `update`
 * makes the change and must have it on the page when it returns (flushSync). Where the browser has no view
 * transitions, with reduced motion, and under the launch splash, the change is made at once.
 */
export function swap(kind: Swap, update: () => void) {
  const doc = document as Doc;
  const root = document.documentElement;
  if (!doc.startViewTransition || reduced() || document.hidden || document.querySelector('.splash')) { update(); return; }
  root.dataset.swap = kind;
  const done = () => { if (root.dataset.swap === kind && now === running) delete root.dataset.swap; };
  const now = ++running;
  try { doc.startViewTransition(update).finished.then(done, done); } catch { done(); update(); }
}
let running = 0;

/** The spring a keyboard pick lands with (--ease-spring), for what the code moves itself. */
export function press(el: Element | null | undefined) {
  if (!el || reduced() || !el.animate) return;
  const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim() || 'ease-out';
  try { el.animate([{ scale: 0.985 }, { scale: 1 }], { duration: 320, easing: ease }); } catch { /* an easing this browser does not know: no press */ }
}
