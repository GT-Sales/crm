'use client';

import type { ComponentProps, ReactNode } from 'react';
import { cn, PopoverContent } from '@gt-sales/ui';

/**
 * Small building blocks for the CRM's dropdown panels (filter, sort, columns,
 * view switcher): 32px menu rows and 13px text on the shared Popover. Popovers
 * are used instead of menus so text and date inputs can live inside them.
 */

export function MenuPanel({ className, ...props }: ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent align="start" className={cn('w-60 p-1 text-[13px]', className)} {...props} />
  );
}

export function MenuItem({
  className,
  selected,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent aria-pressed:font-medium [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">{children}</div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
}

/** A quiet text button: the saved-view switcher and its Save / Save as new view. */
export function BarButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}
