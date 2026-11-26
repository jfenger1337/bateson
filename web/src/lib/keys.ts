// The modifier bateson's shortcuts use: ⌘ on a Mac, Ctrl on Windows and everywhere else.
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** How a shortcut with it is written: ⌘Z on a Mac, Ctrl+Z elsewhere. */
export const MOD = MAC ? '⌘' : 'Ctrl+';
/** Its KeyboardEvent.key, for holding it down to see the keys. */
export const MOD_KEY = MAC ? 'Meta' : 'Control';
export const modHeld = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);
/**
 * A letter key as it would be without Caps Lock: with it on, d comes as "D", the drop shortcut, and a, s, c as
 * capitals no shortcut knows. Shift still makes a capital. Any other key is as it came.
 */
export const keyOf = (e: KeyboardEvent) => {
  if (e.key.length !== 1 || !e.getModifierState?.('CapsLock')) return e.key;
  return e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase();
};
