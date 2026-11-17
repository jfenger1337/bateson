import type { ComponentProps, ReactNode } from 'react';
import * as Radix from '@radix-ui/react-context-menu';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// The right-click menu's parts: Radix's ContextMenu (keyboard, submenus, edge collision, focus), laid out as
// shadcn's is. There is no Tailwind here, so the look is the .cm-* rules in app.css.

export const ContextMenu = Radix.Root;
export const ContextMenuTrigger = Radix.Trigger;
export const ContextMenuSub = Radix.Sub;
export const ContextMenuRadioGroup = Radix.RadioGroup;

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Radix.Content>) {
  return (
    <Radix.Portal>
      <Radix.Content className={cn('cm', className)} collisionPadding={8} {...props} />
    </Radix.Portal>
  );
}

/** A row: what it does, and on the right the key that does the same. */
export function ContextMenuItem({ className, shortcut, children, ...props }: ComponentProps<typeof Radix.Item> & { shortcut?: string }) {
  return (
    <Radix.Item className={cn('cm-item', className)} {...props}>
      {children}
      {shortcut && <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>}
    </Radix.Item>
  );
}

export function ContextMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Radix.RadioItem>) {
  return (
    <Radix.RadioItem className={cn('cm-item', 'cm-check', className)} {...props}>
      <span className="cm-mark"><Radix.ItemIndicator><Check size={14} strokeWidth={2} aria-hidden /></Radix.ItemIndicator></span>
      {children}
    </Radix.RadioItem>
  );
}

export function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof Radix.SubTrigger>) {
  return (
    <Radix.SubTrigger className={cn('cm-item', className)} {...props}>
      {children}
      <ChevronRight className="cm-chevron" size={14} strokeWidth={1.75} aria-hidden />
    </Radix.SubTrigger>
  );
}

export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof Radix.SubContent>) {
  return (
    <Radix.Portal>
      <Radix.SubContent className={cn('cm', className)} collisionPadding={8} sideOffset={2} alignOffset={-5} {...props} />
    </Radix.Portal>
  );
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof Radix.Separator>) {
  return <Radix.Separator className={cn('cm-sep', className)} {...props} />;
}

/** Muted words at the top of a group, e.g. the text you right-clicked on. */
export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof Radix.Label>) {
  return <Radix.Label className={cn('cm-label', className)} {...props} />;
}

export function ContextMenuShortcut({ children }: { children: ReactNode }) {
  return <span className="cm-shortcut rec">{children}</span>;
}
