import { useRef, useState, type ReactElement } from 'react';
import type { Config } from '@lib/types';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioGroup, ContextMenuRadioItem,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { MOD } from './lib/keys';

// Right-click anywhere: bateson's own menu instead of the browser's (Back, Cast, Translate, ... mean nothing in a
// window of its own). It offers what the place you clicked can do: copy what you selected, a link's address,
// put off the item in front of you, take back a decision still on hold, and the window's own settings.
//
// The browser's menu stays where it is the better one: in a field you type in (spelling, paste), with Shift held
// (Inspect, for whoever works on bateson), and on a touch screen, where a long press selects text.

type Theme = Config['theme'];
/** What was under the pointer when the menu opened. */
interface Spot { text: string; href?: string }

const COARSE = window.matchMedia('(pointer: coarse) and (not (any-pointer: fine))');

export function AppMenu({ children, theme, onTheme, onSettings, later, undo }: {
  children: ReactElement;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSettings: () => void;
  /** Put the item in front of you to the back of the queue, when it can be. */
  later?: () => void;
  /** Take back the newest decision still on hold, with what it was. */
  undo?: { label: string; run: () => void };
}) {
  const [spot, setSpot] = useState<Spot>({ text: '' });
  // The selection as it was on the click: focus moves into the menu, and a row's click should not depend on it.
  const spotRef = useRef(spot);

  const onContextMenuCapture = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const typing = !!t.closest('textarea, input, select, [contenteditable=""], [contenteditable="true"]');
    // Stopped here, the event never reaches Radix's trigger, and nothing prevents the browser's own menu.
    if (typing || e.shiftKey) { e.stopPropagation(); return; }
    const a = t.closest<HTMLAnchorElement>('a[href]');
    const next = { text: window.getSelection()?.toString().trim() ?? '', href: a?.href };
    spotRef.current = next;
    setSpot(next);
  };

  const copy = async (s: string) => {
    try { await navigator.clipboard.writeText(s); }
    catch { document.execCommand('copy'); } // The selection is still the page's; the old way copies it.
  };

  const { text, href } = spot;
  const preview = text.length > 42 ? `${text.slice(0, 40).trimEnd()}…` : text;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={COARSE.matches} onContextMenuCapture={onContextMenuCapture}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="bateson">
        {text && (
          <>
            <ContextMenuLabel title={text}>“{preview}”</ContextMenuLabel>
            <ContextMenuItem shortcut={`${MOD}C`} onSelect={() => copy(spotRef.current.text)}>Copy</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {href && (
          <>
            <ContextMenuItem onSelect={() => window.open(href, '_blank', 'noopener')}>Open link</ContextMenuItem>
            <ContextMenuItem onSelect={() => copy(href)}>Copy link address</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {(undo || later) && (
          <>
            {undo && <ContextMenuItem shortcut={`${MOD}Z`} onSelect={undo.run}>Undo “{undo.label}”</ContextMenuItem>}
            {later && <ContextMenuItem shortcut="L" onSelect={later}>Later</ContextMenuItem>}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>Appearance</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={theme} onValueChange={(v) => onTheme(v as Theme)}>
              <ContextMenuRadioItem value="system">System</ContextMenuRadioItem>
              <ContextMenuRadioItem value="light">Light</ContextMenuRadioItem>
              <ContextMenuRadioItem value="dark">Dark</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem shortcut={`${MOD},`} onSelect={onSettings}>Settings</ContextMenuItem>
        <ContextMenuItem shortcut={`${MOD}R`} onSelect={() => location.reload()}>Reload</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
