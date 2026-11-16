// The modifier bateson's shortcuts use: ⌘ on a Mac, Ctrl on Windows and everywhere else.
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** How a shortcut with it is written: ⌘Z on a Mac, Ctrl+Z elsewhere. */
export const MOD = MAC ? '⌘' : 'Ctrl+';
/** Its KeyboardEvent.key, for holding it down to see the keys. */
export const MOD_KEY = MAC ? 'Meta' : 'Control';
export const modHeld = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);
