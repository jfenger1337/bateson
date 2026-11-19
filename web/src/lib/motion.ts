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

// The item you just decided lifts away before the next one rises in (app.css, "Leaving"): the page you are on gets
// .leaving, and the change runs once it is out of sight. With reduced motion the next item is simply there.
export const LEAVE_MS = 140; // --dur-leave
export function leave(update: () => void) {
  const page = document.querySelector('.page');
  if (reduced() || !page) { update(); return; }
  page.classList.add('leaving');
  setTimeout(update, LEAVE_MS);
}
