import { useRef, useState, type ReactElement } from 'react';
import type { Config } from '@lib/types';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioGroup, ContextMenuRadioItem,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { MOD } from './lib/keys';

// Right-click anywhere: bateson's own menu instead of the browser's (Back, Cast, Translate, ... mean nothing in a
// window of its own). It offers what the place you clicked can do: copy or comment on what you selected, a link's address,
// put off the item in front of you, take back a decision still on hold, and the window's own settings.
//
// The browser's menu stays where it is the better one: in a field you type in (spelling, paste), with Shift held
// (Inspect, for whoever works on bateson), and on a touch screen, where a long press selects text.

type Theme = Config['theme'];
/** What was under the pointer when the menu opened. */
interface Spot { text: string; href?: string; /** The selection, when it is in work you can comment on (Review.tsx's [data-comments]). */ range?: Range }

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
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    const range = text && sel!.rangeCount ? sel!.getRangeAt(0).cloneRange() : undefined;
    const start = range?.startContainer;
    const inWork = !!(start && (start.nodeType === 1 ? start as Element : start.parentElement)?.closest('[data-comments]'));
    const next = { text, href: a?.href, range: inWork ? range : undefined };
    spotRef.current = next;
    setSpot(next);
  };

  const copy = async (s: string) => {
    try { await navigator.clipboard.writeText(s); }
    catch { document.execCommand('copy'); } // The selection is still the page's; the old way copies it.
  };

  // After the menu has closed: while it is open it keeps focus inside itself, and the comment box takes it.
  const comment = (r: Range) => window.setTimeout(() => window.dispatchEvent(new CustomEvent('qr-comment', { detail: r })));

  const { text, href, range } = spot;
  const preview = text.length > 42 ? `${text.slice(0, 40).trimEnd()}…` : text;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={COARSE.matches} onContextMenuCapture={onContextMenuCapture}>
        {children}
      </ContextMenuTrigger>
      {/* Closing leaves focus where the row put it (the comment box), not on the window the menu opened from. */}
      {/* Keys pressed in the menu are the menu's: they never reach the window's shortcuts (A approving, Enter
          sending), which would act on the item behind it. Escape still closes it (Radix listens on the document). */}
      <ContextMenuContent aria-label="bateson" onCloseAutoFocus={(e) => e.preventDefault()} onKeyDown={(e) => e.stopPropagation()}>
        {text && (
          <>
            <ContextMenuLabel title={text}>“{preview}”</ContextMenuLabel>
            {range && <ContextMenuItem shortcut="C" onSelect={() => comment(range)}>Comment</ContextMenuItem>}
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
          <ContextMenuSubContent onKeyDown={(e) => e.stopPropagation()}>
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
