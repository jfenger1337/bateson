// Light or dark: the setting ("theme" in config.json), or the system's when the setting is "system".
// The answer goes on <html data-theme>, which app.css reads. index.html sets it before the first paint
// from the copy kept in localStorage, so a chosen theme does not flash the other one on launch.

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'bateson:theme';
const GROUND = { light: '#FCFCFB', dark: '#141414' }; // --work
const system = window.matchMedia('(prefers-color-scheme: dark)');
let pref: Theme = 'system';

function paint() {
  const look = pref === 'system' ? (system.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = look;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', GROUND[look]);
}

export function setTheme(next: Theme | undefined) {
  pref = next === 'light' || next === 'dark' ? next : 'system';
  try { localStorage.setItem(KEY, pref); } catch { /* private window: the system's look until the config loads */ }
  paint();
}

system.addEventListener('change', paint);
