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

/**
 * A ref for a box whose height follows what is typed in it (the row of your own answer): when its content takes
 * another line, or gives one back, the box eases to the new height instead of jumping, and what sits under it
 * moves with it. Nothing is clipped while it does: the letter that started the new line is on the page at once,
 * and the box comes to it. A change of width (the window resized) is not eased: that is the text reflowing.
 * `foot` names what sits under the text inside the box (a note's buttons): it rides the box's lower edge, so it
 * is never left hanging outside the box while the box catches up.
 */
export function easeHeight(el: HTMLElement | null, foot?: string) {
  if (!el || typeof ResizeObserver === 'undefined' || !el.animate) return;
  let h = el.offsetHeight, w = el.offsetWidth;
  let run: Animation | null = null;
  const ro = new ResizeObserver(() => {
    if (run) return; // its own steps; a change made meanwhile shows when it ends, and is eased from there
    const nh = el.offsetHeight, nw = el.offsetWidth;
    const from = h;
    h = nh;
    if (nw !== w || Math.abs(nh - from) < 2 || reduced()) { w = nw; return; }
    const how = { duration: 160, easing: 'cubic-bezier(.2, .8, .2, 1)' }; // --dur-base, --ease-out
    run = el.animate([{ height: `${from}px` }, { height: `${nh}px` }], how);
    if (foot) el.querySelector(foot)?.animate([{ translate: `0 ${from - nh}px` }, { translate: '0 0' }], how);
    const end = () => { run = null; };
    run.finished.then(end, end);
  });
  ro.observe(el);
  return () => { ro.disconnect(); run?.cancel(); };
}
/** easeHeight for a note being written in a review: its buttons ride its lower edge. */
export const easeNote = (el: HTMLElement | null) => easeHeight(el, '.note-actions');
